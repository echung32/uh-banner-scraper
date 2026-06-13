# Refresh Workflow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the hourly `RefreshWorkflow` bounded and resumable at any term size, so the 9,170-section term no longer blows the 10-minute step timeout. Replaces the monolithic per-term step (Tier A + B1 + full B2 in one step) with finer bounded steps, and replaces the thundering "full details pass when >7 days stale" with a rolling K-stalest-per-run refresh.

**Architecture:** Two changes. (1) **Tier A → subject-batch steps:** the Workflow enumerates a term's subjects, then runs one `step.do` per ~40-subject batch (one SIS session each — matches the existing handshake-rotation cadence, so zero extra handshakes), merging each batch's section-diff slice. (2) **Tier B2 → rolling:** each run refreshes the K stalest detail CRNs per term (`course_section LEFT JOIN section_detail ORDER BY COALESCE(section_detail.synced_at,0) ASC LIMIT K`, never-fetched first), sized so a term fully cycles within the freshness window. Drops `term.last_details_synced_at` (obsolete) and `markDetailsSynced`. Tier B1 (diff-driven details for new/changed CRNs) is unchanged.

**Tech Stack:** TypeScript, Astro + `@astrojs/cloudflare`, Cloudflare Workflows (per-step retry/timeout), D1, Playwright e2e against mock SIS.

**Context:** This hardens the feature shipped in PR #8 (merged to master). The first prod cron fired correctly at 11:00 UTC but errored — first on a missing migration (`0008`, now applied to remote), and structurally because the per-term step can't hold the 9k-term details pass. The cron was manually deleted in the dashboard; **it re-registers on the next deploy** (a new commit to master triggers Workers Builds). So this plan's merge re-enables the schedule.

**Reference:** `docs/plans/scheduled-refresh.md` (design, will be updated), `web/src/lib/ingest/{sync,details,refresh}.ts`, `web/src/workflows/refresh.ts`.

---

## File structure

**Create:**
- `web/migrations/0009_drop_term_details_synced.sql` — drop `term.last_details_synced_at`.

**Modify:**
- `web/src/lib/db/upsert.ts` — remove `markDetailsSynced`.
- `web/src/lib/ingest/details.ts` — remove the `markDetailsSynced` call + the scoped-vs-full stamping branch (keep `crns` scoping + full mode for the CLI).
- `web/src/lib/db/queries.ts` — add `getStaleDetailCrns(db, term, limit)` (the rolling-B2 cursor query).
- `web/src/lib/ingest/sync.ts` — factor `syncTerm` into composable pieces: `enumerateSyncSubjects`, `syncSubjectBatch` (sync N subjects in one session, return `{writes, diff}`), and keep `syncTerm` as a thin sequential wrapper (CLI/admin) built on them.
- `web/src/lib/ingest/refresh.ts` — `refreshTerm` uses rolling B2 instead of the `last_details_synced_at` full-pass; drop the `now`/7-day logic; env-tunable per-run cap (`REFRESH_ROLLING_DETAIL_CRNS`, default 250); update `TermRefreshSummary` (replace `detailsFullPass` with `detailsRolled` count).
- `web/src/pages/api/admin/refresh-run.ts` — drop the `now` param (no longer needed).
- `web/wrangler.jsonc` — add `REFRESH_ROLLING_DETAIL_CRNS` to `vars` (default "250"; dashboard-editable, no redeploy needed to tune).
- `web/.env.example` — document `REFRESH_ROLLING_DETAIL_CRNS`.
- `web/src/workflows/refresh.ts` — restructure `run()` into bounded steps: per term → enumerate-subjects step → subject-batch steps → B1 details step → rolling-B2 step.
- `web/e2e/ingest.spec.ts` + `web/e2e/mock-sis-server.mjs` — update the B2 assertions (rolling instead of full-pass + `now` override); add a rolling-B2 assertion.
- `CLAUDE.md`, `docs/plans/scheduled-refresh.md` — document the bounded-steps + rolling-B2 design.

---

## Task 1: Migration 0009 — drop `last_details_synced_at`; remove `markDetailsSynced`

