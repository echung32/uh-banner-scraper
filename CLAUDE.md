# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A reverse-engineering project for the University of Hawaii's Student Information System (Ellucian **Banner SSB9** course search). It has two halves that share the same understanding of the SIS API but no code:

1. **`scripts/`** — Python + Playwright tools that *discovered* the API by driving the real UI in a headless browser and intercepting traffic. These produced the docs and the OpenAPI spec. They talk to the live UH server.
2. **`web/`** — An Astro SSR app that *reimplements* the discovered API as direct HTTP "API mimicry" (no browser), exposing a course-search UI and JSON endpoints backed by a server-side session pool and cache.

The canonical reference for how the SIS API works is **`docs/walkthrough.md`** (request lifecycle, token propagation, all 31 endpoints, full search parameter list) and **`openapi.yaml`** (formal spec). Read the walkthrough before touching `web/src/lib/sis/` — the session handshake there is a direct translation of it.

## The SIS session handshake (core domain knowledge)

Banner SSB9 is a stateful JavaEE/Tomcat app behind an F5 BIG-IP load balancer with CSRF protection. Any client must replay this exact sequence (see `web/src/lib/sis/client.ts:establishSession`):

1. `GET /ssb/term/termSelection?mode=search` → sets `JSESSIONID` + `BIGipServer...` cookies, and embeds **Token_A** in a `<meta name="synchronizerToken">` tag.
2. `POST /ssb/term/search?mode=search` (form-encoded `term`, `uniqueSessionId`) with Token_A → locks the term into the session (302 redirect).
3. `GET /ssb/classSearch/classSearch` → returns a **refreshed Token_B** in the same meta tag.
4. All subsequent search / contact-card / details calls use **Token_B** in the `x-synchronizer-token` header plus the cookie jar.

Key invariants: the synchronizer token is passed as the `x-synchronizer-token` header (not a cookie); Token_A and Token_B are *different* and the switch happens at step 3; the BIGip cookie name varies (it embeds the server pool) so code matches by `startsWith("BIGipServer")`; server sessions expire after ~30 minutes. Most details-modal endpoints return raw HTML fragments, not JSON.

**The search form is stateful server-side.** Banner stores the previous search's criteria against the session, so a pooled/reused session "remembers" the last search. `searchCourses` therefore issues `POST /ssb/classSearch/resetDataForm` (Token_B, empty body, returns `"true"`) *before* every `searchResults` call — without it, changed filters like `txt_courseNumber` are silently ignored and the table shows the prior results. This is the single most subtle correctness trap in the client; don't remove the reset.

## web/ architecture

Astro `output: "server"` with the Node standalone adapter; React islands for interactivity; Tailwind v4 via the Vite plugin; shadcn/ui components under `src/components/ui/`.

The app is split into a **read path** (user-facing, served entirely from a persistent Cloudflare D1 store) and **write paths** (Banner-facing ingestion/refresh jobs that populate D1). The live Banner API is never on the request hot path. Design + rationale: `docs/plans/d1-persistence.md`; the deferred Cloudflare Workers hosting migration: `docs/plans/workers-migration.md`.

