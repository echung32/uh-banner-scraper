/**
 * Neutral D1 surface shared by the read path (native `env.DB` binding, see
 * `binding.ts`) and the Node ingestion backends (REST / local sqlite, see
 * `client.ts`). This module imports nothing so it can be pulled into the Worker
 * bundle without dragging in `node:sqlite`.
 *
 * The interfaces mirror the subset of Cloudflare's native `D1Database` we use;
 * the native binding satisfies them structurally.
 */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Like {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements; atomic where the backend supports it. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