**Files:**
- Create: `web/migrations/0009_drop_term_details_synced.sql`
- Modify: `web/src/lib/db/upsert.ts`, `web/src/lib/ingest/details.ts`

- [ ] **Step 1: Write the migration**

```sql
-- 0009_drop_term_details_synced.sql
-- Drops term.last_details_synced_at: the scheduled refresh switched from a
-- "full details pass when >7 days stale" (which this column gated) to a rolling
-- per-run refresh of the K stalest detail rows. The meaningful detail-freshness
-- signal is now MIN(section_detail.synced_at) per term, queried directly.
ALTER TABLE term DROP COLUMN last_details_synced_at;
```

- [ ] **Step 2: Apply locally + verify the column is gone**

Run:
```bash
cd /workspaces/uh-banner-scraper/web && yarn wrangler d1 migrations apply uh-course-search-db --local
yarn wrangler d1 execute uh-course-search-db --local --command "PRAGMA table_info(term);"
```
Expected: `last_details_synced_at` no longer listed.

- [ ] **Step 3: Remove `markDetailsSynced` from `upsert.ts`**

Delete the `markDetailsSynced` function (added in PR #8). Confirm nothing else imports it after Task 1 Step 4: `grep -rn "markDetailsSynced" src/`.

- [ ] **Step 4: Remove the stamping from `details.ts`**

In `syncDetails`, remove the `markDetailsSynced` import and the block:
```typescript
    if (!scoped && status !== "error") {
      await markDetailsSynced(db, term, Date.now());
    }
```
Keep everything else (the `crns` scoping, `scoped`/`doFilters` logic). A full pass now simply doesn't stamp anything term-level.

- [ ] **Step 5: Typecheck**

Run: `cd /workspaces/uh-banner-scraper/web && yarn build`
Expected: build succeeds. If it fails because `refresh.ts` still reads `last_details_synced_at`, that's fixed in Task 4 — but Task 1 must still compile, so if `refresh.ts`/`refresh-run.ts` reference the column or `markDetailsSynced`, leave those references until Task 4 ONLY IF they compile; if they break the build now, do Task 4's refresh.ts changes together with this task. (Recommended: implement Tasks 1+4+5 as one unit if the build can't be green in between — see note.) Prefer to make Task 1 self-contained by NOT yet removing column readers; but `markDetailsSynced` removal will break `details.ts` import only, which Step 4 handles. The column reader is in `refresh.ts` (Task 4).

> **Implementer note:** Tasks 1, 4, and the refresh-run/workflow changes are coupled (removing the column breaks `refresh.ts`'s B2 read). If you cannot get a green `yarn build` after Task 1 alone, implement Tasks 1→4→5 as a single commit sequence and run the build once at the end of Task 4. Do not leave the tree un-buildable across a commit boundary.

- [ ] **Step 6: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add web/migrations/0009_drop_term_details_synced.sql web/src/lib/db/upsert.ts web/src/lib/ingest/details.ts
git commit -m "$(printf 'refactor(db): drop term.last_details_synced_at (rolling B2 supersedes it)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Rolling-B2 cursor query — `getStaleDetailCrns`

**Files:**
- Modify: `web/src/lib/db/queries.ts`

- [ ] **Step 1: Add the query**

Add an exported function that returns the CRNs whose section detail is stalest (never-fetched first), bounded by `limit`:

```typescript
/**
 * The CRNs whose section detail is stalest for a term — the rolling Tier B2
 * cursor (docs/plans/scheduled-refresh.md). Never-fetched sections (no
 * section_detail row) sort first via COALESCE(...,0); then oldest synced_at.
 * Sized by the caller so a term fully cycles within the freshness window.
 */
export async function getStaleDetailCrns(
  db: D1Like,
  term: string,
  limit: number
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT cs.crn AS crn
         FROM course_section cs
         LEFT JOIN section_detail sd ON sd.term = cs.term AND sd.crn = cs.crn
        WHERE cs.term = ?
        ORDER BY COALESCE(sd.synced_at, 0) ASC, cs.crn ASC
        LIMIT ?`
    )
    .bind(term, limit)
    .all<{ crn: string }>();
  return results.map((r) => r.crn);
}
```

- [ ] **Step 2: Verify table/column names**

Run: `cd /workspaces/uh-banner-scraper/web && grep -n "CREATE TABLE section_detail" -A 8 migrations/0002_course_details.sql`
Confirm `section_detail` has `term`, `crn`, `synced_at`. (Confirmed in design — `synced_at INTEGER NOT NULL`.) Confirm `D1Like` is imported in queries.ts.

- [ ] **Step 3: Typecheck**

Run: `cd /workspaces/uh-banner-scraper/web && yarn build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add web/src/lib/db/queries.ts
git commit -m "$(printf 'feat(db): add getStaleDetailCrns rolling-B2 cursor query\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Factor `syncTerm` into composable subject-batch pieces

`syncTerm` currently handshakes once, enumerates subjects, loops them (rotating the session every `DEFAULT_SUBJECTS_PER_SESSION`=40), delta-writes each, and finalizes (`markTermSynced` + `sync_run`). To let the Workflow drive one step per session-batch, expose the batch as a callable unit while keeping `syncTerm` working for the CLI/admin.

**Files:**
- Modify: `web/src/lib/ingest/sync.ts`

- [ ] **Step 1: Read the current `syncTerm` and note the pieces**

Run: `cd /workspaces/uh-banner-scraper/web && cat src/lib/ingest/sync.ts`
Identify: subject enumeration (`getSubjects`), the per-subject delta-write loop (with `classifyForWrite` + the 4 delta writers + diff accumulation), session rotation, and finalization (`markTermSynced`, `startSyncRun`/`finishSyncRun`).

- [ ] **Step 2: Export `enumerateSyncSubjects`**

Add a small exported function that does one handshake and returns the subject list (and upserts the subject menu, as `syncTerm` does today):
```typescript
/** Enumerate a term's subjects (one handshake) and persist the subject menu. */
export async function enumerateSyncSubjects(
  db: D1Like,
  termCode: string
): Promise<{ code: string }[]> {
  const session = await establishSession(termCode);
  const subjects = await getSubjects(session, termCode);
  await upsertSubjects(db, termCode, subjects);
  return subjects;
}
```
(Match the real `getSubjects`/`upsertSubjects` return shapes — `subjects` is likely `{code, description}[]`; return that type.)

- [ ] **Step 3: Export `syncSubjectBatch`**

Add an exported function that syncs a given list of subjects in ONE fresh session and returns the write counts + diff slice. Extract the per-subject body from `syncTerm`'s loop (the delta-write: `fetchAllSections` → `readSubjectRawJson` → `classifyForWrite` → delete/insert/update writers → diff accumulation), including the per-subject retry/re-handshake-on-failure logic, but WITHOUT term-level finalization:

```typescript
export interface BatchResult {
  writes: SyncWrites;            // reuse the existing SyncWrites shape
  diff: SectionDiff;             // new/dropped/structural for this batch
  subjectsDone: number;
  status: "ok" | "partial";
}

/** Sync one batch of subjects in a single fresh session. No term-level finalize. */
export async function syncSubjectBatch(
  db: D1Like,
  termCode: string,
  subjects: { code: string }[],
  options: { subjectDelayMs?: number; log?: (m: string) => void } = {}
): Promise<BatchResult> {
  // establishSession once; loop subjects with the existing per-subject retry +
  // delta-write + diff accumulation; accumulate writes/diff; return them.
}
```
Reuse the EXACT delta-write block already in `syncTerm` (Task 11 of the prior PR) — do not reinvent it. The session is established once per batch (a batch = one session's worth of subjects). The per-subject failure retry can re-handshake within the batch (as today).

- [ ] **Step 4: Reimplement `syncTerm` on top of the new pieces (CLI/admin path)**

Keep `syncTerm`'s public signature and `SyncResult` shape. Reimplement its body as: `startSyncRun` → `enumerateSyncSubjects` → split subjects into batches of `subjectsPerSession` → for each batch call `syncSubjectBatch` (accumulate writes/diff/status/sections) → `markTermSynced` → `finishSyncRun` → return `SyncResult` (with `diff` when `collectDiff`, and `writes`). This preserves CLI/admin behavior exactly while sharing the batch logic the Workflow will step over.

- [ ] **Step 5: Typecheck + run the ingest e2e (regression guard for delta write + diff)**

Run:
```bash
cd /workspaces/uh-banner-scraper/web && yarn build
yarn test --project=chromium e2e/ingest.spec.ts 2>&1 | tail -6
```
Expected: build clean; ingest e2e still green (the admin sync test drives `syncTerm` → now batched internally; counts unchanged). The B2-related tests may still reference `now`/`detailsFullPass` — those are updated in Task 6; if they fail on that, proceed to Task 6 and re-run. The Tier-A/delta/diff assertions must stay green.

- [ ] **Step 6: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add web/src/lib/ingest/sync.ts
git commit -m "$(printf 'refactor(ingest): factor syncTerm into enumerateSyncSubjects + syncSubjectBatch\n\nLets the Workflow drive Tier A as one bounded step per session-batch;\nsyncTerm keeps its signature for the CLI/admin path.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Rolling B2 in `refreshTerm`; drop the full-pass trigger

**Files:**
- Modify: `web/src/lib/ingest/refresh.ts`, `web/src/pages/api/admin/refresh-run.ts`

- [ ] **Step 1: Add the rolling refresh + an env-tunable per-run cap**

In `refresh.ts`:
```typescript
import { getStaleDetailCrns } from "@/lib/db/queries";

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
```
(Read via `process.env` to match the repo's config pattern — `nodejs_compat_populate_process_env` surfaces wrangler `vars` on `process.env`; same as `DYNAMIC_SYNC`/`SECTION_LAZY_FETCH`.)

- [ ] **Step 2: Replace the B2 block in `refreshTerm`**

Remove the `last_details_synced_at` read + `detailsFullPass` + `now` logic. After Tier A + B1, add:
```typescript
  // Tier B2 (rolling): refresh the stalest details, bounded per run.
  const staleCrns = await getStaleDetailCrns(db, term, rollingDetailCrns());
  let detailsRolled = 0;
  for (const part of chunk(staleCrns, CRN_BATCH)) {
    await syncDetails(db, term, {
      crns: part,
      filters: false,
      courseDelayMs: options.courseDelayMs ?? 0,
      log,
    });
    detailsRolled += part.length;
  }
```
(`CRN_BATCH`=90 and `chunk` already exist in refresh.ts. Note B1's `detailFetchedCrns` and the rolling set may overlap; that's harmless — B1 fetched the just-changed ones, rolling covers the stalest. If you want to avoid the small double-fetch, subtract `detailFetchedCrns` from `staleCrns` before chunking; optional, keep simple unless trivial.)

- [ ] **Step 3: Update `TermRefreshSummary` and `RefreshOptions`**

- Remove `detailsFullPass: boolean` from `TermRefreshSummary`; add `detailsRolled: number` (count of CRNs whose details were rolled this run).
- Remove `now?: number` from `RefreshOptions` (no longer used).
- Populate `detailsRolled` in the returned summary.

- [ ] **Step 4: Drop the `now` param from the admin route**

In `refresh-run.ts`, remove the `now` query-param parsing and the `now` field passed to `refreshMutableTerms`.

- [ ] **Step 5: Register the env var (`REFRESH_ROLLING_DETAIL_CRNS`)**

So prod has an explicit, dashboard-editable value and dev/example documents it:
1. `web/wrangler.jsonc` — add to the `vars` block: `"REFRESH_ROLLING_DETAIL_CRNS": "250"`. (Editable live in the Cloudflare dashboard → Settings → Variables, so cadence can change without a code deploy; mind JSONC comma validity.)
2. `web/.env.example` — add a documented line: `REFRESH_ROLLING_DETAIL_CRNS=250  # Tier B2 rolling cap: stalest detail CRNs refreshed per term per hourly run`.
   (Confirm `.env.example` exists: `ls web/.env.example`. If it doesn't, skip this sub-step and note it.)
Do NOT hard-require it — `rollingDetailCrns()` already defaults to 250 when unset/invalid, so behavior is unchanged if the var is absent.

- [ ] **Step 6: Typecheck**

Run: `cd /workspaces/uh-banner-scraper/web && yarn build`
Expected: build clean (this resolves any `last_details_synced_at` reader left from Task 1).

- [ ] **Step 7: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add web/src/lib/ingest/refresh.ts web/src/pages/api/admin/refresh-run.ts web/wrangler.jsonc web/.env.example
git commit -m "$(printf 'feat(ingest): rolling Tier B2 (env-tunable K stalest details/run) replacing full-pass trigger\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Restructure `RefreshWorkflow` into bounded steps

**Files:**
- Modify: `web/src/workflows/refresh.ts`

- [ ] **Step 1: Rewrite `run()` to step over subject-batches + rolling B2**

Replace the single per-term `step.do(refreshTerm)` with finer steps. Per term:
1. `step.do("enumerate {term}")` → `enumerateSyncSubjects(db, term)` → returns subject codes (serializable).
2. For each batch of `SUBJECTS_PER_BATCH` (=40) subjects: `step.do("sync {term} batch {i}")` → `syncSubjectBatch(db, term, batch, {subjectDelayMs:200})` → returns `{writes, diff, status}` (serializable). Accumulate the diff across batches in the Workflow (concatenate `newCrns`/`droppedCrns`/`structuralCrns`).
3. After all batches: `step.do("finalize {term}")` → `markTermSynced(db, term, status, Date.now())` (overall status = "partial" if any batch was partial, else "ok").
4. `step.do("details {term}")` → run B1 (details for accumulated new∪structural CRNs, chunked) + rolling B2 (`getStaleDetailCrns` + scoped `syncDetails`), each call bounded. (B1+B2 here is small/bounded; one step is fine. If a term's B1 diff is unusually large, chunk into multiple steps by CRN batch.)
5. `step.sleep("pace after {term}", "5 seconds")`.

Each `step.do` has `{ retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" }`. Every step is now bounded: a batch is ≤40 subjects (one session), the details step is ≤`ROLLING_DETAIL_CRNS`+diff CRNs.

Import the needed functions: `enumerateSyncSubjects`, `syncSubjectBatch` from `@/lib/ingest/sync`; `markTermSynced` from `@/lib/db/upsert`; the B1/rolling-B2 helper from `@/lib/ingest/refresh` (export a `refreshTermDetails(db, term, diff, opts)` from refresh.ts that does B1 + rolling B2, so the Workflow and the CLI/admin path share it). Keep `refreshTerms(db)` as step 1 (term-list refresh + mutable codes).

> **Implementer note:** to share B1+rolling-B2 between the Workflow step and the in-process `refreshTerm` (CLI/admin), factor that logic into an exported `refreshTermDetails(db, term, diff, opts): Promise<{detailFetchedCrns, detailsRolled}>` in `refresh.ts`, and call it from both `refreshTerm` (Task 4) and the Workflow details step. Adjust Task 4 to use it.

- [ ] **Step 2: Typecheck**

Run: `cd /workspaces/uh-banner-scraper/web && yarn build`
Expected: build clean; `RefreshWorkflow` bundles (check `dist/server` includes it as before).

- [ ] **Step 3: Confirm the worker entry + binding still resolve**

Run: `yarn test --project=chromium e2e/search.spec.ts 2>&1 | tail -3`
Expected: read-path e2e passes (the custom worker entry is unchanged; only the Workflow body changed).

- [ ] **Step 4: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add web/src/workflows/refresh.ts web/src/lib/ingest/refresh.ts
git commit -m "$(printf 'feat(worker): RefreshWorkflow drives bounded subject-batch + rolling-detail steps\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Update e2e for rolling B2

**Files:**
- Modify: `web/e2e/ingest.spec.ts` (and `mock-sis-server.mjs` if needed)

- [ ] **Step 1: Replace the B2 full-pass test with a rolling-B2 assertion**

The prior "stale details trigger a full pass" test used the `now=+8d` override and asserted `detailsFullPass===true`. Remove that. Replace with a test that asserts the rolling refresh:
- After the B1 test (mock at phase 2, 202730 synced), run `refresh-run?term=202730&delayMs=0` again.
- Assert the summary now reports `detailsRolled > 0` (the rolling pass refreshed stale detail CRNs) and no `detailsFullPass` field exists.
- Optionally assert that a section whose detail was stale/never-fetched now has a `section_detail` row (GET `/api/section` 200), demonstrating the rolling fill.

Keep the B1 test's diff/`writes` assertions (still valid). Update any reference to `detailsFullPass` in the B1 test to `detailsRolled` semantics (the B1 test asserted `detailsFullPass===false`; now assert `typeof summary.detailsRolled === "number"` or a specific small count — derive from the mock's 9 sections and `ROLLING_DETAIL_CRNS`=250, so all 9 roll: `detailsRolled` likely equals the term's section count when under the cap. Verify against actual output and set the exact expectation.)

- [ ] **Step 2: Run the ingest e2e and fix counts to reality**

Run: `cd /workspaces/uh-banner-scraper/web && yarn test --project=chromium e2e/ingest.spec.ts 2>&1 | tail -8`
Expected: all pass. With the mock term ~9 sections < cap 250, every run rolls all detail CRNs — so `detailsRolled` should equal the term's section count (9 for the all-subjects 202730, or the ICS-subset if scoped). Read the actual value from a failing assertion and set it exactly; do not loosen.

- [ ] **Step 3: Commit**

```bash
cd /workspaces/uh-banner-scraper
git add web/e2e/ingest.spec.ts web/e2e/mock-sis-server.mjs
git commit -m "$(printf 'test(e2e): assert rolling Tier B2 (detailsRolled) instead of full-pass trigger\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Docs

**Files:**
- Modify: `docs/plans/scheduled-refresh.md`, `CLAUDE.md`

- [ ] **Step 1: Update the design doc**

In `docs/plans/scheduled-refresh.md`: update the Orchestration + Tier B sections to describe (a) Tier A as bounded subject-batch steps, (b) Tier B2 as a rolling K-stalest-per-run refresh (not a >7-day full pass), and (c) that `last_details_synced_at` was dropped (migration 0009) in favor of `MIN(section_detail.synced_at)`. Add a short "Hardening (post-merge)" note explaining the first-prod-run timeout that motivated this.

- [ ] **Step 2: Update CLAUDE.md**

Adjust the `refresh.ts`/Workflow description to: bounded subject-batch Tier A steps + rolling Tier B2; remove the `last_details_synced_at`/0008 mention (note 0009 drops it) and the B2 "weekly full pass" phrasing. Add `REFRESH_ROLLING_DETAIL_CRNS` to the env-vars sentence (the one listing `SIS_BASE_URL`, `DYNAMIC_SYNC`, etc.) — "Tier B2 rolling cap, default 250."

- [ ] **Step 3: Typecheck (docs-only, but safe) + commit**

```bash
cd /workspaces/uh-banner-scraper/web && yarn build 2>&1 | tail -2
cd /workspaces/uh-banner-scraper
git add docs/plans/scheduled-refresh.md CLAUDE.md
git commit -m "$(printf 'docs: bounded-steps + rolling-B2 refresh hardening\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Post-merge verification (after deploy re-registers the cron)

- [ ] Confirm Workers Builds deployed the merge (the new commit re-creates the cron schedule).
- [ ] Wait for the top of the next hour; `wrangler workflows instances list uh-course-search-refresh` shows a new instance.
- [ ] `wrangler workflows instances describe ... latest` → status ✅, with steps: `refresh term list`, per-term `enumerate`/`sync … batch N`/`finalize`/`details`. No step near the 10-min timeout.
- [ ] Spot-check D1: the 4 mutable terms' `last_synced_at` advanced; `MIN(section_detail.synced_at)` for 202710 is climbing run-over-run (rolling B2 cycling).
- [ ] Confirm one run completes well within the hour (no overlapping instances).

---

## Coverage map (plan ↔ goal)

| Goal | Task |
| --- | --- |
| No step exceeds the timeout at any term size | 3 (subject-batch units), 5 (bounded steps) |
| B2 no longer a thundering full pass | 2 (cursor), 4 (rolling), 5 (bounded details step) |
| Drop obsolete `last_details_synced_at` | 1 |
| CLI/admin path still works | 3 (syncTerm wrapper), 4 (refresh-run) |
| Tests reflect rolling B2 | 6 |
| Docs accurate | 7 |
| Re-enable cron | deploy on merge (Workers Builds) |

---

## PR description (use verbatim as the PR body when finishing the branch)

> **Title:** `fix: harden scheduled refresh — bounded steps + rolling Tier B2`

```markdown
## Summary

The hourly `RefreshWorkflow` (PR #8) errored on its first prod run: first on a
missing migration (`0008`, since applied to remote), and structurally because a
single per-term step ran Tier A + B1 + a *full* Tier B2 details pass — the 9,170-
section term's details pass is ~2 hours of paced Banner requests, far past the
10-minute step timeout. This PR makes every step bounded and replaces the
thundering full-details pass with a rolling, incremental one.

### Changes
- **Tier A → subject-batch steps.** The Workflow enumerates a term's subjects, then
  runs one step per ~40-subject batch (one SIS session each — matches the existing
  handshake-rotation cadence, so zero extra handshakes). Resumable + timeout-proof
  at any term size.
- **Tier B2 → rolling.** Each run refreshes the K stalest detail CRNs per term
  (`COALESCE(section_detail.synced_at, 0) ASC`, never-fetched first), bounded by
  `REFRESH_ROLLING_DETAIL_CRNS` (default 250, dashboard-editable). Replaces the
  ">7-day full pass" trigger; the freshness signal is now `MIN(section_detail.synced_at)`.
- **Dropped `term.last_details_synced_at`** (migration `0009`) + `markDetailsSynced` —
  obsolete under rolling B2.
- Tier B1 (diff-driven details for new/changed CRNs) unchanged.

### What one hourly run does

| Tier | What | Scope per run | A given section is touched | Freshness SLA |
|---|---|---|---|---|
| **A** full sync | re-fetch every section, delta-write changes (seats, meetings, faculty, …) | whole term | every hour | ~1 hour |
| **B1** diff-driven details | fetch details for sections that changed structurally this run | only what changed (often ~0) | when it changes | ~1 hour after a visible change |
| **B2** rolling details | refresh the K stalest detail rows (catches invisible fee/restriction/text edits; fills never-viewed) | a K-CRN slice/term | once per full cycle | = cycle time (< 7 days) |

**B2 cycle time** at K=250/term/run, hourly:

| Term | Sections | Runs to cycle | ≈ time to refresh every detail once |
|---|---|---|---|
| 202713 | 203 | 1 | every hour |
| 202640 | 1,965 | ~8 | ~8 hours |
| 202710 | 9,170 | ~37 | ~1.5 days |

A full run is ~10–18 min (every step bounded; nothing near the 10-min timeout) and
finishes well before the next hourly fire, so instances never overlap. Tune cadence
via `REFRESH_ROLLING_DETAIL_CRNS` (no redeploy — edit in the CF dashboard).

## Test Plan
- [ ] `yarn build` clean; full chromium e2e green (ingest + search)
- [ ] e2e asserts rolling B2 (`detailsRolled`) + the existing delta-write counts
- [ ] Post-merge: deploy re-registers the `0 * * * *` cron; the next top-of-hour
      instance completes ✅ with bounded `enumerate`/`sync … batch N`/`finalize`/`details`
      steps; `MIN(section_detail.synced_at)` for 202710 climbs run-over-run

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

(When completing the branch, create the PR with this block as the body — it's the canonical timeline/timeframe writeup the change is responsible for communicating.)
