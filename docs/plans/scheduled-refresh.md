# Scheduled Metadata Refresh for Mutable Terms (design)

Status: **shipped**.

## What shipped

- Hourly cron-triggered Cloudflare Workflow `uh-course-search-refresh` (cron `0 * * * *`), defined in `web/wrangler.jsonc` `workflows` binding, class `RefreshWorkflow` in `web/src/workflows/refresh.ts`, Worker entry `web/src/worker.ts`.
- Orchestrator `web/src/lib/ingest/refresh.ts`: `refreshMutableTerms` (all non-view-only terms) and `refreshTerm` (single term) — Tier A full sync + Tier B1 diff-driven detail re-fetch + Tier B2 weekly full-details safety net.
- Manual entry points: `POST /api/admin/refresh-run` (secret-guarded) and `yarn ingest refresh-run [--term 202710] [--delayMs 200]`.
- Section-core diff classifier in `web/src/lib/ingest/diff.ts` (new/dropped/structural CRNs; seat fields excluded).
- Migration `0008` (`web/migrations/0008_term_details_synced.sql`) adds `term.last_details_synced_at` (the Tier B2 staleness marker).
- **Content-aware delta write** (`web/src/lib/ingest/diff.ts` `classifyForWrite` + `web/src/lib/db/upsert.ts` writers): Tier A writes only new/changed/dropped sections — seat-only changes UPDATE the row without rewriting child rows; unchanged sections are skipped — cutting D1 writes on the hourly sweep. Per-row `synced_at` becomes last-modified; `term.last_synced_at` remains last-verified.

## Problem

Nothing refreshes course metadata automatically. The Banner-facing write path is a set of
manually-invoked building blocks (`yarn ingest sync | sync-details | refresh-seats | refresh-terms`,
and the `/api/admin/*` routes, which return 501 in production unless `INGEST_ON_WORKER=1`). There is
no cron, no GitHub Action — every refresh is a hand-run CLI command.

Confirmed against the remote D1 (100 terms): **`last_seat_refresh_at` is NULL for every term** — the
seat-refresh pipeline has never executed in production. The four non-view-only terms
(`is_view_only = 0`: currently `202713`, `202710` ≈ 9,170 sections, `202643`, `202640` ≈ 1,965) were
last synced 1–3 days ago and drift with no correction. Non-view-only terms are still mutating: seats,
waitlist, meeting times, instructors, descriptions, restrictions, and fees can all change.

## What each refresh actually costs (per endpoint)

This drives the whole design, so it is recorded explicitly. Costs are Banner HTTP requests.

| Refresh | Endpoint(s) | Cost | Updates | Volatility |
| --- | --- | --- | --- | --- |
| **Full sync** (`ingest/sync.ts`) | `searchResults` paginated @ 500/page (+ `resetDataForm` per page) | **~2 per 500 sections** → ~200–400 for a 9k term | section core: title, **seats/enrollment/waitlist**, meeting times, faculty, credits, schedule type, attributes | seats=HIGH, rest=MED |
| **Seat refresh** (`ingest/seatRefresh.ts`) | `getEnrollmentInfo` | **1 per CRN** → ~9,170 for the big term | enrollment/seat/waitlist counts only | HIGH |
| **Details: catalog** (`ingest/details.ts`) | `getCatalogDetails` (+ description + prerequisites + corequisites when `text`) | **4 per *course*** (deduped to one representative CRN per campus+course) | college/dept/grading + description/prereqs/coreqs | LOW |
| **Details: section** | `getRestrictions` + `getFees` + `getCrossListSections` + `getLinkedSections` + `getSyllabus` | **5 per CRN** | restrictions, fees, cross-list, linked, syllabus | LOW |
| **Details: instructor** | `getContactCard` | **1 per distinct instructor** | contact card | LOW |
| **Filter options** | 10× `get_*` | 10 per term | dropdown menus | LOW |

Two facts that determine the strategy:

1. **The most volatile data (seats/waitlist) is the cheapest to refresh, and a full sync already
   carries it.** The `searchResults` row populates `enrollment/seatsAvailable/waitCount/...` — the
   exact fields `seatRefresh` patches. A full sync of the 9,170-section term costs ~200–400 requests
   and refreshes *all* seats; covering the same seats via per-CRN `getEnrollmentInfo` costs ~9,170
   requests (~25× more) for strictly less data. Per-CRN seat refresh only wins on a small targeted
   subset between syncs — not for whole-term freshness.
2. **The expensive data (~10 requests per section-equivalent: restrictions, fees, cross-list,
   descriptions, prereqs) is low-volatility** — it rarely changes once a term is published.

So the tiers are organized by **frequency-by-volatility**, not by "seats vs everything."

## Design

### Tier A — full sync, hourly

Re-run `syncTerm` on every `is_view_only = 0` term every hour. ~1k requests total across the four
mutable terms; well inside paid limits; keeps seats/waitlist/meeting-times/faculty fresh to ≤1h.
Per-CRN seat refresh is **not** used for whole-term freshness (it is ~25× costlier for less data).

