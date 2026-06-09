# Plan: Cloudflare Workers Hosting Migration (deferred)

Status: **deferred** — execute after `docs/plans/d1-persistence.md` ships. This document is a
plan only; nothing here is built yet.

## Context

The web app currently runs on Astro's `@astrojs/node` standalone adapter. Once the D1
read-model lands (searches served from D1, Banner only on the ingestion/refresh paths), the
app is a good fit for Cloudflare Workers: a native D1 binding replaces the HTTP-API shim, and
the ingestion job becomes a Cron Trigger instead of a system-cron-invoked Node script.

This migration is intentionally separated from the D1 work so the D1 read-model can be built and
validated on the existing host first, de-risking the platform change.

## Why two Workers

The Astro Cloudflare adapter **owns** the generated Worker entrypoint, and bolting a
`scheduled()` (cron) handler onto it is fragile. Split into:

- **Web Worker** — the Astro app (read path), binds D1, serves UI + JSON endpoints.
- **Ingestion Worker** — a plain Worker exporting `{ scheduled, fetch }`. `scheduled()` runs the
  cron full-sync; `fetch()` is the secret-guarded on-demand backfill / seat-refresh trigger.
  Binds the **same** D1 database.

Both live in the monorepo and share `lib/sis/*` and `lib/db/*`. First cut: import the shared lib
across the workspace (simplest under Yarn PnP). Later refactor: hoist `lib/` to a shared
workspace package.

## Changes

- **`web/astro.config.mjs`** — swap `@astrojs/node` (standalone) for `@astrojs/cloudflare`
  (`platformProxy.enabled` for local D1 in `astro dev`). Add `@astrojs/cloudflare`, drop
  `@astrojs/node`.
- **`web/wrangler.jsonc`** — promote from a D1-tooling-only config to the deploy config: `main`
  → Astro adapter output, `compatibility_flags: ["nodejs_compat"]`, recent
  `compatibility_date`, D1 binding `DB`.
- **`lib/db/client.ts`** — construct from the native `env.DB` binding
  (`context.locals.runtime.env.DB`) instead of the HTTP-API shim. Query code is unchanged — the
  shim and the binding present the same `D1Database` surface.
- **`lib/sis/client.ts`** — still reads `process.env.SIS_BASE_URL` (works on Node, used only by
  the ingestion path). Switch it to the Worker env (`env.SIS_BASE_URL`). Grep for any remaining
  `process.env` in the bundle before cutover — `lib/db/client.ts` also reads `process.env` for
  the D1 mode/credentials and must move to the native binding + Worker env.
- **`ingestion/`** (new Worker) — `wrangler.jsonc` with `triggers.crons`, `src/index.ts`
  (`scheduled` + secret `fetch`), reusing `lib/sis` + `lib/db` + the sync/seat-refresh
  orchestration written in the D1 phase.
- **Secrets** — `wrangler secret put` for any Banner/refresh secrets; D1 needs no secret (it's a
  binding).
- **`wrangler types`** in each Worker to generate D1 binding types.

## Tests

- Read-path Playwright runs under `wrangler dev`/miniflare with a seeded local D1 (the D1 phase
  already moved tests to seeded-D1 fixtures).
- Ingestion test runs the Ingestion Worker under `wrangler dev --test-scheduled` against
  `web/e2e/mock-sis-server.mjs`, asserting the `resetDataForm`-before-`searchResults` ordering
  and that D1 rows match.

## Risks

- Astro Cloudflare adapter + React 19 SSR — verify islands hydrate (expected fine with
  `nodejs_compat`).
- Cron wall-clock / CPU (up to ~5 min) and subrequest limits — recent-term revalidation fits one
  invocation; **backfill must chunk subjects** (cursor in `sync_run`) or fan out via
  Queues/Workflows.
- Confirm current D1 limits (size, rows-written/day) before relying on the free tier in
  production.
