// src/workflows/refresh.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getDb } from "@/lib/db/binding";
import { refreshTerms } from "@/lib/ingest/terms";
import {
  DEFAULT_SUBJECTS_PER_SESSION,
  enumerateSyncSubjects,
  syncSubjectBatch,
} from "@/lib/ingest/sync";
import { refreshTermDetails } from "@/lib/ingest/refresh";
import { markTermSynced } from "@/lib/db/upsert";
import type { SectionDiff } from "@/lib/ingest/diff";

/**
 * Hourly scheduled refresh of non-view-only terms (docs/plans/scheduled-refresh.md).
 *
 * Each term is broken into bounded steps so no single step approaches the
 * 10-minute Cloudflare Workflow step timeout, even for the 9 k-section term:
 *
 *   1. enumerate ${code}   — one handshake → subject list (serializable).
 *   2. sync ${code} batch i/n — per-40-subject batch: one fresh session, delta-write,
 *                               returns BatchResult (serializable). Repeated for every
 *                               batch; diff/status accumulated from return values in
 *                               the Workflow body (NOT via closure mutation, which is
 *                               lost on resume).
 *   3. finalize ${code}    — markTermSynced with the aggregated status.
 *   4. details ${code}     — refreshTermDetails: Tier B1 (diff-driven, bounded by the
 *                            diff) + rolling Tier B2 (bounded by REFRESH_ROLLING_DETAIL_CRNS
 *                            default 250). Safe in one step.
 *   5. step.sleep          — 5-second pace before next term.
 *
 * Why bounded: a batch covers exactly one session's worth of subjects (~40). B1 is
 * bounded by structural/new CRNs; B2 is capped by the rolling-detail constant. No
 * step can blow the 10-min limit regardless of term size.
 *
 * Two deliberate scope notes:
 *   - Cold start: a never-backfilled term classifies every section as "new", so its
 *     one-time B1 details step can be large. In practice mutable terms are backfilled
 *     out-of-band (admin sync / sync-details) before the hourly sweep ever sees them,
 *     so the steady-state B1 diff is small; the 10-min step timeout is the backstop.
 *   - sync_run bookkeeping: unlike the CLI/admin syncTerm path, the bounded Workflow
 *     does not open/close a sync_run row (a run would span ~100 steps with retries in
 *     between). term.last_synced_at (set by markTermSynced in the finalize step) is the
 *     freshness signal for Workflow-driven runs.
 */

const STEP_OPTS = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

// One batch = one SIS session's worth of subjects; single-sourced from sync.ts so
// the Workflow's batch size can't silently diverge from syncTerm's session cadence.
const SUBJECTS_PER_BATCH = DEFAULT_SUBJECTS_PER_SESSION;

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export class RefreshWorkflow extends WorkflowEntrypoint {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const db = getDb();

    const codes = await step.do("refresh term list", async () => {
      await refreshTerms(db);
      const { results } = await db
        .prepare("SELECT code FROM term WHERE is_view_only = 0 ORDER BY code DESC")
        .all<{ code: string }>();
      return results.map((r) => r.code);
    });

    for (const code of codes) {
      // Step 1: enumerate subjects for this term (one handshake, returns serializable list).
      const subjects = await step.do(
        `enumerate ${code}`,
        STEP_OPTS,
        async () => enumerateSyncSubjects(db, code)
      );

      // Step 2: sync in per-40-subject batches. Each batch establishes its own session.
      // Accumulate diff and status from step RETURN VALUES (not closure mutation) so
      // Workflow resume replays correctly from cached step results.
      const batches = chunk(subjects, SUBJECTS_PER_BATCH);
      const aggDiff: SectionDiff = { newCrns: [], droppedCrns: [], structuralCrns: [] };
      let overallStatus: "ok" | "partial" = "ok";

      for (let i = 0; i < batches.length; i++) {
        const result = await step.do(
          `sync ${code} batch ${i + 1}/${batches.length}`,
          STEP_OPTS,
          async () => syncSubjectBatch(db, code, batches[i], { subjectDelayMs: 200 })
        );
        // Read from the returned (cached/replayed) value — safe across resumes.
        aggDiff.newCrns.push(...result.diff.newCrns);
        aggDiff.droppedCrns.push(...result.diff.droppedCrns);
        aggDiff.structuralCrns.push(...result.diff.structuralCrns);
        if (result.status === "partial") overallStatus = "partial";
      }

      // Step 3: mark term synced with aggregated status. Date.now() inside the
      // closure runs exactly once (step result is cached on retry/resume).
      await step.do(
        `finalize ${code}`,
        STEP_OPTS,
        async () => markTermSynced(db, code, overallStatus, Date.now())
      );

      // Step 4: Tier B1 diff-driven detail re-fetch + rolling Tier B2 (both bounded).
      await step.do(
        `details ${code}`,
        STEP_OPTS,
        async () => refreshTermDetails(db, code, aggDiff, { courseDelayMs: 200 })
      );

      // Pace before next term.
      await step.sleep(`pace after ${code}`, "5 seconds");
    }
  }
}
