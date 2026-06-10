/**
 * Lazy subject-menu enumeration for not-yet-backfilled ("dynamic") terms.
 *
 * The `term` table is populated with EVERY Banner term (see ingest/terms +
 * /api/admin/refresh-terms), but only a couple of terms are eagerly backfilled.
 * A dynamic term's *sections* are served by the demand-driven page cache
 * (lib/ingest/pageCache) — fetched a page at a time on search. Its Subject
 * *menu*, however, is needed up front (on term selection, before any search) so
 * the dropdown isn't empty; this module fills it with one getSubjects call.
 *
 * Invoked from /api/filters?kind=subject (NOT the read-path query layer, so that
 * stays Banner-free) and only for a term that was never fully synced
 * (`last_synced_at IS NULL`). Disabled with DYNAMIC_SYNC=0 (e2e sets this).
 */
import { establishSession, getSubjects } from "@/lib/sis/client";
import { markTermSubjectsSynced, upsertSubjects } from "@/lib/db/upsert";
import type { D1Like } from "@/lib/db/client";
import { logSis } from "@/lib/log";

/** Concurrent first-views of a dynamic term's subject menu share one fetch. */
const inFlightSubjects = new Map<string, Promise<number>>();

function dynamicEnabled(): boolean {
  return process.env.DYNAMIC_SYNC !== "0";
}

/**
 * Populates the `subject` table for a not-yet-backfilled term with the full
 * Banner subject list (one getSubjects call). Without this the Subject menu —
 * derived from sections, which are filled lazily per page — is empty, so there'd
 * be no way to scope a search to a subject. Backfilled terms already have their
 * subjects (full sync enumerated them, `last_synced_at` set); `subjects_synced_at`
 * marks that the enumeration ran so a term that returns zero subjects (an
 * Extension variant) isn't re-hit every request. Returns the number of subjects
 * (0 if it didn't run).
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
