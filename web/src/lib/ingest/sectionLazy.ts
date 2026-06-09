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
  getBookstore,
  getCrossListSections,
  getFees,
  getLinkedSections,
  getRestrictions,
  getSyllabus,
} from "@/lib/sis/client";
import {
  parseBookstore,
  parseFees,
  parseRestrictions,
  parseSectionCrns,
  parseSyllabus,
} from "@/lib/sis/parse/sectionDetail";
import type { D1Like } from "@/lib/db/client";
import type { SectionDetail } from "@/lib/db/queries";
import { upsertSectionDetail } from "@/lib/db/upsert";

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
  const session = await establishSession(term);
  const [restr, fees, xlst, linked, bookstore, syllabus] = await Promise.all([
    getRestrictions(session, term, crn),
    getFees(session, term, crn),
    getCrossListSections(session, term, crn),
    getLinkedSections(session, term, crn),
    getBookstore(session, term, crn),
    getSyllabus(session, term, crn),
  ]);

  const restrictions = parseRestrictions(restr);
  const parsedFees = parseFees(fees);
  const crossListCrns = parseSectionCrns(xlst);
  const linkedCrns = parseSectionCrns(linked);
  const parsedBookstore = parseBookstore(bookstore);
  const parsedSyllabus = parseSyllabus(syllabus);

  await upsertSectionDetail(
    db,
    term,
    crn,
    {
      restrictions,
      fees: parsedFees,
      crossListCrns,
      linkedCrns,
      bookstore: parsedBookstore,
      syllabus: parsedSyllabus,
      rawRestrictionsHtml: restr,
      rawFeesHtml: fees,
      rawXlstHtml: xlst,
      rawLinkedHtml: linked,
      rawBookstoreHtml: bookstore,
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
    bookstore: parsedBookstore,
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
