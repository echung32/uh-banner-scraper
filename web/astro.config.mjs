import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Runtime config (SIS_BASE_URL, feature flags, ADMIN_SECRET) is supplied to the
// Worker as wrangler `vars`/secrets (and `.dev.vars` locally). With
// `nodejs_compat` + `nodejs_compat_populate_process_env` it lands on `process.env`,
// so the existing `process.env.*` reads keep working with no per-call env
// threading. The v13 adapter (built on @cloudflare/vite-plugin) wires the local
// D1 binding into `astro dev`/`astro preview` from wrangler.jsonc automatically.
// `imageService: "passthrough"` opts out of the Cloudflare Images binding (we
// don't transform images), so no IMAGES binding is required.
export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
