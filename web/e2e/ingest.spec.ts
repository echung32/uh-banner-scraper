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

test("details sync persists filter options and course catalog", async ({ request }) => {
  const res = await request.post(`/api/admin/sync-details?term=${TERM}&delayMs=0`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  // 10 filter kinds attempted; ICS + MATH courses (5 distinct) catalogued.
  expect(body.courses).toBeGreaterThanOrEqual(5);

  // Filter-option menus are now server-driven from filter_option.
  const college = await request.get("/api/filters", {
    params: { term: TERM, kind: "college" },
  });
  expect(college.ok()).toBeTruthy();
  const colleges = (await college.json()).options as Array<{ code: string; description: string }>;
  expect(colleges).toContainEqual({ code: "14", description: "College of Natural Sciences" });

  // An unknown kind is rejected.
  const badKind = await request.get("/api/filters", { params: { term: TERM, kind: "bogus" } });
  expect(badKind.status()).toBe(400);

  // Course catalog: academic college/department parsed from getSectionCatalogDetails,
  // keyed by campus (mock sections are at "Manoa").
  const ics = await request.get("/api/course", {
    params: { term: TERM, campus: "Manoa", subject: "ICS", courseNumber: "111" },
  });
  expect(ics.ok()).toBeTruthy();
  const icsCatalog = await ics.json();
  expect(icsCatalog.campusDescription).toBe("Manoa");
  expect(icsCatalog.collegeName).toBe("College of Natural Sciences");
  expect(icsCatalog.collegeCode).toBe("14");
  expect(icsCatalog.department).toBe("Information& Computer Sciences");
  expect(icsCatalog.departmentCode).toBe("ICS");
  expect(icsCatalog.gradingModes).toContain("Audit  A");
  // Slice 2: course-level text. ICS 111 has a description, no prereqs/coreqs.
  expect(icsCatalog.description).toContain("introductory course");
  expect(icsCatalog.prerequisites).toBeNull();
  expect(icsCatalog.corequisites).toBeNull();

  // ICS 311 carries parsed prerequisites (the populated branch).
  const ics311 = await request.get("/api/course", {
    params: { term: TERM, campus: "Manoa", subject: "ICS", courseNumber: "311" },
  });
  expect((await ics311.json()).prerequisites).toContain("Prerequisites:ICS 211");

  // Slice 3: section-level detail. All 9 CRNs catalogued; CRN 10001 is cross-listed.
  expect(body.sectionDetails).toBe(9);
  const sect = await request.get("/api/section", { params: { term: TERM, crn: "10001" } });
  expect(sect.ok()).toBeTruthy();
  const detail = await sect.json();
  expect(detail.crossListCrns).toEqual(["10002"]);
  expect(detail.fees[0].amount).toBe("$50.00");
  expect(detail.restrictions[0].category).toBe("Campuses");
  expect(detail.linkedCrns).toBeNull();
  expect(detail.syllabus).toBeNull();

  // Slice 4: instructor contact card (CRN 10005 has faculty banner_id 9001).
  expect(body.instructors).toBe(1);
  const instr = await request.get("/api/instructor", { params: { bannerId: "9001" } });
  expect(instr.ok()).toBeTruthy();
  const card = await instr.json();
  expect(card.title).toBe("Associate Professor");
  expect(card.department).toBe("Information & Computer Sciences");
  expect(card.college).toBe("MAN-College of Natural Sciences");

  // Wrong campus for an existing course is a 404 (campus is part of the key).
  const wrongCampus = await request.get("/api/course", {
    params: { term: TERM, campus: "University of Hawaii at Hilo", subject: "ICS", courseNumber: "111" },
  });
  expect(wrongCampus.status()).toBe(404);

  // A course we never ingested is a 404.
  const missing = await request.get("/api/course", {
    params: { term: TERM, campus: "Manoa", subject: "ICS", courseNumber: "999" },
  });
  expect(missing.status()).toBe(404);
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
