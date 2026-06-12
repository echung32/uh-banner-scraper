# D1 read-path optimization (rows-read budget)

Status: **implemented** (pending remote migration apply + deploy). Deltas from the
original plan, found during implementation:

- The `(? IS NULL OR col = ?)` bind pattern in `buildSectionFilter` was itself a
  scan-forcer — SQLite can't push that form into an index range, so even
  subject-filtered searches scanned the whole term. The WHERE is now built
  conditionally (and the `course` LEFT JOIN included only when a college/department
  filter needs it).
- A **second** expression index (`idx_cs_subj_sort`: `term, subject, <catalog-num
  expr>, sequence_number, crn`) serves single-subject searches streamed:
  `resolveSort` drops the constant `subject_description` key under a subject
  filter. It replaces `idx_cs_term_subject` (same equality prefix), so net new
  index count — and per-insert write cost — is +1, as planned.
- `/api/coverage`'s backfilled flavor (a term-wide window aggregate) is also
  edge-cached; `/api/course`/`section`/`instructor` are not (1-row reads).
- College/Department menus are materialized into `filter_option` under
  campus-encoded kinds (`college@<campusDesc>`, `@*` = unscoped) by the details
  sync, with a fallback derive for terms whose details pass hasn't rerun yet.
- The subject menu reads the `subject` table alone (every section producer
  enumerates subjects first); the e2e fixture now seeds it accordingly.
- Verified via `wrangler dev` against the real local snapshot: `x-edge-cache`
  miss→hit, param-order-normalized keys, byte-identical bodies, correct asc/desc
  orders, 40/40 e2e specs green.

## Problem

D1 bills "rows read" as rows the engine *scans*, not rows returned (verified against
current pricing docs 2026-06-11). One homepage load currently burns ~100k of the 5M/day
free-tier read budget — i.e. the free tier supports only ~50 page loads/day. Measured
against the real local snapshot (term `202710`, 9,170 sections), the leaks are:

1. **The search's `ORDER BY` matches no index.** `EXPLAIN QUERY PLAN` on the default
   all-subjects search shows `SEARCH cs USING INDEX idx_cs_term_open (term=?)` +
   `USE TEMP B-TREE FOR ORDER BY`: every row in the term (~9.2k) is read and sorted to
   produce a 50-row page.
2. **`searchSections` runs a separate `COUNT(*)`** over the same filter — another full
   ~9.2k-row scan per search.
