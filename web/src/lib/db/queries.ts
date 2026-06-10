/**
 * Read-path queries. These serve user-facing searches entirely from D1 — the
 * Banner API is never touched here.
 */
import type {
  AutocompleteItem,
  SearchParams,
  SearchResultsResponse,
} from "@/lib/sis/types";
import type { D1Like } from "./client";
import { campusDescriptionForCode } from "@/lib/campuses";
import { rowToCourseSection } from "./mappers";

/**
 * Whitelist of Banner sort columns → physical columns. User input is mapped
 * through this (never interpolated) so an unknown/hostile value can't reach the
 * SQL and falls back to the Banner default of `subjectDescription`.
 */
const SORT_COLUMNS: Record<string, string> = {
  subjectDescription: "subject_description",
  courseNumber: "course_number",
  courseTitle: "course_title",
  sequenceNumber: "sequence_number",
  seatsAvailable: "seats_available",
  enrollment: "enrollment",
  campusDescription: "campus_description",
};

function resolveSort(column: string | undefined, direction: string | undefined): string {
  const col = SORT_COLUMNS[column ?? "subjectDescription"] ?? "subject_description";
  const dir = (direction ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  // Columns are qualified `cs.` because searchSections joins the course table.
  // Tiebreak on (term, crn) for stable pagination.
  return `cs.${col} ${dir}, cs.term ASC, cs.crn ASC`;
}

export interface TermSyncMeta {
  /** Epoch-ms of the last full backfill, or null if never backfilled (dynamic). */
  lastSyncedAt: number | null;
  /** Past terms (description ends "(View Only)") are immutable. */
  isViewOnly: boolean;
}

/**
 * Sync state for one term, or null if unknown. Drives the search route's branch
 * (backfilled → SQL path; dynamic → page cache) and the page cache's staleness
 * rule (view-only windows never expire).
 */
export async function getTermSyncMeta(
  db: D1Like,
  term: string
): Promise<TermSyncMeta | null> {
  const row = await db
    .prepare("SELECT last_synced_at, is_view_only FROM term WHERE code = ?")
    .bind(term)
    .first<{ last_synced_at: number | null; is_view_only: number }>();
  if (!row) return null;
  return { lastSyncedAt: row.last_synced_at, isViewOnly: row.is_view_only === 1 };
}

/** Serves the term dropdown from D1, preserving Banner's verbatim descriptions. */
export async function getTerms(db: D1Like): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      "SELECT code, description FROM term ORDER BY display_order DESC, code DESC"
    )
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/**
 * The filter kinds the read path can serve. Most come from `filter_option`;
 * `subject`, `college`, and `department` are derived from the ingested catalog /
 * sections instead (see fetchFilterOptions) — UH disables their Banner menus.
 */
export const FILTER_KINDS = [
  "subject",
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
] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

/**
 * Subject menu for a term — the union of subjects with sections present
 * (`course_section`) and the enumerated `subject` table. The union matters for
 * not-yet-backfilled terms: their sections are filled lazily per subject, so the
 * menu would be empty until the `subject` table is populated (see
 * dynamicSync.ensureTermSubjects). `code` is the subject code the search filters
 * on; `description` is Banner's subject name.
 */
export async function getSubjectFacet(
  db: D1Like,
  term: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, MAX(description) AS description FROM (
         SELECT subject AS code, subject_description AS description
           FROM course_section WHERE term = ?
         UNION ALL
         SELECT code, description FROM subject WHERE term = ?
       ) GROUP BY code ORDER BY code ASC`
    )
    .bind(term, term)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/** Serves a server-driven filter dropdown for a term, in Banner's order. */
export async function getFilterOptions(
  db: D1Like,
  term: string,
  kind: FilterKind
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, description FROM filter_option
         WHERE term = ? AND kind = ?
         ORDER BY display_order ASC, code ASC`
    )
    .bind(term, kind)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

/**
 * Catalog facets (college, department) — derived from the ingested `course`
 * table, NOT `filter_option` (UH's `get_college`/`get_department` return empty;
 * verified live). Scoped by campus since colleges differ per campus. Returns
 * `[{ code, description }]` for a dropdown.
 */
