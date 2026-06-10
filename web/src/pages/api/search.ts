import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/client";
import { fetchSearchResults } from "@/lib/search";
import { ensureTermSubject } from "@/lib/ingest/dynamicSync";
import { logDb } from "@/lib/log";
import type { SearchParams } from "@/lib/sis/types";

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
    // For a not-yet-backfilled term, pull this subject from Banner on first
    // search and store it (cache-on-miss); a no-op for backfilled terms and
    // already-synced subjects. Then serve from D1 as usual.
    if (subject) await ensureTermSubject(getDb(), term, subject);

    const results = await fetchSearchResults(params);
    logDb(
      `search ${params.term}/${params.subject || "*"} page ${params.pageOffset}+${params.pageMaxSize}` +
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
