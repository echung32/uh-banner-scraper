/**
 * POST /api/admin/refresh-seats  (x-admin-secret required)
 *
 * Global, rate-limited seat refresh for one term. Query params:
 *   - term=<code>      required.
 *   - subject=<code>   limit to one subject.
 *   - crns=a,b,c       limit to specific CRNs (takes precedence over subject).
 *   - max=<n>          safety cap on sections touched (default 100).
 *
 * Enforces a global cooldown via term.last_seat_refresh_at, so one user's
 * refresh updates everyone and refreshes are throttled against Banner.
 *
 * Callers must send `Content-Type: application/json` (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/client";
import { refreshSeats } from "@/lib/ingest/seatRefresh";
import { checkAdmin, json } from "@/lib/ingest/auth";

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export const POST: APIRoute = async ({ request }) => {
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term");
  if (!term) return json({ error: "term is required" }, 400);

  const db = getDb();

  // Cooldown check.
  const row = await db
    .prepare("SELECT last_seat_refresh_at AS at FROM term WHERE code = ?")
    .bind(term)
    .first<{ at: number | null }>();
  const last = row?.at ?? 0;
  const elapsed = Date.now() - last;
  if (last && elapsed < COOLDOWN_MS) {
    return json(
      { error: "cooldown", retryAfterMs: COOLDOWN_MS - elapsed },
      429
    );
  }

  const subject = url.searchParams.get("subject") ?? undefined;
  const crnsParam = url.searchParams.get("crns");
  const crns = crnsParam ? crnsParam.split(",").filter(Boolean) : undefined;
  const max = url.searchParams.get("max");

  try {
    const result = await refreshSeats(db, term, {
      subject,
      crns,
      maxSections: max ? Number(max) : undefined,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Seat refresh failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
