/**
 * GET /api/section?term=<code>&crn=<crn>
 *
 * Section-level detail (restrictions, fees, cross-list / linked CRNs, bookstore,
 * syllabus). Served from D1's section_detail table; on a miss it is fetched live
 * from Banner once, stored, and returned (lazy cache-on-miss — see
 * lib/ingest/sectionLazy). 404 only if the section itself doesn't exist in D1.
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/client";
import { fetchSectionDetail } from "@/lib/search";
import { ensureSectionDetail } from "@/lib/ingest/sectionLazy";

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
    // D1 first; on a cold section, fetch live + store once (lazy cache-on-miss).
    const detail =
      (await fetchSectionDetail(term, crn)) ??
      (await ensureSectionDetail(getDb(), term, crn));
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