export async function getCatalogFacet(
  db: D1Like,
  term: string,
  facet: "college" | "department",
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  const codeCol = facet === "college" ? "college_code" : "department_code";
  const nameCol = facet === "college" ? "college_name" : "department";
  const where = ["term = ?", `${nameCol} IS NOT NULL`];
  const binds: unknown[] = [term];
  if (campusDescription) {
    where.push("campus_description = ?");
    binds.push(campusDescription);
  }
  const { results } = await db
    .prepare(
      `SELECT DISTINCT COALESCE(${codeCol}, ${nameCol}) AS code, ${nameCol} AS description
         FROM course WHERE ${where.join(" AND ")}
         ORDER BY description ASC`
    )
    .bind(...binds)
    .all<{ code: string; description: string }>();
  return results.map((r) => ({ code: r.code, description: r.description }));
}

export interface CourseCatalog {
  term: string;
  campusDescription: string;
  subject: string;
  courseNumber: string;
  collegeCode: string | null;
  collegeName: string | null;
  department: string | null;
  departmentCode: string | null;
  gradingModes: string[];
  scheduleTypes: string[];
  creditBreakdown: unknown;
  description: string | null;
  prerequisites: string | null;
  corequisites: string | null;
}

/**
 * Catalog facts for one course at one campus (null if not yet ingested). Campus
 * is part of the key: the same subject+course at a different campus is a
 * different catalog entry (different college/department/prereqs).
 */
export async function getCourseCatalog(
  db: D1Like,
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  const row = await db
    .prepare(
      `SELECT college_code, college_name, department, department_code,
              grading_modes, schedule_types, credit_breakdown,
              description, prerequisites, corequisites
         FROM course
         WHERE term = ? AND campus_description = ? AND subject = ? AND course_number = ?`
    )
    .bind(term, campusDescription, subject, courseNumber)
    .first<{
      college_code: string | null;
      college_name: string | null;
      department: string | null;
      department_code: string | null;
      grading_modes: string | null;
      schedule_types: string | null;
      credit_breakdown: string | null;
      description: string | null;
      prerequisites: string | null;
      corequisites: string | null;
    }>();
  if (!row) return null;
  const parseArr = (s: string | null): string[] => {
    if (!s) return [];
    try {
      return JSON.parse(s) as string[];
    } catch {
      return [];
    }
  };
  return {
    term,
    campusDescription,
    subject,
    courseNumber,
    collegeCode: row.college_code,
    collegeName: row.college_name,
    department: row.department,
    departmentCode: row.department_code,
    gradingModes: parseArr(row.grading_modes),
    scheduleTypes: parseArr(row.schedule_types),
    creditBreakdown: row.credit_breakdown
      ? JSON.parse(row.credit_breakdown)
      : null,
    description: row.description,
    prerequisites: row.prerequisites,
    corequisites: row.corequisites,
  };
}

export interface SectionDetail {
  term: string;
  crn: string;
  restrictions: unknown | null;
  fees: unknown | null;
  crossListCrns: string[] | null;
  linkedCrns: string[] | null;
  syllabus: string | null;
}

/** Section-level detail (restrictions/fees/cross-list/…); null if not ingested. */
export async function getSectionDetail(
  db: D1Like,
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  const row = await db
    .prepare(
      `SELECT restrictions_json, fees_json, cross_list_crns, linked_crns,
              syllabus_text
         FROM section_detail WHERE term = ? AND crn = ?`
    )
    .bind(term, crn)
    .first<{
      restrictions_json: string | null;
      fees_json: string | null;
      cross_list_crns: string | null;
      linked_crns: string | null;
      syllabus_text: string | null;
    }>();
  if (!row) return null;
  const j = (s: string | null): unknown =>
    s == null ? null : (() => { try { return JSON.parse(s); } catch { return null; } })();
  return {
    term,
    crn,
    restrictions: j(row.restrictions_json),
    fees: j(row.fees_json),
    crossListCrns: j(row.cross_list_crns) as string[] | null,
    linkedCrns: j(row.linked_crns) as string[] | null,
    syllabus: row.syllabus_text,
  };
}

