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
import type { D1Like } from "@/lib/db/client";
import {
  finishSyncRun,
  markTermSynced,
  replaceSubjectSections,
  startSyncRun,
  upsertSubjects,
} from "@/lib/db/upsert";

const PAGE_SIZE = 500;
const SESSION_MAX_AGE_MS = 27 * 60 * 1000; // re-handshake before the ~30-min server expiry
const DEFAULT_SUBJECT_DELAY_MS = 250; // throttle between subjects to be polite to Banner

export interface SyncOptions {
  /** Delay between subjects (ms). Higher = gentler on Banner during backfill. */
  subjectDelayMs?: number;
  /** Progress callback. */
  log?: (msg: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pulls every section for one (term, subject) across all result pages. */
async function fetchAllSections(
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
}

/** Full sync of a single term. */
export async function syncTerm(
  db: D1Like,
  termCode: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  const delay = options.subjectDelayMs ?? DEFAULT_SUBJECT_DELAY_MS;
  const startedAt = Date.now();
  const run = await startSyncRun(db, termCode, "full", startedAt);

  let session = await establishSession(termCode);
  let totalSections = 0;
  let subjectsDone = 0;
  let status: "ok" | "partial" | "error" = "ok";

  try {
    const subjects = await getSubjects(session, termCode);
    await upsertSubjects(db, termCode, subjects);
    log(`[${termCode}] ${subjects.length} subjects`);

    for (const subject of subjects) {
      if (Date.now() - session.establishedAt > SESSION_MAX_AGE_MS) {
        session = await establishSession(termCode);
      }
      try {
        const sections = await fetchAllSections(session, termCode, subject.code);
        const written = await replaceSubjectSections(
          db,
          termCode,
          subject.code,
          sections,
          Date.now()
        );
        totalSections += written;
        log(`[${termCode}] ${subject.code}: ${written} sections`);
      } catch (err) {
        status = "partial";
        log(`[${termCode}] ${subject.code} FAILED: ${(err as Error).message}`);
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

  return { term: termCode, subjects: subjectsDone, sections: totalSections, status };
}
