// Mock of the UH Banner SSB9 SIS server for end-to-end tests.
//
// It implements just enough of the handshake (see docs/walkthrough.md) for the
// web/ client to drive it without the live UH host, and — crucially — it
// faithfully reproduces Banner's *stateful search form*: search criteria are
// stored server-side per session and a search reuses the stored criteria unless
// the form is reset via POST /classSearch/resetDataForm first. That is the quirk
// that made the course-number filter appear broken on reused sessions.
//
// Run: node e2e/mock-sis-server.mjs   (PORT env optional, default 9999)

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_SIS_PORT ?? 9999);
const BASE = "/StudentRegistrationSsb";

const TOKEN_A = "tokenA-00000000-aaaa-aaaa-aaaa-000000000000";
const TOKEN_B = "tokenB-11111111-bbbb-bbbb-bbbb-111111111111";

// 202710 (Fall 2026) is used by the seeded read-path tests; 202730 (Spring 2026)
// is synced live from this mock by the ingestion test (ingest.spec.ts).
const TERMS = [
  { code: "202730", description: "Spring 2026" },
  { code: "202710", description: "Fall 2026" },
];

const SUBJECTS = [
  { code: "ICS", description: "Information & Computer Sciences" },
  { code: "MATH", description: "Mathematics" },
];

// Canonical filter-option menus, served by /ssb/classSearch/get_<kind>. Small
// fixtures keyed by kind; the details ingest persists these into filter_option.
const FILTER_OPTIONS = {
  campus: [
    { code: "MAN", description: "University of Hawaii at Manoa" },
    { code: "HIL", description: "University of Hawaii at Hilo" },
  ],
  college: [
    { code: "14", description: "College of Natural Sciences" },
    { code: "20", description: "College of Arts & Sciences" },
  ],
  department: [
    { code: "ICS", description: "Information & Computer Sciences" },
    { code: "MATH", description: "Mathematics" },
  ],
  instructionalMethod: [{ code: "INP", description: "In Person" }],
  attribute: [],
  partOfTerm: [{ code: "1", description: "Full Term" }],
  scheduleType: [{ code: "LEC", description: "Lecture" }],
  level: [{ code: "UG", description: "Undergraduate" }],
  session: [],
  building: [{ code: "POST", description: "Pacific Ocean Science & Tech" }],
};

// Course-level catalog fragment (mirrors getSectionCatalogDetails). College and
// department vary by subject so the ingest's per-course parse can be asserted.
function catalogHtml(subject) {
  const college =
    subject === "ICS"
      ? "MAN-College of Natural Sciences  14"
      : "MAN-College of Arts &amp; Sciences  20";
  const dept =
    subject === "ICS"
      ? "Information&amp; Computer Sciences  ICS"
      : "Mathematics  MATH";
  return `<section aria-labelledby="catalog">
    <span class="status-bold">Title:</span>Course Title<br/>
    <span class="status-bold">College:</span>
        <span>${college}</span>
        <br/>
    <span class="status-bold">Department:</span>
        <span>${dept}</span>
        <br/>
    <span class="status-bold">Hours:</span><br/>
    <span class="indent-left">Credit Hours:</span><span class="credit-hours-direction">3  </span><br/>
    <span class="status-bold">Grading Modes:</span>
    <div class="indent-left">Audit  A<br/>Letter Plus + Minus  G</div>
    <span class="status-bold">Schedule Types:</span>
    <div class="indent-left">Lecture  LEC</div>
  </section>`;
}

