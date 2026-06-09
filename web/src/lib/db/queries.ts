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
  // Tiebreak on (term, crn) for stable pagination.
  return `${col} ${dir}, term ASC, crn ASC`;
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

/** Reproduces Banner's searchResults filter/sort/paginate semantics over D1. */
export async function searchSections(
  db: D1Like,
  params: SearchParams
): Promise<SearchResultsResponse> {
  const where = "term = ? AND subject = ?"
    + " AND (? IS NULL OR course_number = ?)"
    + " AND (? = 0 OR open_section = 1)";

  const courseNumber = params.courseNumber ?? null;
  const openOnly = params.openOnly ? 1 : 0;
  const filterBinds = [
    params.term,
    params.subject,
    courseNumber,
    courseNumber,
    openOnly,
  ];

  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM course_section WHERE ${where}`)
    .bind(...filterBinds)
    .first<{ n: number }>();
  const totalCount = count?.n ?? 0;

  const { results } = await db
    .prepare(
      `SELECT raw_json FROM course_section WHERE ${where}`
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
