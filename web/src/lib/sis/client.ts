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
