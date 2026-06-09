// Live verification of the per-course grain assumption (docs/plans/course-details.md).
//
// The detail endpoints are all keyed by courseReferenceNumber (CRN). This script
// fetches the catalog/description/prereq/coreq fragments for MULTIPLE CRNs of the
// SAME course and diffs them, to confirm whether per-course dedup is safe (and
// whether the description endpoint carries section-specific overrides).
//
// Standalone (no app / PnP): replicates the handshake from src/lib/sis/client.ts
// with plain fetch. Run:  node scripts/verify-per-course.mjs [TERM] [SUBJECT] [COURSE]
//
// Hits the LIVE UH SIS — run only when Banner is up.

const BASE =
  process.env.SIS_BASE_URL ??
  "https://www.sis.hawaii.edu:9234/StudentRegistrationSsb";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const TERM = process.argv[2] ?? "202710";
const SUBJECT = process.argv[3] ?? "ICS";
const COURSE = process.argv[4] ?? "111";

const url = (p) => `${BASE}${p}`;
const headers = (cookie, token) => ({
  Cookie: cookie,
  "x-synchronizer-token": token,
  Accept: "application/json, text/html, */*",
  "User-Agent": UA,
});

function token(html) {
  const m =
    /name="synchronizerToken"[^>]*content="([^"]*)"/.exec(html) ??
    /content="([^"]*)"[^>]*name="synchronizerToken"/.exec(html);
  if (!m) throw new Error("synchronizerToken not found");
  return m[1];
}
function uniqueSessionId() {
  return "h3if" + Math.floor(Math.random() * 1e14).toString().padStart(14, "0");
}
function parseSetCookies(res) {
  const jar = new Map();
  const list = res.headers.getSetCookie?.() ?? [];
  for (const raw of list) {
    const [pair] = raw.split(";");
    const i = pair.indexOf("=");
    if (i === -1) continue;
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return jar;
}
function cookieStr(jar) {
  const js = jar.get("JSESSIONID") ?? "";
  let big = "";
  for (const [n, v] of jar) if (n.startsWith("BIGipServer")) { big = `${n}=${v}`; break; }
  return big ? `JSESSIONID=${js}; ${big}` : `JSESSIONID=${js}`;
}

async function establish(term) {
  const usid = uniqueSessionId();
  const p1 = await fetch(url("/ssb/term/termSelection?mode=search"), {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  const jar = parseSetCookies(p1);
  const tokenA = token(await p1.text());

  const body = new URLSearchParams({
    term, uniqueSessionId: usid, studyPath: "", studyPathText: "",
    startDatepicker: "", endDatepicker: "",
  });
  const p3 = await fetch(url("/ssb/term/search?mode=search"), {
    method: "POST", redirect: "manual",
    headers: { ...headers(cookieStr(jar), tokenA), "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  for (const [n, v] of parseSetCookies(p3)) jar.set(n, v);

  const p4 = await fetch(url("/ssb/classSearch/classSearch"), {
    headers: { ...headers(cookieStr(jar), tokenA), Accept: "text/html" },
  });
  const tokenB = token(await p4.text());
  return { jar, tokenA, tokenB, usid };
}

async function search(s, term, subject, course) {
  await fetch(url("/ssb/classSearch/resetDataForm"), {
    method: "POST", headers: headers(cookieStr(s.jar), s.tokenB),
  });
  const q = new URLSearchParams({
    txt_subject: subject, txt_courseNumber: course, txt_term: term,
    startDatepicker: "", endDatepicker: "", uniqueSessionId: s.usid,
    pageOffset: "0", pageMaxSize: "50", sortColumn: "subjectDescription", sortDirection: "asc",
  });
  const res = await fetch(url(`/ssb/searchResults/searchResults?${q}`), {
    headers: headers(cookieStr(s.jar), s.tokenB),
  });
  return res.json();
}

async function detail(s, term, crn, endpoint) {
  const res = await fetch(url(`/ssb/searchResults/${endpoint}`), {
    method: "POST",
    headers: { ...headers(cookieStr(s.jar), s.tokenB), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ term, courseReferenceNumber: crn }).toString(),
  });
  return res.text();
}

const norm = (h) => h.replace(/\s+/g, " ").trim();

const ENDPOINTS = [
  "getSectionCatalogDetails",
  "getCourseDescription",
  "getSectionPrerequisites",
  "getCorequisites",
];

async function main() {
  console.log(`Term ${TERM}  ${SUBJECT} ${COURSE}  @ ${BASE}\n`);
  const s = await establish(TERM);
  const result = await search(s, TERM, SUBJECT, COURSE);
  const crns = (result.data ?? []).map((d) => d.courseReferenceNumber);
  console.log(`Found ${result.totalCount} sections; CRNs: ${crns.join(", ")}`);
  const sample = crns.slice(0, 3);
  if (sample.length < 2) {
    console.log("Need >=2 sections to compare; aborting.");
    return;
  }

  for (const endpoint of ENDPOINTS) {
    const bodies = {};
    for (const crn of sample) bodies[crn] = await detail(s, TERM, crn, endpoint);
    const normed = sample.map((c) => norm(bodies[c]));
    const allIdentical = normed.every((n) => n === normed[0]);
    console.log(`\n=== ${endpoint} ===`);
    console.log(`identical across ${sample.length} CRNs (whitespace-normalized): ${allIdentical}`);
    if (!allIdentical) {
      for (const crn of sample) {
        console.log(`  --- CRN ${crn} (${bodies[crn].length} bytes) ---`);
        console.log("  " + norm(bodies[crn]).slice(0, 400));
      }
    } else {
      console.log("  sample: " + normed[0].slice(0, 200));
    }
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
