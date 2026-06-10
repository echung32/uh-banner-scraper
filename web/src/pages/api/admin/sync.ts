/**
 * POST /api/admin/sync  (x-admin-secret required)
 *
 * Triggers a Banner → D1 full sync. Query params:
 *   - term=<code>   sync exactly this term (used for one-off view-only backfill).
 *   - (omitted)     refresh the term list, then sync every non-view-only term.
 *   - delayMs=<n>   per-subject throttle (default 250; raise for big backfills).
 *
 * Runs inline; a full multi-subject term can take a while. On Workers this
 * becomes a Cron Trigger (docs/plans/workers-migration.md).
 *
 * Callers must send `Content-Type: application/json` so the request isn't
 * treated as a cross-site form POST by Astro's CSRF origin check, e.g.:
 *   curl -X POST '.../api/admin/sync?term=202730' \
 *     -H 'x-admin-secret: $ADMIN_SECRET' -H 'content-type: application/json'
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { refreshTerms } from "@/lib/ingest/terms";
import { syncTerm, type SyncResult } from "@/lib/ingest/sync";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  const delayMs = Number(url.searchParams.get("delayMs") ?? "250");
  const perSessionParam = url.searchParams.get("subjectsPerSession");
  const opts = {
    subjectDelayMs: delayMs,
    ...(perSessionParam ? { subjectsPerSession: Number(perSessionParam) } : {}),
  };
  const db = getDb();

  try {
    const results: SyncResult[] = [];

    if (term) {
      results.push(await syncTerm(db, term, opts));
    } else {
      // Refresh the term list, then sync all currently-searchable terms.
      await refreshTerms(db);
      const { results: terms } = await db
        .prepare("SELECT code FROM term WHERE is_view_only = 0")
        .all<{ code: string }>();
      for (const t of terms) {
        results.push(await syncTerm(db, t.code, opts));
      }
    }

    return json({ ok: true, results });
  } catch (err) {
    console.error("Sync failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
