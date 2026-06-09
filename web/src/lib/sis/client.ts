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

/**
 * The Banner `get_*` autocomplete kinds that back filter dropdowns. Each is
 * served at `/ssb/classSearch/get_<kind>` and returns `[{code, description}]`,
 * the same shape getSubjects parses. (`subject` is fetched separately by
 * getSubjects since the ingestion enumerates it.)
 */
export type FilterKind =
  | "campus"
  | "college"
  | "department"
  | "instructionalMethod"
  | "attribute"
  | "partOfTerm"
  | "scheduleType"
  | "level"
  | "session"
  | "building";

/** Fetches one canonical filter-option list for a term (Token_B). */
export async function getFilterOptions(
  session: SisSession,
  termCode: string,
  kind: FilterKind
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
    sisUrl(`/ssb/classSearch/get_${kind}?${params.toString()}`),
    {
      method: "GET",
      headers: commonHeaders(sessionCookieString(session), session.tokenB),
    }
  );

  if (!res.ok) {
    throw new Error(`get_${kind} failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as Array<{ code: string; description: string }>;
  return json.map((item) => ({ code: item.code, description: item.description }));
}

/**
 * Fetches the catalog-details HTML fragment for a section (Token_B). Despite the
 * "Section" in the Banner endpoint name, the payload is catalog-level (academic
 * College, Department, grading modes, catalog schedule types) — shared by every
 * section of the course. Returns the raw fragment; parsing lives in
 * `lib/sis/parse/catalogDetails`.
 */
export async function getCatalogDetails(
  session: SisSession,
  term: string,
  courseReferenceNumber: string
): Promise<string> {
  const body = new URLSearchParams({ term, courseReferenceNumber });

  const res = await fetch(sisUrl("/ssb/searchResults/getSectionCatalogDetails"), {
    method: "POST",
    headers: {
      ...commonHeaders(sessionCookieString(session), session.tokenB),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(
      `getSectionCatalogDetails failed: ${res.status} ${res.statusText}`
    );
  }

  return res.text();
}

/** Shared POST for the per-section detail fragments (term+CRN → HTML string). */
async function postSectionFragment(
  session: SisSession,
  term: string,
  courseReferenceNumber: string,
  endpoint: string
): Promise<string> {
  const body = new URLSearchParams({ term, courseReferenceNumber });
  const res = await fetch(sisUrl(`/ssb/searchResults/${endpoint}`), {
    method: "POST",
    headers: {
      ...commonHeaders(sessionCookieString(session), session.tokenB),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`${endpoint} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/** Course catalog description HTML fragment (parse with lib/sis/parse/text). */
export function getCourseDescription(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getCourseDescription");
}

/** Catalog prerequisites HTML fragment. */
export function getPrerequisites(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getSectionPrerequisites");
}

/** Corequisites HTML fragment. */
export function getCorequisites(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getCorequisites");
}

/** Enrollment restrictions HTML fragment. */
export function getRestrictions(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getRestrictions");
}

/** Course/lab fees HTML fragment. */
export function getFees(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getFees");
}

/** Cross-listed sibling sections HTML fragment. */
export function getCrossListSections(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getXlstSections");
}

/** Linked sections HTML fragment. */
export function getLinkedSections(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getLinkedSections");
}

/** Bookstore links HTML fragment. */
export function getBookstore(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getSectionBookstoreDetails");
}

/** Syllabus HTML fragment. */
export function getSyllabus(
  session: SisSession,
  term: string,
  crn: string
): Promise<string> {
  return postSectionFragment(session, term, crn, "getSyllabus");
}

export interface InstructorCard {
  bannerId: string;
  displayName: string | null;
  title: string | null;
  department: string | null;
  college: string | null;
  email: string | null;
  telephone: string | null;
  raw: unknown;
}

/**
 * Faculty contact card (Token_B, GET, JSON). Name/email overlap with the
 * section's `faculty[]`; the card adds title / department / college / phone when
 * present. NOTE: the live `bannerId` (from the section's `faculty[]`) must be
 * used — older ids 500. `deptAndCollegeInformation` is an array of objects (a
 * nested `college` + optional `department`), not a string.
 */
export async function getContactCard(
  session: SisSession,
  bannerId: string,
  termCode: string
): Promise<InstructorCard> {
  const params = new URLSearchParams({ bannerId, termCode });
  const res = await fetch(
    sisUrl(`/ssb/contactCard/retrieveData?${params.toString()}`),
    { method: "GET", headers: commonHeaders(sessionCookieString(session), session.tokenB) }
  );
  if (!res.ok) {
    throw new Error(`contactCard failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    data?: { personData?: Record<string, any> };
  };
  const p = json.data?.personData ?? {};
  const dci = Array.isArray(p.deptAndCollegeInformation)
    ? p.deptAndCollegeInformation[0]
    : null;
  const college = (dci?.college?.description as string) ?? null;
  const department =
    (dci?.department?.description as string) ??
    (typeof p.deptAndCollegeInformation === "string"
      ? (p.deptAndCollegeInformation as string)
      : null);
  return {
    bannerId: String(p.bannerId ?? bannerId),
    displayName: (p.displayName as string) ?? null,
    title: (p.title as string) ?? null,
    department,
    college,
    email: (p.email as string) ?? null,
    telephone: (p.telephone as string) ?? null,
    raw: p,
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
