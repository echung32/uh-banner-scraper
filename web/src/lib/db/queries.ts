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
 * Subject menu for a term — derived from the sections actually present
 * (`course_section`), so it only lists subjects that have data. `code` is the
 * subject code the search filters on; `description` is Banner's subject name.
 */
export async function getSubjectFacet(
  db: D1Like,
  term: string
): Promise<AutocompleteItem[]> {
  const { results } = await db
    .prepare(
      `SELECT subject AS code, MAX(subject_description) AS description
         FROM course_section WHERE term = ?
         GROUP BY subject ORDER BY subject ASC`
    )
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
  bookstore: unknown | null;
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
              bookstore_json, syllabus_text
         FROM section_detail WHERE term = ? AND crn = ?`
    )
    .bind(term, crn)
    .first<{
      restrictions_json: string | null;
      fees_json: string | null;
      cross_list_crns: string | null;
      linked_crns: string | null;
      bookstore_json: string | null;
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
    bookstore: j(row.bookstore_json),
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
