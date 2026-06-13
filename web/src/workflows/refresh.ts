// src/workflows/refresh.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getDb } from "@/lib/db/binding";
import { refreshTerms } from "@/lib/ingest/terms";
import { refreshTerm } from "@/lib/ingest/refresh";

/**
 * Hourly scheduled refresh of non-view-only terms (docs/plans/scheduled-refresh.md).
 * One step per term keeps the in-memory SIS session/rotation logic in syncTerm
 * intact (a session object can't cross step boundaries) while giving term-level
 * resumability + retry. Tier A full sync (~200-400 reqs/term) is well under the
 * step timeout and the Worker subrequest budget; Tier B1/B2 details run inside
 * the same per-term step via refreshTerm. step.sleep paces between terms.
 */
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
      // Per-term step: Tier A sync + Tier B1 diff-driven details + Tier B2. Its
      // returned summary is the step's (serializable) result, so a retry resumes
      // at this term rather than re-running earlier terms.
      await step.do(
        `refresh ${code}`,
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => refreshTerm(db, code, { subjectDelayMs: 200, courseDelayMs: 200 })
      );
      await step.sleep(`pace after ${code}`, "5 seconds");
    }
  }
}
