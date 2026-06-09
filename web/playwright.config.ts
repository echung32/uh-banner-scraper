import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the UH course-search web app.
 *
 * Tests run the full Astro SSR stack against a local mock SIS server
 * (e2e/mock-sis-server.mjs) so they are deterministic and never touch the live
 * UH host. The mock listens on MOCK_SIS_PORT and the Astro server is pointed at
 * it via SIS_BASE_URL.
 */
const MOCK_SIS_PORT = 9999;
const APP_PORT = 4321;
const SIS_BASE_URL = `http://127.0.0.1:${MOCK_SIS_PORT}/StudentRegistrationSsb`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "on-first-retry",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
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
      command: `yarn astro dev --port ${APP_PORT} --host 127.0.0.1`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      env: { SIS_BASE_URL },
      stdout: "pipe",
      timeout: 120_000,
    },
  ],
});
