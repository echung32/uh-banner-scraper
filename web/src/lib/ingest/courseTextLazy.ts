/**
 * Lazy (cache-on-miss) course-text fetch: description / prerequisites /
 * corequisites.
 *
 * The eager catalog pass ran with `text=0` (the three text fragments are 3 of
 * the 4 per-course fetches — ~31k requests — so they were deferred), which is
 * why every backfilled `course` row has `description = NULL`. This fills them in
 * the first time a course's panel is opened (`/api/course`) and serves from D1
 * forever after — the same cache-on-miss idea as section detail / dynamic sync.
 *
 * Only enriches an EXISTING `course` row (a backfilled term's catalog); a term
 * whose catalog was never synced has no row and is skipped. `raw_description_html`
 * is the "already fetched" marker, so a course with genuinely no description is
 * fetched once, not on every view. Disabled with COURSE_TEXT_LAZY=0.
 */
import {
  establishSession,
  getCorequisites,
  getCourseDescription,
  getPrerequisites,
} from "@/lib/sis/client";
import {
  parseCorequisites,
  parseCourseDescription,
  parsePrerequisites,
} from "@/lib/sis/parse/text";
import type { D1Like } from "@/lib/db/client";
import { getCourseCatalog, type CourseCatalog } from "@/lib/db/queries";
import { updateCourseText } from "@/lib/db/upsert";
import { logSis } from "@/lib/log";

/** Concurrent first-views of the same course share one live fetch. */
const inFlight = new Map<string, Promise<CourseCatalog | null>>();

function lazyEnabled(): boolean {
  return process.env.COURSE_TEXT_LAZY !== "0";
}

async function fetchAndStore(
  db: D1Like,
  term: string,
  campus: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  // A representative CRN for this course at this campus drives the text fetch.
  const crnRow = await db
    .prepare(
      `SELECT MIN(crn) AS crn FROM course_section
         WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(term, campus, subject, courseNumber)
    .first<{ crn: string | null }>();
  const crn = crnRow?.crn;
  if (!crn) return null;

  logSis(`course text ${term}/${campus}/${subject} ${courseNumber} — live fetch (cache miss)`);
  const session = await establishSession(term);
  // Tolerate a single failing fragment; if every fragment fails (throttled /
  // unknown CRN) return null WITHOUT marking, so a later view retries.
  const settled = await Promise.allSettled([
    getCourseDescription(session, term, crn),
    getPrerequisites(session, term, crn),
    getCorequisites(session, term, crn),
  ]);
  if (settled.every((s) => s.status === "rejected")) {
    console.warn(`Course text: all fragments failed for ${term}/${subject} ${courseNumber}`);
    return null;
  }
  const raw = (i: number): string | null =>
    settled[i].status === "fulfilled"
      ? (settled[i] as PromiseFulfilledResult<string>).value
      : null;
  const descHtml = raw(0);
  const prereqHtml = raw(1);
  const coreqHtml = raw(2);

  await updateCourseText(
    db,
    term,
    campus,
    subject,
    courseNumber,
    {
      description: descHtml ? parseCourseDescription(descHtml) : null,
      prerequisites: prereqHtml ? parsePrerequisites(prereqHtml) : null,
      corequisites: coreqHtml ? parseCorequisites(coreqHtml) : null,
      rawDescriptionHtml: descHtml,
      rawPrereqHtml: prereqHtml,
      rawCoreqHtml: coreqHtml,
    },
    Date.now()
  );

  return getCourseCatalog(db, term, campus, subject, courseNumber);
}

/**
 * Fills a course's text on first view and returns the refreshed catalog — but
 * only if the course row exists and its text hasn't been fetched yet
 * (`raw_description_html IS NULL`). Returns null otherwise (the caller keeps the
 * row it already has), so a course with no description isn't re-fetched.
 */
export async function ensureCourseText(
  db: D1Like,
  term: string,
  campus: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  if (!lazyEnabled()) return null;

  const row = await db
    .prepare(
      `SELECT raw_description_html FROM course
         WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(term, campus, subject, courseNumber)
    .first<{ raw_description_html: string | null }>();
  // No catalog row (un-synced term) or text already fetched → nothing to do.
  if (!row || row.raw_description_html != null) return null;

  const key = `${term}:${campus}:${subject}:${courseNumber}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndStore(db, term, campus, subject, courseNumber).finally(
    () => inFlight.delete(key)
  );
  inFlight.set(key, promise);
  return promise;
}
