# Scheduled Metadata Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep non-view-only Banner terms fresh automatically via an hourly cron-triggered Cloudflare Workflow — Tier A full-sync (cheap, covers seats), Tier B diff-driven detail re-fetch, and a weekly full-details safety net.

**Architecture:** A `RefreshWorkflow` (`WorkflowEntrypoint`) runs hourly. Each run refreshes the term list, then for every `is_view_only = 0` term: runs `syncTerm` (now also computing a section-core diff), re-fetches `section_detail`/catalog/instructors only for new + structurally-changed CRNs (B1), deletes detail for dropped CRNs, and runs a full `syncDetails` pass if the term's details are >7 days stale (B2). All orchestration lives in a plain async function `refreshMutableTerms` in `src/lib/ingest/refresh.ts`; the Workflow class is a thin `step.do` wrapper, and an admin route exposes the same function for e2e (the established testing pattern — Workflows infra isn't available under `astro preview`).

**Tech Stack:** TypeScript, Astro SSR + `@astrojs/cloudflare` v13 adapter, Cloudflare Workers + Workflows + cron triggers, D1, Playwright e2e against a mock SIS server. No unit-test runner exists — pure logic is verified through the e2e integration path.

**Reference docs:** `docs/plans/scheduled-refresh.md` (design), `docs/plans/course-details.md` (details model), `docs/walkthrough.md` (SIS handshake).

---

## File structure

**Create:**
- `web/migrations/0008_term_details_synced.sql` — adds `last_details_synced_at` to `term`.
- `web/src/lib/ingest/diff.ts` — pure section-core diff classifier (`classifySectionChanges`, `structuralFingerprint`).
- `web/src/lib/ingest/refresh.ts` — `refreshMutableTerms` orchestrator (Tier A + B1 + B2).
- `web/src/pages/api/admin/refresh-run.ts` — secret-guarded admin route that calls `refreshMutableTerms` (manual trigger + e2e hook).
- `web/src/worker.ts` — custom Worker entry: re-exports the adapter's `handle` as `fetch` and the `RefreshWorkflow` class.
- `web/src/workflows/refresh.ts` — `RefreshWorkflow` (`WorkflowEntrypoint`) wrapping `refreshMutableTerms` in steps.

**Modify:**
- `web/src/lib/ingest/sync.ts` — `syncTerm` gains a `collectDiff` option; accumulates a `SectionDiff` across subjects and returns it.
- `web/src/lib/ingest/details.ts` — `syncDetails` gains an optional `crns` scope (B1) and only stamps `last_details_synced_at` on a full (unscoped) pass (B2).
- `web/src/lib/db/upsert.ts` — add `markDetailsSynced` and `deleteSectionDetails`.
- `web/scripts/ingest.ts` — add a `refresh-run` CLI command (Node parity for manual runs/backfill).
- `web/wrangler.jsonc` — point `main` at `./src/worker.ts`, add the `workflows` binding with `schedules`, raise `limits.subrequests`.
- `web/e2e/mock-sis-server.mjs` — add a second catalog phase + a `POST /__mock/advance` control so a re-sync produces a diff.
- `web/e2e/ingest.spec.ts` — add refresh-pipeline tests (B1 classification + B2 trigger).
- `web/e2e/global-setup.ts` — ensure the refresh test term is non-view-only and stamp its `last_details_synced_at` for the B1 (fresh) vs B2 (stale) scenarios.
- `CLAUDE.md` and `docs/plans/scheduled-refresh.md` — document the shipped pipeline; flip status to shipped.

---

## Task 1: Migration — `last_details_synced_at` on `term`

**Files:**
- Create: `web/migrations/0008_term_details_synced.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0008_term_details_synced.sql
-- Tracks the last FULL course-details pass per term, so the scheduled refresh
-- (docs/plans/scheduled-refresh.md, Tier B2) knows when a term's low-volatility
-- details (restrictions/fees/text/instructors) are >7 days stale and need a
-- full re-fetch. NULL = never had a full details pass.
ALTER TABLE term ADD COLUMN last_details_synced_at INTEGER;
```

- [ ] **Step 2: Apply locally and verify the column exists**

Run:
```bash
cd web && yarn wrangler d1 migrations apply uh_sis --local
yarn wrangler d1 execute uh_sis --local --command "PRAGMA table_info(term);"
```
Expected: output lists a `last_details_synced_at` column.

- [ ] **Step 3: Commit**

```bash
git add web/migrations/0008_term_details_synced.sql
git commit -m "feat(db): add term.last_details_synced_at for scheduled details refresh"
```

---

## Task 2: `markDetailsSynced` + `deleteSectionDetails` in upsert.ts

**Files:**
- Modify: `web/src/lib/db/upsert.ts`

- [ ] **Step 1: Add the two helpers**

Append near the other `term`-stamping helpers (after `markSeatRefresh`):

