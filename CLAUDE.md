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
- **`src/pages/api/{search,terms}.ts`** — thin Astro API routes; parse/validate/clamp params, map errors to HTTP status.
- **`src/lib/search.ts`** — application layer; calls the DB query layer (no cache, no Banner, no session).
- **`src/lib/db/queries.ts`** — `getTerms` and `searchSections` (reproduces Banner's filter/sort/paginate semantics in SQL; sort column is whitelisted). Sections are reconstructed byte-faithfully from a stored `raw_json` blob (`src/lib/db/mappers.ts`).
- **`src/lib/db/client.ts`** — a narrow `D1Like` interface with two backends: `remoteD1` (D1 REST API, for a deployed Node host) and `localSqliteD1` (Node `node:sqlite` over the wrangler local D1 file, for dev/tests). Selected by `D1_MODE`. On Workers the native `env.DB` binding satisfies `D1Like` directly.

**Write path** (Banner-facing; only these touch the live SIS):
- **`src/lib/sis/client.ts`** — the SIS HTTP client and handshake: `establishSession`, `getTerms`, `getSubjects`, `resetSearchForm`, `searchCourses`, `getEnrollmentInfo`.
- **`src/lib/ingest/*`** — `sync.ts` (full catalog sync: enumerate subjects, paginate, delete-and-replace per `(term,subject)`), `seatRefresh.ts` (per-CRN seat-only update via `getEnrollmentInfo`), `terms.ts` (term-list refresh + `is_view_only` recompute).
- **`src/lib/db/upsert.ts`** — all D1 writes + `sync_run` bookkeeping.
- **`src/pages/api/admin/{sync,refresh-seats}.ts`** — secret-guarded (`x-admin-secret`) triggers; seat refresh enforces a global per-term cooldown. POSTs must send `Content-Type: application/json` to clear Astro's CSRF origin check.

D1 schema lives in `web/migrations/` (`wrangler d1 migrations apply uh_sis [--local|--remote]`). `SIS_BASE_URL`, `D1_MODE`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`, and `ADMIN_SECRET` come from env (see `web/.env.example`).

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
