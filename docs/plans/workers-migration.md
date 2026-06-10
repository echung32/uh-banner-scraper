# Cloudflare Workers Hosting Migration (shipped)

Status: **shipped**. The web app runs on Cloudflare Workers via the `@astrojs/cloudflare`
adapter, served from a native D1 binding. Ingestion runs from Node (not the Worker). This doc
records the architecture and the decisions behind it; it supersedes the original deferred plan.

## What runs where

- **Web Worker (read path)** — the Astro SSR app + JSON API, deployed by **Workers Builds** from
  GitHub. Reads D1 through the native `env.DB` binding. The only live-Banner calls on the request
  path are the lazy cache-on-miss writers (`pageCache`/`sectionLazy`/`courseTextLazy`/`dynamicSync`),
  which are a handful of subrequests each and fit comfortably in the Worker CPU/subrequest budget.
- **Node ingestion CLI (`web/scripts/ingest.ts`)** — the Banner → D1 write path. The full-catalog
  `sync` and `sync-details` passes run for many minutes (far past the Workers CPU limit), so they
  run in Node against the **same D1** via the REST shim (`D1_MODE=remote`). Invoke locally or from a
  scheduled GitHub Action.

The admin ingestion routes (`/api/admin/*`) still exist but return **501 on the Worker** unless
`INGEST_ON_WORKER=1` (the e2e suite sets it to drive the tiny mock catalog through the worker — that
preserves the `resetDataForm` regression guard without real CPU pressure). Production leaves it unset.

## Why `process.env` needed no rewrite

With `nodejs_compat` and a compatibility date ≥ 2025-04-01 (`2026-06-01`), the
`nodejs_compat_populate_process_env` flag is on, so Worker `vars`/secrets are readable via
`process.env.*` — including top-level module reads like `SIS_BASE` in `lib/sis/client.ts`. The dozen
`process.env` consumers (SIS host, feature flags, `LOG_SOURCE`, `ADMIN_SECRET`) work unchanged; only
their values move into wrangler `vars` (`wrangler.jsonc`) and `ADMIN_SECRET` into a secret.

## D1 access is split by execution context

`node:sqlite` does not exist on workerd, so the old `lib/db/client.ts` (which imported it) cannot
enter the Worker bundle. The access layer is now three modules:

- **`lib/db/types.ts`** — the neutral `D1Like`/`D1Result`/`D1PreparedStatement` interfaces (zero
  imports; safe in both bundles).
- **`lib/db/binding.ts`** — Worker-side `getDb()` returning `env.DB` (via `import { env } from
  "cloudflare:workers"`). The native `D1Database` satisfies `D1Like` structurally; its `batch()` is
  atomic (an improvement over the old non-atomic REST shim). Imported by the read-path routes and
  `lib/search.ts`.
- **`lib/db/client.ts`** — Node-only. Keeps both backends (`remoteD1` REST, `localSqliteD1`
  `node:sqlite`) and the `D1_MODE` selector. Imported **only** by the ingestion CLI. `yarn build`
  fails if `node:sqlite` ever leaks into the Worker bundle — that's the guardrail.

## Config

- **`astro.config.mjs`** — `adapter: cloudflare({ imageService: "passthrough" })` (no Images
  binding). The v13 adapter (built on `@cloudflare/vite-plugin`) wires the local D1 binding into
  `astro dev`/`wrangler dev` from `wrangler.jsonc`. The old `process.loadEnvFile` block is gone.
- **`wrangler.jsonc`** — `name: "uh-course-search"` (must match the GitHub-connected service),
  `main: "@astrojs/cloudflare/entrypoints/server"` (the adapter owns the entry + assets),
  `compatibility_flags: ["nodejs_compat", "nodejs_compat_populate_process_env"]`, the `DB` D1
  binding, and `vars` for `SIS_BASE_URL` + feature flags. `astro build` emits the deploy artifact
  (`dist/server/entry.mjs` + `dist/client/` assets + a generated `dist/server/wrangler.json`); plain
  `wrangler deploy` from `web/` assembles it with the SESSION KV (auto-provisioned), DB, ASSETS, and
  vars all bound.
- **`package.json`** — `build: astro build`; `deploy: astro build && wrangler deploy`;
  `preview: wrangler dev`; `cf-typegen: wrangler types`; `db:snapshot` (below); `ingest: tsx
  scripts/ingest.ts`. `@astrojs/node` removed, `@astrojs/cloudflare` + `@cloudflare/workers-types` +
  `tsx` added. Yarn PnP needed a `packageExtensions` entry in the root `.yarnrc.yml` declaring the
  adapter's undeclared `prismjs` dependency.

## Local dev gets real data (remote → local snapshot)

The seeded local fixture is thin, and the catalog only exists in remote D1. `yarn db:snapshot`
exports remote D1 to SQL and loads it into the local Miniflare store
(`wrangler d1 export uh_sis --remote` → `wrangler d1 execute uh_sis --local --file`). `astro dev`
then reads real data locally via the native binding, offline. The lazy on-the-fly fetches stay
separated per-environment. Note: `yarn test` reseeds the local store, so re-snapshot after testing.

## e2e

Playwright now serves the built Worker under `wrangler dev` (the same artifact that deploys), with
per-test config passed as `--var` (SIS host → mock, `INGEST_ON_WORKER=1`, `COURSE_TEXT_LAZY=0`,
`DYNAMIC_SYNC=1`, `ADMIN_SECRET`) — Playwright's `env:` would only set the parent process and never
reach the worker runtime. `global-setup.ts` seeds the local D1 (unchanged; `node:sqlite` in its own
process). Workers run with `workers: 1` / `fullyParallel: false`: one Miniflare instance throttles
under parallel page loads and races island hydration against the first click (the old standalone-node
server tolerated full parallelism). All 30 specs pass across chromium/firefox/webkit.

## Workers Builds (dashboard) config

- **Root directory:** `web`. **Build command:** `yarn build`. **Deploy command:** `yarn wrangler
  deploy` (`npx` may not resolve under PnP). The D1 binding + vars come from `wrangler.jsonc`;
  `ADMIN_SECRET` is a secret.
- **Disable preview/PR builds:** Settings → Build → **Branch control** → uncheck **Builds for
  non-production branches**.

## Security note

`web/.env` held a live `CLOUDFLARE_API_TOKEN` + `ADMIN_SECRET`. The Worker no longer uses the token
(native binding), but the Node ingestion CLI does. Confirm `.env` is git-ignored (it is) and rotate
if there's any chance it was committed.
