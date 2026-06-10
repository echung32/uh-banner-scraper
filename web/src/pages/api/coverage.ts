import type { APIRoute } from "astro";
import {
  fetchBackfillCoverageDetail,
  fetchCoverageDetail,
  fetchTermSyncMeta,
} from "@/lib/search";
import type { SearchParams } from "@/lib/sis/types";

/**
 * Per-window coverage for one search's sort + filters, keyed the same way as
 * /api/search. Read-only (never touches Banner). Two flavors by term kind:
 *  - dynamic (page-cached) → which windows are cached (search_chunk).
 *  - backfilled → data-freshness per window (course_section.synced_at), derived
 *    on the fly. campus/college/department matter here (they shape the row set),
 *    so they're read in; the dynamic path ignores them via filterSignature.
 */
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  if (!term) {
    return new Response(JSON.stringify({ error: "term is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Sort + filters key the coverage; paging is irrelevant. campus/college/dept
  // only affect the backfill (SQL) path's row set.
  const params: SearchParams = {
    term,
    subject: (url.searchParams.get("subject") ?? "").trim().toUpperCase(),
    courseNumber: url.searchParams.get("courseNumber") ?? undefined,
    campus: url.searchParams.get("campus") ?? undefined,
    college: url.searchParams.get("college") ?? undefined,
    department: url.searchParams.get("department") ?? undefined,
    openOnly: url.searchParams.get("openOnly") === "true",
    pageOffset: 0,
    pageMaxSize: 0,
    sortColumn: url.searchParams.get("sortColumn") ?? "subjectDescription",
    sortDirection: url.searchParams.get("sortDirection") ?? "asc",
  };

  try {
    const meta = await fetchTermSyncMeta(term);
    const coverage =
      meta?.lastSyncedAt != null
        ? await fetchBackfillCoverageDetail(params, meta)
        : await fetchCoverageDetail(params);
    return new Response(JSON.stringify(coverage), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Coverage lookup failed:", err);
    return new Response(JSON.stringify({ error: "Failed to fetch coverage" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
