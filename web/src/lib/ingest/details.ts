/**
 * Course-details ingestion (phase 2, slice 1) — the Banner-facing write path for
 * the additive endpoints. Runs AFTER a term's course_section rows exist (a full
 * sync), since the course-catalog pass enumerates the live course set from D1.
 *
 * Two passes:
 *   - filter options: the canonical `get_*` dropdown menus, per term.
 *   - course catalog: academic College/Department/grading/schedule, fetched from
 *     ONE representative CRN per (campus, course). Catalog facts are
 *     campus-specific (the same subject+course at another campus is a different
 *     catalog entry) but uniform within a campus, and have no section-override
 *     slot — so per-(campus,course) dedup is safe. See docs/plans/course-details.md.
 */
import {
  establishSession,
  getBookstore,
  getCatalogDetails,
  getContactCard,
  getCorequisites,
  getCourseDescription,
  getCrossListSections,
  getFees,
  getFilterOptions,
  getLinkedSections,
  getPrerequisites,
  getRestrictions,
  getSyllabus,
  type FilterKind,
} from "@/lib/sis/client";
import { parseCatalogDetails } from "@/lib/sis/parse/catalogDetails";
import {
  parseCorequisites,
  parseCourseDescription,
  parsePrerequisites,
} from "@/lib/sis/parse/text";
import {
  parseBookstore,
  parseFees,
  parseRestrictions,
  parseSectionCrns,
  parseSyllabus,
} from "@/lib/sis/parse/sectionDetail";
import type { SisSession } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/client";
import {
  finishSyncRun,
  replaceFilterOptions,
  startSyncRun,
  upsertCourse,
  upsertInstructor,
  upsertSectionDetail,
} from "@/lib/db/upsert";

const SESSION_MAX_AGE_MS = 27 * 60 * 1000;
const DEFAULT_COURSE_DELAY_MS = 250; // throttle between per-course catalog fetches
// Banner silently throttles a session after a few hundred requests, so rotate to
// a fresh session by request count too (not just age). Budgeted as ~requests per
// session ÷ requests per item: catalog = 4 fetches/course, instructors = 1/card.
const CATALOG_PER_SESSION = 25; // ~100 requests
const ITEMS_PER_SESSION = 80;

/** Re-handshakes if the session is too old or has done too many requests. */
async function rotateIfNeeded(
  session: SisSession,
  term: string,
  count: number,
  perSession: number
): Promise<SisSession> {
  if (count >= perSession || Date.now() - session.establishedAt > SESSION_MAX_AGE_MS) {
    return establishSession(term);
  }
  return session;
}

