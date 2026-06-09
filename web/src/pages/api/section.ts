/**
 * GET /api/section?term=<code>&crn=<crn>
 *
 * Section-level detail (restrictions, fees, cross-list / linked CRNs, bookstore,
 * syllabus) from D1's section_detail table. 404 if not ingested.
 */
import type { APIRoute } from "astro";
import { fetchSectionDetail } from "@/lib/search";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  const crn = url.searchParams.get("crn");

  if (!term || !crn) return bad("term and crn are required");

  try {
    const detail = await fetchSectionDetail(term, crn);
    if (!detail) return bad("section detail not found", 404);
    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Section detail failed:", err);
    return bad("Failed to fetch section detail", 500);
  }
};
