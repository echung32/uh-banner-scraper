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

const TERMS = [{ code: "202710", description: "Fall 2026" }];

// A tiny ICS catalog: 6 sections total, of which 2 are course number 111.
function section(crn, courseNumber, sequenceNumber, title) {
  return {
    id: Number(crn),
    term: "202710",
    termDesc: "Fall 2026",
    courseReferenceNumber: crn,
    partOfTerm: "1",
    courseNumber,
    subject: "ICS",
    subjectDescription: "Information & Computer Sciences",
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
    subjectCourse: `ICS ${courseNumber}`,
    faculty: [],
    meetingsFaculty: [],
    reservedSeatSummary: null,
    sectionAttributes: [],
  };
}

const CATALOG = [
  section("10001", "111", "001", "Intro to Computer Science I"),
  section("10002", "111", "002", "Intro to Computer Science I"),
  section("10003", "141", "001", "Foundations I"),
  section("10004", "211", "001", "Intro to Computer Science II"),
  section("10005", "311", "001", "Algorithms"),
  section("10006", "311", "002", "Algorithms"),
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

const server = createServer((req, res) => {
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

    const data = CATALOG.filter(
      (s) =>
        s.subject === effective.subject &&
        (!effective.courseNumber || s.courseNumber === effective.courseNumber)
    );

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
