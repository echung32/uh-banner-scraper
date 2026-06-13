/**
 * Scheduled refresh of non-view-only terms (docs/plans/scheduled-refresh.md).
 *
 * Tier A: full sync each mutable term (cheap; also refreshes seats/waitlist).
 * Tier B1: re-fetch course/section/instructor details for NEW + STRUCTURALLY
 *          changed CRNs from the Tier A diff; delete detail for DROPPED CRNs.
 * Tier B2: each run refreshes the K stalest detail CRNs (never-fetched first),
 *          bounded by REFRESH_ROLLING_DETAIL_CRNS (default 250). Catches
 *          fee/restriction/text edits the diff can't see. Driven hourly by
 *          RefreshWorkflow; also runnable from the CLI / admin route.
 *          Reuses syncTerm + syncDetails verbatim.
 */
import type { D1Like } from "@/lib/db/types";
import { refreshTerms } from "@/lib/ingest/terms";
import { syncTerm } from "@/lib/ingest/sync";
import { syncDetails } from "@/lib/ingest/details";
import { deleteSectionDetails } from "@/lib/db/upsert";
import { getStaleDetailCrns } from "@/lib/db/queries";
import type { SectionDiff } from "@/lib/ingest/diff";

const CRN_BATCH = 90; // keep IN(...) lists under the remote-D1 ~100 param cap

// Tier B2 rolling cap: max stale detail CRNs refreshed per term per run.
// Env-tunable via REFRESH_ROLLING_DETAIL_CRNS (default 250) so cadence can be
// changed live in the Cloudflare dashboard without a code deploy. Sized so even
// the largest term (~9k sections) cycles within a few days at hourly cadence
// (9170 / 250 ≈ 37 runs ≈ ~1.5 days). Bounded → no thundering full pass.
const DEFAULT_ROLLING_DETAIL_CRNS = 250;
function rollingDetailCrns(): number {
  const n = Number(process.env.REFRESH_ROLLING_DETAIL_CRNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ROLLING_DETAIL_CRNS;
}

export interface RefreshOptions {
  /** Restrict to these term codes (e.g. e2e). Default: every is_view_only=0 term. */
  terms?: string[];
  /** Skip the leading refreshTerms() call (e.g. scoped e2e runs). Default false. */
  skipTermRefresh?: boolean;
  subjectDelayMs?: number;
  courseDelayMs?: number;
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
  /** Count of CRNs whose details were rolled (Tier B2) this run. */
  detailsRolled: number;
  /** Tier A delta-write counts (rows actually written vs skipped). */
  writes: { inserted: number; structural: number; seatUpdated: number; deleted: number; unchanged: number };
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

export interface DetailRefreshOptions {
  courseDelayMs?: number;
  log?: (msg: string) => void;
}

/**
 * Tier B1 (diff-driven) + Tier B2 (rolling) detail refresh for one term.
 * B1: fetch details for new ∪ structural CRNs, delete details for dropped CRNs.
 * B2: refresh the K stalest detail CRNs (never-fetched first), bounded per run.
 * Shared by refreshTerm (CLI/admin) and the RefreshWorkflow details step.
 */
export async function refreshTermDetails(
  db: D1Like,
  term: string,
  diff: SectionDiff,
  options: DetailRefreshOptions = {}
): Promise<{ detailFetchedCrns: string[]; detailsRolled: number }> {
  const log = options.log ?? (() => {});
  const courseDelayMs = options.courseDelayMs ?? 0;

  // Tier B1: re-fetch details for new + structural; delete dropped.
  const detailFetchedCrns = [...diff.newCrns, ...diff.structuralCrns];
  if (detailFetchedCrns.length > 0) {
    for (const part of chunk(detailFetchedCrns, CRN_BATCH)) {
      await syncDetails(db, term, { crns: part, filters: false, courseDelayMs, log });
    }
  }
  if (diff.droppedCrns.length > 0) {
    await deleteSectionDetails(db, term, diff.droppedCrns);
  }

  // Tier B2 (rolling): refresh the stalest details, bounded per run. B1's CRNs
  // and the rolling set may overlap harmlessly (B1 just-fetched ones sort newest).
  const staleCrns = await getStaleDetailCrns(db, term, rollingDetailCrns());
  let detailsRolled = 0;
  for (const part of chunk(staleCrns, CRN_BATCH)) {
    await syncDetails(db, term, { crns: part, filters: false, courseDelayMs, log });
    detailsRolled += part.length;
  }

  return { detailFetchedCrns, detailsRolled };
}

/** Refreshes one term: Tier A sync + Tier B1 diff-driven details + rolling Tier B2. */
export async function refreshTerm(
  db: D1Like,
  term: string,
  options: RefreshOptions = {}
): Promise<TermRefreshSummary> {
  const log = options.log ?? (() => {});

  // Tier A.
  const sync = await syncTerm(db, term, {
    collectDiff: true,
    subjectDelayMs: options.subjectDelayMs,
    log,
  });
  const diff = sync.diff ?? { newCrns: [], droppedCrns: [], structuralCrns: [] };

  // Tier B1 + rolling B2.
  const { detailFetchedCrns, detailsRolled } = await refreshTermDetails(db, term, diff, {
    courseDelayMs: options.courseDelayMs,
    log,
  });

  return {
    term,
    syncStatus: sync.status,
    sections: sync.sections,
    newCrns: diff.newCrns,
    droppedCrns: diff.droppedCrns,
    structuralCrns: diff.structuralCrns,
    detailFetchedCrns,
    detailsRolled,
    writes: sync.writes ?? { inserted: 0, structural: 0, seatUpdated: 0, deleted: 0, unchanged: 0 },
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