3. **Facet menus are derived per request.** `getSubjectFacet` (GROUP BY over all the
   term's sections) and `getCatalogFacet` ×2 (DISTINCT over `course`) re-scan on every
   page load, though their answers only change at sync time.
4. **Nothing is cached in front of D1.** Every anonymous visitor re-runs the identical
   default search + menus.

4–5 term-wide scans × ~9.2k rows + the `course` scans ≈ the observed ~100k/load.

## Fixes (in order of impact)

### 1. Edge-cache the read API routes (Cache API, not KV)

Wrap the GET read routes (`/api/search`, `/api/filters`, `/api/terms`, `/api/course`,
`/api/section`, `/api/instructor`) in `caches.default` so repeat queries cost **0 D1
rows**. This is the lever that scales with traffic: the homepage default search and the
menus are the same bytes for every visitor.

**Why the Cache API and not Workers KV** (evaluated against current docs):

| | Cache API | Workers KV |
|---|---|---|
| Scope | Per data center, shared by **all isolates in the colo** (the "per-instance" caveat is wrong — it's per-colo, not per-isolate) | Global (eventually consistent, ≤60s) |
| Works on workers.dev | **Yes** (docs now confirm; the old custom-domain-only limitation is gone) | Yes |
| Quota | **Free, unmetered** | Own budget: 100k reads/day, **1k writes/day** free |
| Fit for a search cache | High-cardinality keys are free | Every cache **fill is a KV write** — 1k/day caps us at 1k distinct uncached queries/day, the tightest quota in the whole system |
| Invalidation | No global purge (per-colo `delete` only) → use **versioned keys** (below) | TTL / explicit delete |

Per-colo scope is nearly irrelevant for us: a UH course search serves Hawaii, which
lands on one or two colos (HNL has a PoP) — so the colo cache behaves like a global one
for the audience that matters. KV's strength (global replication) buys nothing here,
and its 1k writes/day free limit is an outright hazard for a cache keyed on arbitrary
filter/sort/page combinations. **Cache API wins on every axis for this app.**

Design:

- **Key**: the request URL + a data-version component, e.g.
  `https://cache.local/v{last_synced_at}.{last_seat_refresh_at}/api/search?...`.
  Versioned keys make invalidation automatic (a sync/seat-refresh bumps the version, old
  entries just expire) — which neutralizes the Cache API's lack of global purge. The
  version comes from `getTermSyncMeta`, which the search route already loads (1 row).
- **TTL** via `Cache-Control` on the stored response:
  - view-only terms: days (immutable data);
  - backfilled active terms: ~1h is safe — seat data only moves on seat refresh, and the
    refresh bumps the key version anyway, so TTL is just a garbage bound;
  - dynamic terms: short (~5 min) or skip — page-cache misses must reach D1 to trigger
    the live fill, and coverage grows as users page.
- **Gate** with an env flag (`EDGE_CACHE`, default on in prod, **off in e2e** — the
  ingestion specs mutate D1 mid-run and must observe fresh reads).
- Only cache 200s; never cache admin routes.

### 2. Sort-matching expression index (kills the temp B-tree)

The blocker is that `resolveSort` orders by `subject_description` + the *derived*
catalog number (`trim(substr(subject_course, length(subject)+1))`) — no plain column
index can serve it. SQLite supports **indexes on expressions**, and this was verified
against the real data copy:

```sql
CREATE INDEX idx_cs_sort_subj ON course_section(
  term, subject_description,
  trim(substr(subject_course, length(subject) + 1)),
  sequence_number, crn
);
```

`EXPLAIN QUERY PLAN` flips from `USE TEMP B-TREE FOR ORDER BY` (9,170 rows read) to a
streamed `SEARCH cs USING INDEX idx_cs_sort_subj (term=?)` that early-exits at
`LIMIT 50` (~50 rows + 50 `course` PK probes, 0.2 ms). The `ORDER BY`'s mid-list
`cs.term ASC` is constant under `term = ?` so it doesn't break index order.

Caveats:

- **The query must spell the expression identically** to the index definition —
  `CATALOG_NUMBER_SQL` already does.
- **DESC sorts**: verified that the current resolveSort (DESC primary + ASC tiebreaks)
  cannot use a backward scan and falls back to the temp B-tree, while mirrored
  directions (`DESC` on every component) use the same index backwards. Change
  `resolveSort` to apply the direction to the tiebreaks too (UX-neutral: it only flips
  ordering *within* a course's sections on desc sorts).
- **Write cost**: D1 bills index maintenance as rows written — one extra index ≈ +1 row
  written per section insert (~+9k per full-term sync against the 100k/day budget,
  noticeable during the 77-term backfill). So index **only the default sort**
  (`subjectDescription`) now; it's what every homepage load uses. Other sort columns are
  user-initiated, rare, and edge-cached — add `course_title` later only if analytics
  show misses. With `OFFSET`, deep pages still walk the index from the start
  (offset+50 rows) — fine: page 1 dominates, and the per-page cache absorbs repeats.

Ship as `migrations/0007_sort_index.sql`.

### 3. Materialize facets at sync time

- **Subject menu**: serve `getSubjectFacet` from the `subject` table alone (PK
  `(term, code)`, ~200 rows) and drop the `course_section` UNION arm. The union only
  exists for terms with sections whose subjects aren't enumerated — but full sync
  enumerates subjects first, and dynamic terms get `ensureTermSubjects` on first menu
  load. Only `crnLazy` can insert a section without enumeration; acceptable (the menu
  self-heals on the next `/api/filters?kind=subject` of a dynamic term).
- **College/Department menus**: at `sync-details` time, write the distinct
  college/department sets per `(term, campus)` into `filter_option`
  (`kind='college'/'department'` — the kinds UH's Banner leaves empty anyway), and point
  `getCatalogFacet` at `filter_option`'s PK instead of DISTINCT-scanning `course`.
  Keep the on-the-fly query as fallback when no materialized rows exist (pre-backfill).

### 4. COUNT(\*) — accept, bounded by the cache

After fix 2 the count query is the only remaining term-wide scan (~9.2k rows on an
all-subjects **cache miss**; subject-filtered searches count only that subject's rows).
Options considered and deferred: window-function counts (still scan), materialized
per-filter counts (unbounded filter combinations). The edge cache bounds it: the count
runs once per distinct query per TTL window. Optional later micro-fix: store the term's
total section count on `term` at sync and use it for the unfiltered default search.

## Verification

- `EXPLAIN QUERY PLAN` assertions were run against a copy of the real local snapshot
  (103 MB, 18.7k sections) — repeat after the migration lands.
- D1 result `meta.rows_read` is the exact billing counter: temporarily log it per query
  behind `LOG_SOURCE` in dev to confirm the before/after, and watch the D1 dashboard
  (GraphQL analytics) after deploy.
- e2e: full suite must pass with `EDGE_CACHE=0`; add one chromium spec that two
  identical `/api/search` requests with `EDGE_CACHE=1` hit D1 once (assert via the
  `[DB]`/`[SIS]` log tags or a response header like `x-cache: hit`).

## Expected outcome

| Scenario | Rows read today | After |
|---|---|---|
| Homepage load, cache hit | ~100k | **0** |
| Homepage load, cache miss | ~100k | ~9.5k (count scan) + ~100 (page) + ~300 (facets fallback) |
| Subject-filtered search, miss | ~20–40k | ~100–600 |
| Free-tier capacity | ~50 loads/day | ~500 uncached all-subject searches/day + unlimited cached |

Paid headroom if ever needed: D1's paid tier includes 25B rows read/month (~$5 base).
