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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