export interface Instructor {
  bannerId: string;
  displayName: string | null;
  title: string | null;
  department: string | null;
  college: string | null;
  email: string | null;
}

/** Instructor contact-card facts; null if not ingested. */
export async function getInstructor(
  db: D1Like,
  bannerId: string
): Promise<Instructor | null> {
  const row = await db
    .prepare(
      `SELECT banner_id, display_name, title, department, college, email
         FROM instructor WHERE banner_id = ?`
    )
    .bind(bannerId)
    .first<{
      banner_id: string;
      display_name: string | null;
      title: string | null;
      department: string | null;
      college: string | null;
      email: string | null;
    }>();
  if (!row) return null;
  return {
    bannerId: row.banner_id,
    displayName: row.display_name,
    title: row.title,
    department: row.department,
    college: row.college,
    email: row.email,
  };
}

/** Reproduces Banner's searchResults filter/sort/paginate semantics over D1. */
export async function searchSections(
  db: D1Like,
  params: SearchParams
): Promise<SearchResultsResponse> {
  // College/Department live on the `course` table, so the section query LEFT
  // JOINs it on (term, campus, subject, course_number) — a 1:0..1 join (course
  // PK is exactly those four cols), so COUNT and pagination are unaffected when
  // no catalog filter is applied. Columns are `cs.`/`c.` qualified.
  const from =
    "course_section cs LEFT JOIN course c"
    + " ON c.term = cs.term AND c.campus_description = cs.campus_description"
    + " AND c.subject = cs.subject AND c.course_number = cs.course_number";

  const where = "cs.term = ?"
    + " AND (? IS NULL OR cs.subject = ?)"
    + " AND (? IS NULL OR cs.course_number = ?)"
    + " AND (? IS NULL OR cs.campus_description = ?)"
    + " AND (? IS NULL OR c.college_code = ?)"
    + " AND (? IS NULL OR c.department_code = ?)"
    + " AND (? = 0 OR cs.open_section = 1)";

  // Subject is optional on the read path: empty/absent → search all subjects.
  const subject = params.subject ? params.subject : null;
  const courseNumber = params.courseNumber ?? null;
  // Sections store only the campus description, so map the selected code to it;
  // an unknown/absent code yields NULL → no campus filter (all campuses).
  const campusDescription = params.campus
    ? campusDescriptionForCode(params.campus)
    : null;
  const college = params.college ?? null;
  const department = params.department ?? null;
  const openOnly = params.openOnly ? 1 : 0;
  const filterBinds = [
    params.term,
    subject,
    subject,
    courseNumber,
    courseNumber,
    campusDescription,
    campusDescription,
    college,
    college,
    department,
    department,
    openOnly,
  ];

  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`)
    .bind(...filterBinds)
    .first<{ n: number }>();
  const totalCount = count?.n ?? 0;

  const { results } = await db
    .prepare(
      `SELECT cs.raw_json AS raw_json FROM ${from} WHERE ${where}`
        + ` ORDER BY ${resolveSort(params.sortColumn, params.sortDirection)}`
        + " LIMIT ? OFFSET ?"
    )
    .bind(...filterBinds, params.pageMaxSize, params.pageOffset)
    .all<{ raw_json: string }>();

  return {
    success: true,
    totalCount,
    data: results.map(rowToCourseSection),
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sectionsFetchedCount: results.length,
    pathMode: "search",
  };
}

// ── demand-driven page cache (dynamic terms) ─────────────────────────────────
//
// Dynamic (not-yet-backfilled) terms serve searches from a per-window cache
// (search_chunk) filled live from Banner one page at a time. The read side here
// reconstructs a page from already-cached windows; the fill side is
// lib/ingest/pageCache. See migrations/0006_search_chunk.sql.

/** Internal page-cache granularity — rows per stored window (offset-aligned). */
export const CHUNK_SIZE = 50;

/**
 * Canonical signature of the filters Banner actually applies on a live dynamic-
 * term page (subject / course number / open-only). college/department are
 * catalog-derived and unavailable for dynamic terms, so they're excluded.
 */
export function filterSignature(params: SearchParams): string {
  return JSON.stringify({
    subject: params.subject || "",
    courseNumber: params.courseNumber || "",
    openOnly: params.openOnly ? 1 : 0,
  });
}

/** The chunk indices whose windows overlap `[offset, offset + size)`. */
export function chunkIndicesFor(offset: number, size: number): number[] {
  if (size <= 0) return [];
  const first = Math.floor(offset / CHUNK_SIZE);
  const last = Math.floor((offset + size - 1) / CHUNK_SIZE);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

function chunkArr<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Serves one search page for a dynamic term from the cached windows, in Banner's
 * order. Reconstructs the absolute CRN sequence across the covering chunks, slices
 * to the requested window, then loads those sections' raw_json from
 * course_section. A page is only as complete as its chunks — the caller
 * (ensureSearchPage) fills any missing/stale windows first; with DYNAMIC_SYNC off
 * an uncached page simply comes back empty.
 */
export async function getSearchPageFromChunks(
  db: D1Like,
  params: SearchParams
): Promise<SearchResultsResponse> {
  const sortColumn = params.sortColumn ?? "subjectDescription";
  const sortDirection = (params.sortDirection ?? "asc").toLowerCase() === "desc"
    ? "desc"
    : "asc";
  const sig = filterSignature(params);
  const indices = chunkIndicesFor(params.pageOffset, params.pageMaxSize);

  const empty = (totalCount = 0): SearchResultsResponse => ({
    success: true,
    totalCount,
    data: [],
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sectionsFetchedCount: 0,
    pathMode: "search",
  });
  if (indices.length === 0) return empty();

  const ph = indices.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT chunk_index, crns_json, total_count FROM search_chunk
         WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?
           AND chunk_index IN (${ph})
         ORDER BY chunk_index ASC`
    )
    .bind(params.term, sig, sortColumn, sortDirection, ...indices)
    .all<{ chunk_index: number; crns_json: string; total_count: number }>();
  if (results.length === 0) return empty();

  const totalCount = results[0].total_count;
  const crnsByChunk = new Map<number, string[]>();
  for (const r of results) {
    crnsByChunk.set(r.chunk_index, JSON.parse(r.crns_json) as string[]);
  }

  // Walk the requested absolute positions; stop at a missing chunk or past the
  // real end of data (a partial last window, or beyond totalCount).
  const pageCrns: string[] = [];
  const end = Math.min(params.pageOffset + params.pageMaxSize, totalCount);
  for (let p = params.pageOffset; p < end; p++) {
    const ci = Math.floor(p / CHUNK_SIZE);
    const arr = crnsByChunk.get(ci);
    if (!arr) break;
    const within = p - ci * CHUNK_SIZE;
    if (within >= arr.length) break;
    pageCrns.push(arr[within]);
  }
  if (pageCrns.length === 0) return empty(totalCount);

  // Load the section bodies (keep IN-lists under the 100-param cap), then restore
  // Banner's order.
  const rawByCrn = new Map<string, string>();
  for (const part of chunkArr(pageCrns, 90)) {
    const inPh = part.map(() => "?").join(",");
    const { results: rows } = await db
      .prepare(`SELECT crn, raw_json FROM course_section WHERE term = ? AND crn IN (${inPh})`)
      .bind(params.term, ...part)
      .all<{ crn: string; raw_json: string }>();
    for (const r of rows) rawByCrn.set(r.crn, r.raw_json);
  }
  const data = pageCrns
    .map((crn) => rawByCrn.get(crn))
    .filter((j): j is string => j != null)
    .map((raw_json) => rowToCourseSection({ raw_json }));

  return {
    success: true,
    totalCount,
    data,
    pageOffset: params.pageOffset,
    pageMaxSize: params.pageMaxSize,
    sectionsFetchedCount: data.length,
    pathMode: "search",
  };
}
