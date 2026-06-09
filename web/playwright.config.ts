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

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
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
      // Use the production build (preview) rather than dev so the Astro dev
      // toolbar / serialized island debug output don't pollute the DOM.
      command: `yarn build && yarn preview`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      env: {
        SIS_BASE_URL,
        HOST: "127.0.0.1",
        PORT: String(APP_PORT),
        // Read path serves from the seeded local D1; ingestion writes to it.
        D1_MODE: "local",
        ADMIN_SECRET,
      },
      stdout: "pipe",
      timeout: 180_000,
    },
  ],
});
