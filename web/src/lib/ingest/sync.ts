/**
 * Full catalog sync — the primary Banner-facing write path.
 *
 * For a term: handshake once, enumerate subjects, paginate every subject's
 * sections, and delta-write them per subject in D1 (new=insert, dropped=delete,
 * structural=rewrite, seat-only=row UPDATE, unchanged=skip). This is the only
 * place (besides seat refresh / term refresh) that touches the live Banner API.
 */
import {
  establishSession,
  getSubjects,
  searchCourses,
} from "@/lib/sis/client";
import type { CourseSection, SisSession } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/types";
import {
  deleteSectionsAndChildren,
  finishSyncRun,
  insertSectionsAndChildren,
  markTermSynced,
  startSyncRun,
  updateSectionRows,
  upsertSubjects,
} from "@/lib/db/upsert";
import {
  classifyForWrite,
  type SectionDiff,
  type SectionWriteDelta,
} from "@/lib/ingest/diff";

const PAGE_SIZE = 500;
const SESSION_MAX_AGE_MS = 27 * 60 * 1000; // re-handshake before the ~30-min server expiry
const DEFAULT_SUBJECT_DELAY_MS = 250; // throttle between subjects to be polite to Banner
const SUBJECT_MAX_ATTEMPTS = 3; // re-handshake + retry a subject before giving up
const RETRY_BACKOFF_MS = 2000; // wait before a re-handshake so we don't amplify throttling
// Banner silently throttles a session after a few hundred requests (each subject
// is ~2: resetDataForm + searchResults), so rotate to a fresh session well before
// that. Rotating too often re-triggers handshake throttling, so keep it modest.
const DEFAULT_SUBJECTS_PER_SESSION = 40;