```typescript
/** Stamps a term's last FULL course-details pass (Tier B2 boundary). */
export async function markDetailsSynced(
  db: D1Like,
  term: string,
  syncedAt: number
): Promise<void> {
  await db
    .prepare("UPDATE term SET last_details_synced_at = ? WHERE code = ?")
    .bind(syncedAt, term)
    .run();
}

/** Removes section_detail rows for CRNs that no longer exist in a term. */
export async function deleteSectionDetails(
  db: D1Like,
  term: string,
  crns: string[]
): Promise<number> {
  if (crns.length === 0) return 0;
  let deleted = 0;
  // Chunk to respect the remote-D1 ~100-param limit (see CLAUDE.md).
  for (const part of chunk(crns, 90)) {
    const placeholders = part.map(() => "?").join(",");
    await db
      .prepare(`DELETE FROM section_detail WHERE term = ? AND crn IN (${placeholders})`)
      .bind(term, ...part)
      .run();
    deleted += part.length;
  }
  return deleted;
}
```

- [ ] **Step 2: Confirm `chunk` is already imported/defined in upsert.ts**

Run: `grep -n "function chunk\|chunk(" web/src/lib/db/upsert.ts | head`
Expected: `chunk` is already defined in this file (used by `replaceSubjectSections`). If not, add `function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; }`.

