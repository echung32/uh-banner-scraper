/**
 * Application layer for the read path. Searches are served entirely from the
 * persistent D1 store (see docs/plans/d1-persistence.md); the live Banner API is
 * only touched by the ingestion / refresh jobs in lib/ingest. There is no
 * request-time cache or session pool anymore — D1 is the source of truth.
 */
import { getDb } from "@/lib/db/client";
import { getTerms, searchSections } from "@/lib/db/queries";
import type {
  AutocompleteItem,
  SearchParams,
  SearchResultsResponse,
} from "@/lib/sis/types";

export async function fetchTerms(): Promise<AutocompleteItem[]> {
  return getTerms(getDb());
}

export async function fetchSearchResults(
  params: SearchParams
): Promise<SearchResultsResponse> {
  return searchSections(getDb(), params);
}