export interface SyncOptions {
  /** Delay between subjects (ms). Higher = gentler on Banner during backfill. */
  subjectDelayMs?: number;
  /** Re-handshake after this many subjects to dodge per-session throttling. */
  subjectsPerSession?: number;
  /** Progress callback. */
  log?: (msg: string) => void;
  /** Accumulate a section-core diff across subjects (Tier B1). Default false. */
  collectDiff?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the stored CRNs + raw_json strings for one (term, subject) — the
 * minimal read needed to classify incoming sections for a delta write.
 */
async function readSubjectRawJson(
  db: D1Like,
  term: string,
  subject: string
): Promise<Array<{ crn: string; rawJson: string }>> {
  const { results } = await db
    .prepare("SELECT crn, raw_json FROM course_section WHERE term = ? AND subject = ?")
    .bind(term, subject)
    .all<{ crn: string; raw_json: string }>();
  return results.map((r) => ({ crn: r.crn, rawJson: r.raw_json }));
}

/** Pulls every section for one (term, subject) across all result pages. */
export async function fetchAllSections(
  session: SisSession,
  term: string,
  subject: string
): Promise<CourseSection[]> {
  const all: CourseSection[] = [];
  let pageOffset = 0;
  for (;;) {
    const res = await searchCourses(session, {
      term,
      subject,
      pageOffset,
      pageMaxSize: PAGE_SIZE,
    });
    all.push(...res.data);
    pageOffset += res.data.length;
    if (res.data.length === 0 || pageOffset >= res.totalCount) break;
  }
  return all;
}

export interface SyncWrites {
  inserted: number;
  structural: number;
  seatUpdated: number;
  deleted: number;
  unchanged: number;
}

export interface SyncResult {
  term: string;
  subjects: number;
  /** Total number of sections in the term (= sum of incoming sections per subject). */
  sections: number;
  status: "ok" | "partial" | "error";
  /** Present only when collectDiff was set; aggregated across all subjects. */
  diff?: SectionDiff;
  /** Write-delta totals across all subjects — always present. */
  writes?: SyncWrites;
}

/** Full sync of a single term. */
export async function syncTerm(
  db: D1Like,
  termCode: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  const delay = options.subjectDelayMs ?? DEFAULT_SUBJECT_DELAY_MS;
  const perSession = options.subjectsPerSession ?? DEFAULT_SUBJECTS_PER_SESSION;
  const collectDiff = options.collectDiff ?? false;
  const diff: SectionDiff = { newCrns: [], droppedCrns: [], structuralCrns: [] };
  const writes: SyncWrites = { inserted: 0, structural: 0, seatUpdated: 0, deleted: 0, unchanged: 0 };
  const startedAt = Date.now();
  const run = await startSyncRun(db, termCode, "full", startedAt);

  let session = await establishSession(termCode);
  // totalSections accumulates incoming section counts (= term size, not write count).
  let totalSections = 0;
  let subjectsDone = 0;
  let sinceHandshake = 0;
  let status: "ok" | "partial" | "error" = "ok";

  try {
    const subjects = await getSubjects(session, termCode);
    await upsertSubjects(db, termCode, subjects);
    log(`[${termCode}] ${subjects.length} subjects`);

    for (const subject of subjects) {
      // Rotate the session by request count (per-session throttle) AND by age.
      if (sinceHandshake >= perSession || Date.now() - session.establishedAt > SESSION_MAX_AGE_MS) {
        session = await establishSession(termCode);
        sinceHandshake = 0;
      }
      sinceHandshake += 1;
      // Retry each subject a few times, re-establishing the session between
      // attempts. A long single-session run (hundreds of sequential searches)
      // eventually gets throttled by Banner — the failures cluster in the tail —
      // and a fresh handshake clears it. Without this, late subjects (incl. big
      // ones like SOC/SPAN) silently come back empty and the run is "partial".
      let subjectDelta: SectionWriteDelta | null = null;
      let subjectCount: number | null = null;
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < SUBJECT_MAX_ATTEMPTS; attempt++) {
        try {
          // Re-handshake (inside the try) before a retry; a failed handshake
          // then just fails THIS subject instead of aborting the whole run.
          if (attempt > 0) {
            await sleep(RETRY_BACKOFF_MS);
            session = await establishSession(termCode);
          }
          const sections = await fetchAllSections(session, termCode, subject.code);
          // Always read existing raw_json strings — the delta classifier needs them
          // regardless of collectDiff (the whole point is trading reads for writes).
          const existing = await readSubjectRawJson(db, termCode, subject.code);
          const delta = classifyForWrite(existing, sections);
          const now = Date.now();

          // 1. Delete dropped CRNs.
          await deleteSectionsAndChildren(db, termCode, delta.droppedCrns);
          // 2. Structurally-changed: delete old row+children, then re-insert.
          if (delta.structuralSections.length > 0) {
            await deleteSectionsAndChildren(
              db,
              termCode,
              delta.structuralSections.map((s) => s.courseReferenceNumber)
            );
          }
          // 3. Insert new + structural sections (with their children).
          await insertSectionsAndChildren(
            db,
            [...delta.newSections, ...delta.structuralSections],
            now
          );
          // 4. Seat-only: UPDATE the section row only (no child table writes).
          await updateSectionRows(db, delta.seatOnlySections, now);

          subjectDelta = delta;
          subjectCount = sections.length;
          break;
        } catch (err) {
          lastErr = err as Error;
        }
      }
      if (subjectDelta === null || subjectCount === null) {
        status = "partial";
        log(`[${termCode}] ${subject.code} FAILED: ${lastErr?.message}`);
      } else {
        // Accumulate term size (incoming count) so SyncResult.sections = term's
        // total section count, not the write count.
        totalSections += subjectCount;
        const written =
          subjectDelta.newSections.length +
          subjectDelta.structuralSections.length +
          subjectDelta.seatOnlySections.length;
        writes.inserted += subjectDelta.newSections.length;
        writes.structural += subjectDelta.structuralSections.length;
        writes.seatUpdated += subjectDelta.seatOnlySections.length;
        writes.deleted += subjectDelta.droppedCrns.length;
        writes.unchanged += subjectDelta.unchangedCrns.length;
        log(`[${termCode}] ${subject.code}: ${subjectCount} sections (${written} written, ${subjectDelta.unchangedCrns.length} unchanged)`);
        if (collectDiff) {
          // classifyForWrite gives us new/dropped/structural directly.
          diff.newCrns.push(...subjectDelta.newSections.map((s) => s.courseReferenceNumber));
          diff.droppedCrns.push(...subjectDelta.droppedCrns);
          diff.structuralCrns.push(...subjectDelta.structuralSections.map((s) => s.courseReferenceNumber));
        }
      }
      subjectsDone += 1;
      if (delay > 0) await sleep(delay);
    }

    await markTermSynced(db, termCode, status, Date.now());
    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status,
      subjectsTotal: subjects.length,
      subjectsDone,
      sectionsUpserted: totalSections,
    });
  } catch (err) {
    status = "error";
    await markTermSynced(db, termCode, "error", Date.now());
    await finishSyncRun(db, run, {
      finishedAt: Date.now(),
      status: "error",
      subjectsDone,
      sectionsUpserted: totalSections,
      errorMessage: (err as Error).message,
    });
  }

  return {
    term: termCode,
    subjects: subjectsDone,
    sections: totalSections,
    status,
    writes,
    ...(collectDiff ? { diff } : {}),
  };
}
