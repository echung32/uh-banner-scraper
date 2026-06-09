import { test, expect, type APIRequestContext } from "@playwright/test";

// Exercises the Banner-facing ingestion path end-to-end: the admin sync route
// drives the mock SIS server (handshake → subjects → paginated searchResults)
// and writes to the same local D1 the read path serves from. Uses term 202730,
// disjoint from the seeded read-path term (202710), so it can run in parallel.
//
// This is also the reset-quirk regression guard: the sync reuses ONE session
// across both subjects (ICS then MATH). If searchCourses stopped calling
// resetDataForm, the second subject would replay the first's criteria and MATH
// would come back empty (and ICS CRNs would collide), so MATH === 3 below fails.

const ADMIN_SECRET = "e2e-admin-secret";
const TERM = "202730";

async function searchCount(
  request: APIRequestContext,
  params: Record<string, string>
): Promise<number> {
  const res = await request.get("/api/search", { params });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).totalCount as number;
}

test.describe.configure({ mode: "serial" });

test("admin sync ingests the mock catalog into D1", async ({ request }) => {
  const res = await request.post(`/api/admin/sync?term=${TERM}`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);

  // 6 ICS sections + 3 MATH sections were ingested (reset quirk preserved).
  expect(await searchCount(request, { term: TERM, subject: "ICS", pageMaxSize: "50" })).toBe(6);
  expect(await searchCount(request, { term: TERM, subject: "MATH", pageMaxSize: "50" })).toBe(3);

  // Course-number filter works via SQL.
  expect(
    await searchCount(request, { term: TERM, subject: "ICS", courseNumber: "111", pageMaxSize: "50" })
  ).toBe(2);
});

test("admin sync rejects requests without the secret", async ({ request }) => {
  const res = await request.post(`/api/admin/sync?term=${TERM}`, {
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(401);
});

test("seat refresh updates stored seat counts", async ({ request }) => {
  const before = await request.get("/api/search", {
    params: { term: TERM, subject: "ICS", pageMaxSize: "50" },
  });
  expect((await before.json()).data[0].seatsAvailable).toBe(10);

  const refresh = await request.post(`/api/admin/refresh-seats?term=${TERM}&subject=ICS`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(refresh.ok()).toBeTruthy();
  expect((await refresh.json()).refreshed).toBe(6);

  // The mock reports 5 seats available (40 max − 35 enrolled).
  const after = await request.get("/api/search", {
    params: { term: TERM, subject: "ICS", pageMaxSize: "50" },
  });
  expect((await after.json()).data[0].seatsAvailable).toBe(5);

  // A second refresh within the cooldown window is rejected.
  const again = await request.post(`/api/admin/refresh-seats?term=${TERM}&subject=ICS`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(again.status()).toBe(429);
});
