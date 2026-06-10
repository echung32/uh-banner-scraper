/**
 * Request-path source tagging for the dev terminal.
 *
 * The whole point of the D1 read model is that user requests are served from the
 * database and never touch the live Banner API. These tags make that visible at
 * a glance while developing:
 *
 *   [DB]   served from D1 (the fast, normal path)
 *   [SIS]  required a live Banner call (lazy section detail, dynamic term sync,
 *          ingestion) — the slow, rate-limited path. A [SIS] line on a plain
 *          user request means a cache-miss fetch fired.
 *
 * Tags are coloured (cyan / yellow) so they stand out among Astro's request log.
 * Silenced when LOG_SOURCE=0.
 */
const enabled = process.env.LOG_SOURCE !== "0";

const DB_TAG = "\x1b[36m[DB] \x1b[0m"; // cyan
const SIS_TAG = "\x1b[33m[SIS]\x1b[0m"; // yellow

/** Served from D1 — the normal read path. */
export function logDb(msg: string): void {
  if (enabled) console.log(`${DB_TAG} ${msg}`);
}

/** Required a live Banner call — the slow, rate-limited path. */
export function logSis(msg: string): void {
  if (enabled) console.log(`${SIS_TAG} ${msg}`);
}