- [ ] **Step 3: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds (this is the real typecheck — `astro check` doesn't resolve under PnP).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/db/upsert.ts
git commit -m "feat(db): add markDetailsSynced and deleteSectionDetails"
```

---

## Task 3: Section-core diff classifier (`diff.ts`)

The diff distinguishes **new** / **dropped** / **structurally-changed** CRNs, excluding the always-moving seat fields so routine enrollment churn never triggers a detail re-fetch.

**Files:**
- Create: `web/src/lib/ingest/diff.ts`

- [ ] **Step 1: Write the classifier**

```typescript
/**
 * Section-core diff for the scheduled refresh (docs/plans/scheduled-refresh.md,
 * Tier B1). A Tier A full sync re-pulls every section's searchResults row; this
 * classifies each CRN as new / dropped / structurally-changed so only meaningful
 * changes trigger an (expensive) detail re-fetch.
 *
 * "Structural" deliberately EXCLUDES the seat/enrollment fields, which change on
 * almost every sync as students register and would otherwise make every section
 * look changed. The detail endpoints (restrictions/fees/cross-list/text) never
 * depend on seat counts, so a seat-only delta is correctly ignored here.
 */
import type { CourseSection } from "@/lib/sis/types";

export interface SectionDiff {
  newCrns: string[];
  droppedCrns: string[];
  structuralCrns: string[];
}

/**
 * Deterministic fingerprint of the section-detail-relevant fields. Built from an
 * explicit allow-list (not a deny-list) so adding a volatile field to
 * CourseSection later can't silently start triggering refetches. Seat fields
 * (enrollment, seatsAvailable, waitCount, waitCapacity, waitAvailable,
 * openSection) are intentionally absent.
 */
export function structuralFingerprint(s: CourseSection): string {
  return JSON.stringify({
    title: s.courseTitle,
    schedule: s.scheduleTypeDescription,
    credits: [s.creditHours, s.creditHourLow, s.creditHourHigh],
    partOfTerm: s.partOfTerm,
    campus: s.campusDescription,
    subjectCourse: s.subjectCourse,
    seq: s.sequenceNumber,
    link: [s.linkIdentifier, s.isSectionLinked],
    attrs: (s.sectionAttributes ?? [])
      .map((a) => a.code)
      .slice()
      .sort(),
    faculty: (s.faculty ?? [])
      .map((f) => `${f.bannerId ?? ""}:${f.displayName ?? ""}`)
      .slice()
      .sort(),
    meetings: (s.meetingsFaculty ?? [])
      .map((m) => {
        const mt = m.meetingTime ?? {};
        return [
          mt.beginTime, mt.endTime, mt.building, mt.room,
          mt.monday, mt.tuesday, mt.wednesday, mt.thursday,
          mt.friday, mt.saturday, mt.sunday,
        ].join("|");
      })
      .slice()
      .sort(),
  });
}

export function classifySectionChanges(
  existing: CourseSection[],
  incoming: CourseSection[]
): SectionDiff {
  const existingByCrn = new Map(existing.map((s) => [s.courseReferenceNumber, s]));
  const incomingByCrn = new Map(incoming.map((s) => [s.courseReferenceNumber, s]));

  const newCrns: string[] = [];
  const structuralCrns: string[] = [];
  for (const [crn, inc] of incomingByCrn) {
    const prev = existingByCrn.get(crn);
    if (!prev) {
      newCrns.push(crn);
    } else if (structuralFingerprint(prev) !== structuralFingerprint(inc)) {
      structuralCrns.push(crn);
    }
  }
  const droppedCrns: string[] = [];
  for (const crn of existingByCrn.keys()) {
    if (!incomingByCrn.has(crn)) droppedCrns.push(crn);
  }
  return { newCrns, droppedCrns, structuralCrns };
}
```

- [ ] **Step 2: Verify the CourseSection field names used above match the type**

Run: `cd web && sed -n '/interface CourseSection/,/^}/p' src/lib/sis/types.ts`
Expected: confirm `courseTitle`, `scheduleTypeDescription`, `creditHours`/`creditHourLow`/`creditHourHigh`, `partOfTerm`, `campusDescription`, `subjectCourse`, `sequenceNumber`, `linkIdentifier`, `isSectionLinked`, `sectionAttributes` (array of `{code,description}`), `faculty`, `meetingsFaculty` exist. If `faculty`/`meetingsFaculty` element shapes differ (e.g. `meetingTime` nesting, `bannerId`/`displayName` names), adjust the projection to the real field names — the goal is a stable string over those values, exact accessor names must match the type.

- [ ] **Step 3: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds. If field-name mismatches surface, fix per Step 2 and rebuild.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/ingest/diff.ts
git commit -m "feat(ingest): add section-core diff classifier (new/dropped/structural)"
```

> The classifier's behavior is verified end-to-end in Task 8 (the repo has no unit runner; the e2e integration against the mock catalog is the regression guard, consistent with how `resetDataForm` is tested).

---

## Task 4: `syncTerm` computes the diff

`syncTerm` already reads incoming sections per `(term, subject)` and delete-replaces them. To diff, read the **existing** rows for that subject *before* the replace, classify, and accumulate across subjects.

**Files:**
- Modify: `web/src/lib/ingest/sync.ts`

- [ ] **Step 1: Add imports and a read helper at the top of sync.ts**

Add to the existing imports:
```typescript
import { rowToCourseSection } from "@/lib/db/mappers";
import { classifySectionChanges, type SectionDiff } from "@/lib/ingest/diff";
```

Add this helper (near `fetchAllSections`):
```typescript
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
```

- [ ] **Step 2: Extend `SyncOptions` and `SyncResult`**

```typescript
export interface SyncOptions {
  subjectDelayMs?: number;
  subjectsPerSession?: number;
  log?: (msg: string) => void;
  /** Accumulate a section-core diff across subjects (Tier B1). Default false. */
  collectDiff?: boolean;
}

export interface SyncResult {
  term: string;
  subjects: number;
  sections: number;
  status: "ok" | "partial" | "error";
  /** Present only when collectDiff was set; aggregated across all subjects. */
  diff?: SectionDiff;
}
```

- [ ] **Step 3: Accumulate the diff inside the subject loop**

In `syncTerm`, declare an accumulator before the loop:
```typescript
const collectDiff = options.collectDiff ?? false;
const diff: SectionDiff = { newCrns: [], droppedCrns: [], structuralCrns: [] };
```

Inside the per-subject `for (let attempt...)` success branch, *before* calling `replaceSubjectSections`, capture existing rows and classify. Replace the existing success block:
```typescript
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
```

- [ ] **Step 4: Return the diff**

Change the final return:
```typescript
  return {
    term: termCode,
    subjects: subjectsDone,
    sections: totalSections,
    status,
    ...(collectDiff ? { diff } : {}),
  };
```

- [ ] **Step 5: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/ingest/sync.ts
git commit -m "feat(ingest): syncTerm computes section-core diff when collectDiff set"
```

---

## Task 5: Scope `syncDetails` by CRN set + stamp full passes

B1 re-fetches details for only the changed CRNs; B2 runs the full pass and stamps `last_details_synced_at`. Both reuse `syncDetails` by adding an optional `crns` scope.

**Files:**
- Modify: `web/src/lib/ingest/details.ts`

- [ ] **Step 1: Add `crns` to `DetailsOptions` and import `markDetailsSynced`**

Add to the `upsert` import in details.ts: `markDetailsSynced`.

Add to `DetailsOptions`:
```typescript
  /**
   * Restrict the catalog / section-detail / instructor passes to these CRNs
   * (Tier B1 diff-driven refresh). When set, the term-level filter-option pass
   * is skipped and last_details_synced_at is NOT stamped (it's a partial pass).
   * Undefined = full term pass (Tier B2), which stamps last_details_synced_at.
   */
  crns?: string[];
```

- [ ] **Step 2: Thread `crns` into the section-detail query**

In `syncSectionDetails`, change the section-loading query to optionally filter by CRN:
```typescript
async function syncSectionDetails(
  db: D1Like,
  session: SisSession,
  term: string,
  delayMs: number,
  log: (m: string) => void,
  crns?: string[]
): Promise<{ done: number; status: "ok" | "partial"; session: SisSession }> {
  let sql = "SELECT crn FROM course_section WHERE term = ?";
  const binds: unknown[] = [term];
  if (crns && crns.length > 0) {
    sql += ` AND crn IN (${crns.map(() => "?").join(",")})`;
    binds.push(...crns);
  }
  sql += " ORDER BY crn";
  const { results: sections } = await db.prepare(sql).bind(...binds).all<{ crn: string }>();
  // ...rest of the function body unchanged...
```
Leave the remainder of `syncSectionDetails` (the per-CRN fetch loop) exactly as-is.

- [ ] **Step 3: Thread `crns` into the catalog query (representative course per changed CRN)**

In `syncCourseCatalog`, scope the course list to the campuses/subjects/courses that own a changed CRN when `crns` is set:
```typescript
async function syncCourseCatalog(
  db: D1Like,
  session: SisSession,
  term: string,
  delayMs: number,
  withText: boolean,
  log: (m: string) => void,
  crns?: string[]
): Promise<{ courses: number; status: "ok" | "partial"; session: SisSession }> {
  let sql =
    `SELECT campus_description AS campus, subject, course_number AS courseNumber,
            MIN(crn) AS crn
       FROM course_section WHERE term = ?`;
  const binds: unknown[] = [term];
  if (crns && crns.length > 0) {
    sql += ` AND (campus_description, subject, course_number) IN (
              SELECT campus_description, subject, course_number FROM course_section
                WHERE term = ? AND crn IN (${crns.map(() => "?").join(",")}))`;
    binds.push(term, ...crns);
  }
  sql += ` GROUP BY campus_description, subject, course_number
           ORDER BY campus_description, subject, course_number`;
  const { results: courses } = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ campus: string; subject: string; courseNumber: string; crn: string }>();
  // ...rest of the function body unchanged...
```
Leave the remainder of `syncCourseCatalog` (the per-course fetch loop) exactly as-is.

> Note: remote D1 caps bound params (~100, see CLAUDE.md). The orchestrator (Task 6) batches `crns` to ≤90 per `syncDetails` call, so the `IN (...)` lists here stay within the limit.

- [ ] **Step 4: Thread `crns` into the instructor query**

In `syncInstructors`, scope the distinct banner IDs to the changed CRNs when set:
```typescript
async function syncInstructors(
  db: D1Like,
  session: SisSession,
  term: string,
  delayMs: number,
  log: (m: string) => void,
  crns?: string[]
): Promise<{ done: number; status: "ok" | "partial"; session: SisSession }> {
  let sql =
    "SELECT DISTINCT banner_id FROM section_faculty WHERE term = ?"
    + " AND banner_id IS NOT NULL AND banner_id <> ''";
  const binds: unknown[] = [term];
  if (crns && crns.length > 0) {
    sql += ` AND crn IN (${crns.map(() => "?").join(",")})`;
    binds.push(...crns);
  }
  sql += " ORDER BY banner_id";
  const { results: ids } = await db.prepare(sql).bind(...binds).all<{ banner_id: string }>();
  // ...rest of the function body unchanged...
```

- [ ] **Step 5: Wire `crns` through `syncDetails`, skip filters when scoped, stamp only full passes**

In `syncDetails`:
- Compute `const scoped = options.crns !== undefined;`
- Default `doFilters` to `!scoped` (skip the term-level filter-option pass on a scoped B1 run): `const doFilters = options.filters ?? !scoped;`
- Pass `options.crns` to `syncCourseCatalog(..., options.crns)`, `syncSectionDetails(..., options.crns)`, `syncInstructors(..., options.crns)`.
- After a successful run, stamp only when unscoped:
```typescript
    if (!scoped && status !== "error") {
      await markDetailsSynced(db, term, Date.now());
    }
```
Place this just before the existing `await finishSyncRun(...)` success call.

- [ ] **Step 6: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/ingest/details.ts web/src/lib/db/upsert.ts
git commit -m "feat(ingest): scope syncDetails by CRN set; stamp last_details_synced_at on full pass"
```

---

## Task 6: `refreshMutableTerms` orchestrator

**Files:**
- Create: `web/src/lib/ingest/refresh.ts`

- [ ] **Step 1: Write the orchestrator**

```typescript
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
```

- [ ] **Step 2: Verify `refreshTerms` signature matches**

Run: `cd web && grep -n "export async function refreshTerms" src/lib/ingest/terms.ts`
Expected: `refreshTerms(db: D1Like): Promise<...>`. If it takes more args, adjust the call.

- [ ] **Step 3: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/ingest/refresh.ts
git commit -m "feat(ingest): add refreshMutableTerms orchestrator (Tier A + B1 + B2)"
```

---

## Task 7: Admin route `/api/admin/refresh-run`

Exposes `refreshMutableTerms` over HTTP — manual trigger in prod-equivalent runs, and the e2e hook. Mirrors `refresh-seats.ts` exactly (auth, `ingestDisabledOnWorker`, JSON).

**Files:**
- Create: `web/src/pages/api/admin/refresh-run.ts`

- [ ] **Step 1: Write the route**

```typescript
/**
 * POST /api/admin/refresh-run  (x-admin-secret required)
 *
 * Runs the scheduled metadata refresh (docs/plans/scheduled-refresh.md) on
 * demand — Tier A full sync + Tier B1 diff-driven details + Tier B2 weekly
 * safety net. The hourly RefreshWorkflow runs the same refreshMutableTerms()
 * on the Worker; this route is the manual / e2e entry point.
 *
 * Query params (all optional):
 *   - term=<code>   restrict to one term (also skips the leading refreshTerms).
 *   - delayMs=<n>   per-subject / per-course delay (default 0 here; the Workflow
 *                   uses a polite non-zero delay).
 *   - now=<ms>      override "now" for the Tier B2 staleness check (e2e only) —
 *                   lets a test force the >7-day full-details boundary.
 *
 * Callers must send `Content-Type: application/json` (Astro CSRF; see sync.ts).
 */
import type { APIRoute } from "astro";
import { getDb } from "@/lib/db/binding";
import { refreshMutableTerms } from "@/lib/ingest/refresh";
import { checkAdmin, ingestDisabledOnWorker, json } from "@/lib/ingest/auth";

export const POST: APIRoute = async ({ request }) => {
  const off = ingestDisabledOnWorker();
  if (off) return off;
  const denied = checkAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const term = url.searchParams.get("term") ?? undefined;
  const delayMs = url.searchParams.get("delayMs");
  const delay = delayMs != null ? Number(delayMs) : 0;
  const nowParam = url.searchParams.get("now");
  const now = nowParam != null ? Number(nowParam) : undefined;

  try {
    const result = await refreshMutableTerms(getDb(), {
      terms: term ? [term] : undefined,
      skipTermRefresh: !!term,
      subjectDelayMs: delay,
      courseDelayMs: delay,
      now,
    });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("Refresh run failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
};
```

- [ ] **Step 2: Verify the auth helpers' exported names**

Run: `cd web && grep -n "export function checkAdmin\|export function ingestDisabledOnWorker\|export function json" src/lib/ingest/auth.ts`
Expected: all three exist with these names (they're used by `refresh-seats.ts`). If `json` is named differently, match it.

- [ ] **Step 3: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/api/admin/refresh-run.ts
git commit -m "feat(api): add /api/admin/refresh-run admin trigger"
```

---

## Task 8: e2e — refresh pipeline (mock catalog phases + assertions)

Adds a second mock catalog phase so a re-sync produces a real diff, then asserts B1 classification (new/dropped/structural, seat-only skipped) and the B2 trigger.

**Files:**
- Modify: `web/e2e/mock-sis-server.mjs`
- Modify: `web/e2e/global-setup.ts`
- Modify: `web/e2e/ingest.spec.ts`

- [ ] **Step 1: Add a second catalog phase + control endpoint to the mock**

In `mock-sis-server.mjs`, after the `CATALOG` array, add:
```javascript
// Phase-2 catalog for the refresh test (docs/plans/scheduled-refresh.md).
// vs CATALOG: 10006 dropped; 10007 added; 10005 title changed (STRUCTURAL);
// 10001 seat-only change (handled by getEnrollmentInfo / row counts, NOT a
// structural change). Everything else identical.
const CATALOG_PHASE2 = [
  section("10001", "ICS", "111", "001", "Intro to Computer Science I"),
  section("10002", "ICS", "111", "002", "Intro to Computer Science I"),
  section("10003", "ICS", "141", "001", "Foundations I"),
  section("10004", "ICS", "211", "001", "Intro to Computer Science II"),
  section("10005", "ICS", "311", "001", "Algorithms and Complexity"), // STRUCTURAL: title changed
  // 10006 dropped
  section("10007", "ICS", "111", "003", "Intro to Computer Science I"), // NEW
  section("20001", "MATH", "241", "001", "Calculus I"),
  section("20002", "MATH", "242", "001", "Calculus II"),
  section("20003", "MATH", "243", "001", "Calculus III"),
];

let catalogPhase = 1;
const activeCatalog = () => (catalogPhase === 1 ? CATALOG : CATALOG_PHASE2);
```

Replace every read of `CATALOG` in the request handlers (`getSubjects` is derived from SUBJECTS so unaffected; the ones to change are in `searchResults`, `getClassDetails`, and the enrollment-info handler) with `activeCatalog()`. Find them:
```bash
grep -n "CATALOG" web/e2e/mock-sis-server.mjs
```
Change the lookups inside the `searchResults`, `getClassDetails`, and `getEnrollmentInfo`/seat handlers from `CATALOG` to `activeCatalog()`. Leave the `const CATALOG = [...]` definition itself named `CATALOG`.

Add the control endpoint near the top of the request handler (before the handshake routes), so the test can advance the phase:
```javascript
  if (path === "/__mock/advance") {
    catalogPhase = 2;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
```

- [ ] **Step 2: Verify the seat handler still drives the seat-refresh test**

The existing "seat refresh updates stored seat counts" test expects ICS 10001 to go 10→5 via `getEnrollmentInfo`. The phase-2 catalog leaves 10001's structural fields identical, and the enrollment handler returns its own seat numbers, so that test is unaffected as long as the refresh test (which calls `/__mock/advance`) runs AFTER it. Confirm by reading the seat handler:
```bash
grep -n "getEnrollmentInfo\|maximumEnrollment\|seatsAvailable\|enrolled" web/e2e/mock-sis-server.mjs
```
Expected: the seat handler computes seats independently of `catalogPhase`. If it reads from the catalog, ensure it uses `activeCatalog()` and that 10001's seat numbers are stable across phases.

- [ ] **Step 3: Mark the refresh test term mutable + stamp details freshness in global-setup**

The refresh test reuses term `202730` (already synced from the mock by the first ingest test). In `global-setup.ts`, after the fixture insert, ensure `202730` is non-view-only and give it a FRESH `last_details_synced_at` (so the first refresh exercises B1 only, not B2). Find the term seeding:
```bash
grep -n "202730\|is_view_only\|INSERT INTO term\|last_synced_at" web/e2e/global-setup.ts
```
Add (or adjust) so the row for `202730` has `is_view_only = 0` and `last_details_synced_at` set to "now" (a recent epoch-ms value passed in setup). If `202730` is created by the ingest test at runtime rather than seeded, instead set these via a direct D1 statement at the START of the refresh test (Step 4) using `yarn wrangler d1 execute` is not available mid-test — so do it through SQL the app can run. Simplest: in the refresh test, before advancing, the test cannot run raw SQL; therefore seed `202730` as `is_view_only=0` with a fresh `last_details_synced_at` in `global-setup.ts` (which already opens the local D1). Use the same local-sqlite handle global-setup already uses for the fixture insert.

- [ ] **Step 4: Add the B1 refresh test (fresh details → diff-driven only)**

Append to `ingest.spec.ts`, AFTER the seat-refresh test (so prior tests see phase-1):
```typescript
test("scheduled refresh: diff-driven detail re-fetch (Tier B1)", async ({ request }) => {
  // Advance the mock to phase 2: 10006 dropped, 10007 added, 10005 title changed
  // (structural), all else identical. 202730 has a FRESH last_details_synced_at,
  // so Tier B2 must NOT fire — only the diff-driven detail re-fetch.
  const advance = await request.post("http://127.0.0.1:9999/StudentRegistrationSsb/__mock/advance");
  expect(advance.ok()).toBeTruthy();

  const res = await request.post(`/api/admin/refresh-run?term=${TERM}&delayMs=0`, {
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  const summary = body.terms.find((t: { term: string }) => t.term === TERM);
  expect(summary).toBeTruthy();

  // Classification: 10007 new, 10006 dropped, 10005 structural, 10001 NOT changed.
  expect(summary.newCrns).toContain("10007");
  expect(summary.droppedCrns).toContain("10006");
  expect(summary.structuralCrns).toContain("10005");
  expect(summary.structuralCrns).not.toContain("10001");
  // Details re-fetched only for new ∪ structural; seat-stable 10001 excluded.
  expect(summary.detailFetchedCrns.sort()).toEqual(["10005", "10007"]);
  expect(summary.detailsFullPass).toBe(false);

  // New section is now searchable from D1.
  expect(await searchCount(request, { term: TERM, subject: "ICS", pageMaxSize: "50" })).toBe(6); // 10006 out, 10007 in

  // New CRN got section detail; dropped CRN's detail was deleted.
  const newSect = await request.get("/api/section", { params: { term: TERM, crn: "10007" } });
  expect(newSect.ok()).toBeTruthy();
  const dropped = await request.get("/api/section", { params: { term: TERM, crn: "10006" } });
  expect(dropped.status()).toBe(404);
});
```

> The ICS count stays 6 (one dropped, one added). If the mock's phase-2 ICS count differs, adjust the expected number to match `CATALOG_PHASE2`'s ICS rows.

- [ ] **Step 5: Add the B2 trigger test (stale details → full pass)**

The `now` override param makes this deterministic: 202730's `last_details_synced_at` was stamped fresh in global-setup, so passing a `now` 8 days in the future crosses the 7-day boundary and forces the full pass. Append after the B1 test:
```typescript
test("scheduled refresh: stale details trigger a full pass (Tier B2)", async ({ request }) => {
  // Pass now = setup-stamp + 8 days so (now - last_details_synced_at) > 7d and
  // Tier B2 fires. (The mock is at phase 2 from the prior test; no new diff is
  // needed — we're asserting the full-details pass, not the diff.)
  const eightDays = 8 * 24 * 60 * 60 * 1000;
  const future = Date.now() + eightDays;
  const res = await request.post(
    `/api/admin/refresh-run?term=${TERM}&delayMs=0&now=${future}`,
    { headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" } }
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const summary = body.terms.find((t: { term: string }) => t.term === TERM);
  expect(summary.detailsFullPass).toBe(true);

  // The full pass re-stamped last_details_synced_at and re-fetched section detail
  // for an UNCHANGED CRN too (e.g. 10003, which was never in any diff). Confirm
  // its section_detail row is present (the full pass touched every CRN).
  const sect = await request.get("/api/section", { params: { term: TERM, crn: "10003" } });
  expect(sect.ok()).toBeTruthy();
});
```

> The `now` override only affects the B2 staleness comparison (`now - last_details_synced_at`), never the stamps written (those use real `Date.now()` inside `syncDetails`/`markDetailsSynced`), so it can't corrupt persisted timestamps.

- [ ] **Step 6: Run the e2e suite (chromium — ingest mutates shared D1)**

Run: `cd web && yarn test --project=chromium -g "scheduled refresh"`
Expected: both refresh tests PASS. Then run the full ingest spec to confirm no regressions: `yarn test --project=chromium e2e/ingest.spec.ts`
Expected: all ingest tests PASS (seat-refresh test still 10→5; reset-quirk MATH===3 intact).

- [ ] **Step 7: Commit**

```bash
git add web/e2e/mock-sis-server.mjs web/e2e/global-setup.ts web/e2e/ingest.spec.ts
git commit -m "test(e2e): cover scheduled refresh diff classification and B2 trigger"
```

---

## Task 9: Worker entry + `RefreshWorkflow` + wrangler wiring

Wires the orchestrator into the deployed Worker as an hourly cron-triggered Workflow. (Per the adapter research: there is no `workerEntryPoint` option in v13 — you point `main` at your own file that re-exports the adapter's `handle` as `fetch` plus the Workflow class.)

**Files:**
- Create: `web/src/workflows/refresh.ts`
- Create: `web/src/worker.ts`
- Modify: `web/wrangler.jsonc`

- [ ] **Step 1: Write the Workflow class**

```typescript
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
```

> Note: `refreshTerm` (not `refreshMutableTerms`) is called per term here so each term is its own resumable step; the Workflow does its own `refreshTerms()` + term-list query in step 1 instead of delegating to `refreshMutableTerms`. Both functions are exported from `refresh.ts`.

- [ ] **Step 2: Write the custom Worker entry**

```typescript
// src/worker.ts — custom Worker entrypoint (replaces the adapter's default
// server entry). Re-exports the adapter's request handler as `fetch` (byte-
// equivalent to @astrojs/cloudflare/entrypoints/server, which is just
// { fetch: handle }) and the RefreshWorkflow class so the workflows binding can
// resolve class_name="RefreshWorkflow" in this same module.
import { handle } from "@astrojs/cloudflare/handler";

export { RefreshWorkflow } from "./workflows/refresh";

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env as never, ctx) as unknown as Response;
  },
};
```

- [ ] **Step 3: Update wrangler.jsonc**

Change `main` and add the `workflows` binding + `limits`:
```jsonc
  "main": "./src/worker.ts",
  // ...existing fields...
  "limits": { "subrequests": 50000 },
  "workflows": [
    {
      "binding": "REFRESH_WORKFLOW",
      "name": "uh-course-search-refresh",
      "class_name": "RefreshWorkflow",
      "schedules": ["0 * * * *"]
    }
  ],
```
Leave `d1_databases`, `vars`, `compatibility_*`, `observability`, etc. unchanged.

- [ ] **Step 4: Regenerate Worker types (if the repo has a typegen script)**

Run: `cd web && grep -n "cf-typegen\|wrangler types" package.json`
If a script exists, run it (e.g. `yarn cf-typegen`). Otherwise run `yarn wrangler types`. This adds `REFRESH_WORKFLOW` to the generated `Env`.
Expected: the generated env type file now includes `REFRESH_WORKFLOW: Workflow`.

- [ ] **Step 5: Production build (typecheck + bundle the new entry)**

Run: `cd web && yarn build`
Expected: build succeeds and bundles `src/worker.ts` as the entry. If the adapter complains that `main` must be its entrypoint, confirm the import path `@astrojs/cloudflare/handler` resolves (it's in the package `exports` map per the adapter research); if not, fall back to re-exporting from `@astrojs/cloudflare/entrypoints/server` per the installed adapter version's docs.

- [ ] **Step 6: Verify the fetch path still works under preview**

Run: `cd web && yarn test --project=chromium e2e/search.spec.ts`
Expected: read-path e2e PASSES (the custom entry's `fetch` is byte-equivalent to the old default, so search/UI are unaffected). Workflows/cron are not exercised under `astro preview` — the orchestrator logic is covered by Task 8's admin-route tests.

- [ ] **Step 7: Commit**

```bash
git add web/src/worker.ts web/src/workflows/refresh.ts web/wrangler.jsonc
git commit -m "feat(worker): hourly cron-triggered RefreshWorkflow for mutable terms"
```

---

## Task 10: CLI parity + docs

**Files:**
- Modify: `web/scripts/ingest.ts`
- Modify: `CLAUDE.md`, `docs/plans/scheduled-refresh.md`

- [ ] **Step 1: Add a `refresh-run` CLI command**

In `scripts/ingest.ts`, add the import:
```typescript
import { refreshMutableTerms } from "@/lib/ingest/refresh";
```
Add a `case` in the command switch (alongside `refresh-seats`):
```typescript
    case "refresh-run": {
      const result = await refreshMutableTerms(db, {
        terms: typeof flags.term === "string" ? [flags.term] : undefined,
        skipTermRefresh: typeof flags.term === "string",
        subjectDelayMs: num(flags.delayMs) ?? 200,
        courseDelayMs: num(flags.delayMs) ?? 200,
        log,
      });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      break;
    }
```
Update the usage string and the file header's `Usage:` comment to include `refresh-run [--term 202710] [--delayMs 200]`.

- [ ] **Step 2: Typecheck**

Run: `cd web && yarn build`
Expected: build succeeds.

- [ ] **Step 3: Smoke-test the CLI against local D1 + mock (optional but recommended)**

Run (in one shell, start the mock; in another, run the CLI against local D1):
```bash
cd web && node e2e/mock-sis-server.mjs &
SIS_BASE_URL=http://127.0.0.1:9999/StudentRegistrationSsb D1_MODE=local yarn ingest refresh-run --term 202730 --delayMs 0
```
Expected: prints `{ ok: true, terms: [ { term: "202730", ... } ] }`. Kill the mock afterward.

- [ ] **Step 4: Update docs**

In `docs/plans/scheduled-refresh.md`, change `Status: **proposed**` to `Status: **shipped**` and add a short "What shipped" note (the Workflow name `uh-course-search-refresh`, hourly `0 * * * *`, the `refresh-run` route/CLI).

In `CLAUDE.md`, under the write-path bullets, add `refresh.ts` (the scheduled Tier A+B1+B2 orchestrator, run hourly by `RefreshWorkflow`) and note the new `/api/admin/refresh-run` route and `yarn ingest refresh-run` command, plus that the Worker entry is now `src/worker.ts` (re-exporting the adapter handler + the Workflow class).

- [ ] **Step 5: Commit**

```bash
git add web/scripts/ingest.ts CLAUDE.md docs/plans/scheduled-refresh.md
git commit -m "feat(ingest): add refresh-run CLI; document scheduled refresh pipeline"
```

---

## Self-review checklist (run after implementing)

- [ ] **Deploy sanity:** after `wrangler deploy`, confirm in the dashboard that the `uh-course-search-refresh` Workflow exists with an hourly schedule, and that `INGEST_ON_WORKER` being unset does NOT block the Workflow (it only gates the admin HTTP routes — the Workflow calls `refreshMutableTerms` directly).
- [ ] **First-run check:** trigger one Workflow instance manually (dashboard or `wrangler workflows trigger`), then query D1 for the four mutable terms — `last_synced_at` advanced, `last_details_synced_at` populated (B2 fired on first run since it was NULL), and a spot-checked changed CRN has fresh `section_detail`.
- [ ] **Banner politeness:** confirm the per-term `subjectDelayMs`/`courseDelayMs` (200ms) and the `step.sleep` between terms keep request rate similar to the existing `backfill-sweep.sh` (which used `--delayMs 200`), so the scheduled job doesn't trip Banner's session throttle.

---

## Coverage map (plan ↔ spec)

| Spec requirement | Task(s) |
| --- | --- |
| Tier A: hourly full sync of mutable terms | 4 (diff), 6 (orchestrator), 9 (hourly cron Workflow) |
| Tier B1: diff-driven detail re-fetch (new/dropped/structural, seats excluded) | 3 (classifier), 5 (scoped syncDetails), 6 (orchestration + delete dropped) |
| Tier B2: weekly full-details safety net | 1+2 (`last_details_synced_at` + stamp), 5 (full-pass stamp), 6 (7-day boundary) |
| Cron-triggered Cloudflare Workflow on the Worker | 9 (`worker.ts`, `RefreshWorkflow`, `schedules`) |
| `refreshTerms` each run (pick up new / view-only flips) | 6 (`refreshMutableTerms`), 9 (step 1) |
| `last_details_synced_at` schema | 1 |
| `limits.subrequests` raised for worst-case term | 9 (step 3) |
| Verification: diff classifier + B2 boundary + e2e | 8 (e2e), self-review |
| Out of scope: per-CRN seat top-ups, UI button, view-only terms | not implemented (by design) |
