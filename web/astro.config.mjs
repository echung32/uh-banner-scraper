import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Load web/.env into process.env for `astro dev`. Vite exposes .env only via
// `import.meta.env`, but the server config (D1_MODE, SIS_BASE_URL, Cloudflare
// creds) is read from `process.env` (and SIS_BASE is read at module load), so
// without this `yarn dev` silently falls back to D1_MODE=local — serving the
// e2e fixture instead of the configured (e.g. remote) store. Runs here, before
// the app module graph is evaluated, so every server module sees the values.
// `loadEnvFile` never overrides already-set vars, so an explicit shell export
// (and the e2e preview's D1_MODE=local) still wins; the catch makes .env
// optional (CI / production supply env directly).
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // no .env file — env is provided by the environment
}

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
