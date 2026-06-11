import type { APIRoute } from "astro";
import { fetchTerms } from "@/lib/search";
import { withEdgeCache } from "@/lib/edgeCache";

async function handleTerms(): Promise<Response> {
  try {
    const terms = await fetchTerms();
    return new Response(JSON.stringify(terms), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Failed to fetch terms:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch terms" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export const GET: APIRoute = async ({ request }) => {
  // The term list changes a handful of times a year (refresh-terms), so a plain
  // TTL bound is enough — no data-version key like the term-scoped routes.
  return withEdgeCache(request, { version: "terms", ttlSeconds: 3600 }, handleTerms);
};
