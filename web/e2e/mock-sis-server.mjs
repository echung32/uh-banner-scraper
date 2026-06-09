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
    const data = CATALOG.filter(
      (s) =>
        s.subject === effective.subject &&
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
