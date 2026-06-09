/**
 * GET /api/instructor?bannerId=<id>
 *
 * Instructor contact-card facts (title / department / email) from D1's
 * instructor table. 404 if not ingested.
 */
import type { APIRoute } from "astro";
import { fetchInstructor } from "@/lib/search";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const bannerId = url.searchParams.get("bannerId");

  if (!bannerId) return bad("bannerId is required");

  try {
    const instructor = await fetchInstructor(bannerId);
    if (!instructor) return bad("instructor not found", 404);
    return new Response(JSON.stringify(instructor), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Instructor failed:", err);
    return bad("Failed to fetch instructor", 500);
  }
};
