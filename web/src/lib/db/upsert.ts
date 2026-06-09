/**
 * Write-path persistence used by the ingestion / refresh jobs (lib/ingest).
 * The read path never imports this module.
 */
import type { AutocompleteItem, CourseSection } from "@/lib/sis/types";
import type { D1Like, D1PreparedStatement } from "./client";
import {
  isViewOnly,
  sectionToFacultyRows,
  sectionToMeetingRows,
  sectionToRow,
  type CourseSectionRow,
  type FacultyRow,
  type MeetingRow,
} from "./mappers";

// Keep chunks small so the combined bound-parameter count stays well under
// SQLite/D1 limits regardless of backend.
const SECTION_CHUNK = 15;
const CHILD_CHUNK = 40;

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

  for (const part of chunk(sectionRows, SECTION_CHUNK)) {
    await db.batch([insertStatement(db, "course_section", SECTION_COLUMNS, part)]);
  }
  for (const part of chunk(facultyRows, CHILD_CHUNK)) {
    await db.batch([insertStatement(db, "section_faculty", FACULTY_COLUMNS, part)]);
  }
  for (const part of chunk(meetingRows, CHILD_CHUNK)) {
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

export interface SyncRunHandle {
  id: number;
}

export async function startSyncRun(
  db: D1Like,
  term: string,
  kind: "full" | "seat_refresh" | "terms",
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
