/**
 * GET /api/course?term=<code>&campus=<description>&subject=<code>&courseNumber=<n>
 *
 * Catalog facts for one course at one campus (academic college/department,
 * grading modes, catalog schedule types, credit breakdown) from D1's course
 * table. Campus is required — the same subject+course at a different campus is a
 * different catalog entry. Returns 404 if not ingested.
 */
import type { APIRoute } from "astro";
import { fetchCourseCatalog } from "@/lib/search";

function bad(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  const campus = url.searchParams.get("campus");
  const subject = url.searchParams.get("subject");
  const courseNumber = url.searchParams.get("courseNumber");

  if (!term || !campus || !subject || !courseNumber) {
    return bad("term, campus, subject and courseNumber are required");
  }

  try {
    const catalog = await fetchCourseCatalog(term, campus, subject, courseNumber);
    if (!catalog) return bad("course not found", 404);
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Course catalog failed:", err);
    return bad("Failed to fetch course catalog", 500);
  }
};
