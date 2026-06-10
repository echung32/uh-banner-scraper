/**
 * POST /api/admin/refresh-terms  (x-admin-secret required)
 *
 * Populates the `term` table with EVERY Banner term (one cheap getTerms call) —
 * descriptions, view-only flags, display order — WITHOUT backfilling any section
 * data. Terms that aren't eagerly synced are filled in lazily, per subject, on
 * first search (lib/ingest/dynamicSync). Idempotent (upsert by code).
 *
 * Send `Content-Type: application/json` so Astro's CSRF origin check doesn't
 * reject it, e.g.:
 *   curl -X POST '.../api/admin/refresh-terms' \
 *     -H 'x-admin-secret: $ADMIN_SECRET' -H 'content-type: application/json'
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/client";
import { refreshTerms } from "@/lib/ingest/terms";
import { checkAdmin, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const denied = checkAdmin(request);
  if (denied) return denied;

  try {
    const terms = await refreshTerms(getDb());
    return json({ ok: true, terms: terms.length });
  } catch (err) {
    console.error("Term refresh failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
