import { establishSession } from "./client";
import type { SisSession } from "./types";

const SESSION_TTL_MS = 28 * 60 * 1000; // 28 minutes (2-min buffer before 30-min server expiry)

const sessionPool = new Map<string, SisSession>();
const inflight = new Map<string, Promise<SisSession>>();

function isExpired(session: SisSession): boolean {
  return Date.now() - session.establishedAt > SESSION_TTL_MS;
}

export async function getOrCreateSession(termCode: string): Promise<SisSession> {
  const existing = sessionPool.get(termCode);
  if (existing && !isExpired(existing)) {
    return existing;
  }

  // Coalesce concurrent init requests for the same term
  const inFlightPromise = inflight.get(termCode);
  if (inFlightPromise) {
    return inFlightPromise;
  }

  const promise = establishSession(termCode)
    .then((session) => {
      sessionPool.set(termCode, session);
      inflight.delete(termCode);
      return session;
    })
    .catch((err) => {
      inflight.delete(termCode);
      sessionPool.delete(termCode);
      throw err;
    });

  inflight.set(termCode, promise);
  return promise;
}

export function evictSession(termCode: string): void {
  sessionPool.delete(termCode);
  inflight.delete(termCode);
}
