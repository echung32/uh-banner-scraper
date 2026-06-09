# Plan: Persistent D1 Data Layer

Status: **in progress** · Owner: web · Supersedes the in-memory cache/session in `web/`.

## Context

The `web/` Astro app currently caches everything **in process memory** — an `unstorage`
memory driver behind `@epic-web/cachified` (`web/src/lib/cache/index.ts`) and an in-memory
session pool (`web/src/lib/sis/session.ts`). Both reset on every restart, aren't shared
across instances, and every user search hits the live UH Banner API on a cache miss.

We want a **persistent, queryable data layer** so that:

1. **View-only (past) terms** — those whose Banner description ends in `(View Only)` — are
   scraped **once**, stored in the DB, and served from the DB forever (never hit Banner again).
2. **Recent (~2 non-view-only) terms** are stored too, but **revalidated periodically**
   (full catalog sync every 6–12h) plus an **on-demand global seat refresh** (cheap, per-CRN,
   rate-limited).
3. The stored data is structured for **future analytics / charts** (planned here, **not built**).

Decision: use **Cloudflare D1**, build the **D1 read-model first on the current Node host**,
and **defer the Cloudflare Workers hosting migration** to a later phase
(see `docs/plans/workers-migration.md`).

## Why D1

D1 (edge SQLite) is the right primary store. The access pattern is exactly relational —
filter by `(term, subject, courseNumber, openSection)`, sort, paginate, COUNT, and later
GROUP BY for analytics — which SQLite does natively and KV cannot. **No KV** (no
range/sort/aggregate; D1 serves the small terms list fine). **No R2** for v1 (the per-section
`raw_json` blob already gives faithful replay; R2 raw-payload archival is a deferred analytics
nice-to-have).

Key architectural consequence: **searches are served entirely from D1; Banner is touched only
by the ingestion/refresh paths.** This removes Banner (and the session handshake) from the hot
path, which also makes the eventual Workers migration clean — the ephemeral-isolate-unfriendly
session pool no longer lives on the request path.

## Architecture

**Read path (user requests):** `pages/api/{search,terms}.ts` → `lib/db/` query layer → D1.
No Banner, no cachified, no session pool.

**Write paths (Banner-facing, infrequent, throttled):**

- **Full sync** (catalog + seats) — enumerate subjects per term, paginate `searchResults`,
  upsert. Triggerable job (Node script / secret-guarded route now; Workers Cron later) every
  6–12h for non-view-only terms; one-time for view-only terms.
