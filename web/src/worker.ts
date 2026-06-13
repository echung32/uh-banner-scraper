// src/worker.ts — custom Worker entrypoint (replaces the adapter's default
// server entry). Re-exports the adapter's request handler as `fetch` (byte-
// equivalent to @astrojs/cloudflare/entrypoints/server, which is just
// { fetch: handle }) and the RefreshWorkflow class so the workflows binding can
// resolve class_name="RefreshWorkflow" in this same module.
import { handle } from "@astrojs/cloudflare/handler";

export { RefreshWorkflow } from "./workflows/refresh";

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env as never, ctx) as unknown as Response;
  },
};
