/**
 * POST /api/admin/refresh-run  (x-admin-secret required)
 *
 * Runs the scheduled metadata refresh (docs/plans/scheduled-refresh.md) on
 * demand — Tier A full sync + Tier B1 diff-driven details + Tier B2 weekly
 * safety net. The hourly RefreshWorkflow runs the same refreshMutableTerms()
 * on the Worker; this route is the manual / e2e entry point.
 *
 * Query params (all optional):
 *   - term=<code>   restrict to one term (also skips the leading refreshTerms).
 *   - delayMs=<n>   per-subject / per-course delay (default 0 here; the Workflow
 *                   uses a polite non-zero delay).
 *   - now=<ms>      override "now" for the Tier B2 staleness check (e2e only) —
 *                   lets a test force the >7-day full-details boundary.
 *
 * Callers must send `Content-Type: application/json` (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { refreshMutableTerms } from "@/lib/ingest/refresh";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;
  const delayMs = url.searchParams.get("delayMs");
  const delay = delayMs != null ? Number(delayMs) : 0;
  const nowParam = url.searchParams.get("now");
  const now = nowParam != null ? Number(nowParam) : undefined;

  try {
    const result = await refreshMutableTerms(getDb(), {
      terms: term ? [term] : undefined,
      skipTermRefresh: !!term,
      subjectDelayMs: delay,
      courseDelayMs: delay,
      now,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Refresh run failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