// A tiny catalog. `term` is filled in per request so the same catalog can be
// served for any requested term.
function section(crn, subject, courseNumber, sequenceNumber, title) {
  return {
    id: Number(crn),
    term: "",
    termDesc: null,
    courseReferenceNumber: crn,
    partOfTerm: "1",
    courseNumber,
    subject,
    subjectDescription:
      subject === "ICS" ? "Information & Computer Sciences" : "Mathematics",
    sequenceNumber,
    campusDescription: "Manoa",
    scheduleTypeDescription: "Lecture",
    courseTitle: title,
    creditHours: 3,
    creditHourLow: 3,
    creditHourHigh: null,
    maximumEnrollment: 40,
    enrollment: 30,
    seatsAvailable: 10,
    waitCapacity: 0,
    waitCount: 0,
    waitAvailable: 0,
    openSection: true,
    linkIdentifier: null,
    isSectionLinked: false,
    subjectCourse: `${subject} ${courseNumber}`,
    faculty: [],
    meetingsFaculty: [],
    reservedSeatSummary: null,
    sectionAttributes: [],
  };
}

// 6 ICS sections (2 are course number 111) + 3 MATH sections.
const CATALOG = [
  section("10001", "ICS", "111", "001", "Intro to Computer Science I"),
  section("10002", "ICS", "111", "002", "Intro to Computer Science I"),
  section("10003", "ICS", "141", "001", "Foundations I"),
  section("10004", "ICS", "211", "001", "Intro to Computer Science II"),
  section("10005", "ICS", "311", "001", "Algorithms"),
  section("10006", "ICS", "311", "002", "Algorithms"),
  section("20001", "MATH", "241", "001", "Calculus I"),
  section("20002", "MATH", "242", "001", "Calculus II"),
  section("20003", "MATH", "243", "001", "Calculus III"),
];

// One section has faculty so the instructor (contact-card) pass has a banner_id.
CATALOG.find((s) => s.courseReferenceNumber === "10005").faculty = [
  {
    bannerId: "9001",
    category: "01",
    courseReferenceNumber: "10005",
    displayName: "Jane Instructor",
    emailAddress: "jane@hawaii.edu",
    primaryIndicator: true,
    term: "",
  },
];

// 6 ICS sections (2 are course number 111) + 3 MATH sections — phase 1 baseline.
// Phase 2 differs: 10006 DROPPED, 10007 ADDED, 10003 has a changed title (structural),
// 10001 has only seat/enrollment counts changed (NOT structural).
const CATALOG_PHASE2 = [
  // 10001: seat-only change (enrollment 30→35, seatsAvailable 10→5); all structural fields same.
  { ...section("10001", "ICS", "111", "001", "Intro to Computer Science I"), maximumEnrollment: 40, enrollment: 35, seatsAvailable: 5 },
  section("10002", "ICS", "111", "002", "Intro to Computer Science I"),
  // 10003: structural change (course title differs).
  section("10003", "ICS", "141", "001", "Foundations I Revised"),
  section("10004", "ICS", "211", "001", "Intro to Computer Science II"),
  section("10005", "ICS", "311", "001", "Algorithms"),
  // 10006: DROPPED (was ICS 311 §002).
  // 10007: ADDED (new section).
  section("10007", "ICS", "321", "001", "Software Engineering"),
  section("20001", "MATH", "241", "001", "Calculus I"),
  section("20002", "MATH", "242", "001", "Calculus II"),
  section("20003", "MATH", "243", "001", "Calculus III"),
];

// Preserve the faculty entry on 10005 in phase 2 as well.
CATALOG_PHASE2.find((s) => s.courseReferenceNumber === "10005").faculty = [
  {
    bannerId: "9001",
    category: "01",
    courseReferenceNumber: "10005",
    displayName: "Jane Instructor",
    emailAddress: "jane@hawaii.edu",
    primaryIndicator: true,
    term: "",
  },
];

// Active catalog phase (1 = CATALOG, 2 = CATALOG_PHASE2).
let catalogPhase = 1;
const activeCatalog = () => (catalogPhase === 1 ? CATALOG : CATALOG_PHASE2);

// Per-session server-side state, keyed by JSESSIONID.
// storedCriteria === null means "fresh form" (just reset or just initialized).
const sessions = new Map();

