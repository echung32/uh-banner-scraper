/**
 * Seat-only refresh — updates live enrollment / seat / waitlist counts for
 * already-stored sections without a full catalog scrape, via Banner's per-CRN
 * `getEnrollmentInfo`. Bounded by a subject (or explicit CRN list) and a cap so
 * a manual global refresh stays cheap; the per-term cooldown is enforced by the
 * caller (see markSeatRefresh / the refresh route).
 */
import { establishSession, getEnrollmentInfo } from "@/lib/sis/client";
import type { CourseSection } from "@/lib/sis/types";
import type { D1Like } from "@/lib/db/client";
import { rowToCourseSection } from "@/lib/db/mappers";
import {
  finishSyncRun,
  markSeatRefresh,
  startSyncRun,
  updateSeats,
} from "@/lib/db/upsert";

const DEFAULT_MAX_SECTIONS = 100;
const DEFAULT_REQUEST_DELAY_MS = 150;
const UPDATE_CHUNK = 25;

export interface SeatRefreshOptions {
  /** Limit to one subject. */
  subject?: string;
  /** Or an explicit set of CRNs (takes precedence over subject). */
  crns?: string[];
  /** Safety cap on how many sections one refresh touches. */
  maxSections?: number;
  requestDelayMs?: number;
  log?: (msg: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface SeatRefreshResult {
  term: string;
  refreshed: number;
}

export async function refreshSeats(
  db: D1Like,
  termCode: string,
  options: SeatRefreshOptions = {}
): Promise<SeatRefreshResult> {
  const log = options.log ?? (() => {});
  const cap = options.maxSections ?? DEFAULT_MAX_SECTIONS;
  const delay = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const startedAt = Date.now();
  const run = await startSyncRun(db, termCode, "seat_refresh", startedAt);

  // Load the target sections from D1 (we patch their stored raw_json in place).
  let sql = "SELECT raw_json FROM course_section WHERE term = ?";
  const binds: unknown[] = [termCode];
  if (options.crns && options.crns.length > 0) {
    sql += ` AND crn IN (${options.crns.map(() => "?").join(",")})`;
    binds.push(...options.crns);
  } else if (options.subject) {
    sql += " AND subject = ?";
    binds.push(options.subject);
  }
  sql += " LIMIT ?";
  binds.push(cap);

  const { results } = await db.prepare(sql).bind(...binds).all<{ raw_json: string }>();
  const sections = results.map(rowToCourseSection);

  const session = await establishSession(termCode);
  const updated: CourseSection[] = [];

  for (const section of sections) {
    try {
      const info = await getEnrollmentInfo(session, termCode, section.courseReferenceNumber);
      const patched: CourseSection = {
        ...section,
        maximumEnrollment: info.maximumEnrollment,
        enrollment: info.enrollment,
        seatsAvailable: info.seatsAvailable,
        waitCapacity: info.waitCapacity,
        waitCount: info.waitCount,
        waitAvailable: info.waitAvailable,
        openSection: info.seatsAvailable > 0,
      };
      updated.push(patched);
    } catch (err) {
      log(`[${termCode}] seat refresh ${section.courseReferenceNumber} FAILED: ${(err as Error).message}`);
    }
    if (delay > 0) await sleep(delay);
  }

  const now = Date.now();
  for (const part of chunk(updated, UPDATE_CHUNK)) {
    await updateSeats(db, part, now);
  }
  await markSeatRefresh(db, termCode, now);
  await finishSyncRun(db, run, {
    finishedAt: now,
    status: "ok",
    sectionsUpserted: updated.length,
  });

  log(`[${termCode}] refreshed ${updated.length} sections`);
  return { term: termCode, refreshed: updated.length };
}
