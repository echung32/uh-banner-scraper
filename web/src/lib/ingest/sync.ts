/**
 * Full catalog sync — the primary Banner-facing write path.
 *
 * For a term: handshake once, enumerate subjects, paginate every subject's
 * sections, and delete-and-replace them per subject in D1. This is the only
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
  finishSyncRun,
  markTermSynced,
  replaceSubjectSections,
  startSyncRun,
  upsertSubjects,
} from "@/lib/db/upsert";
import { rowToCourseSection } from "@/lib/db/mappers";
import { classifySectionChanges, type SectionDiff } from "@/lib/ingest/diff";

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

/** Current stored sections for one (term, subject) — used to diff a re-sync. */
async function readSubjectSections(
  db: D1Like,
  term: string,
  subject: string
): Promise<CourseSection[]> {
  const { results } = await db
    .prepare("SELECT raw_json FROM course_section WHERE term = ? AND subject = ?")
    .bind(term, subject)
    .all<{ raw_json: string }>();
  return results.map(rowToCourseSection);
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

export interface SyncResult {
  term: string;
  subjects: number;
  sections: number;
  status: "ok" | "partial" | "error";
  /** Present only when collectDiff was set; aggregated across all subjects. */
  diff?: SectionDiff;
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
  const startedAt = Date.now();
  const run = await startSyncRun(db, termCode, "full", startedAt);

  let session = await establishSession(termCode);
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
      let written: number | null = null;
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
          if (collectDiff) {
            const existing = await readSubjectSections(db, termCode, subject.code);
            const d = classifySectionChanges(existing, sections);
            diff.newCrns.push(...d.newCrns);
            diff.droppedCrns.push(...d.droppedCrns);
            diff.structuralCrns.push(...d.structuralCrns);
          }
          written = await replaceSubjectSections(
            db,
            termCode,
            subject.code,
            sections,
            Date.now()
          );
          break;
        } catch (err) {
          lastErr = err as Error;
        }
      }
      if (written === null) {
        status = "partial";
        log(`[${termCode}] ${subject.code} FAILED: ${lastErr?.message}`);
      } else {
        totalSections += written;
        log(`[${termCode}] ${subject.code}: ${written} sections`);
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
    ...(collectDiff ? { diff } : {}),
  };
}
