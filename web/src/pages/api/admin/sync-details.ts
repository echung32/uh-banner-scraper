/**
 * POST /api/admin/sync-details  (x-admin-secret required)
 *
 * Ingests the additive course-details data for a term: filter-option menus and
 * course-level catalog facts (academic college/department/grading/schedule).
 * Run AFTER /api/admin/sync has populated the term's sections — the catalog pass
 * enumerates the live course set from D1.
 *
 * Query params:
 *   - term=<code>     required.
 *   - filters=0       skip the filter-option pass.
 *   - catalog=0       skip the course-catalog pass.
 *   - sections=0      skip the per-CRN section-detail pass (the heaviest one).
 *   - instructors=0   skip the per-instructor contact-card pass.
 *   - delayMs=<n>     per-course / per-CRN / per-instructor throttle (default 250).
 *
 * Callers must send `Content-Type: application/json` (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/client";
import { syncDetails } from "@/lib/ingest/details";
import { checkAdmin, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  if (!term) return json({ error: "term is required" }, 400);

  const delayMs = Number(url.searchParams.get("delayMs") ?? "250");
  const filters = url.searchParams.get("filters") !== "0";
  const catalog = url.searchParams.get("catalog") !== "0";
  const sections = url.searchParams.get("sections") !== "0";
  const instructors = url.searchParams.get("instructors") !== "0";

  try {
    const result = await syncDetails(getDb(), term, {
      filters,
      catalog,
      sections,
      instructors,
      courseDelayMs: delayMs,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Details sync failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
