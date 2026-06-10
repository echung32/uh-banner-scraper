/**
 * Lazy (cache-on-miss) section-detail fetch. The eager per-CRN pass in
 * `details.ts` is the heaviest ingest (6 Banner endpoints × every CRN), so the
 * read path instead fetches a section's detail the first time it's viewed and
 * stores it — subsequent views are pure D1 hits, and a section with no detail
 * still stores (all-null) once and never refetches.
 *
 * This is the ONE place a user request can reach the live Banner API (only for a
 * cold section_detail); search itself is always served from D1. The fallback is
 * invoked by the `/api/section` route, not by the read-path `search.ts`, so that
 * module stays Banner-free.
 */
import {
  establishSession,
  getCrossListSections,
  getFees,
  getLinkedSections,
  getRestrictions,
  getSyllabus,
} from "@/lib/sis/client";
import {
  parseFees,
  parseRestrictions,
  parseSectionCrns,
  parseSyllabus,
} from "@/lib/sis/parse/sectionDetail";
import type { D1Like } from "@/lib/db/types";
import type { SectionDetail } from "@/lib/db/queries";
import { upsertSectionDetail } from "@/lib/db/upsert";
import { logSis } from "@/lib/log";

/** Concurrent first-views of the same section share one live fetch. */
const inFlight = new Map<string, Promise<SectionDetail | null>>();

function lazyEnabled(): boolean {
  return process.env.SECTION_LAZY_FETCH !== "0";
}

/** True when a section actually exists for (term, crn) — bounds live fetches. */
async function sectionExists(
  db: D1Like,
  term: string,
  crn: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM course_section WHERE term = ? AND crn = ?")
    .bind(term, crn)
    .first<{ ok: number }>();
  return !!row;
}

async function fetchAndStore(
  db: D1Like,
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  logSis(`section detail ${term}:${crn} — live fetch (cache miss)`);
  const session = await establishSession(term);
  // Per-fragment tolerance: Banner returns 500 for a CRN it doesn't recognize
  // (e.g. a section that has since been cancelled), and any one fragment may
  // fail transiently. `allSettled` keeps a single bad endpoint from sinking the
  // whole panel. If EVERY fragment fails the section is unknown to Banner (or
  // the session/IP is throttled), so we return null WITHOUT caching — the route
  // 404s ("no detail") instead of 500ing, and a later view retries live rather
  // than being stuck with a cached all-null row (the lazy path never refetches).
  const settled = await Promise.allSettled([
    getRestrictions(session, term, crn),
    getFees(session, term, crn),
    getCrossListSections(session, term, crn),
    getLinkedSections(session, term, crn),
    getSyllabus(session, term, crn),
  ]);
  if (settled.every((s) => s.status === "rejected")) {
    console.warn(
      `Section detail: all fragments failed for ${term}:${crn} (unknown CRN or throttled) — not caching`
    );
    return null;
  }
  const raw = (i: number): string | null =>
    settled[i].status === "fulfilled"
      ? (settled[i] as PromiseFulfilledResult<string>).value
      : null;
  const restr = raw(0);
  const fees = raw(1);
  const xlst = raw(2);
  const linked = raw(3);
  const syllabus = raw(4);

  const restrictions = restr ? parseRestrictions(restr) : null;
  const parsedFees = fees ? parseFees(fees) : null;
  const crossListCrns = xlst ? parseSectionCrns(xlst) : null;
  const linkedCrns = linked ? parseSectionCrns(linked) : null;
  const parsedSyllabus = syllabus ? parseSyllabus(syllabus) : null;

  await upsertSectionDetail(
    db,
    term,
    crn,
    {
      restrictions,
      fees: parsedFees,
      crossListCrns,
      linkedCrns,
      syllabus: parsedSyllabus,
      rawRestrictionsHtml: restr,
      rawFeesHtml: fees,
      rawXlstHtml: xlst,
      rawLinkedHtml: linked,
      rawSyllabusHtml: syllabus,
    },
    Date.now()
  );

  return {
    term,
    crn,
    restrictions,
    fees: parsedFees,
    crossListCrns,
    linkedCrns,
    syllabus: parsedSyllabus,
  };
}

/**
 * Fetches a section's detail live, stores it, and returns it — but only if the
 * section actually exists in D1 and lazy fetching is enabled. Returns `null`
 * otherwise (the route then 404s), so an unknown CRN never triggers a live call.
 */
export async function ensureSectionDetail(
  db: D1Like,
  term: string,
  crn: string
): Promise<SectionDetail | null> {
  if (!lazyEnabled()) return null;
  if (!(await sectionExists(db, term, crn))) return null;

  const key = `${term}:${crn}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndStore(db, term, crn).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
