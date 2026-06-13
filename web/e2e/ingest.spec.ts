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

test("backfilled term exposes a data-freshness summary and per-window grid", async ({ request }) => {
  // 202730 is fully backfilled (above), so coverage reports data freshness
  // (mode "backfill", everything present) rather than cached-vs-not. The grid is
  // derived on the fly from course_section.synced_at — no search_chunk rows.
  const search = await request.get("/api/search", {
    params: { term: TERM, subject: "ICS", pageMaxSize: "50" },
  });
  const cov = (await search.json()).coverage;
  expect(cov).toMatchObject({
    mode: "backfill",
    dynamic: false,
    chunkSize: 50,
    totalChunks: 1,
    cachedChunks: 1,
    cachedCount: 6,
  });

  const detail = await request.get("/api/coverage", { params: { term: TERM, subject: "ICS" } });
  expect(detail.ok()).toBeTruthy();
  const body = await detail.json();
  expect(body).toMatchObject({ mode: "backfill", dynamic: false, totalCount: 6, totalChunks: 1 });
  expect(body.chunks).toHaveLength(1);
  expect(body.chunks[0]).toMatchObject({ index: 0, count: 6 });
  expect(body.chunks[0].oldestSyncedAt).toBeGreaterThan(0);
  expect(body.chunks[0].newestSyncedAt).toBeGreaterThanOrEqual(body.chunks[0].oldestSyncedAt);
  expect(typeof body.lastSyncedAt).toBe("number");

  // Window counts reconstruct the full result set (all-subjects = 9 sections).
  const all = await request.get("/api/coverage", { params: { term: TERM } });
  const allBody = await all.json();
  expect(allBody.chunks.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(9);
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

test("CRN search on a dynamic term fetches the section live, then from D1", async ({ request }) => {
  // 202740 is dynamic and still empty at this point (the page-cache test below is
  // what first populates it). A CRN search must therefore miss D1, fetch the
  // single section live from Banner via the class-details → course-number-scoped
  // searchResults fallback, store it, and return exactly that one section.
  const DYN = "202740";
  const hit = await request.get("/api/search", { params: { term: DYN, crn: "20001" } });
  expect(hit.ok()).toBeTruthy();
  const body = await hit.json();
  expect(body.totalCount).toBe(1);
  expect(body.data[0].courseReferenceNumber).toBe("20001");
  expect(body.data[0].subjectCourse).toBe("MATH 241");

  // A CRN that doesn't exist in the term returns no section (getClassDetails
  // reports no such section, so the fallback gives up cleanly).
  const miss = await request.get("/api/search", { params: { term: DYN, crn: "99999" } });
  expect((await miss.json()).totalCount).toBe(0);
});

test("page cache serves a dynamic term from Banner, then from D1", async ({ request }) => {
  // 202740 is seeded dynamic (last_synced_at NULL) with no sections. An
  // "All Subjects" search must fetch the whole-term page live from Banner (the
  // mock returns every subject for an empty txt_subject), store it, and assemble
  // the page from the cache. This is the regression guard for the original bug:
  // a subject-less search on a not-yet-backfilled term returned nothing.
  const DYN = "202740";
  expect(await searchCount(request, { term: DYN, pageMaxSize: "50" })).toBe(9); // 6 ICS + 3 MATH

  // A subject-scoped page on the same dynamic term (a distinct cache key).
  expect(await searchCount(request, { term: DYN, subject: "ICS", pageMaxSize: "50" })).toBe(6);

  // Revisiting the all-subjects page is served from the cache and is consistent;
  // the sections are now durably in D1 and individually searchable.
  expect(await searchCount(request, { term: DYN, pageMaxSize: "50" })).toBe(9);
  expect(await searchCount(request, { term: DYN, subject: "MATH", pageMaxSize: "50" })).toBe(3);

  // The search response carries a cache-coverage summary for a dynamic term, and
  // /api/coverage reports the windows now cached for that sort + filters. With 9
  // all-subjects sections in one 50-section window, the term is fully covered.
  const search = await request.get("/api/search", { params: { term: DYN, pageMaxSize: "50" } });
  const cov = (await search.json()).coverage;
  expect(cov).toMatchObject({ dynamic: true, chunkSize: 50, totalChunks: 1, cachedChunks: 1, cachedCount: 9 });

  const detail = await request.get("/api/coverage", { params: { term: DYN } });
  expect(detail.ok()).toBeTruthy();
  const detailBody = await detail.json();
  expect(detailBody).toMatchObject({ dynamic: true, totalCount: 9, totalChunks: 1 });
  expect(detailBody.chunks).toHaveLength(1);
  expect(detailBody.chunks[0]).toMatchObject({ index: 0, count: 9 });
  expect(detailBody.chunks[0].fetchedAt).toBeGreaterThan(0);
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

  // Capture the window's freshness before the refresh (currently the full-sync time).
  const covBefore = await (
    await request.get("/api/coverage", { params: { term: TERM, subject: "ICS" } })
  ).json();
  const newestBefore = covBefore.chunks[0].newestSyncedAt as number;

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

  // The per-CRN synced_at bump from the seat refresh surfaces in the freshness grid.
  const covAfter = await (
    await request.get("/api/coverage", { params: { term: TERM, subject: "ICS" } })
  ).json();
  expect(covAfter.chunks[0].newestSyncedAt).toBeGreaterThan(newestBefore);

  // A second refresh within the cooldown window is rejected.
  const again = await request.post(`/api/admin/refresh-seats?term=${TERM}&subject=ICS`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(again.status()).toBe(429);
});

// The mock's control port — matches MOCK_SIS_PORT in playwright.config.ts.
const MOCK_ORIGIN = "http://127.0.0.1:9999";

test("scheduled refresh: diff-driven detail re-fetch (Tier B1)", async ({ request }) => {
  // Advance the mock catalog to phase 2:
  //   DROPPED: 10006 (ICS 311 §002)
  //   ADDED:   10007 (ICS 321 §001 "Software Engineering")
  //   STRUCTURAL change: 10003 (ICS 141 title → "Foundations I Revised")
  //   SEAT-ONLY change:  10001 (enrollment 30→35, seatsAvailable 10→5; no structural diff)
  const advance = await request.post(`${MOCK_ORIGIN}/__mock/advance`);
  expect(advance.ok()).toBeTruthy();

  // Run the scheduled refresh scoped to TERM (skips refreshTerms; uses the
  // last_details_synced_at seeded in global-setup so B2 does NOT fire here).
  const run = await request.post(`/api/admin/refresh-run?term=${TERM}&delayMs=0`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(run.ok()).toBeTruthy();
  const body = await run.json();
  expect(body.ok).toBe(true);

  const summary = body.terms.find((t: { term: string }) => t.term === TERM);
  expect(summary).toBeDefined();

  // Diff classification.
  expect(summary.newCrns).toContain("10007");
  expect(summary.droppedCrns).toContain("10006");
  expect(summary.structuralCrns).toContain("10003");
  // Seat-only CRN 10001 must NOT appear in structuralCrns.
  expect(summary.structuralCrns).not.toContain("10001");

  // Tier B1 re-fetches details for new + structural only.
  const fetched = [...summary.detailFetchedCrns].sort();
  expect(fetched).toEqual(["10003", "10007"].sort());

  // B2 must NOT have fired (last_details_synced_at is fresh).
  expect(summary.detailsFullPass).toBe(false);

  // Tier A delta-write counts: 1 new (10007), 1 structural (10003), 3 seat-only
  // (10002/10004/10005 — the preceding seat-refresh wrote enrollment:35/seats:5
  // for those, but phase-2 carries the original enrollment:30/seats:10, so they
  // now differ seat-only vs stored; 10001 matches stored exactly because phase-2
  // explicitly sets enrollment:35/seats:5 matching the seat-refresh values);
  // 1 deleted (10006); 4 unchanged (10001 + 20001/02/03).
  expect(summary.writes).toEqual({ inserted: 1, structural: 1, seatUpdated: 3, deleted: 1, unchanged: 4 });

  // Section counts reflect the add/drop: still 6 ICS (10001-10005 + 10007) + 3 MATH.
  expect(
    await searchCount(request, { term: TERM, subject: "ICS", pageMaxSize: "50" })
  ).toBe(6);
  expect(
    await searchCount(request, { term: TERM, subject: "MATH", pageMaxSize: "50" })
  ).toBe(3);

  // New CRN 10007 is now searchable.
  const newSect = await request.get("/api/section", { params: { term: TERM, crn: "10007" } });
  expect(newSect.ok()).toBeTruthy();

  // Dropped CRN 10006 is gone from D1.
  const droppedSect = await request.get("/api/section", { params: { term: TERM, crn: "10006" } });
  expect(droppedSect.status()).toBe(404);
});

test("scheduled refresh: stale details trigger a full pass (Tier B2)", async ({ request }) => {
  // Provide a clock 8 days ahead of the current real time so the staleness check
  // (>7 days) fires regardless of when last_details_synced_at was last written
  // (the "details sync" test above calls syncDetails unscoped, which updates
  // last_details_synced_at to Date.now() — so we must use a fakeNow relative to
  // the real clock, not the seeded SYNCED epoch).
  const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
  const fakeNow = Date.now() + EIGHT_DAYS_MS;

  // The mock is already at phase 2 from the previous test; that's fine — we only
  // care that the full-pass flag fires and touches every CRN.
  const run = await request.post(
    `/api/admin/refresh-run?term=${TERM}&delayMs=0&now=${fakeNow}`,
    { headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" } }
  );
  expect(run.ok()).toBeTruthy();
  const body = await run.json();
  expect(body.ok).toBe(true);

  const summary = body.terms.find((t: { term: string }) => t.term === TERM);
  expect(summary).toBeDefined();
  expect(summary.detailsFullPass).toBe(true);

  // Core proof of the optimization: the mock is still at phase 2, which is
  // identical to what B1 already stored → Tier A writes NOTHING, all 9 sections
  // are byte-identical to the stored rows.
  expect(summary.writes).toEqual({ inserted: 0, structural: 0, seatUpdated: 0, deleted: 0, unchanged: 9 });

  // An unchanged CRN that was never in any diff (10002 = ICS 111 §002) should
  // now have a section_detail row, proving the full pass ran over every CRN.
  const unchanged = await request.get("/api/section", {
    params: { term: TERM, crn: "10002" },
  });
  expect(unchanged.ok()).toBeTruthy();
});