### Tier B — re-freshing the expensive details

Tier B's job is the low-volatility detail endpoints (restrictions, fees, cross-list, linked,
syllabus, course text, instructor cards). Two complementary mechanisms:

**B1 — diff-driven (every run, cheap).** Tier A's full sync re-pulls every section's `raw_json`. The
sync write path is modified to diff the incoming section set against the existing rows *before* the
delete-and-replace, classifying each CRN:

- **new** (in the sync, absent from D1) → has no details; fetch its full detail set.
- **dropped** (in D1, absent from the sync) → delete its `section_detail`.
- **structurally changed** → re-fetch its details. "Structural" = a diff of the section-core fields
  *excluding* the always-moving seat/enrollment fields (`enrollment`, `seatsAvailable`, `waitCount`,
  `waitCapacity`, `waitAvailable`, `openSection`). Triggering fields: faculty, meeting times, title,
  schedule type, `sectionAttributes`, credit hours, link identifier.

Detail re-fetches reuse the existing per-CRN fetchers (`sectionLazy` / `courseTextLazy` / the
`details.ts` section/catalog fetchers).

**Known blind spot of B1.** Tier A's payload carries no Tier B field (`restrictions`, `fees`,
cross-list CRNs, `syllabus`, `reservedSeatSummary` is always `null` in search; course text is not in
a section row at all). So a fee/restriction/text edit on a section whose *core* did not move is
invisible to the diff. B2 closes this gap.

**B2 — weekly safety net.** If a term's last full details pass is older than 7 days, run the full
`syncDetails` pass for it. This is the only thing that catches the invisible detail/text edits.
Stagger across terms so they don't all fire in the same hour.

### Orchestration — one cron-triggered Cloudflare Workflow

A `WorkflowEntrypoint` (`RefreshWorkflow`) triggered **hourly** by a native cron schedule (no
separate `scheduled()` entrypoint). Workflows provide durable, resumable steps with per-step
retry/backoff — the right primitive for multi-hundred-request sweeps that must survive transient
Banner failures.

It runs on the Worker runtime, calling the existing `lib/ingest/*` functions directly. The
`INGEST_ON_WORKER` guard only gates the admin *HTTP routes*; a `WorkflowEntrypoint` is a separate
entry, so it runs regardless. The Node `yarn ingest` CLI is retained unchanged for manual and
historical-backfill use.

Per hourly run:

1. **`refreshTerms`** (~1–2 requests) — recompute `is_view_only` and pick up new terms, so terms
   that flipped to view-only drop out of the sweep and new ones join.
2. **For each mutable term — Tier A full sync** as one `step.do()` per term (term-level
   resumability + retry; a single step keeps the in-memory SIS session/rotation in `syncTerm`
   intact, since a session can't cross step boundaries), with `step.sleep` pacing between terms.
   The diff (B1) is computed inside this write path and its new/dropped/structurally-changed CRN
   sets are emitted.
3. **Tier B B1** — fetch/delete/re-fetch details for the CRN sets from step 2.
4. **Tier B B2** — for each mutable term whose `last_details_synced_at` is >7 days old (staggered),
   run the full `syncDetails` pass.

`limits.subrequests` in `wrangler.jsonc` is raised (e.g. 50,000) to cover a worst-case term. CPU is a
non-issue — the work is almost entirely `await fetch()` to Banner (CPU caps at 5 min/invocation; the
sweep's CPU is negligible). Pacing between chunks is the deliberate Banner-politeness throttle, not a
platform constraint.

## Schema

- New migration: add `last_details_synced_at INTEGER` to `term` (drives the B2 weekly boundary and
  surfaces details freshness; the column does not exist today).
- Diffing needs the pre-replace section set. The sync already reads and writes per `(term, subject)`,
  so the diff is computed in that write path from the rows being replaced — no extra storage or
  snapshot table required. (The write mechanism was subsequently optimized: rather than
  delete-and-replace, `syncTerm` now runs a content-aware delta via `classifyForWrite` in
  `diff.ts`, issuing only insert/update/delete statements for rows that actually changed — see the
  "What shipped" bullet above.)

## Verification

- **Unit** — the diff classifier (new / dropped / structural, with seat/enrollment fields excluded)
  and the B2 weekly-boundary trigger.
- **e2e (chromium, against the mock SIS, extending `ingest.spec.ts`)** — a Workflow run:
  advances `last_synced_at`; refreshes a changed seat count; fetches details for a newly-appeared CRN;
  deletes details for a dropped CRN; **skips** a details re-fetch for a seat-only change; and triggers
  the full details pass when `last_details_synced_at` is stale. The mock already reproduces Banner's
  stateful-form quirk, preserving the `resetDataForm` regression guard.

## Out of scope

- A manual "refresh now" button in the UI.
- Near-real-time (sub-15-minute) seat counts and per-CRN seat top-ups between syncs — the hourly full
  sync covers seats ~25× more cheaply, and tighter cadence risks tripping Banner's session throttle.
- Refreshing view-only (immutable) terms — by definition they no longer change.
