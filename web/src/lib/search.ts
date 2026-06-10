/**
 * Application layer for the read path. Searches are served entirely from the
 * persistent D1 store (see docs/plans/d1-persistence.md); the live Banner API is
 * only touched by the ingestion / refresh jobs in lib/ingest. There is no
 * request-time cache or session pool anymore — D1 is the source of truth.
 */
import { getDb } from "@/lib/db/client";
import {
  getBackfillCoverageDetail,
  getBackfillCoverageSummary,
  getCatalogFacet,
  getCourseCatalog,
  getCoverageDetail,
  getCoverageSummary,
  getFilterOptions,
  getInstructor,
  getSectionDetail,
  getSearchPageFromChunks,
  getSubjectFacet,
  getTermSyncMeta,
  getTerms,
  searchSections,
  type CourseCatalog,
  type FilterKind,
  type Instructor,
  type SectionDetail,
  type TermSyncMeta,
} from "@/lib/db/queries";
import type {
  AutocompleteItem,
  CoverageDetail,
  SearchCoverage,
  SearchParams,
  SearchResultsResponse,
} from "@/lib/sis/types";

export async function fetchTerms(): Promise<AutocompleteItem[]> {
  return getTerms(getDb());
}

export async function fetchSearchResults(
  params: SearchParams
): Promise<SearchResultsResponse> {
  return searchSections(getDb(), params);
}

/** Page-cache read for a dynamic term (assembled from cached windows). */
export async function fetchSearchPage(
  params: SearchParams
): Promise<SearchResultsResponse> {
  return getSearchPageFromChunks(getDb(), params);
}

/** Sync state for a term (null if unknown) — drives the search route's branch. */
export async function fetchTermSyncMeta(term: string): Promise<TermSyncMeta | null> {
  return getTermSyncMeta(getDb(), term);
}

/** Cache-coverage summary for a dynamic-term search (attached to the response). */
export async function fetchCoverageSummary(
  params: SearchParams,
  totalCount: number
): Promise<SearchCoverage> {
  return getCoverageSummary(getDb(), params, totalCount);
}

/** Per-window coverage for the coverage grid (`/api/coverage`). */
export async function fetchCoverageDetail(
  params: SearchParams
): Promise<CoverageDetail> {
  return getCoverageDetail(getDb(), params);
}

/** Cheap freshness summary for a backfilled-term search (attached to the response). */
export function fetchBackfillCoverageSummary(
  params: SearchParams,
  totalCount: number,
  meta: TermSyncMeta
): SearchCoverage {
  return getBackfillCoverageSummary(params, totalCount, meta);
}

/** Per-window data-freshness for a backfilled term (`/api/coverage`). */
export async function fetchBackfillCoverageDetail(
  params: SearchParams,
  meta: TermSyncMeta
): Promise<CoverageDetail> {
  return getBackfillCoverageDetail(getDb(), params, meta);
}

export async function fetchFilterOptions(
  term: string,
  kind: FilterKind,
  campusDescription?: string
): Promise<AutocompleteItem[]> {
  // Subject is derived from the sections present for the term.
  if (kind === "subject") {
    return getSubjectFacet(getDb(), term);
  }
  // College/Department aren't in filter_option (UH's get_college/get_department
  // return empty); derive them from the ingested course catalog, campus-scoped.
  if (kind === "college" || kind === "department") {
    return getCatalogFacet(getDb(), term, kind, campusDescription);
  }
  return getFilterOptions(getDb(), term, kind);
}

export async function fetchCourseCatalog(
  term: string,
  campusDescription: string,
  subject: string,
  courseNumber: string
): Promise<CourseCatalog | null> {
  return getCourseCatalog(getDb(), term, campusDescription, subject, courseNumber);
}

export async function fetchSectionDetail(
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  return getSectionDetail(getDb(), term, crn);
}

export async function fetchInstructor(bannerId: string): Promise<Instructor | null> {
  return getInstructor(getDb(), bannerId);
}
