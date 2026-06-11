import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import {
  fetchBackfillCoverageSummary,
  fetchCoverageSummary,
  fetchSearchPage,
  fetchSearchResults,
  fetchSectionByCrn,
  fetchTermSyncMeta,
} from "@/lib/search";
import { ensureSearchPage } from "@/lib/ingest/pageCache";
import { ensureSectionByCrn } from "@/lib/ingest/crnLazy";
import { logDb } from "@/lib/log";
import type { CourseSection, SearchParams, SearchResultsResponse } from "@/lib/sis/types";

/** Wraps a CRN lookup as a single-(or zero-)row search response for the table. */
function crnResponse(section: CourseSection | null): SearchResultsResponse {
  const data = section ? [section] : [];
  return {
    success: true,
    totalCount: data.length,
    data,
    pageOffset: 0,
    pageMaxSize: data.length || 20,
    sectionsFetchedCount: data.length,
    pathMode: "search",
  };
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  // Subject is optional — empty means "all subjects" (search across everything).
  const subject = (url.searchParams.get("subject") ?? "").trim().toUpperCase();

  if (!term) {
    return new Response(JSON.stringify({ error: "term is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // CRN search is a distinct mode: a CRN identifies exactly one section within a
  // term (it's unique only per-term — see docs), so it ignores every other filter
  // and returns that single section. Serve from D1; for a dynamic (un-backfilled)
  // term, fall back to a live Banner fetch on a miss (ensureSectionByCrn).
  const crn = (url.searchParams.get("crn") ?? "").trim();
  if (crn) {
    try {
      let section = await fetchSectionByCrn(term, crn);
      if (!section && (await ensureSectionByCrn(getDb(), term, crn))) {
        section = await fetchSectionByCrn(term, crn);
      }
      logDb(`crn ${term}/${crn} → ${section ? "1" : "0"}`);
      return new Response(JSON.stringify(crnResponse(section)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("CRN search failed:", err);
      return new Response(
        JSON.stringify({ error: "Failed to fetch CRN" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  const pageOffset = parseInt(url.searchParams.get("pageOffset") ?? "0", 10);
  const pageMaxSize = Math.min(
    parseInt(url.searchParams.get("pageMaxSize") ?? "20", 10),
    100
  );

  const params: SearchParams = {
    term,
    subject,
    courseNumber: url.searchParams.get("courseNumber") ?? undefined,
    campus: url.searchParams.get("campus") ?? undefined,
    college: url.searchParams.get("college") ?? undefined,
    department: url.searchParams.get("department") ?? undefined,
    openOnly: url.searchParams.get("openOnly") === "true",
    pageOffset: isNaN(pageOffset) ? 0 : pageOffset,
    pageMaxSize: isNaN(pageMaxSize) ? 10 : pageMaxSize,
    sortColumn: url.searchParams.get("sortColumn") ?? "subjectDescription",
    sortDirection: url.searchParams.get("sortDirection") ?? "asc",
  };

  try {
    // Dynamic (not-yet-backfilled) terms serve from the demand-driven page cache:
    // ensureSearchPage fills the viewed window(s) from Banner on a miss, then we
    // assemble the page from D1. It returns false for backfilled/unknown terms (or
    // when DYNAMIC_SYNC is off), in which case we serve from the SQL read path.
    const viaPageCache = await ensureSearchPage(getDb(), params);
    const results = viaPageCache
      ? await fetchSearchPage(params)
      : await fetchSearchResults(params);
    // Attach a coverage summary: a dynamic term reports partial page-cache
    // coverage; a backfilled term reports a (cheap) data-freshness summary so the
    // UI can offer the per-window age grid. Unknown terms get nothing.
    if (viaPageCache) {
      results.coverage = await fetchCoverageSummary(params, results.totalCount);
    } else if (results.totalCount > 0) {
      const meta = await fetchTermSyncMeta(params.term);
      if (meta?.lastSyncedAt != null) {
        results.coverage = fetchBackfillCoverageSummary(params, results.totalCount, meta);
      }
    }
    logDb(
      `search ${params.term}/${params.subject || "*"} page ${params.pageOffset}+${params.pageMaxSize}` +
        `${viaPageCache ? " (page-cache)" : ""}` +
        ` → ${results.sectionsFetchedCount}/${results.totalCount}`
    );
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Search failed:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch search results" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
