/**
 * Demand-driven page cache for not-yet-backfilled ("dynamic") terms.
 *
 * A dynamic term (`term.last_synced_at IS NULL`) is never fully backfilled.
 * Instead, each search fetches only the offset window(s) the user is viewing
 * live from Banner, stores the section bodies in `course_section`, and records
 * the covered window in `search_chunk` (keyed by sort order + the live-applied
 * filters). A revisit then serves from D1 (lib/db/queries.getSearchPageFromChunks);
 * coverage fills incrementally as users page through. View-only terms are
 * immutable so their windows never expire; other terms revalidate after
 * PAGE_TTL_MS (seats change).
 *
 * Banner-facing — invoked from the /api/search route (never the read-path query
 * layer), gated by DYNAMIC_SYNC (e2e sets it to 0 so read-path tests stay off the
 * live SIS). Backfilled terms short-circuit here and use the SQL path instead.
 */
import { establishSession, searchCourses } from "@/lib/sis/client";
import { upsertSections } from "@/lib/db/upsert";
import {
  CHUNK_SIZE,
  chunkIndicesFor,
  filterSignature,
  getTermSyncMeta,
} from "@/lib/db/queries";
import type { D1Like } from "@/lib/db/types";
import type { SearchParams, SisSession } from "@/lib/sis/types";
import { logSis } from "@/lib/log";

/** Revalidation window for a non-view-only term's cached page (seats change). */
const PAGE_TTL_MS = 30 * 60 * 1000;

/** Concurrent first-fetches of the same window share one live request. */
const inFlight = new Map<string, Promise<void>>();

function dynamicEnabled(): boolean {
  return process.env.DYNAMIC_SYNC !== "0";
}

function normalizeSort(params: SearchParams): {
  sortColumn: string;
  sortDirection: "asc" | "desc";
} {
  return {
    sortColumn: params.sortColumn ?? "subjectDescription",
    sortDirection:
      (params.sortDirection ?? "asc").toLowerCase() === "desc" ? "desc" : "asc",
  };
}

/** Of `indices`, the windows we must (re)fetch — absent, stale, or non-empty. */
async function staleOrMissingChunks(
  db: D1Like,
  term: string,
  sig: string,
  sortColumn: string,
  sortDirection: string,
  indices: number[],
  isViewOnly: boolean
): Promise<number[]> {
  const ph = indices.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT chunk_index, fetched_at, total_count FROM search_chunk
         WHERE term = ? AND filter_sig = ? AND sort_column = ? AND sort_direction = ?
           AND chunk_index IN (${ph})`
    )
    .bind(term, sig, sortColumn, sortDirection, ...indices)
    .all<{ chunk_index: number; fetched_at: number; total_count: number }>();

  const now = Date.now();
  const fresh = new Set<number>();
  for (const r of results) {
    const stale = !isViewOnly && now - r.fetched_at > PAGE_TTL_MS;
    if (!stale) fresh.add(r.chunk_index);
  }
  // If any covering window is known, its total bounds which windows can hold data.
  const total = results[0]?.total_count;
  return indices.filter((i) => {
    if (fresh.has(i)) return false;
    // A window that starts past the known end has nothing to fetch.
    if (total != null && i * CHUNK_SIZE >= total) return false;
    return true;
  });
}

async function writeChunk(
  db: D1Like,
  term: string,
  sig: string,
  sortColumn: string,
  sortDirection: string,
  chunkIndex: number,
  crns: string[],
  totalCount: number,
  fetchedAt: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO search_chunk
         (term, filter_sig, sort_column, sort_direction, chunk_index,
          crns_json, total_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term, filter_sig, sort_column, sort_direction, chunk_index)
       DO UPDATE SET crns_json = excluded.crns_json,
                     total_count = excluded.total_count,
                     fetched_at = excluded.fetched_at`
    )
    .bind(term, sig, sortColumn, sortDirection, chunkIndex, JSON.stringify(crns), totalCount, fetchedAt)
    .run();
}

/**
 * Ensures the cached windows covering `params`' page exist (filling any
 * missing/stale ones from Banner). Returns true when the page-cache path applies
 * (the caller should then read via getSearchPageFromChunks), false when the term
 * is backfilled/unknown or DYNAMIC_SYNC is off (caller uses the SQL path).
 */
export async function ensureSearchPage(
  db: D1Like,
  params: SearchParams
): Promise<boolean> {
  if (!dynamicEnabled()) return false;
  const meta = await getTermSyncMeta(db, params.term);
  if (!meta || meta.lastSyncedAt != null) return false; // unknown or backfilled

  const indices = chunkIndicesFor(params.pageOffset, params.pageMaxSize);
  if (indices.length === 0) return true;

  const { sortColumn, sortDirection } = normalizeSort(params);
  const sig = filterSignature(params);
  const needed = await staleOrMissingChunks(
    db,
    params.term,
    sig,
    sortColumn,
    sortDirection,
    indices,
    meta.isViewOnly
  );
  if (needed.length === 0) return true;

  // Fetch the needed windows sequentially on one reused session (polite to Banner
  // and avoids a handshake per window). Concurrent identical fetches dedupe.
  let session: SisSession | null = null;
  for (const ci of needed) {
    const key = `${params.term}|${sig}|${sortColumn}|${sortDirection}|${ci}`;
    const existing = inFlight.get(key);
    if (existing) {
      await existing;
      continue;
    }
    const promise = (async () => {
      if (!session) session = await establishSession(params.term);
      logSis(
        `page ${params.term}/${params.subject || "*"} ${sortColumn} ${sortDirection}` +
          ` chunk ${ci} — live Banner`
      );
      const res = await searchCourses(session, {
        term: params.term,
        subject: params.subject,
        courseNumber: params.courseNumber,
        openOnly: params.openOnly,
        sortColumn,
        sortDirection,
        pageOffset: ci * CHUNK_SIZE,
        pageMaxSize: CHUNK_SIZE,
      });
      const now = Date.now();
      await upsertSections(db, res.data, now);
      await writeChunk(
        db,
        params.term,
        sig,
        sortColumn,
        sortDirection,
        ci,
        res.data.map((s) => s.courseReferenceNumber),
        res.totalCount,
        now
      );
      logSis(
        `page ${params.term}/${params.subject || "*"} chunk ${ci} →` +
          ` ${res.data.length} sections (total ${res.totalCount})`
      );
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    await promise;
  }
  return true;
}