/** The filter-option lists we persist (subject is handled by the full sync). */
export const FILTER_KINDS: FilterKind[] = [
  "campus",
  "college",
  "department",
  "instructionalMethod",
  "attribute",
  "partOfTerm",
  "scheduleType",
  "level",
  "session",
  "building",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DetailsOptions {
  /** Run the filter-option pass (default true). */
  filters?: boolean;
  /** Run the course-catalog pass (default true). */
  catalog?: boolean;
  /** Run the per-CRN section-detail pass (default true). The heaviest pass. */
  sections?: boolean;
  /** Run the per-instructor contact-card pass (default true). */
  instructors?: boolean;
  /**
   * In the catalog pass, also fetch course description / prerequisites /
   * corequisites (default true). These are 3 of the 4 per-course fetches, so
   * `text:false` runs a ~4× lighter "college/department only" pass (enough for
   * the College/Department filters); the text is preserved if already present
   * (upsertCourse COALESCEs it) and can be filled later.
   */
  text?: boolean;
  /** Delay between per-course / per-CRN / per-instructor fetches (ms). */
  courseDelayMs?: number;
  log?: (msg: string) => void;
}

export interface DetailsResult {
  term: string;
  filterKinds: number;
  filterOptions: number;
  courses: number;
  sectionDetails: number;
  instructors: number;
  status: "ok" | "partial" | "error";
}

/** Persists every filter-option list for a term. */
async function syncFilterOptions(
  db: D1Like,
  session: SisSession,
  term: string,
  log: (m: string) => void
): Promise<{ kinds: number; options: number; status: "ok" | "partial" }> {
  let kinds = 0;
  let options = 0;
  let status: "ok" | "partial" = "ok";
  for (const kind of FILTER_KINDS) {
    try {
      const items = await getFilterOptions(session, term, kind);
      const n = await replaceFilterOptions(db, term, kind, items);
      kinds += 1;
      options += n;
      log(`[${term}] filter ${kind}: ${n}`);
    } catch (err) {
      status = "partial";
      log(`[${term}] filter ${kind} FAILED: ${(err as Error).message}`);
    }
  }
  return { kinds, options, status };
}

/**
 * Fetches catalog details for one representative CRN per distinct course in the
 * term and upserts the `course` row.
 */
async function syncCourseCatalog(
  db: D1Like,
  session: SisSession,
  term: string,
  delayMs: number,
  withText: boolean,
  log: (m: string) => void
): Promise<{ courses: number; status: "ok" | "partial"; session: SisSession }> {
  // One representative CRN per (campus, subject, course_number). Catalog facts
  // (college/department/description/prereqs) are campus-specific — the same
  // subject+course at a different campus is a different catalog entry — but
  // uniform within a campus, so one CRN per campus suffices. See the plan's
  // verification note.
  const { results: courses } = await db
    .prepare(
      `SELECT campus_description AS campus, subject, course_number AS courseNumber,
              MIN(crn) AS crn
         FROM course_section WHERE term = ?
         GROUP BY campus_description, subject, course_number
         ORDER BY campus_description, subject, course_number`
    )
    .bind(term)
    .all<{ campus: string; subject: string; courseNumber: string; crn: string }>();

  let done = 0;
  let since = 0;
  let status: "ok" | "partial" = "ok";
  // With text it's 4 fetches/course, without it's 1 — budget the per-session
  // request count accordingly so a slim pass doesn't re-handshake too often.
  const perSession = withText ? CATALOG_PER_SESSION : CATALOG_PER_SESSION * 4;
  for (const c of courses) {
    const rotated = await rotateIfNeeded(session, term, since, perSession);
    if (rotated !== session) { session = rotated; since = 0; }
    since += 1;
    try {
      // Catalog always; the three text fragments only when withText.
      const [catalogHtml, descHtml, prereqHtml, coreqHtml] = await Promise.all([
        getCatalogDetails(session, term, c.crn),
        withText ? getCourseDescription(session, term, c.crn) : Promise.resolve(null),
        withText ? getPrerequisites(session, term, c.crn) : Promise.resolve(null),
        withText ? getCorequisites(session, term, c.crn) : Promise.resolve(null),
      ]);
      await upsertCourse(
        db,
        term,
        c.campus ?? "",
        c.subject,
        c.courseNumber,
        {
          catalog: parseCatalogDetails(catalogHtml),
          rawCatalogHtml: catalogHtml,
          // null leaves existing text untouched (upsertCourse COALESCEs).
          description: descHtml === null ? null : parseCourseDescription(descHtml),
          prerequisites: prereqHtml === null ? null : parsePrerequisites(prereqHtml),
          corequisites: coreqHtml === null ? null : parseCorequisites(coreqHtml),
          rawDescriptionHtml: descHtml,
          rawPrereqHtml: prereqHtml,
          rawCoreqHtml: coreqHtml,
        },
        Date.now()
      );
      done += 1;
    } catch (err) {
      status = "partial";
      log(`[${term}] ${c.campus} ${c.subject} ${c.courseNumber} FAILED: ${(err as Error).message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  log(`[${term}] catalog: ${done}/${courses.length} courses`);
  return { courses: done, status, session };
}

/**
 * Per-CRN section-detail pass — the heaviest (6 endpoints × every CRN). Fetches
 * restrictions / fees / cross-list / linked / bookstore / syllabus, parses, and
 * upserts `section_detail`.
 */
async function syncSectionDetails(
  db: D1Like,
  session: SisSession,
  term: string,
  delayMs: number,
  log: (m: string) => void
): Promise<{ done: number; status: "ok" | "partial"; session: SisSession }> {
  const { results: sections } = await db
    .prepare("SELECT crn FROM course_section WHERE term = ? ORDER BY crn")
    .bind(term)
    .all<{ crn: string }>();

  let done = 0;
  let since = 0;
  let status: "ok" | "partial" = "ok";
  for (const s of sections) {
    // 6 fetches/CRN, so rotate roughly every ~16 CRNs to stay near ~100 requests.
    const rotated = await rotateIfNeeded(session, term, since, Math.ceil(CATALOG_PER_SESSION / 1.5));
    if (rotated !== session) { session = rotated; since = 0; }
    since += 1;
    try {
      const [restr, fees, xlst, linked, bookstore, syllabus] = await Promise.all([
        getRestrictions(session, term, s.crn),
        getFees(session, term, s.crn),
        getCrossListSections(session, term, s.crn),
        getLinkedSections(session, term, s.crn),
        getBookstore(session, term, s.crn),
        getSyllabus(session, term, s.crn),
      ]);
      await upsertSectionDetail(
        db,
        term,
        s.crn,
        {
          restrictions: parseRestrictions(restr),
          fees: parseFees(fees),
          crossListCrns: parseSectionCrns(xlst),
          linkedCrns: parseSectionCrns(linked),
          bookstore: parseBookstore(bookstore),
          syllabus: parseSyllabus(syllabus),
          rawRestrictionsHtml: restr,
          rawFeesHtml: fees,
          rawXlstHtml: xlst,
          rawLinkedHtml: linked,
          rawBookstoreHtml: bookstore,
          rawSyllabusHtml: syllabus,
        },
        Date.now()
      );
      done += 1;
    } catch (err) {
      status = "partial";
      log(`[${term}] section ${s.crn} FAILED: ${(err as Error).message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  log(`[${term}] section detail: ${done}/${sections.length} CRNs`);
  return { done, status, session };
}

/** Per-instructor contact-card pass over the term's distinct faculty. */
async function syncInstructors(
  db: D1Like,
  session: SisSession,
  term: string,
  delayMs: number,
  log: (m: string) => void
): Promise<{ done: number; status: "ok" | "partial"; session: SisSession }> {
  const { results: ids } = await db
    .prepare(
      "SELECT DISTINCT banner_id FROM section_faculty WHERE term = ?"
        + " AND banner_id IS NOT NULL AND banner_id <> '' ORDER BY banner_id"
    )
    .bind(term)
    .all<{ banner_id: string }>();

  let done = 0;
  let since = 0;
  let status: "ok" | "partial" = "ok";
  for (const r of ids) {
    const rotated = await rotateIfNeeded(session, term, since, ITEMS_PER_SESSION);
    if (rotated !== session) { session = rotated; since = 0; }
    since += 1;
    try {
      const card = await getContactCard(session, r.banner_id, term);
      await upsertInstructor(db, card, Date.now());
      done += 1;
    } catch (err) {
      status = "partial";
      log(`[${term}] instructor ${r.banner_id} FAILED: ${(err as Error).message}`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  log(`[${term}] instructors: ${done}/${ids.length}`);
  return { done, status, session };
}

/** Orchestrates the course-details passes for a term. */
export async function syncDetails(
  db: D1Like,
  term: string,
  options: DetailsOptions = {}
): Promise<DetailsResult> {
  const log = options.log ?? (() => {});
  const doFilters = options.filters ?? true;
  const doCatalog = options.catalog ?? true;
  const doSections = options.sections ?? true;
  const doInstructors = options.instructors ?? true;
  const withText = options.text ?? true;
  const delay = options.courseDelayMs ?? DEFAULT_COURSE_DELAY_MS;

  const startedAt = Date.now();
  const run = await startSyncRun(db, term, "details", startedAt);

  let session = await establishSession(term);
  let filterKinds = 0;
  let filterOptions = 0;
  let courses = 0;
  let sectionDetails = 0;
  let instructors = 0;
  let status: "ok" | "partial" | "error" = "ok";

  try {
    if (doFilters) {
      const f = await syncFilterOptions(db, session, term, log);
      filterKinds = f.kinds;
      filterOptions = f.options;
      if (f.status === "partial") status = "partial";
    }
    if (doCatalog) {
      const c = await syncCourseCatalog(db, session, term, delay, withText, log);
      courses = c.courses;
      session = c.session;
      if (c.status === "partial") status = "partial";
    }
    if (doSections) {
      const sd = await syncSectionDetails(db, session, term, delay, log);
      sectionDetails = sd.done;
      session = sd.session;
      if (sd.status === "partial") status = "partial";
    }
    if (doInstructors) {
      const ins = await syncInstructors(db, session, term, delay, log);
      instructors = ins.done;
      session = ins.session;
      if (ins.status === "partial") status = "partial";
    }

    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status,
      sectionsUpserted: courses + sectionDetails,
    });
  } catch (err) {
    status = "error";
    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status: "error",
      sectionsUpserted: courses + sectionDetails,
      errorMessage: (err as Error).message,
    });
  }

  return {
    term,
    filterKinds,
    filterOptions,
    courses,
    sectionDetails,
    instructors,
    status,
  };
}
