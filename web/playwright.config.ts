import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the UH course-search web app.
 *
 * Read-path tests run the full Astro SSR stack against a seeded local D1
 * (see e2e/global-setup.ts) — searches are served from the database, not SIS.
 * The ingestion test (e2e/ingest.spec.ts) drives the Banner-facing sync against
 * the local mock SIS server (e2e/mock-sis-server.mjs), which the app reaches via
 * SIS_BASE_URL. Nothing here touches the live UH host.
 */
const MOCK_SIS_PORT = 9999;
const APP_PORT = 4321;
const SIS_BASE_URL = `http://127.0.0.1:${MOCK_SIS_PORT}/StudentRegistrationSsb`;
const ADMIN_SECRET = "e2e-admin-secret";
// e2e seeds and mutates its own throwaway D1 here — NOT the default
// `.wrangler/state` the dev server reads — so a test run never clobbers the real
// data developers keep locally. global-setup.ts hardcodes the same path.
const E2E_PERSIST = ".wrangler-e2e";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // Single worker: the app is served by one `wrangler dev` (miniflare) instance,
  // which throttles under many concurrent page loads and races island hydration
  // against the test's first click. Serial execution keeps it deterministic (the
  // old standalone-node server tolerated full parallelism; miniflare does not).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "on-first-retry",
  },

  projects: [
    // The ingestion spec mutates shared D1 state, so it runs on chromium only;
    // the read-path specs run on every browser.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: "**/ingest.spec.ts",
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: "**/ingest.spec.ts",
    },
  ],

  /* Start the mock SIS server and the Astro app before running tests. */
  webServer: [
    {
      command: `node e2e/mock-sis-server.mjs`,
      url: `http://127.0.0.1:${MOCK_SIS_PORT}/StudentRegistrationSsb/health`,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_SIS_PORT: String(MOCK_SIS_PORT) },
      stdout: "pipe",
    },
    {
      // Run the built Worker under wrangler dev (local D1 binding) — the same
      // artifact that deploys. Config reaches the Worker via `--var` (wrangler
      // populates process.env from vars); Playwright's `env:` would only set the
      // parent process and never reach the worker runtime. Vars:
      //   SIS_BASE_URL      → the mock SIS, never the live UH host.
      //   DYNAMIC_SYNC=1    → ingestion spec exercises the page cache (term 202740).
      //   COURSE_TEXT_LAZY=0→ seeded course rows have NULL descriptions; keep the
      //                       course panel off the SIS.
      //   INGEST_ON_WORKER=1→ enable the admin ingestion routes for the ingest
      //                       spec (tiny mock catalog — no real CPU pressure;
      //                       production leaves this unset, so those routes 501).
      command:
        `yarn build && yarn wrangler dev --ip 127.0.0.1 --port ${APP_PORT}` +
        ` --persist-to ${E2E_PERSIST}` +
        ` --var SIS_BASE_URL:${SIS_BASE_URL}` +
        ` --var DYNAMIC_SYNC:1 --var COURSE_TEXT_LAZY:0 --var LOG_SOURCE:0` +
        ` --var INGEST_ON_WORKER:1 --var ADMIN_SECRET:${ADMIN_SECRET}`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      timeout: 180_000,
    },
  ],
});
