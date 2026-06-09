import type {
  AutocompleteItem,
  CourseSection,
  SearchParams,
  SearchResultsResponse,
  SisSession,
} from "./types";
import {
  buildCookieHeader,
  extractSynchronizerToken,
  generateUniqueSessionId,
  parseCookies,
} from "./utils";

const SIS_BASE =
  process.env.SIS_BASE_URL ??
  "https://www.sis.hawaii.edu:9234/StudentRegistrationSsb";

function sisUrl(path: string): string {
  return `${SIS_BASE}${path}`;
}

function commonHeaders(cookieHeader: string, token: string): HeadersInit {
  return {
    Cookie: cookieHeader,
    "x-synchronizer-token": token,
    Accept: "application/json, text/html, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  };
}

export async function establishSession(termCode: string): Promise<SisSession> {
  const uniqueSessionId = generateUniqueSessionId();

  // Phase 1: GET termSelection → cookies + Token_A
  const phase1Res = await fetch(
    sisUrl("/ssb/term/termSelection?mode=search"),
    {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    }
  );

  if (!phase1Res.ok) {
    throw new Error(`Phase 1 failed: ${phase1Res.status} ${phase1Res.statusText}`);
  }

  const cookieJar = parseCookies(phase1Res.headers);
  const phase1Html = await phase1Res.text();
  const tokenA = extractSynchronizerToken(phase1Html);

  const jsessionId = cookieJar.get("JSESSIONID") ?? "";
  // BIGip cookie name contains the server pool name
  let bigipCookie = "";
  for (const [name, value] of cookieJar.entries()) {
    if (name.startsWith("BIGipServer")) {
      bigipCookie = `${name}=${value}`;
      break;
    }
  }

  // Build cookie header (JSESSIONID + BIGip)
  const cookieString = bigipCookie
    ? `JSESSIONID=${jsessionId}; ${bigipCookie}`
    : `JSESSIONID=${jsessionId}`;

  // Phase 3: POST term/search to lock term into session
  const phase3Body = new URLSearchParams({
    term: termCode,
    uniqueSessionId,
    studyPath: "",
    studyPathText: "",
    startDatepicker: "",
    endDatepicker: "",
  });

  const phase3Res = await fetch(sisUrl("/ssb/term/search?mode=search"), {
    method: "POST",
    redirect: "manual",
    headers: {
      ...commonHeaders(cookieString, tokenA),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: phase3Body.toString(),
  });

  // Absorb any new cookies from Phase 3 redirect response
  const phase3Cookies = parseCookies(phase3Res.headers);
  for (const [name, value] of phase3Cookies.entries()) {
    cookieJar.set(name, value);
  }

  // Rebuild cookie string after possible updates
  const updatedJsessionId = cookieJar.get("JSESSIONID") ?? jsessionId;
  let updatedBigip = bigipCookie;
  for (const [name, value] of cookieJar.entries()) {
    if (name.startsWith("BIGipServer")) {
      updatedBigip = `${name}=${value}`;
      break;
    }
  }
  const updatedCookieString = updatedBigip
    ? `JSESSIONID=${updatedJsessionId}; ${updatedBigip}`
    : `JSESSIONID=${updatedJsessionId}`;

  // Phase 4: GET classSearch to obtain Token_B
  const phase4Res = await fetch(sisUrl("/ssb/classSearch/classSearch"), {
    method: "GET",
    redirect: "follow",
    headers: {
      ...commonHeaders(updatedCookieString, tokenA),
      Accept: "text/html",
    },
  });

  if (!phase4Res.ok) {
    throw new Error(`Phase 4 failed: ${phase4Res.status} ${phase4Res.statusText}`);
  }

  const phase4Html = await phase4Res.text();
  const tokenB = extractSynchronizerToken(phase4Html);

  return {
    jsessionId: updatedJsessionId,
    bigipCookie: updatedBigip,
    tokenA,
    tokenB,
    uniqueSessionId,
    termCode,
    establishedAt: Date.now(),
  };
}

function sessionCookieString(session: SisSession): string {
  return session.bigipCookie
    ? `JSESSIONID=${session.jsessionId}; ${session.bigipCookie}`
    : `JSESSIONID=${session.jsessionId}`;
}

/**
 * Clears the server-side search form state for the session.
 *
 * Banner SSB9 stores the previous search's criteria server-side; a pooled
 * session (see session.ts) therefore "remembers" the last search. Without this
 * reset, a subsequent search reuses the stale criteria and silently ignores
 * changed filters such as `txt_courseNumber`. The real UI issues this same
 * `POST /classSearch/resetDataForm` before every fresh search (see
 * scripts/intercepted_calls.json). Returns the literal string `"true"`.
 */
export async function resetSearchForm(session: SisSession): Promise<void> {
  const res = await fetch(sisUrl("/ssb/classSearch/resetDataForm"), {
    method: "POST",
    headers: commonHeaders(sessionCookieString(session), session.tokenB),
  });

  if (!res.ok) {
    throw new Error(`resetDataForm failed: ${res.status} ${res.statusText}`);
  }
}

export async function getTerms(
  session: Pick<SisSession, "jsessionId" | "bigipCookie" | "tokenA" | "uniqueSessionId">
): Promise<AutocompleteItem[]> {
  const cookieStr = session.bigipCookie
    ? `JSESSIONID=${session.jsessionId}; ${session.bigipCookie}`
    : `JSESSIONID=${session.jsessionId}`;

  const params = new URLSearchParams({
    searchTerm: "",
    offset: "1",
    max: "100",
    uniqueSessionId: session.uniqueSessionId,
    _: String(Date.now()),
  });

  const res = await fetch(
    sisUrl(`/ssb/classSearch/getTerms?${params.toString()}`),
    {
      method: "GET",
      headers: commonHeaders(cookieStr, session.tokenA),
    }
  );

  if (!res.ok) {
    throw new Error(`getTerms failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as Array<{ code: string; description: string }>;
  return json.map((item) => ({ code: item.code, description: item.description }));
}

/**
 * Lists all subjects for the session's locked term — the enumeration source the
 * ingestion job iterates (Banner requires a subject per search). Same empty
 * `searchTerm` + large `max` autocomplete pattern as getTerms, but on the
 * classSearch page so it uses Token_B.
 */
export async function getSubjects(
  session: SisSession,
  termCode: string
): Promise<AutocompleteItem[]> {
  const params = new URLSearchParams({
    searchTerm: "",
    term: termCode,
    offset: "1",
    max: "500",
    uniqueSessionId: session.uniqueSessionId,
    _: String(Date.now()),
  });

  const res = await fetch(
    sisUrl(`/ssb/classSearch/get_subject?${params.toString()}`),
    {
      method: "GET",
      headers: commonHeaders(sessionCookieString(session), session.tokenB),
    }
  );

  if (!res.ok) {
    throw new Error(`getSubjects failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as Array<{ code: string; description: string }>;
  return json.map((item) => ({ code: item.code, description: item.description }));
}

export interface EnrollmentInfo {
  enrollment: number;
  maximumEnrollment: number;
  seatsAvailable: number;
  waitCapacity: number;
  waitCount: number;
  waitAvailable: number;
}

function parseEnrollmentField(text: string, label: string): number {
  const match = new RegExp(`${label}:\\s*</span>\\s*<span[^>]*>\\s*(-?\\d+)`, "i").exec(text);
  return match ? Number(match[1]) : 0;
}

/**
 * Fetches live seat / waitlist counts for a single section. Banner returns an
 * HTML fragment (not JSON), so the numbers are parsed out by label. Used by the
 * seat-refresh path to update counts without a full catalog scrape.
 */
export async function getEnrollmentInfo(
  session: SisSession,
  term: string,
  courseReferenceNumber: string
): Promise<EnrollmentInfo> {
  const body = new URLSearchParams({ term, courseReferenceNumber });

  const res = await fetch(sisUrl("/ssb/searchResults/getEnrollmentInfo"), {
    method: "POST",
    headers: {
      ...commonHeaders(sessionCookieString(session), session.tokenB),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`getEnrollmentInfo failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return {
    enrollment: parseEnrollmentField(html, "Enrollment Actual"),
    maximumEnrollment: parseEnrollmentField(html, "Enrollment Maximum"),
    seatsAvailable: parseEnrollmentField(html, "Enrollment Seats Available"),
    waitCapacity: parseEnrollmentField(html, "Waitlist Capacity"),
    waitCount: parseEnrollmentField(html, "Waitlist Actual"),
    waitAvailable: parseEnrollmentField(html, "Waitlist Seats Available"),
  };
}

export async function searchCourses(
  session: SisSession,
  params: SearchParams
): Promise<SearchResultsResponse> {
  const cookieStr = sessionCookieString(session);

  // Banner retains the prior search's criteria server-side on a reused session,
  // so clear the form first or changed filters (e.g. course number) are ignored.
  await resetSearchForm(session);

  const query = new URLSearchParams({
    txt_term: params.term,
    txt_subject: params.subject,
    uniqueSessionId: session.uniqueSessionId,
    pageOffset: String(params.pageOffset),
    pageMaxSize: String(params.pageMaxSize),
    sortColumn: params.sortColumn ?? "subjectDescription",
    sortDirection: params.sortDirection ?? "asc",
    _: String(Date.now()),
  });

  if (params.courseNumber) {
    query.set("txt_courseNumber", params.courseNumber);
  }
  if (params.openOnly) {
    query.set("chk_open_only", "true");
  }

  const res = await fetch(
    sisUrl(`/ssb/searchResults/searchResults?${query.toString()}`),
    {
      method: "GET",
      headers: commonHeaders(cookieStr, session.tokenB),
    }
  );

  if (!res.ok) {
    throw new Error(`searchCourses failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<SearchResultsResponse>;
}
