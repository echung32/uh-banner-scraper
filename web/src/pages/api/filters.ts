/**
 * GET /api/filters?term=<code>&kind=<kind>
 *
 * Server-driven filter-option menus (campus, college, department, …) served from
 * D1's filter_option table. Returns [{ code, description }].
 */
import type { APIRoute } from "astro";
import { fetchFilterOptions } from "@/lib/search";
import { FILTER_KINDS, type FilterKind } from "@/lib/db/queries";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  const kind = url.searchParams.get("kind");
  // For college/department, an optional campus DESCRIPTION scopes the facet.
  const campus = url.searchParams.get("campus") ?? undefined;

  if (!term || !kind) return bad("term and kind are required");
  if (!FILTER_KINDS.includes(kind as FilterKind)) {
    return bad(`unknown kind '${kind}'`);
  }

  try {
    const options = await fetchFilterOptions(term, kind as FilterKind, campus);
    return new Response(JSON.stringify({ kind, options }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Filter options failed:", err);
    return bad("Failed to fetch filter options", 500);
  }
};
