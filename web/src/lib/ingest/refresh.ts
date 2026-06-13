/**
 * Scheduled refresh of non-view-only terms (docs/plans/scheduled-refresh.md).
 *
 * Tier A: full sync each mutable term (cheap; also refreshes seats/waitlist).
 * Tier B1: re-fetch course/section/instructor details for NEW + STRUCTURALLY
 *          changed CRNs from the Tier A diff; delete detail for DROPPED CRNs.
 * Tier B2: if a term's last FULL details pass is >7 days old, run the full
 *          syncDetails pass (catches fee/restriction/text edits the diff can't
 *          see). Driven hourly by RefreshWorkflow; also runnable from the CLI /
 *          admin route. Reuses syncTerm + syncDetails verbatim.
 */
import type { D1Like } from "@/lib/db/types";
import { refreshTerms } from "@/lib/ingest/terms";
import { syncTerm } from "@/lib/ingest/sync";
import { syncDetails } from "@/lib/ingest/details";
import { deleteSectionDetails } from "@/lib/db/upsert";

const DETAILS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Tier B2 staleness boundary
const CRN_BATCH = 90; // keep IN(...) lists under the remote-D1 ~100 param cap

export interface RefreshOptions {
  /** Restrict to these term codes (e.g. e2e). Default: every is_view_only=0 term. */
  terms?: string[];
  /** Skip the leading refreshTerms() call (e.g. scoped e2e runs). Default false. */
  skipTermRefresh?: boolean;
  subjectDelayMs?: number;
  courseDelayMs?: number;
  /** Override "now" for the B2 staleness check (testing). Default Date.now(). */
  now?: number;
  log?: (msg: string) => void;
}

export interface TermRefreshSummary {
  term: string;
  syncStatus: "ok" | "partial" | "error";
  sections: number;
  newCrns: string[];
  droppedCrns: string[];
  structuralCrns: string[];
  /** CRNs whose details were re-fetched in B1 (new ∪ structural). */
  detailFetchedCrns: string[];
  /** True if the Tier B2 full-details pass ran this cycle. */
  detailsFullPass: boolean;
}

export interface RefreshResult {
  terms: TermRefreshSummary[];
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

async function mutableTermCodes(db: D1Like, only?: string[]): Promise<string[]> {
  let sql = "SELECT code FROM term WHERE is_view_only = 0";
  const binds: unknown[] = [];
  if (only && only.length > 0) {
    sql += ` AND code IN (${only.map(() => "?").join(",")})`;
    binds.push(...only);
  }
  sql += " ORDER BY code DESC";
  const { results } = await db.prepare(sql).bind(...binds).all<{ code: string }>();
  return results.map((r) => r.code);
}

/** Refreshes one term: Tier A sync + Tier B1 diff-driven details + Tier B2. */
export async function refreshTerm(
  db: D1Like,
  term: string,
  options: RefreshOptions = {}
): Promise<TermRefreshSummary> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now();

  // Tier A.
  const sync = await syncTerm(db, term, {
    collectDiff: true,
    subjectDelayMs: options.subjectDelayMs,
    log,
  });
  const diff = sync.diff ?? { newCrns: [], droppedCrns: [], structuralCrns: [] };
  const detailFetchedCrns = [...diff.newCrns, ...diff.structuralCrns];

  // Tier B1: re-fetch details for new + structural; delete dropped.
  if (detailFetchedCrns.length > 0) {
    for (const part of chunk(detailFetchedCrns, CRN_BATCH)) {
      await syncDetails(db, term, {
        crns: part,
        filters: false,
        courseDelayMs: options.courseDelayMs ?? 0,
        log,
      });
    }
  }
  if (diff.droppedCrns.length > 0) {
    await deleteSectionDetails(db, term, diff.droppedCrns);
  }

  // Tier B2: full details pass if stale.
  const row = await db
    .prepare("SELECT last_details_synced_at AS at FROM term WHERE code = ?")
    .bind(term)
    .first<{ at: number | null }>();
  const lastDetails = row?.at ?? 0;
  const detailsFullPass = now - lastDetails > DETAILS_MAX_AGE_MS;
  if (detailsFullPass) {
    await syncDetails(db, term, { courseDelayMs: options.courseDelayMs ?? 0, log });
  }

  return {
    term,
    syncStatus: sync.status,
    sections: sync.sections,
    newCrns: diff.newCrns,
    droppedCrns: diff.droppedCrns,
    structuralCrns: diff.structuralCrns,
    detailFetchedCrns,
    detailsFullPass,
  };
}

/** Refreshes every mutable term (or the given subset). */
export async function refreshMutableTerms(
  db: D1Like,
  options: RefreshOptions = {}
): Promise<RefreshResult> {
  const log = options.log ?? (() => {});
  if (!options.skipTermRefresh) {
    await refreshTerms(db);
  }
  const codes = await mutableTermCodes(db, options.terms);
  log(`[refresh] ${codes.length} mutable terms: ${codes.join(", ")}`);
  const terms: TermRefreshSummary[] = [];
  for (const code of codes) {
    terms.push(await refreshTerm(db, code, options));
  }
  return { terms };
}
