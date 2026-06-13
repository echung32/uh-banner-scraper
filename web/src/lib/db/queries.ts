/**
 * Read-path queries. These serve user-facing searches entirely from D1 — the
 * Banner API is never touched here.
 */
import type {
  AutocompleteItem,
  CourseSection,
  CoverageDetail,
  SearchCoverage,
  SearchParams,
  SearchResultsResponse,
} from "@/lib/sis/types";
import type { D1Like } from "./types";
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

/**
 * The catalog course number as displayed (e.g. "111", "110D"), derived by
 * stripping the subject prefix off `subject_course` ("ICS111" → "111"). Banner
 * stores `course_number` in an internal padded form ("1110") that the UI never
 * shows and that its own course-number search does NOT match against; the search
 * box and the table both speak the catalog number, so filtering and ordering use
 * this. `subject_course` is always `subject` + the catalog number (Banner emits
 * no separator — "ICS111"), so stripping the leading `subject` is exact; the
 * trim() only guards against a stray separator (e.g. test fixtures use "ICS 111").
 */
const CATALOG_NUMBER_SQL = "trim(substr(cs.subject_course, length(cs.subject) + 1))";

function resolveSort(
  column: string | undefined,
  direction: string | undefined,
  subjectFiltered = false
): string {
  const col = SORT_COLUMNS[column ?? "subjectDescription"] ?? "subject_description";
  const dir = (direction ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  // Columns are qualified `cs.` because searchSections may join the course table.
  // Tiebreak by catalog course number, then sequence, then (term, crn): within a
  // subject (where subject_description is constant) this yields course order
  // instead of the effectively-random CRN order. CATALOG_NUMBER_SQL is the
  // displayed catalog number (e.g. "111"), not Banner's internal padded
  // course_number (e.g. "1110") — see buildSectionFilter.
  //
  // The tiebreaks MIRROR the primary direction: the default sort is served
  // streamed from the expression indexes in migrations/0007_sort_indexes.sql, and
  // a DESC primary with ASC tiebreaks can't be satisfied by a backward index scan
  // (verified: it falls back to a temp B-tree over the whole term).
  const tail =
    `${CATALOG_NUMBER_SQL} ${dir},`
    + ` cs.sequence_number ${dir}, cs.term ${dir}, cs.crn ${dir}`;
  // Under a single-subject filter, subject_description is constant, so sorting by
  // it is a no-op — dropping it lets the planner stream from idx_cs_subj_sort
  // (term=? AND subject=?) instead of scanning the term in description order.
  if (subjectFiltered && col === "subject_description") return tail;
  return `cs.${col} ${dir}, ${tail}`;
}

export interface TermSyncMeta {
  /** Epoch-ms of the last full backfill, or null if never backfilled (dynamic). */
  lastSyncedAt: number | null;
  /** Epoch-ms of the last seat-only refresh, or null if never refreshed. */
  lastSeatRefreshAt: number | null;
  /** Past terms (description ends "(View Only)") are immutable. */
  isViewOnly: boolean;
}

/**
 * Sync state for one term, or null if unknown. Drives the search route's branch
 * (backfilled → SQL path; dynamic → page cache), the page cache's staleness rule
 * (view-only windows never expire), and the backfill freshness view's term-level
 * anchors (last full sync vs last seat refresh).
 */
export async function getTermSyncMeta(
  db: D1Like,
  term: string
): Promise<TermSyncMeta | null> {
  const row = await db
    .prepare(
      "SELECT last_synced_at, last_seat_refresh_at, is_view_only FROM term WHERE code = ?"
    )
    .bind(term)
    .first<{
      last_synced_at: number | null;
      last_seat_refresh_at: number | null;
      is_view_only: number;
    }>();
  if (!row) return null;
  return {
    lastSyncedAt: row.last_synced_at,
    lastSeatRefreshAt: row.last_seat_refresh_at,
    isViewOnly: row.is_view_only === 1,
  };
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
 * Subject menu for a term — served from the enumerated `subject` table alone
 * (PK lookup, ~270 rows). Every section producer enumerates subjects first: the
 * full sync (sync.ts) and the dynamic-term menu fill (dynamicSync.
 * ensureTermSubjects) both upsert the table, so a term with sections has its
 * subjects here. (This used to UNION in the distinct subjects of
 * `course_section`, but that scanned every section row of the term on each menu
 * load — a D1 rows-read cost — to cover only the crnLazy edge case, where a lone
 * CRN-fetched section could predate enumeration; the menu self-heals on first
 * open via ensureTermSubjects, so the union wasn't worth the scan.)
 * `code` is the subject code the search filters on; `description` is Banner's
 * subject name.
 */
export async function getSubjectFacet(
  db: D1Like,
  term: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare("SELECT code, description FROM subject WHERE term = ? ORDER BY code ASC")
    .bind(term)
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
 * The `filter_option.kind` a materialized catalog facet is stored under. Campus
 * is part of the menu's identity (colleges differ per campus), so it's encoded
 * into the kind; `*` is the unscoped (all-campuses) menu. Written by the details
 * sync (materializeCatalogFacets), read by getCatalogFacet.
 */
export function catalogFacetKind(
  facet: "college" | "department",
  campusDescription?: string
): string {
  return `${facet}@${campusDescription ?? "*"}`;
}

/**
 * Derives a catalog facet (college, department) from the ingested `course` table
 * — NOT `filter_option`'s Banner menus (UH's `get_college`/`get_department`
 * return empty; verified live). Scoped by campus since colleges differ per
 * campus. This scans the term's course rows (~5k), so the read path only falls
 * back to it when no materialized menu exists yet; the details sync also calls
 * it to produce the materialized rows.
 */
export async function deriveCatalogFacet(
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

/**
 * Catalog facets (college, department) for a dropdown. Prefers the menu
 * materialized into `filter_option` at details-sync time (a PK-ranged read of a
 * few dozen rows); falls back to deriving from `course` for terms whose details
 * pass hasn't run since materialization shipped. Returns `[{ code, description }]`.
 */
export async function getCatalogFacet(
  db: D1Like,
  term: string,
  facet: "college" | "department",
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT code, description FROM filter_option
         WHERE term = ? AND kind = ?
         ORDER BY display_order ASC, code ASC`
    )
    .bind(term, catalogFacetKind(facet, campusDescription))
    .all<{ code: string; description: string }>();
  if (results.length > 0) {
    return results.map((r) => ({ code: r.code, description: r.description }));
  }
  return deriveCatalogFacet(db, term, facet, campusDescription);
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

/**
 * The CRNs whose section detail is stalest for a term — the rolling Tier B2
 * cursor (docs/plans/scheduled-refresh.md). Never-fetched sections (no
 * section_detail row) sort first via COALESCE(...,0); then oldest synced_at.
 * Sized by the caller so a term fully cycles within the freshness window.
 */
export async function getStaleDetailCrns(
  db: D1Like,
  term: string,
  limit: number
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT cs.crn AS crn
         FROM course_section cs
         LEFT JOIN section_detail sd ON sd.term = cs.term AND sd.crn = cs.crn
        WHERE cs.term = ?
        ORDER BY COALESCE(sd.synced_at, 0) ASC, cs.crn ASC
        LIMIT ?`
    )
    .bind(term, limit)
    .all<{ crn: string }>();
  return results.map((r) => r.crn);
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
/**
 * The shared FROM + WHERE + binds for a section search. Extracted so the backfill
 * freshness view (getBackfillCoverageDetail) reproduces the *exact* filter/sort as
 * the paginated search, guaranteeing window N lines up with search page N.
 *
 * Clauses are built CONDITIONALLY — only for filters actually present — never as
 * `(? IS NULL OR col = ?)`. The OR form defeats the query planner (it can't push
 * the equality into an index range), which forced a full-term scan on every
 * search; static clauses let the sort/subject indexes (migration 0007) serve the
 * common shapes streamed. D1 bills rows *scanned*, so this is a cost fix, not
 * just a speed fix.
 *
 * College/Department live on the `course` table, so those filters LEFT JOIN it on
 * (term, campus, subject, course_number) — a 1:0..1 join (course PK is exactly
 * those four cols), so COUNT and pagination are unaffected. The join is included
 * only when a catalog filter is applied; it would otherwise cost a PK probe per
 * emitted row. Columns are `cs.`/`c.` qualified.
 */
function buildSectionFilter(params: SearchParams): {
  from: string;
  where: string;
  binds: (string | number)[];
} {
  const clauses = ["cs.term = ?"];
  const binds: (string | number)[] = [params.term];

  // Subject is optional on the read path: empty/absent → search all subjects.
  if (params.subject) {
    clauses.push("cs.subject = ?");
    binds.push(params.subject);
  }
  if (params.courseNumber) {
    clauses.push(`${CATALOG_NUMBER_SQL} = ?`);
    binds.push(params.courseNumber);
  }
  // Sections store only the campus description, so map the selected code to it;
  // an unknown code yields null → no campus filter (all campuses), matching the
  // previous behavior.
  const campusDescription = params.campus
    ? campusDescriptionForCode(params.campus)
    : null;
  if (campusDescription) {
    clauses.push("cs.campus_description = ?");
    binds.push(campusDescription);
  }
  if (params.college) {
    clauses.push("c.college_code = ?");
    binds.push(params.college);
  }
  if (params.department) {
    clauses.push("c.department_code = ?");
    binds.push(params.department);
  }
  if (params.openOnly) clauses.push("cs.open_section = 1");

  const from =
    params.college || params.department
      ? "course_section cs LEFT JOIN course c"
        + " ON c.term = cs.term AND c.campus_description = cs.campus_description"
        + " AND c.subject = cs.subject AND c.course_number = cs.course_number"
      : "course_section cs";
  return { from, where: clauses.join(" AND "), binds };
}

/**
 * One section by `(term, crn)` — the CRN search's D1 read. A CRN is unique within
 * a term (it's half the `course_section` primary key), so this returns at most one
 * row, reconstructed byte-faithfully from `raw_json`. Null when not stored (the
 * route may then try a live fetch for a dynamic term — see ingest/crnLazy).
 */
export async function getSectionByCrn(
  db: D1Like,
  term: string,
  crn: string
): Promise<CourseSection | null> {
  const row = await db
    .prepare("SELECT raw_json FROM course_section WHERE term = ? AND crn = ?")
    .bind(term, crn)
    .first<{ raw_json: string }>();
  return row ? rowToCourseSection(row) : null;
}

export async function searchSections(
  db: D1Like,
  params: SearchParams
): Promise<SearchResultsResponse> {
  const { from, where, binds: filterBinds } = buildSectionFilter(params);

  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`)
    .bind(...filterBinds)
    .first<{ n: number }>();
  const totalCount = count?.n ?? 0;

  const { results } = await db
    .prepare(
      `SELECT cs.raw_json AS raw_json FROM ${from} WHERE ${where}`
        + ` ORDER BY ${resolveSort(params.sortColumn, params.sortDirection, Boolean(params.subject))}`
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

/**
 * Coverage summary for a dynamic term's search (current sort + filters): how many
 * sections / windows are cached out of the full result set. `totalCount` is
 * supplied by the caller (the just-served page already knows Banner's total) so
 * this is a single aggregate over the term's `search_chunk` rows.
 */
export async function getCoverageSummary(
  db: D1Like,
  params: SearchParams,
  totalCount: number
): Promise<SearchCoverage> {
  const { sortColumn, sortDirection } = normalizeChunkSort(params);
  const sig = filterSignature(params);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS chunks, COALESCE(SUM(json_array_length(crns_json)), 0) AS cached
         FROM search_chunk
        WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?`
    )
    .bind(params.term, sig, sortColumn, sortDirection)
    .first<{ chunks: number; cached: number }>();
  return {
    mode: "page-cache",
    dynamic: true,
    chunkSize: CHUNK_SIZE,
    totalChunks: Math.ceil(totalCount / CHUNK_SIZE),
    cachedChunks: row?.chunks ?? 0,
    cachedCount: row?.cached ?? 0,
  };
}

/**
 * Per-window coverage for one search's sort + filters, for the coverage grid.
 * Returns only the cached windows (absent indices are uncached); `totalChunks`
 * bounds the grid. `totalCount` comes from any cached window's stored Banner total
 * (0 — empty grid — when nothing is cached yet).
 */
export async function getCoverageDetail(
  db: D1Like,
  params: SearchParams
): Promise<CoverageDetail> {
  const { sortColumn, sortDirection } = normalizeChunkSort(params);
  const sig = filterSignature(params);
  const { results } = await db
    .prepare(
      `SELECT chunk_index, json_array_length(crns_json) AS count, total_count, fetched_at
         FROM search_chunk
        WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?
        ORDER BY chunk_index ASC`
    )
    .bind(params.term, sig, sortColumn, sortDirection)
    .all<{ chunk_index: number; count: number; total_count: number; fetched_at: number }>();
  const totalCount = results[0]?.total_count ?? 0;
  return {
    mode: "page-cache",
    dynamic: true,
    chunkSize: CHUNK_SIZE,
    totalCount,
    totalChunks: Math.ceil(totalCount / CHUNK_SIZE),
    chunks: results.map((r) => ({
      index: r.chunk_index,
      count: r.count,
      fetchedAt: r.fetched_at,
    })),
  };
}

/**
 * Coverage summary for a fully-backfilled term — cheap, runs on every search.
 * Everything is in `course_section`, so all windows are present; this just bounds
 * the grid (no row scan). The per-window freshness comes later, on dialog open
 * (getBackfillCoverageDetail). `totalCount` is the count the search already computed.
 */
export function getBackfillCoverageSummary(
  params: SearchParams,
  totalCount: number,
  meta: TermSyncMeta
): SearchCoverage {
  const totalChunks = Math.ceil(totalCount / CHUNK_SIZE);
  return {
    mode: "backfill",
    dynamic: false,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    cachedChunks: totalChunks,
    cachedCount: totalCount,
    isViewOnly: meta.isViewOnly,
  };
}

/**
 * Per-window data-freshness for a backfilled term, for the coverage grid. Derived
 * on the fly (no stored chunks): number each filtered/sorted row with the same
 * ORDER BY as the paginated search (resolveSort), bucket into CHUNK_SIZE windows,
 * and aggregate `synced_at` per window. MIN(synced_at) is the worst-case staleness
 * the grid colors on; MAX shows the freshest write in the slice. Runs only on
 * dialog open. CHUNK_SIZE is a trusted constant, safe to interpolate.
 */
export async function getBackfillCoverageDetail(
  db: D1Like,
  params: SearchParams,
  meta: TermSyncMeta
): Promise<CoverageDetail> {
  const { from, where, binds } = buildSectionFilter(params);
  const order = resolveSort(params.sortColumn, params.sortDirection, Boolean(params.subject));
  const { results } = await db
    .prepare(
      `SELECT (rn - 1) / ${CHUNK_SIZE} AS chunk_index, COUNT(*) AS count,
              MIN(synced_at) AS oldest, MAX(synced_at) AS newest
         FROM (
           SELECT cs.synced_at AS synced_at,
                  ROW_NUMBER() OVER (ORDER BY ${order}) AS rn
             FROM ${from} WHERE ${where}
         )
        GROUP BY (rn - 1) / ${CHUNK_SIZE}
        ORDER BY chunk_index ASC`
    )
    .bind(...binds)
    .all<{ chunk_index: number; count: number; oldest: number; newest: number }>();

  const totalCount = results.reduce((n, r) => n + r.count, 0);
  return {
    mode: "backfill",
    dynamic: false,
    chunkSize: CHUNK_SIZE,
    totalCount,
    totalChunks: Math.ceil(totalCount / CHUNK_SIZE),
    chunks: results.map((r) => ({
      index: r.chunk_index,
      count: r.count,
      oldestSyncedAt: r.oldest,
      newestSyncedAt: r.newest,
    })),
    isViewOnly: meta.isViewOnly,
    lastSyncedAt: meta.lastSyncedAt,
    lastSeatRefreshAt: meta.lastSeatRefreshAt,
  };
}

/** The (column, direction) a chunk row is keyed by — matches the fill side. */
function normalizeChunkSort(params: SearchParams): {
  sortColumn: string;
  sortDirection: "asc" | "desc";
} {
  return {
    sortColumn: params.sortColumn ?? "subjectDescription",
    sortDirection:
      (params.sortDirection ?? "asc").toLowerCase() === "desc" ? "desc" : "asc",
  };
}
