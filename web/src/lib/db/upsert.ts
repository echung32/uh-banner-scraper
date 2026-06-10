/**
 * Write-path persistence used by the ingestion / refresh jobs (lib/ingest).
 * The read path never imports this module.
 */
import type { AutocompleteItem, CourseSection } from "@/lib/sis/types";
import type { CatalogDetails } from "@/lib/sis/parse/catalogDetails";
import type { D1Like, D1PreparedStatement } from "./types";
import {
  isViewOnly,
  sectionToFacultyRows,
  sectionToMeetingRows,
  sectionToRow,
  type CourseSectionRow,
  type FacultyRow,
  type MeetingRow,
} from "./mappers";

// Cloudflare's D1 REST /query endpoint caps a statement at 100 bound parameters
// ("too many SQL variables"), so a multi-row INSERT must keep rows × columns ≤
// 100. The chunk size is therefore derived from each table's column count (not a
// fixed row count) — e.g. a 23-column section row allows only 4 rows per insert.
const D1_MAX_PARAMS = 100;

function rowsPerChunk(columnCount: number): number {
  return Math.max(1, Math.floor(D1_MAX_PARAMS / columnCount));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Builds a multi-row `INSERT ... VALUES (..),(..)` statement for `rows`. */
function insertStatement<T extends Record<string, unknown>>(
  db: D1Like,
  table: string,
  columns: (keyof T)[],
  rows: T[]
): D1PreparedStatement {
  const placeholders = rows
    .map(() => `(${columns.map(() => "?").join(",")})`)
    .join(",");
  const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`;
  const binds = rows.flatMap((r) => columns.map((c) => r[c] ?? null));
  return db.prepare(sql).bind(...binds);
}

const SECTION_COLUMNS: (keyof CourseSectionRow)[] = [
  "term", "crn", "subject", "subject_description", "course_number",
  "sequence_number", "subject_course", "course_title", "campus_description",
  "schedule_type_desc", "credit_hours", "credit_hour_low", "credit_hour_high",
  "maximum_enrollment", "enrollment", "seats_available", "wait_capacity",
  "wait_count", "wait_available", "open_section", "part_of_term", "raw_json",
  "synced_at",
];

const FACULTY_COLUMNS: (keyof FacultyRow)[] = [
  "term", "crn", "banner_id", "display_name", "email_address",
  "primary_indicator", "category",
];

const MEETING_COLUMNS: (keyof MeetingRow)[] = [
  "term", "crn", "meeting_index", "begin_time", "end_time", "begin_date",
  "end_date", "building", "building_desc", "room", "campus", "meeting_type",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

/**
 * Delete-and-replace all sections for one `(term, subject)`. Child rows are
 * deleted explicitly (not relying on FK cascade, which D1/local differ on).
 * Returns the number of sections written.
 */
export async function replaceSubjectSections(
  db: D1Like,
  term: string,
  subject: string,
  sections: CourseSection[],
  syncedAt: number
): Promise<number> {
  await db.batch([
    db.prepare("DELETE FROM section_faculty WHERE term = ? AND crn IN (SELECT crn FROM course_section WHERE term = ? AND subject = ?)").bind(term, term, subject),
    db.prepare("DELETE FROM section_meeting WHERE term = ? AND crn IN (SELECT crn FROM course_section WHERE term = ? AND subject = ?)").bind(term, term, subject),
    db.prepare("DELETE FROM course_section WHERE term = ? AND subject = ?").bind(term, subject),
  ]);

  if (sections.length === 0) return 0;

  const sectionRows = sections.map((s) => sectionToRow(s, syncedAt));
  const facultyRows = sections.flatMap(sectionToFacultyRows);
  const meetingRows = sections.flatMap(sectionToMeetingRows);

  for (const part of chunk(sectionRows, rowsPerChunk(SECTION_COLUMNS.length))) {
    await db.batch([insertStatement(db, "course_section", SECTION_COLUMNS, part)]);
  }
  for (const part of chunk(facultyRows, rowsPerChunk(FACULTY_COLUMNS.length))) {
    await db.batch([insertStatement(db, "section_faculty", FACULTY_COLUMNS, part)]);
  }
  for (const part of chunk(meetingRows, rowsPerChunk(MEETING_COLUMNS.length))) {
    await db.batch([insertStatement(db, "section_meeting", MEETING_COLUMNS, part)]);
  }

  return sectionRows.length;
}

// Every section column except the (term, crn) primary key — the ON CONFLICT
// UPDATE list for upsertSections.
const SECTION_UPDATE_COLUMNS = SECTION_COLUMNS.filter(
  (c) => c !== "term" && c !== "crn"
);

/** Builds a multi-row upsert (`INSERT … ON CONFLICT(term,crn) DO UPDATE`). */
function upsertSectionStatement(
  db: D1Like,
  rows: CourseSectionRow[]
): D1PreparedStatement {
  const placeholders = rows
    .map(() => `(${SECTION_COLUMNS.map(() => "?").join(",")})`)
    .join(",");
  const setClause = SECTION_UPDATE_COLUMNS.map(
    (c) => `${String(c)} = excluded.${String(c)}`
  ).join(", ");
  const sql =
    `INSERT INTO course_section (${SECTION_COLUMNS.join(",")}) VALUES ${placeholders}` +
    ` ON CONFLICT(term, crn) DO UPDATE SET ${setClause}`;
  const binds = rows.flatMap((r) => SECTION_COLUMNS.map((c) => r[c] ?? null));
  return db.prepare(sql).bind(...binds);
}

/**
 * Idempotent upsert of sections keyed by (term, crn) — used by the demand-driven
 * page cache (lib/ingest/pageCache), where the same CRN can re-appear across
 * pages or filters. Unlike replaceSubjectSections there is NO subject-scoped
 * delete (and so no empty window): each row is inserted-or-updated in place, and
 * child faculty/meeting rows are refreshed per CRN. All sections must belong to
 * one term. Returns the number of sections written.
 */
export async function upsertSections(
  db: D1Like,
  sections: CourseSection[],
  syncedAt: number
): Promise<number> {
  if (sections.length === 0) return 0;
  const term = sections[0].term;
  const crns = sections.map((s) => s.courseReferenceNumber);
  const sectionRows = sections.map((s) => sectionToRow(s, syncedAt));
  const facultyRows = sections.flatMap(sectionToFacultyRows);
  const meetingRows = sections.flatMap(sectionToMeetingRows);

  // Refresh child rows for just these CRNs (delete-then-insert; not relying on FK
  // cascade, which D1/local differ on). Keep the IN-list under the 100-param cap.
  for (const part of chunk(crns, 90)) {
    const inList = part.map(() => "?").join(",");
    await db.batch([
      db
        .prepare(`DELETE FROM section_faculty WHERE term = ? AND crn IN (${inList})`)
        .bind(term, ...part),
      db
        .prepare(`DELETE FROM section_meeting WHERE term = ? AND crn IN (${inList})`)
        .bind(term, ...part),
    ]);
  }

  for (const part of chunk(sectionRows, rowsPerChunk(SECTION_COLUMNS.length))) {
    await db.batch([upsertSectionStatement(db, part)]);
  }
  for (const part of chunk(facultyRows, rowsPerChunk(FACULTY_COLUMNS.length))) {
    await db.batch([insertStatement(db, "section_faculty", FACULTY_COLUMNS, part)]);
  }
  for (const part of chunk(meetingRows, rowsPerChunk(MEETING_COLUMNS.length))) {
    await db.batch([insertStatement(db, "section_meeting", MEETING_COLUMNS, part)]);
  }

  return sectionRows.length;
}

/** Refreshes the term table from Banner's term list; recomputes view-only. */
export async function upsertTerms(db: D1Like, terms: AutocompleteItem[]): Promise<void> {
  const statements = terms.map((t, i) =>
    db
      .prepare(
        `INSERT INTO term (code, description, is_view_only, display_order)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           description = excluded.description,
           is_view_only = excluded.is_view_only,
           display_order = excluded.display_order`
      )
      // Banner returns terms newest-first; preserve that as descending order.
      .bind(t.code, t.description, isViewOnly(t.description) ? 1 : 0, terms.length - i)
  );
  if (statements.length > 0) await db.batch(statements);
}

/** Upserts the subject list for a term. */
export async function upsertSubjects(
  db: D1Like,
  term: string,
  subjects: AutocompleteItem[]
): Promise<void> {
  if (subjects.length === 0) return;
  const statements = subjects.map((s) =>
    db
      .prepare(
        `INSERT INTO subject (term, code, description) VALUES (?, ?, ?)
         ON CONFLICT(term, code) DO UPDATE SET description = excluded.description`
      )
      .bind(term, s.code, s.description)
  );
  await db.batch(statements);
}

/** Seat-only update: patch counts + raw_json for already-stored sections. */
export async function updateSeats(
  db: D1Like,
  sections: CourseSection[],
  syncedAt: number
): Promise<void> {
  if (sections.length === 0) return;
  const statements = sections.map((s) =>
    db
      .prepare(
        `UPDATE course_section SET
           maximum_enrollment = ?, enrollment = ?, seats_available = ?,
           wait_capacity = ?, wait_count = ?, wait_available = ?,
           open_section = ?, raw_json = ?, synced_at = ?
         WHERE term = ? AND crn = ?`
      )
      .bind(
        s.maximumEnrollment ?? 0,
        s.enrollment ?? 0,
        s.seatsAvailable ?? 0,
        s.waitCapacity ?? 0,
        s.waitCount ?? 0,
        s.waitAvailable ?? 0,
        s.openSection ? 1 : 0,
        JSON.stringify(s),
        syncedAt,
        s.term,
        s.courseReferenceNumber
      )
  );
  await db.batch(statements);
}

// ── course details (phase 2) ─────────────────────────────────────────────────

/**
 * Replaces all filter-option rows for one `(term, kind)` — delete-and-replace so
 * a shrunk Banner list doesn't leave stale options. Preserves Banner's order.
 */
export async function replaceFilterOptions(
  db: D1Like,
  term: string,
  kind: string,
  items: AutocompleteItem[]
): Promise<number> {
  await db
    .prepare("DELETE FROM filter_option WHERE term = ? AND kind = ?")
    .bind(term, kind)
    .run();
  if (items.length === 0) return 0;
  const statements = items.map((item, i) =>
    db
      .prepare(
        "INSERT INTO filter_option (term, kind, code, description, display_order) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(term, kind, item.code, item.description, i)
  );
  await db.batch(statements);
  return items.length;
}

/**
 * Upserts the catalog facts for one course. Only the catalog columns are written
 * here (college/department/grading/schedule/credit + raw_catalog_html); the
 * description/prereq/coreq columns are left untouched so a later slice can fill
 * them without this overwriting them (and vice-versa).
 */
export interface CourseUpsert {
  catalog: CatalogDetails;
  rawCatalogHtml: string;
  description?: string | null;
  prerequisites?: string | null;
  corequisites?: string | null;
  rawDescriptionHtml?: string | null;
  rawPrereqHtml?: string | null;
  rawCoreqHtml?: string | null;
}

/**
 * Upserts a course's catalog facts + text (description/prereqs/coreqs). Catalog
 * and text are fetched together in one ingest pass, so all columns are written
 * (and overwritten on conflict) in one statement.
 */
export async function upsertCourse(
  db: D1Like,
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string,
  data: CourseUpsert,
  syncedAt: number
): Promise<void> {
  const { catalog } = data;
  await db
    .prepare(
      `INSERT INTO course
         (term, campus_description, subject, course_number, college_code,
          college_name, department, department_code, grading_modes,
          schedule_types, credit_breakdown, description, prerequisites,
          corequisites, raw_catalog_html, raw_description_html, raw_prereq_html,
          raw_coreq_html, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term, campus_description, subject, course_number) DO UPDATE SET
         college_code = excluded.college_code,
         college_name = excluded.college_name,
         department = excluded.department,
         department_code = excluded.department_code,
         grading_modes = excluded.grading_modes,
         schedule_types = excluded.schedule_types,
         credit_breakdown = excluded.credit_breakdown,
         description = COALESCE(excluded.description, course.description),
         prerequisites = COALESCE(excluded.prerequisites, course.prerequisites),
         corequisites = COALESCE(excluded.corequisites, course.corequisites),
         raw_catalog_html = excluded.raw_catalog_html,
         raw_description_html = COALESCE(excluded.raw_description_html, course.raw_description_html),
         raw_prereq_html = COALESCE(excluded.raw_prereq_html, course.raw_prereq_html),
         raw_coreq_html = COALESCE(excluded.raw_coreq_html, course.raw_coreq_html),
         synced_at = excluded.synced_at`
    )
    .bind(
      term,
      campusDescription,
      subject,
      courseNumber,
      catalog.collegeCode,
      catalog.collegeName,
      catalog.department,
      catalog.departmentCode,
      JSON.stringify(catalog.gradingModes),
      JSON.stringify(catalog.scheduleTypes),
      JSON.stringify(catalog.creditBreakdown),
      data.description ?? null,
      data.prerequisites ?? null,
      data.corequisites ?? null,
      data.rawCatalogHtml,
      data.rawDescriptionHtml ?? null,
      data.rawPrereqHtml ?? null,
      data.rawCoreqHtml ?? null,
      syncedAt
    )
    .run();
}

export interface CourseTextUpdate {
  description: string | null;
  prerequisites: string | null;
  corequisites: string | null;
  rawDescriptionHtml: string | null;
  rawPrereqHtml: string | null;
  rawCoreqHtml: string | null;
}

/**
 * Updates ONLY the catalog-text columns of an existing `course` row (lazy
 * course-text path). COALESCE so a failed/empty fragment never overwrites
 * existing text; the catalog facts (college/department/…) are untouched, so this
 * can run without re-fetching getSectionCatalogDetails. `raw_description_html`
 * doubles as the "text fetched" marker that stops the lazy path refetching.
 */
export async function updateCourseText(
  db: D1Like,
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string,
  t: CourseTextUpdate,
  syncedAt: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE course SET
         description = COALESCE(?, description),
         prerequisites = COALESCE(?, prerequisites),
         corequisites = COALESCE(?, corequisites),
         raw_description_html = COALESCE(?, raw_description_html),
         raw_prereq_html = COALESCE(?, raw_prereq_html),
         raw_coreq_html = COALESCE(?, raw_coreq_html),
         synced_at = ?
       WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(
      t.description,
      t.prerequisites,
      t.corequisites,
      t.rawDescriptionHtml,
      t.rawPrereqHtml,
      t.rawCoreqHtml,
      syncedAt,
      term,
      campusDescription,
      subject,
      courseNumber
    )
    .run();
}

export interface SectionDetailUpsert {
  restrictions: unknown | null;
  fees: unknown | null;
  crossListCrns: string[] | null;
  linkedCrns: string[] | null;
  syllabus: string | null;
  // Null when that fragment's live fetch failed (lazy path tolerates a single
  // bad/unrecognized endpoint); the column is nullable.
  rawRestrictionsHtml: string | null;
  rawFeesHtml: string | null;
  rawXlstHtml: string | null;
  rawLinkedHtml: string | null;
  rawSyllabusHtml: string | null;
}

const jsonOrNull = (v: unknown): string | null =>
  v == null ? null : JSON.stringify(v);

/** Upserts the section-level detail (restrictions/fees/cross-list/linked/…). */
export async function upsertSectionDetail(
  db: D1Like,
  term: string,
  crn: string,
  d: SectionDetailUpsert,
  syncedAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO section_detail
         (term, crn, restrictions_json, fees_json, cross_list_crns, linked_crns,
          syllabus_text, raw_restrictions_html, raw_fees_html,
          raw_xlst_html, raw_linked_html, raw_syllabus_html,
          synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term, crn) DO UPDATE SET
         restrictions_json = excluded.restrictions_json,
         fees_json = excluded.fees_json,
         cross_list_crns = excluded.cross_list_crns,
         linked_crns = excluded.linked_crns,
         syllabus_text = excluded.syllabus_text,
         raw_restrictions_html = excluded.raw_restrictions_html,
         raw_fees_html = excluded.raw_fees_html,
         raw_xlst_html = excluded.raw_xlst_html,
         raw_linked_html = excluded.raw_linked_html,
         raw_syllabus_html = excluded.raw_syllabus_html,
         synced_at = excluded.synced_at`
    )
    .bind(
      term,
      crn,
      jsonOrNull(d.restrictions),
      jsonOrNull(d.fees),
      jsonOrNull(d.crossListCrns),
      jsonOrNull(d.linkedCrns),
      d.syllabus,
      d.rawRestrictionsHtml,
      d.rawFeesHtml,
      d.rawXlstHtml,
      d.rawLinkedHtml,
      d.rawSyllabusHtml,
      syncedAt
    )
    .run();
}