function getSession(req) {
  const cookie = req.headers["cookie"] ?? "";
  const match = /JSESSIONID=([^;]+)/.exec(cookie);
  const id = match?.[1];
  if (!id) return null;
  if (!sessions.has(id)) sessions.set(id, { storedCriteria: null });
  return sessions.get(id);
}

function tokenPage(token) {
  return `<!doctype html><html><head><meta name="synchronizerToken" content="${token}"></head><body>ok</body></html>`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json;charset=UTF-8" });
  res.end(payload);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "text/html;charset=utf-8", ...extraHeaders });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname;

  // Health check used by Playwright's webServer readiness probe.
  if (path === "/health") return sendJson(res, 200, { ok: true });

  // Control endpoint: advance to catalog phase 2.
  if (req.method === "POST" && path === "/__mock/advance") {
    catalogPhase = 2;
    return sendJson(res, 200, { ok: true, phase: catalogPhase });
  }

  // Phase 1: termSelection — issue cookies + Token_A.
  if (path === "/ssb/term/termSelection") {
    const jsessionId = `mockjsession${sessions.size + 1}${PORT}`;
    sessions.set(jsessionId, { storedCriteria: null });
    res.setHeader("Set-Cookie", [
      `JSESSIONID=${jsessionId}; Path=${BASE}`,
      `BIGipServerPOOL_app=mockbigip; Path=/`,
    ]);
    return sendHtml(res, 200, tokenPage(TOKEN_A));
  }

  // Phase 3: lock the term into the session (redirect in the real server).
  if (path === "/ssb/term/search") {
    return sendHtml(res, 302, "redirect", { Location: `${BASE}/ssb/classSearch/classSearch` });
  }

  // Phase 4: classSearch — issue refreshed Token_B and initialize a fresh form.
  if (path === "/ssb/classSearch/classSearch") {
    const session = getSession(req);
    if (session) session.storedCriteria = null;
    return sendHtml(res, 200, tokenPage(TOKEN_B));
  }

  // Term autocomplete list.
  if (path === "/ssb/classSearch/getTerms") {
    return sendJson(res, 200, TERMS);
  }

  // Subject autocomplete list (ingestion enumerates this).
  if (path === "/ssb/classSearch/get_subject") {
    return sendJson(res, 200, SUBJECTS);
  }

  // Filter-option menus: /ssb/classSearch/get_<kind>.
  if (path.startsWith("/ssb/classSearch/get_")) {
    const kind = path.slice("/ssb/classSearch/get_".length);
    if (kind in FILTER_OPTIONS) return sendJson(res, 200, FILTER_OPTIONS[kind]);
  }

  // Class-details modal fragment (CRN-lookup live fallback). Echoes the section's
  // identity — CRN + the catalog course number — for the requested CRN; an
  // unknown CRN yields a fragment with no courseReferenceNumber (the "no such
  // section" signal parseClassDetails keys on).
  if (path === "/ssb/searchResults/getClassDetails") {
    const body = await readBody(req);
    const crn = new URLSearchParams(body).get("courseReferenceNumber") ?? "";
    const sec = activeCatalog().find((s) => s.courseReferenceNumber === crn);
    if (!sec) {
      return sendHtml(res, 200, `<section aria-labelledby="classDetails">No section found.</section>`);
    }
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="classDetails">
        <span class="status-bold">CRN:</span><span id="courseReferenceNumber">${sec.courseReferenceNumber}</span><br/>
        <span class="status-bold">Subject:</span><span id="subject">${sec.subjectDescription}</span><br/>
        <span class="status-bold">Course Number:</span>
        <span id="courseNumber" style="display:none;">${sec.courseNumber}0</span>
        <span id="courseDisplay">${sec.courseNumber}</span><br/>
        <span class="status-bold">Title:</span><span id="courseTitle">${sec.courseTitle}</span><br/>
      </section>`
    );
  }

  // Course-level catalog fragment (details ingest, per representative CRN).
  if (path === "/ssb/searchResults/getSectionCatalogDetails") {
    const body = await readBody(req);
    const crn = new URLSearchParams(body).get("courseReferenceNumber") ?? "";
    const subject = activeCatalog().find((s) => s.courseReferenceNumber === crn)?.subject ?? "ICS";
    return sendHtml(res, 200, catalogHtml(subject));
  }

  // Course-level text fragments (Slice 2 ingest).
  if (
    path === "/ssb/searchResults/getCourseDescription" ||
    path === "/ssb/searchResults/getSectionPrerequisites" ||
    path === "/ssb/searchResults/getCorequisites"
  ) {
    const body = await readBody(req);
    const crn = new URLSearchParams(body).get("courseReferenceNumber") ?? "";
    const sec = activeCatalog().find((s) => s.courseReferenceNumber === crn);
    if (path.endsWith("getCourseDescription")) {
      return sendHtml(
        res,
        200,
        `<section aria-labelledby="courseDescription">
          <!--display course description-->
          ${sec ? sec.courseTitle + ". An introductory course." : ""}
          <br/>
        </section>`
      );
    }
    if (path.endsWith("getSectionPrerequisites")) {
      // Only ICS 311 has prereqs, to exercise both branches.
      const hasPrereq = sec && sec.subject === "ICS" && sec.courseNumber === "311";
      return sendHtml(
        res,
        200,
        `<section aria-labelledby="preReqs"><h3>Catalog Prerequisites</h3>
          ${hasPrereq ? "<table><tbody><tr><td><pre>Prerequisites:ICS 211 Completed w/C grade</pre></td></tr></tbody></table>" : "No prerequisite information available."}
        </section>`
      );
    }
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="coReqs"><h3>Corequisites</h3>
        No corequisite course information available.
      </section>`
    );
  }

  // Section-level detail fragments (Slice 3 ingest).
  if (path === "/ssb/searchResults/getRestrictions") {
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="restrictions">
        <span class="status-bold">Must be enrolled in one of the following Campuses:</span><br/>
        <span class="detail-popup-indentation">University of Hawaii at Manoa (MAN)</span><br/>
      </section>`
    );
  }
  if (path === "/ssb/searchResults/getFees") {
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="fees"><table class="basePreqTable">
        <thead><tr><th>Level</th><th>Description</th><th>Amount</th></tr></thead>
        <tbody><tr><td></td><td>Course Fee</td><td class="courseFeeAmount">$50.00</td></tr></tbody>
      </table></section>`
    );
  }
  if (path === "/ssb/searchResults/getXlstSections") {
    const body = await readBody(req);
    const crn = new URLSearchParams(body).get("courseReferenceNumber") ?? "";
    // CRN 10001 (ICS 111 §001) is cross-listed with 10002.
    const rows = crn === "10001"
      ? "<tr><td>10002</td><td>ICS</td><td>111</td><td>Intro</td><td>002</td></tr>"
      : "";
    return sendHtml(
      res,
      200,
      rows
        ? `<section aria-labelledby="xlstSections"><table><tbody>${rows}</tbody></table></section>`
        : `<section aria-labelledby="xlstSections">No cross-list information available.</section>`
    );
  }
  if (path === "/ssb/searchResults/getLinkedSections") {
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="linked">No linked course information available.</section>`
    );
  }
  if (path === "/ssb/searchResults/getSectionBookstoreDetails") {
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="bookstore"><div class="indent-left">
        <a href="https://hawaii-manoa.verbacompare.com/" target="_blank">Manoa.Bookstore</a><br/>
      </div></section>`
    );
  }
  if (path === "/ssb/searchResults/getSyllabus") {
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="syllabus">No Syllabus Information Available</section>`
    );
  }

  // Instructor contact card (Slice 4 ingest) — GET ?bannerId=&termCode=.
  if (path === "/ssb/contactCard/retrieveData") {
    const bannerId = url.searchParams.get("bannerId") ?? "";
    // Mirrors the live shape: deptAndCollegeInformation is an array with a
    // nested college (and optional department), not a string.
    return sendJson(res, 200, {
      data: {
        personData: {
          displayName: "Jane Instructor",
          title: "Associate Professor",
          deptAndCollegeInformation: [
            {
              college: { code: "14", description: "MAN-College of Natural Sciences" },
              department: { description: "Information & Computer Sciences" },
            },
          ],
          email: "jane@hawaii.edu",
          telephone: null,
          address: null,
          bannerId,
        },
        message: "",
      },
    });
  }

  // Per-section enrollment fragment (seat refresh path). Returns live-ish seats
  // derived from the CRN so the refresh test can assert a changed value.
  if (path === "/ssb/searchResults/getEnrollmentInfo") {
    const body = await readBody(req);
    const crn = new URLSearchParams(body).get("courseReferenceNumber") ?? "0";
    const max = 40;
    const actual = 35; // differs from the seeded enrollment (30) so updates show
    const avail = max - actual;
    return sendHtml(
      res,
      200,
      `<section aria-labelledby="enrollmentInfo">
        <span class="status-bold">Enrollment Actual:</span> <span dir="ltr">${actual}</span><br/>
        <span class="status-bold">Enrollment Maximum:</span> <span dir="ltr">${max}</span><br/>
        <span class="status-bold">Enrollment Seats Available:</span> <span dir="ltr">${avail}</span><br/>
        <hr/>
        <span class="status-bold">Waitlist Capacity:</span> <span dir="ltr">0</span><br/>
        <span class="status-bold">Waitlist Actual:</span> <span dir="ltr">0</span><br/>
        <span class="status-bold">Waitlist Seats Available:</span> <span dir="ltr">0</span><br/>
      </section>`
    );
  }

  // Reset the server-side search form — the fix under test calls this.
  if (path === "/ssb/classSearch/resetDataForm") {
    const session = getSession(req);
    if (session) session.storedCriteria = null;
    return sendHtml(res, 200, "true");
  }

  // Search results — reproduces Banner's stateful form behavior.
  if (path === "/ssb/searchResults/searchResults") {
    const session = getSession(req) ?? { storedCriteria: null };
    const queryCriteria = {
      subject: url.searchParams.get("txt_subject") ?? "",
      courseNumber: url.searchParams.get("txt_courseNumber") ?? "",
    };

    // The quirk: only a fresh form reads the incoming query. A form that already
    // holds a prior search ignores the new params and replays the stored search.
    if (session.storedCriteria === null) {
      session.storedCriteria = queryCriteria;
    }
    const effective = session.storedCriteria;

    const term = url.searchParams.get("txt_term") ?? "202710";
    // An empty subject is a whole-term search (Banner returns every subject) —
    // this is what the demand-driven page cache uses for an "All Subjects" page.
    const data = activeCatalog().filter(
      (s) =>
        (!effective.subject || s.subject === effective.subject) &&
        (!effective.courseNumber || s.courseNumber === effective.courseNumber)
    ).map((s) => ({ ...s, term, termDesc: null }));

    const pageOffset = Number(url.searchParams.get("pageOffset") ?? "0");
    const pageMaxSize = Number(url.searchParams.get("pageMaxSize") ?? "10");
    return sendJson(res, 200, {
      success: true,
      totalCount: data.length,
      data: data.slice(pageOffset, pageOffset + pageMaxSize),
      pageOffset,
      pageMaxSize,
      sectionsFetchedCount: data.length,
      pathMode: "search",
    });
  }

  sendJson(res, 404, { error: `unmapped mock path: ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-sis] listening on http://127.0.0.1:${PORT}${BASE}`);
});
