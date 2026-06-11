/**
 * Edge-response cache for the read API routes, backed by the Cloudflare Cache
 * API (`caches.default`). A cache hit serves the response without touching D1 at
 * all — this is what makes the read path scale with traffic instead of with the
 * D1 rows-read budget (see docs/plans/d1-read-optimization.md).
 *
 * Why the Cache API and not Workers KV: the cache is per data center but shared
 * by every isolate in it (our audience is effectively single-colo), it's free
 * and unmetered, and a search cache's high key cardinality would burn KV's
 * 1k-writes/day free tier on cache *fills* alone.
 *
 * Invalidation is by KEY VERSION, not purge (the Cache API has no global purge):
 * the term's sync timestamps are baked into the cache key, so a full sync or
 * seat refresh moves every reader to fresh keys and the stale entries simply age
 * out of the colo. The TTL is therefore only a garbage/staleness bound, not the
 * invalidation mechanism.
 *
 * Only responses for BACKFILLED terms are cached (termCacheProfile returns null
 * otherwise): dynamic terms mutate D1 on read (page cache / lazy fills), so
 * caching their responses would freeze the very coverage a request is meant to
 * grow.
 *
 * Disabled with EDGE_CACHE=0 (e2e sets it: the ingestion specs mutate D1 mid-run
 * and must observe fresh reads). Outside a Cloudflare runtime `caches` is absent
 * and every call transparently degrades to uncached.
 */
import type { TermSyncMeta } from "@/lib/db/queries";

/** Minimal structural Cache type — avoids depending on DOM vs workers-types. */
interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function edgeCache(): CacheLike | null {
  if (process.env.EDGE_CACHE === "0") return null;
  const caches = (globalThis as { caches?: { default?: CacheLike } }).caches;
  return caches?.default ?? null;
}

/** View-only terms are immutable — cache for a week (key version pins content). */
export const VIEW_ONLY_TTL_S = 7 * 24 * 3600;
/** Active terms: seat data only moves on refresh (which bumps the key version). */
export const ACTIVE_TTL_S = 3600;

export interface CacheProfile {
  /** Data-version baked into the cache key; a bump is the invalidation. */
  version: string;
  ttlSeconds: number;
}

/**
 * The cache profile for a term's responses, or null when they must not be
 * cached (unknown or dynamic term — those reads fill D1 as a side effect).
 */
export function termCacheProfile(meta: TermSyncMeta | null): CacheProfile | null {
  if (meta?.lastSyncedAt == null) return null;
  return {
    version: `${meta.lastSyncedAt}.${meta.lastSeatRefreshAt ?? 0}`,
    ttlSeconds: meta.isViewOnly ? VIEW_ONLY_TTL_S : ACTIVE_TTL_S,
  };
}

/**
 * Serves `request` from the edge cache, or runs `produce` and caches its
 * response (200s only). The synthetic key host is never fetched — it just
 * namespaces entries; sorted query params keep param order from splitting
 * entries. Responses carry `x-edge-cache: hit|miss` for debugging/tests.
 */
export async function withEdgeCache(
  request: Request,
  profile: CacheProfile,
  produce: () => Promise<Response>
): Promise<Response> {
  const cache = edgeCache();
  if (!cache) return produce();

  const url = new URL(request.url);
  url.searchParams.sort();
  const key = new Request(
    `https://edge-cache.internal/${encodeURIComponent(profile.version)}`
      + `${url.pathname}?${url.searchParams}`,
    { method: "GET" }
  );

  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch {
    // Cache unavailable (non-CF runtime quirk) — fall through to uncached.
  }

  const res = await produce();
  if (res.status !== 200) return res;

  const body = await res.arrayBuffer();
  const stored = new Headers(res.headers);
  stored.set("Cache-Control", `public, max-age=${profile.ttlSeconds}`);
  // Stored copy says "hit": that's what a future match will truthfully be.
  stored.set("x-edge-cache", "hit");
  try {
    await cache.put(key, new Response(body, { status: 200, headers: stored }));
  } catch {
    // cache.put can reject (e.g. dashboard preview) — serving uncached is fine.
  }

  const fresh = new Headers(res.headers);
  fresh.set("x-edge-cache", "miss");
  return new Response(body, { status: 200, headers: fresh });
}
