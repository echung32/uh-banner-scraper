import { getTerms, searchCourses } from "@/lib/sis/client";
import { getOrCreateSession } from "@/lib/sis/session";
import type { AutocompleteItem, SearchParams, SearchResultsResponse } from "@/lib/sis/types";
import { cache, cachified } from "@/lib/cache/index";
import { searchKey, termListKey } from "@/lib/cache/keys";

const TERMS_FALLBACK_TERM = "202510"; // a known recent term used only to bootstrap getTerms

export async function fetchTerms(): Promise<AutocompleteItem[]> {
  return cachified({
    cache,
    key: termListKey(),
    ttl: 4 * 60 * 60 * 1000, // 4 hours
    staleWhileRevalidate: 60 * 60 * 1000, // 1 hour extra stale window
    async getFreshValue() {
      const session = await getOrCreateSession(TERMS_FALLBACK_TERM);
      return getTerms(session);
    },
  });
}

export async function fetchSearchResults(
  params: SearchParams
): Promise<SearchResultsResponse> {
  return cachified({
    cache,
    key: searchKey(params),
    ttl: 5 * 60 * 1000, // 5 minutes
    staleWhileRevalidate: 60 * 1000, // 1 minute extra stale window
    async getFreshValue() {
      const session = await getOrCreateSession(params.term);
      return searchCourses(session, params);
    },
  });
}
