/**
 * D1 access layer.
 *
 * The query code in this directory targets a narrow `D1Like` interface that
 * mirrors the subset of Cloudflare's native `D1Database` binding we use. Two
 * backends implement it:
 *
 *   - `remoteD1`      — the D1 REST API (shared, durable). Used by a deployed
 *                       Node host where no native binding exists.
 *   - `localSqliteD1` — Node 24's built-in `node:sqlite` over the wrangler
 *                       local D1 file (`.wrangler/state`). Used in dev + e2e so
 *                       tests run against a fast, deterministic local store that
 *                       `wrangler d1 execute --local` can seed.
 *
 * On the eventual move to Cloudflare Workers (docs/plans/workers-migration.md)
 * the native `env.DB` binding satisfies `D1Like` directly, so only `getDb()`'s
 * construction changes — the queries stay identical.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

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

const EMPTY_META: Record<string, unknown> = {};

interface RawStatement {
  sql: string;
  params: unknown[];
}

/** A prepared statement that exposes its (sql, params) for batch combining. */
interface BoundStatement extends D1PreparedStatement {
  readonly raw: RawStatement;
}

// ── remote D1 (REST API) backend ────────────────────────────────────────────

interface HttpConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

async function httpQuery(
  config: HttpConfig,
  statements: RawStatement[]
): Promise<D1Result[]> {
  // The REST /query endpoint runs a (possibly multi-statement) SQL string with
  // one positional params array, returning one result object per statement.
  const sql = statements.map((s) => s.sql).join(";\n");
  const params = statements.flatMap((s) => s.params);

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    }
  );

  const json = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result?: Array<{ results?: unknown[]; success: boolean; meta?: unknown }>;
  };

  if (!res.ok || !json.success) {
    const msg = json.errors?.map((e) => e.message).join("; ") ?? res.statusText;
    throw new Error(`D1 HTTP query failed: ${msg}`);
  }

  return (json.result ?? []).map((r) => ({
    results: (r.results ?? []) as Record<string, unknown>[],
    success: r.success,
    meta: (r.meta ?? EMPTY_META) as Record<string, unknown>,
  }));
}

function httpStatement(
  config: HttpConfig,
  sql: string,
  params: unknown[]
): BoundStatement {
  return {
    raw: { sql, params },
    bind(...values: unknown[]) {
      return httpStatement(config, sql, values);
    },
    async first<T>(colName?: string): Promise<T | null> {
      const [result] = await httpQuery(config, [{ sql, params }]);
      const row = result?.results[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return (colName ? (row[colName] as T) : (row as T)) ?? null;
    },
    async all<T>(): Promise<D1Result<T>> {
      const [result] = await httpQuery(config, [{ sql, params }]);
      return result as D1Result<T>;
    },
    async run(): Promise<D1Result> {
      const [result] = await httpQuery(config, [{ sql, params }]);
      return result;
    },
  };
}

export function remoteD1(config: HttpConfig): D1Like {
  return {
    prepare(query: string) {
      return httpStatement(config, query, []);
    },
    async batch(statements: D1PreparedStatement[]) {
      const raw = statements.map((s) => (s as BoundStatement).raw);
      return httpQuery(config, raw);
    },
  };
}

// ── node:sqlite (local wrangler D1 file) backend ────────────────────────────

function findLocalD1File(): string {
  const dir = join(
    process.cwd(),
    ".wrangler",
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject"
  );
  const file = readdirSync(dir).find(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite"
  );
  if (!file) {
    throw new Error(
      `No local D1 sqlite file in ${dir}. Run: wrangler d1 migrations apply uh_sis --local`
    );
  }
  return join(dir, file);
}

function localStatement(
  db: DatabaseSync,
  sql: string,
  params: unknown[]
): D1PreparedStatement {
  return {
    bind(...values: unknown[]) {
      return localStatement(db, sql, values);
    },
    async first<T>(colName?: string): Promise<T | null> {
      const row = db.prepare(sql).get(...(params as never[])) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      return (colName ? (row[colName] as T) : (row as T)) ?? null;
    },
    async all<T>(): Promise<D1Result<T>> {
      const results = db.prepare(sql).all(...(params as never[])) as T[];
      return { results, success: true, meta: EMPTY_META };
    },
    async run(): Promise<D1Result> {
      db.prepare(sql).run(...(params as never[]));
      return { results: [], success: true, meta: EMPTY_META };
    },
  };
}

export function localSqliteD1(filePath?: string): D1Like {
  // Foreign keys are intentionally OFF to match D1, which does not enforce FK
  // constraints by default. node:sqlite enables them by default, so it must be
  // disabled explicitly. Child rows are pruned explicitly in the upsert path.
  const db = new DatabaseSync(filePath ?? findLocalD1File(), {
    enableForeignKeyConstraints: false,
  });
  return {
    prepare(query: string) {
      return localStatement(db, query, []);
    },
    async batch(statements: D1PreparedStatement[]) {
      db.exec("BEGIN");
      try {
        const out: D1Result[] = [];
        for (const stmt of statements) out.push(await stmt.run());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

// ── selector ────────────────────────────────────────────────────────────────

let cached: D1Like | null = null;

/**
 * Returns the process-wide D1 client. `D1_MODE=local` (default outside
 * production) uses the wrangler local file; otherwise the remote REST API is
 * used, requiring CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN.
 */
export function getDb(): D1Like {
  if (cached) return cached;
  cached = createDb();
  return cached;
}

function createDb(): D1Like {
  const mode =
    process.env.D1_MODE ??
    (process.env.NODE_ENV === "production" ? "remote" : "local");

  if (mode === "local") return localSqliteD1();

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = process.env.D1_DATABASE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      "Remote D1 requires CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN"
    );
  }
  return remoteD1({ accountId, databaseId, apiToken });
}
