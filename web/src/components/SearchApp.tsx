import { useState } from "react";
import { SearchForm } from "./SearchForm";
import { ResultsTable } from "./ResultsTable";
import { ALL_CAMPUSES } from "@/lib/campuses";
import type { AutocompleteItem, SearchResultsResponse } from "@/lib/sis/types";

interface SearchAppProps {
  terms: AutocompleteItem[];
}

interface SearchState {
  term: string;
  subject: string;
  courseNumber: string;
  campus: string;
  college: string;
  department: string;
  openOnly: boolean;
  pageOffset: number;
  pageMaxSize: number;
}

export function SearchApp({ terms }: SearchAppProps) {
  const [results, setResults] = useState<SearchResultsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<SearchState | null>(null);

  async function runSearch(params: SearchState) {
    setIsLoading(true);
    setError(null);

    const query = new URLSearchParams({
      term: params.term,
      subject: params.subject,
      pageOffset: String(params.pageOffset),
      pageMaxSize: String(params.pageMaxSize),
      openOnly: String(params.openOnly),
    });
    if (params.courseNumber) query.set("courseNumber", params.courseNumber);
    // ALL_CAMPUSES (or empty) means "don't filter by campus" — omit the param.
    if (params.campus && params.campus !== ALL_CAMPUSES)
      query.set("campus", params.campus);
    // "ALL" means no catalog facet filter — omit.
    if (params.college && params.college !== "ALL")
      query.set("college", params.college);
    if (params.department && params.department !== "ALL")
      query.set("department", params.department);

    try {
      const res = await fetch(`/api/search?${query.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Search failed");
      }
      const data: SearchResultsResponse = await res.json();
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSearch(params: {
    term: string;
    subject: string;
    courseNumber: string;
    campus: string;
    college: string;
    department: string;
    openOnly: boolean;
  }) {
    const state: SearchState = { ...params, pageOffset: 0, pageMaxSize: 10 };
    setSearchState(state);
    runSearch(state);
  }

  function handlePageChange(pageOffset: number) {
    if (!searchState) return;
    const state = { ...searchState, pageOffset };
    setSearchState(state);
    runSearch(state);
  }

  return (
    <div className="space-y-6">
      <SearchForm terms={terms} onSearch={handleSearch} isLoading={isLoading} />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <ResultsTable
        results={results}
        isLoading={isLoading}
        onPageChange={handlePageChange}
      />
    </div>
  );
}
