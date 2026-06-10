/**
 * Dynamic (lazy) per-(term, subject) catalog sync.
 *
 * The `term` table is populated with EVERY Banner term (see ingest/terms +
 * /api/admin/refresh-terms), but only a couple of terms are eagerly backfilled.
 * For the rest, sections are pulled from Banner the first time someone searches
 * a specific subject in that term, then served from D1 forever after — the same
 * cache-on-miss idea as lazy section detail (lib/ingest/sectionLazy).
 *
 * This is invoked from the /api/search route (NOT the read-path query layer, so
 * that stays Banner-free) and only fires for a term that has never been fully
 * synced (`term.last_synced_at IS NULL`). A fully-backfilled term already has a
 * `subject` row for every subject, so it never triggers. Disabled with
 * DYNAMIC_SYNC=0 (e2e sets this so read-path tests stay deterministic).
 */
import { establishSession, getSubjects } from "@/lib/sis/client";
import { fetchAllSections } from "@/lib/ingest/sync";
import {
  markTermSubjectsSynced,
  replaceSubjectSections,
  upsertSubjects,
} from "@/lib/db/upsert";
import type { D1Like } from "@/lib/db/client";
import { logSis } from "@/lib/log";

/** Concurrent first-searches of the same (term, subject) share one live sync. */
const inFlight = new Map<string, Promise<number>>();
/** Concurrent first-views of a dynamic term's subject menu share one fetch. */
const inFlightSubjects = new Map<string, Promise<number>>();

function dynamicEnabled(): boolean {
  return process.env.DYNAMIC_SYNC !== "0";
}

/** A term we may dynamically populate: it exists and was never fully backfilled. */
async function termIsDynamic(db: D1Like, term: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT last_synced_at FROM term WHERE code = ?")
    .bind(term)
    .first<{ last_synced_at: number | null }>();
  return !!row && row.last_synced_at == null;
}

/**
 * True once this (term, subject) has been synced — a `subject` row exists. We
 * write that marker even when the subject has zero sections, so an empty subject
 * isn't re-fetched on every search.
 */
async function alreadySynced(
  db: D1Like,
  term: string,
  subject: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM subject WHERE term = ? AND code = ?")
    .bind(term, subject)
    .first<{ ok: number }>();
  return !!row;
}

/**
 * Populates the `subject` table for a not-yet-backfilled term with the full
 * Banner subject list (one getSubjects call). Without this the Subject menu —
 * derived from sections, which don't exist yet — is empty, so there'd be no way
 * to pick a subject to trigger the per-subject section sync. Backfilled terms
 * already have their subjects (full sync enumerated them, `last_synced_at` set);
 * `subjects_synced_at` marks that the enumeration ran so a term that returns
 * zero subjects (an Extension variant) isn't re-hit every request. Returns the
 * number of subjects (0 if it didn't run).
 */
export async function ensureTermSubjects(
  db: D1Like,
  term: string
): Promise<number> {
  if (!dynamicEnabled()) return 0;
  const row = await db
    .prepare("SELECT last_synced_at, subjects_synced_at FROM term WHERE code = ?")
    .bind(term)
    .first<{ last_synced_at: number | null; subjects_synced_at: number | null }>();
  // Unknown term, already backfilled, or already enumerated → nothing to do.
  if (!row || row.last_synced_at != null || row.subjects_synced_at != null) return 0;

  const existing = inFlightSubjects.get(term);
  if (existing) return existing;

  const promise = (async () => {
    logSis(`dynamic subjects ${term} — live Banner (term not backfilled)`);
    const session = await establishSession(term);
    const subjects = await getSubjects(session, term);
    await upsertSubjects(db, term, subjects);
    await markTermSubjectsSynced(db, term, Date.now());
    logSis(`dynamic subjects ${term} → ${subjects.length} subjects`);
    return subjects.length;
  })().finally(() => inFlightSubjects.delete(term));
  inFlightSubjects.set(term, promise);
  return promise;
}

async function doSync(
  db: D1Like,
  term: string,
  subject: string
): Promise<number> {
  logSis(`dynamic sync ${term}/${subject} — live Banner (term not backfilled)`);
  const session = await establishSession(term);
  const sections = await fetchAllSections(session, term, subject);
  const written = await replaceSubjectSections(
    db,
    term,
    subject,
    sections,
    Date.now()
  );
  // Marker row (additive upsert) so this subject isn't re-synced — even at 0.
  await upsertSubjects(db, term, [
    { code: subject, description: sections[0]?.subjectDescription ?? subject },
  ]);
  logSis(`dynamic sync ${term}/${subject} → ${written} sections stored`);
  return written;
}

/**
 * If `(term, subject)` belongs to a not-yet-backfilled term and hasn't been
 * synced, pull it from Banner and store it. Returns the number of sections
 * written (0 if it didn't run). Safe to call on every search — the gates make
 * it a no-op for backfilled terms, already-synced subjects, and the no-subject
 * ("all subjects") case.
 */
export async function ensureTermSubject(
  db: D1Like,
  term: string,
  subject: string
): Promise<number> {
  if (!dynamicEnabled() || !subject) return 0;
  if (!(await termIsDynamic(db, term))) return 0;
  if (await alreadySynced(db, term, subject)) return 0;

  const key = `${term}:${subject}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = doSync(db, term, subject).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