- **Seat refresh** (seats only) — `POST /ssb/searchResults/getEnrollmentInfo` per CRN updates
  `enrollment`/`seats_available`/`wait_count` (and `raw_json`) without a full catalog scrape.
  Exposed as a **global manual refresh** with a **cooldown stored in D1** (e.g. 5–10 min
  lockout, global so one user's refresh updates everyone).

Each Banner-facing run does **one** `establishSession()` handshake and reuses it (re-establishing
past the 28-min TTL within long runs). No persistent cross-request session pool.

### D1 access abstraction

`lib/db/` talks to a **`D1Database`-shaped client**. On Workers that's the native `env.DB`
binding. On the **current Node host**, back the same interface with a thin shim over the **D1
HTTP REST API** (`POST /accounts/{account_id}/d1/database/{db_id}/query`) using
`CLOUDFLARE_API_TOKEN`. Same `prepare().bind().all()/first()/run()` surface either way, so the
Workers migration only swaps client construction — query code is untouched.

> A remote D1 over HTTP adds per-query latency vs a native binding; acceptable for v1 and
> removed by the Workers migration. A local file-based D1 (miniflare/`wrangler --local`) is
> **not** a valid production store on Node (per-instance, not shared) — use remote D1 for any
> deployed Node instance.

## D1 schema (`migrations/0001_init.sql`)

Store model: **one row per section keyed `(term, crn)`** — CRN is unique only *within* a term.
Scalar columns for everything the search/sort/filter and analytics need, **plus a `raw_json`
blob** holding the exact `CourseSection` for byte-faithful API reconstruction (nested `faculty`,
`meetingsFaculty`, `sectionAttributes`). Separate `section_faculty` / `section_meeting`
projection tables for analytics only (populated in the same upsert; **not** read on the hot
path). SQLite booleans as `INTEGER`, timestamps as epoch-ms `INTEGER`.

Tables: `term`, `subject`, `course_section`, `section_faculty`, `section_meeting`, `sync_run`,
and (future) `enrollment_snapshot`. See the migration file for exact columns and indexes.

**`is_view_only` rule** (single helper): description matches `/\(View Only\)\s*$/i` →
view-only. Recomputed on every term-list refresh so a term that flips mid-life stops being
revalidated.

## Serving from D1

- **`getTerms`** → `SELECT code, description FROM term ORDER BY display_order DESC, code DESC`;
  map to `AutocompleteItem`. Description stored verbatim (incl. `(View Only)`), so existing UI
  parsing is unchanged.
- **`searchCourses`** → a `COUNT(*)` for `totalCount` and a paged
  `SELECT raw_json ... ORDER BY <whitelisted col> <dir>, term, crn LIMIT ? OFFSET ?`. Filters:
  `term=?`, `subject=?`, optional `course_number=?`, optional `open_section=1`. **Sort column
  is whitelisted** (map `sortColumn` → fixed physical column; never interpolate).
- **Reconstruct** `SearchResultsResponse`: `data = rows.map(r => JSON.parse(r.raw_json))` — all
  ~30 fields + nested faculty/meetings exact, React islands need zero changes. `success:true`,
  `totalCount` from COUNT, `sectionsFetchedCount = rows.length`, `pathMode:"search"`.
- An un-synced term/subject is an **empty result** (`totalCount:0`), not a 502; reserve 5xx for
  real DB errors.

## Ingestion / refresh design

Add to `web/src/lib/sis/client.ts`: `getSubjects(session, termCode)` (the `searchTerm=""`,
large `max` autocomplete pattern, like `getTerms`) and `getEnrollmentInfo(session, term, crn)`
(POST, parse the HTML fragment for Enrollment Actual/Maximum/Seats Available + Waitlist numbers).

**Full sync per term:** handshake → `getSubjects` (upsert `subject`) → for each subject:
`resetSearchForm` then paginate `searchResults` (page size ~500) until `pageOffset ≥
totalCount`. **The `resetDataForm`-before-each-search quirk is preserved and matters more here**
(one session reused across many subject searches). Upsert = **delete-and-replace per
`(term, subject)`** in a `batch()` (handles cancelled sections; per-subject scope means a
mid-run failure doesn't wipe a whole term). Then update
`term.last_synced_at/last_sync_status/section_count` and write a `sync_run` row.

**Backfill = all available view-only terms.** Heaviest load → **chunked and throttled**:
sequential subject requests with a small delay, resume via `sync_run`/`term.seeded` checkpoints,
run **off the normal cadence** as a deliberate one-shot. Set `term.seeded=1` when done;
view-only seeded terms are skipped forever.

**Recent terms:** full sync every 6–12h (non-view-only). On Node now, trigger via a
secret-guarded API route or a script invoked by system cron; becomes a Workers Cron Trigger
later.

**Manual global seat refresh:** a secret/rate-limited route that, for a term (optionally a
subject or the visible CRN set), calls `getEnrollmentInfo` per CRN and updates the seat columns
+ `raw_json`. Global **cooldown** via `term.last_seat_refresh_at` (reject if within X minutes).

## Phased rollout

1. **Provision + schema** — create D1 `uh_sis`, write/apply `0001_init.sql`, `wrangler types`,
   D1 client shim (HTTP API) + smoke query.
2. **Ingestion + backfill (no user-facing change)** — `getSubjects`/`getEnrollmentInfo`, sync
   orchestration, delete-and-replace upsert, `sync_run` checkpoints. Seed recent terms + begin
   the throttled view-only backfill.
3. **Read path on D1** — `lib/db/queries`, rewrite `search.ts`, thread DB into API routes,
   remove cachified/session/cache. Adapt read-path e2e.
4. **Automation + seat refresh** — scheduled full sync for non-view-only terms; one-time
   view-only seed sweep; manual global seat-refresh route + cooldown; move the reset regression
   test to ingestion.
5. **Workers migration** — see `docs/plans/workers-migration.md`.
6. **Analytics** (future, not built) — below.

## Future analytics (planned, not built)

Tables already provisioned: `section_faculty`, `section_meeting`, `sync_run`,
`enrollment_snapshot` (last populated only after revalidation switches to upsert-by-CRN so seat
history is preserved). Example queries/charts: seat-fill rate per subject/term
(`SUM(enrollment)/SUM(maximum_enrollment) GROUP BY subject`); enrollment-over-time per CRN from
`enrollment_snapshot` (registration velocity line chart); instructor load from `section_faculty`;
building/time-of-day utilization heatmaps from `section_meeting`. Optional R2 raw-payload
archival for re-ingestion/audit.

## Risks

- **Backfill load / Banner rate limits** (all view-only terms) → sequential + delayed requests,
  resumable `sync_run`/`seeded` checkpoints, off-cadence one-shot, keep the realistic User-Agent.
- **D1 free-tier limits** — verify current **rows-written/day** cap and DB size ceiling before
  the big backfill; throttle writes across days or use paid D1.
- **D1-over-HTTP latency** on the Node phase → acceptable for v1, removed by the native binding.
- **`(term, crn)` composite key** (CRNs repeat across terms) — must not key on CRN alone.
- **`resetDataForm` quirk** — preserved on the ingestion path.
- **`process.env` → Worker env** — only `client.ts` reads it today; grep before the Workers
  cutover.

## Verification

- `wrangler d1 execute uh_sis --local --command "SELECT count(*) FROM course_section"` after a
  seeded sync; spot-check `raw_json` round-trips to a valid `CourseSection`.
- Run the ingestion job against `web/e2e/mock-sis-server.mjs`; assert reset-before-search
  ordering and that D1 rows match the mock catalog.
- `yarn test` (read-path Playwright) against seeded local D1 — filter, sort, pagination green.
- Manually exercise `/api/search` and `/api/terms`; confirm a view-only term returns DB-backed
  results with **zero** Banner traffic.
- Trigger a seat refresh; confirm seat columns update and a second refresh within the cooldown
  is rejected.
- `yarn build` (the real typecheck under PnP) passes.
