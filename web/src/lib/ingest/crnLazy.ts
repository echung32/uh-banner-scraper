/**
 * Demand-driven single-section fetch by CRN, for not-yet-backfilled ("dynamic")
 * terms. Complements the page cache (lib/ingest/pageCache): the page cache fills
 * sections a *page* at a time keyed by the search filters, but a CRN search has
 * no subject/course-number to page on — the user only knows the CRN.
 *
 * A CRN is unique only *within* a term, and Banner's Browse Classes search has no
 * CRN field, so there's no one-shot "section by CRN" search call. Instead we:
 *   1. ask `getClassDetails(term, crn)` — the one per-CRN endpoint that echoes the
 *      section's catalog course number (and confirms the CRN exists at all), then
 *   2. run a normal `searchResults` scoped to that course number (no subject — we
 *      only have the subject *description* from the modal, not its code) and pick
 *      the row whose CRN matches, and
 *   3. store it in `course_section` so subsequent lookups serve from D1 forever.
 *
 * Banner-facing — invoked from /api/search (the CRN branch), never the read-path
 * query layer. Only fires for a dynamic term (`last_synced_at IS NULL`); a
 * backfilled term already holds every section, so a CRN miss there is a genuine
 * "no such section". Gated by DYNAMIC_SYNC (e2e toggles it). Concurrent first-hits
 * of the same (term, crn) dedupe.
 */
import { establishSession, getClassDetails, searchCourses } from "@/lib/sis/client";
import { parseClassDetails } from "@/lib/sis/parse/classDetails";
import { upsertSections } from "@/lib/db/upsert";
import { getTermSyncMeta } from "@/lib/db/queries";
import type { D1Like } from "@/lib/db/types";
import type { CourseSection } from "@/lib/sis/types";
import { logSis } from "@/lib/log";

/** Page size + page cap for the course-number-scoped scan that locates the CRN. */
const SCAN_PAGE_SIZE = 100;
const MAX_SCAN_PAGES = 10;

/** Concurrent first-views of the same (term, crn) share one live fetch. */
const inFlight = new Map<string, Promise<boolean>>();

function dynamicEnabled(): boolean {
  return process.env.DYNAMIC_SYNC !== "0";
}

/**
 * Ensures the section for `(term, crn)` is in D1, fetching it live from Banner on
 * a miss for a dynamic term. Returns true when the section is now present (the
 * caller re-reads it from D1), false when the term is backfilled/unknown, the
 * feature is off, or no such CRN exists in the term.
 */
export async function ensureSectionByCrn(
  db: D1Like,
  term: string,
  crn: string
): Promise<boolean> {
  if (!dynamicEnabled()) return false;
  const meta = await getTermSyncMeta(db, term);
  if (!meta || meta.lastSyncedAt != null) return false; // unknown or backfilled

  const key = `${term}|${crn}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const session = await establishSession(term);
    logSis(`crn ${term}/${crn} — live Banner (term not backfilled)`);

    const details = parseClassDetails(await getClassDetails(session, term, crn));
    if (!details) {
      logSis(`crn ${term}/${crn} → no such section`);
      return false;
    }

    // Scope the scan to the catalog course number when we have it (a handful of
    // sections); fall back to a whole-term scan otherwise. Either way, stop as
    // soon as the matching CRN turns up.
    const courseNumber = details.courseNumber ?? undefined;
    let found: CourseSection | null = null;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const res = await searchCourses(session, {
        term,
        subject: "",
        courseNumber,
        pageOffset: page * SCAN_PAGE_SIZE,
        pageMaxSize: SCAN_PAGE_SIZE,
      });
      found = res.data.find((s) => s.courseReferenceNumber === crn) ?? null;
      if (found) break;
      if ((page + 1) * SCAN_PAGE_SIZE >= res.totalCount) break;
    }

    if (!found) {
      logSis(`crn ${term}/${crn} → not located in search (course ${courseNumber ?? "*"})`);
      return false;
    }

    await upsertSections(db, [found], Date.now());
    logSis(`crn ${term}/${crn} → stored (${found.subjectCourse})`);
    return true;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