/** Upserts an instructor contact card. */
export async function upsertInstructor(
  db: D1Like,
  card: {
    bannerId: string;
    displayName: string | null;
    title: string | null;
    department: string | null;
    college: string | null;
    email: string | null;
    raw: unknown;
  },
  syncedAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO instructor
         (banner_id, display_name, title, department, college, email, raw_json, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(banner_id) DO UPDATE SET
         display_name = excluded.display_name,
         title = excluded.title,
         department = excluded.department,
         college = excluded.college,
         email = excluded.email,
         raw_json = excluded.raw_json,
         synced_at = excluded.synced_at`
    )
    .bind(
      card.bannerId,
      card.displayName,
      card.title,
      card.department,
      card.college,
      card.email,
      JSON.stringify(card.raw),
      syncedAt
    )
    .run();
}

// ── term sync metadata ──────────────────────────────────────────────────────

export async function markTermSynced(
  db: D1Like,
  term: string,
  status: "ok" | "partial" | "error",
  syncedAt: number
): Promise<void> {
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM course_section WHERE term = ?")
    .bind(term)
    .first<{ n: number }>();
  await db
    .prepare(
      `UPDATE term SET last_synced_at = ?, last_sync_status = ?, section_count = ?,
         seeded = CASE WHEN is_view_only = 1 AND ? = 'ok' THEN 1 ELSE seeded END
       WHERE code = ?`
    )
    .bind(syncedAt, status, count?.n ?? 0, status, term)
    .run();
}

export async function markSeatRefresh(db: D1Like, term: string, at: number): Promise<void> {
  await db.prepare("UPDATE term SET last_seat_refresh_at = ? WHERE code = ?").bind(at, term).run();
}

/** Records that a term's subjects have been enumerated (lazy subject path). */
export async function markTermSubjectsSynced(db: D1Like, term: string, at: number): Promise<void> {
  await db.prepare("UPDATE term SET subjects_synced_at = ? WHERE code = ?").bind(at, term).run();
}

export interface SyncRunHandle {
  id: number;
}

export async function startSyncRun(
  db: D1Like,
  term: string,
  kind: "full" | "seat_refresh" | "terms" | "details",
  startedAt: number
): Promise<SyncRunHandle> {
  const row = await db
    .prepare(
      "INSERT INTO sync_run (term, kind, started_at) VALUES (?, ?, ?) RETURNING id"
    )
    .bind(term, kind, startedAt)
    .first<{ id: number }>();
  return { id: row?.id ?? 0 };
}

export async function finishSyncRun(
  db: D1Like,
  handle: SyncRunHandle,
  fields: {
    finishedAt: number;
    status: "ok" | "partial" | "error";
    subjectsTotal?: number;
    subjectsDone?: number;
    sectionsUpserted?: number;
    errorMessage?: string;
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_run SET finished_at = ?, status = ?, subjects_total = ?,
         subjects_done = ?, sections_upserted = ?, error_message = ?
       WHERE id = ?`
    )
    .bind(
      fields.finishedAt,
      fields.status,
      fields.subjectsTotal ?? null,
      fields.subjectsDone ?? null,
      fields.sectionsUpserted ?? null,
      fields.errorMessage ?? null,
      handle.id
    )
    .run();
}
