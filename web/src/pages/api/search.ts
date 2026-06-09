import type { APIRoute } from "astro";
import { fetchSearchResults } from "@/lib/search";
import type { SearchParams } from "@/lib/sis/types";

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  const subject = url.searchParams.get("subject");

  if (!term || !subject) {
    return new Response(
      JSON.stringify({ error: "term and subject are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const pageOffset = parseInt(url.searchParams.get("pageOffset") ?? "0", 10);
  const pageMaxSize = Math.min(
    parseInt(url.searchParams.get("pageMaxSize") ?? "10", 10),
    50
  );

  const params: SearchParams = {
    term,
    subject,
    courseNumber: url.searchParams.get("courseNumber") ?? undefined,
    openOnly: url.searchParams.get("openOnly") === "true",
    pageOffset: isNaN(pageOffset) ? 0 : pageOffset,
    pageMaxSize: isNaN(pageMaxSize) ? 10 : pageMaxSize,
    sortColumn: url.searchParams.get("sortColumn") ?? "subjectDescription",
    sortDirection: url.searchParams.get("sortDirection") ?? "asc",
  };

  try {
    const results = await fetchSearchResults(params);
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