**Read path** (each layer only calls the one below):
- **`src/pages/api/{search,terms,filters,course,section,instructor}.ts`** — thin Astro API routes; parse/validate/clamp params, map errors to HTTP status. `filters` serves server-driven dropdown menus (incl. `kind=subject`, derived from the term's sections); `course` serves catalog facts + text for one course (keyed by `term+campus+subject+courseNumber`); `section` serves per-CRN detail (restrictions/fees/cross-list/…); `instructor` serves contact-card facts by `bannerId`. `search` filters by `campus`, `college`, and `department`; **`subject` is optional — omitting it searches all subjects in the term.** `search` also has a **CRN mode**: a `crn` param identifies exactly one section (a CRN is unique only *within* a term — never globally — and Banner's search form has no CRN field), so it ignores every other filter and returns that single section. `search` is also the one read route that may trigger a live Banner call: for a not-yet-backfilled ("dynamic") term it serves searches from a demand-driven, sort-aware **page cache** — fetching only the viewed page(s) live from Banner and recording coverage (see page cache below); a CRN miss on a dynamic term likewise falls back to a single live fetch (`crnLazy`).
- **`src/lib/search.ts`** — application layer; calls the DB query layer (no cache, no Banner, no session).
- **`src/lib/db/queries.ts`** — `getTerms`, `searchSections` (reproduces Banner's filter/sort/paginate in SQL; sort whitelisted; LEFT JOINs `course` for the campus/college/department filters; `subject` is an optional filter — empty = all subjects), `getFilterOptions`, `getCatalogFacet`, `getSubjectFacet` (the Subject menu — the union of subjects with sections and the enumerated `subject` table, so un-backfilled terms still list subjects once enumerated), `getCourseCatalog`. Sections are reconstructed byte-faithfully from a stored `raw_json` blob (`src/lib/db/mappers.ts`). **College/Department menus are derived from the `course` table (`getCatalogFacet`), not `filter_option` — UH disables `get_college`/`get_department`/`get_scheduleType`/`get_partOfTerm` in their Banner config (confirmed live; `filter_option` only carries campus/subject/attribute/level/instructionalMethod).** Catalog facts are per `(term, campus, subject, course)` — the same course at another campus is a different catalog entry.
- **`src/lib/db/client.ts`** — a narrow `D1Like` interface with two backends: `remoteD1` (D1 REST API, for a deployed Node host) and `localSqliteD1` (Node `node:sqlite` over the wrangler local D1 file, for dev/tests). Selected by `D1_MODE`. On Workers the native `env.DB` binding satisfies `D1Like` directly.

**Write path** (Banner-facing; only these touch the live SIS):
- **`src/lib/sis/client.ts`** — the SIS HTTP client and handshake: `establishSession`, `getTerms`, `getSubjects`, `resetSearchForm`, `searchCourses`, `getEnrollmentInfo`, plus the course-details fetchers `getFilterOptions` (the `get_*` menus), `getCatalogDetails`, and `getClassDetails` (the per-CRN modal that echoes a section's subject + catalog course number — used by the CRN-lookup fallback). HTML-fragment parsers live in `src/lib/sis/parse/`.
- **`src/lib/ingest/*`** — `sync.ts` (full catalog sync: enumerate subjects, paginate, delete-and-replace per `(term,subject)`), `seatRefresh.ts` (per-CRN seat-only update via `getEnrollmentInfo`), `terms.ts` (term-list refresh + `is_view_only` recompute — populates **every** term, no section backfill), `details.ts` (course-details phase: filter-option menus, course-level catalog/text from one representative CRN per `(campus,course)`, per-CRN `section_detail`, and per-instructor contact cards — see `docs/plans/course-details.md`), `sectionLazy.ts`, `courseTextLazy.ts`, `dynamicSync.ts`, `pageCache.ts`, and `crnLazy.ts` (the cache-on-miss paths invoked from read routes — see below). HTML-fragment parsers live in `src/lib/sis/parse/`.

**Cache-on-miss (the only live-Banner calls on a user request).** Several lazy paths fill gaps on first view and serve from D1 forever after, invoked from the API routes (never the query layer, so it stays Banner-free):
- `sectionLazy.ensureSectionDetail` — per-CRN section detail (`/api/section`).
- `courseTextLazy.ensureCourseText` — per-course description/prereqs/coreqs (`/api/course`); the eager catalog pass ran `text=0`, so existing `course` rows have a NULL description until first view. `raw_description_html` is the "fetched" marker.
- `pageCache.ensureSearchPage` — the demand-driven **page cache** (`/api/search`). For a dynamic term, fetches **only the offset window(s) the user is viewing** live from Banner (`searchCourses` omits `txt_subject` for an all-subjects page — Banner returns the whole sorted, paginated term), stores the bodies in `course_section` (`upsert.upsertSections`, keyed `term,crn` — no delete window), and records each filled window in `search_chunk`, keyed by **sort order + the live-applied filters** (`subject`/`courseNumber`/`openOnly`; college/department are catalog-derived and unavailable for dynamic terms). The read side reassembles a page from cached windows (`queries.getSearchPageFromChunks`). Windows are a fixed internal size (`CHUNK_SIZE`); view-only terms are immutable so a window never expires, other terms revalidate after `PAGE_TTL_MS`. Coverage fills incrementally as users page through. Replaces the old per-`(term,subject)` lazy sync.
- `dynamicSync.ensureTermSubjects` — the term's subject **menu** (`/api/filters?kind=subject`); one `getSubjects` call so a not-yet-backfilled term's Subject dropdown isn't empty (`term.subjects_synced_at` marks it ran, so a term with zero subjects isn't re-hit).
- `crnLazy.ensureSectionByCrn` — one section by `(term, crn)` for the search route's CRN mode (`/api/search?crn=`). A CRN search has no subject/course-number to page on, and Banner has no CRN search field, so on a D1 miss it calls `getClassDetails(term, crn)` to learn the catalog course number (and confirm the CRN exists), runs a course-number-scoped `searchResults` to pick the matching row, and stores it. Backfilled terms already hold every section, so a miss there is a genuine "no such section" — no live call.

The dynamic paths only fire for a term that was never fully backfilled (`term.last_synced_at IS NULL`); backfilled terms serve searches entirely from D1 via the SQL path, so they never trigger. All are gated by env flags (`SECTION_LAZY_FETCH`, `COURSE_TEXT_LAZY`, `DYNAMIC_SYNC`) and dedupe concurrent first-hits. e2e marks the read-path fixture terms backfilled so their searches stay on the SQL path, and exercises the page cache against a dedicated dynamic term (`COURSE_TEXT_LAZY=0` keeps the course panel off the mock). Dev logs tag every request path: **`[DB]`** (served from D1) vs **`[SIS]`** (a live Banner call) via `src/lib/log.ts` (`LOG_SOURCE=0` to silence). **Known gap:** College/Department menus (catalog-derived) stay empty for an un-backfilled term until its catalog is synced — only subjects + the viewed section pages are filled dynamically.
- **`src/lib/db/upsert.ts`** — all D1 writes + `sync_run` bookkeeping.
- **`src/pages/api/admin/{sync,refresh-seats,sync-details,refresh-terms}.ts`** — secret-guarded (`x-admin-secret`) triggers; seat refresh enforces a global per-term cooldown; `sync-details` runs after a full sync (it enumerates the live course set from D1); `refresh-terms` populates the `term` table with every Banner term (no section backfill — the rest fill in on demand via the page cache). POSTs must send `Content-Type: application/json` to clear Astro's CSRF origin check.

D1 schema lives in `web/migrations/` (`wrangler d1 migrations apply uh_sis [--local|--remote]`). `0001` is the core search model; `0002` adds the additive course-details tables (`course`, `filter_option`, plus `section_detail`/`instructor` reserved for later slices) — these are *new native tables*; `0006` adds `search_chunk` (the demand-driven page cache's per-window coverage for dynamic terms); `course_section` + `raw_json` stays Banner-faithful (hybrid, per `docs/plans/course-details.md`). `SIS_BASE_URL`, `D1_MODE`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`, and `ADMIN_SECRET` come from env (see `web/.env.example`).

> Note: the previous in-memory `cachified`/`unstorage` cache and the in-memory session pool (`src/lib/cache/`, `src/lib/sis/session.ts`) have been removed — D1 is the source of truth and the handshake now runs once per ingestion job, not per request.

## Commands

### web/ (Yarn 4, run from `web/`)
```bash
yarn dev        # astro dev server
yarn build      # production build (also the real typecheck — astro check's binary doesn't resolve under PnP)
yarn preview    # serve the build
yarn test       # playwright e2e (all browsers)
yarn test --project=chromium                 # single browser
yarn test -g "course number filter"          # single test by title
```
Note: the **root** also has a `package.json` with `workspaces: ["web"]` and Yarn PnP (`.pnp.cjs`); run `yarn` from the root (or `web/`) to install. The `yarn astro check` typecheck cannot find its binary under Yarn PnP, so rely on `yarn build` for type errors.

**Env loading.** Server config (`D1_MODE`, `SIS_BASE_URL`, the Cloudflare D1 creds, `ADMIN_SECRET`) is read from `process.env`. Vite only surfaces `.env` via `import.meta.env`, so `astro.config.mjs` calls `process.loadEnvFile("./.env")` at the top — this is what makes **`yarn dev` pick up `web/.env`** (without it `D1_MODE` is unset → defaults to `local` → dev serves the e2e fixture, not the remote store). `loadEnvFile` never overrides already-set vars, so an explicit shell export wins and e2e's `D1_MODE=local` is unaffected. The built standalone server (`yarn preview`) does **not** load `astro.config.mjs`, so preview/ingestion runs still need env exported first (`set -a; . ./.env; set +a`).

E2E tests live in `web/e2e/` and run the **full Astro SSR build** (`build` + `preview`); Playwright's `webServer` launches both the app and the mock SIS server (`web/e2e/mock-sis-server.mjs`) — never the live UH host. Two flavors:
- **Read-path** (`search.spec.ts`, all browsers) — served from a **seeded local D1**. `e2e/global-setup.ts` applies the local migration and inserts a fixture catalog; the app reads it via `D1_MODE=local`. No SIS involved.
- **Ingestion** (`ingest.spec.ts`, chromium only — it mutates shared D1) — drives the Banner-facing sync/seat-refresh through the admin routes against the mock SIS, writing to the same local D1. The mock reproduces Banner's stateful-form quirk, and the sync reuses one session across two subjects, so the test is the genuine regression guard for the `resetDataForm` reset.

Tests use the production build (not `dev`) to keep the Astro dev toolbar out of the DOM.

### Python scripts (uv, run from repo root)
```bash
uv run python scripts/<name>.py
uv run playwright install        # first-time browser setup
```
Python 3.13+, the only dependency is `playwright` (`pyproject.toml`). `main.py` is an unused `uv init` stub.

## scripts/ orientation

Two kinds, documented fully in `docs/scripts.md`:
- **Live (hit the real UH server via Playwright):** `verify_all_endpoints.py` (sequential 200-OK check of all 31 endpoints → `verification_report.json`), `scrape_banner.py` (captures traffic → `intercepted_calls.json`), `confirm_search_params.py`, and the cookie/token diagnostics (`find_tokens.py`, `get_session_cookies.py`).
- **Offline (analyze the dumped `intercepted_calls.json`, no network):** the `inspect_*.py` family + `validate_openapi.py`.

When the SIS API behavior is in question, prefer re-running the offline `inspect_*` scripts against the existing dumps before hitting the live server.
