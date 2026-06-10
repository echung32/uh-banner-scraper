/**
 * Guards the Banner-facing /api/admin/* routes. Fails closed: if ADMIN_SECRET is
 * unset, or the `x-admin-secret` header doesn't match, the request is rejected.
 */
export function checkAdmin(request: Request): Response | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return json({ error: "ADMIN_SECRET is not configured" }, 503);
  }
  if (request.headers.get("x-admin-secret") !== expected) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/**
 * The heavy admin ingestion routes (full-catalog sync / details) can run for
 * minutes — far past the Workers CPU limit — so production ingestion runs from
 * the Node CLI (`scripts/ingest.ts`) against the same D1. On the deployed Worker
 * these routes are disabled (501); the e2e suite sets INGEST_ON_WORKER=1 to
 * exercise them against the tiny mock catalog (no real CPU pressure).
 */
export function ingestDisabledOnWorker(): Response | null {
  if (process.env.INGEST_ON_WORKER === "1") return null;
  return json(
    {
      error: "ingestion is disabled on the Worker; run the Node CLI (yarn ingest)",
    },
    501
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
