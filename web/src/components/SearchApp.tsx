import { useEffect, useState } from "react";
import {
  useQueryStates,
  parseAsString,
  parseAsBoolean,
  parseAsInteger,
} from "nuqs";
import { NuqsAdapter } from "nuqs/adapters/react";
import { SearchForm, type SearchFormValues } from "./SearchForm";
import { ResultsTable } from "./ResultsTable";
import { SectionDialog } from "./SectionDialog";
import type { CoverageParams } from "./CoverageDialog";
import { ALL_CAMPUSES, DEFAULT_CAMPUS } from "@/lib/campuses";
import type { AutocompleteItem, SearchResultsResponse } from "@/lib/sis/types";

interface SearchAppProps {
  terms: AutocompleteItem[];
}

const DEFAULT_PAGE_SIZE = 20;

// The executed search lives entirely in the URL (shareable). Default values are
// omitted from the querystring so links stay clean. `page` is 1-based for
// readability; it maps to the API's 0-based `pageOffset`.
const searchParsers = {
  term: parseAsString.withDefault(""),
  subject: parseAsString.withDefault(""),
  courseNumber: parseAsString.withDefault(""),
  campus: parseAsString.withDefault(DEFAULT_CAMPUS),
  college: parseAsString.withDefault(""),
  department: parseAsString.withDefault(""),
  openOnly: parseAsBoolean.withDefault(false),
  crn: parseAsString.withDefault(""),
  page: parseAsInteger.withDefault(1),
  size: parseAsInteger.withDefault(DEFAULT_PAGE_SIZE),
  // `view` is a detail-dialog overlay, NOT a search filter: it holds the CRN
  // whose full detail is shown in a modal. It is deliberately absent from the
  // search-trigger effect below, so opening/closing the dialog never re-runs the
  // table search. Distinct from `crn` (which is the one-row CRN search filter).
  view: parseAsString.withDefault(""),
};

interface SearchQuery {
  term: string;
  subject: string;
  courseNumber: string;
  campus: string;
  college: string;
  department: string;
  openOnly: boolean;
  crn: string;
  page: number;
  size: number;
}

function SearchAppInner({ terms }: SearchAppProps) {
  const [results, setResults] = useState<SearchResultsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Wall-clock duration (ms) of the most recent search/page fetch, client-side.
  const [tookMs, setTookMs] = useState<number | null>(null);
  // `push` so each committed search / page change is its own history entry —
  // the browser Back/Forward buttons then step through prior searches.
  const [q, setQ] = useQueryStates(searchParsers, { history: "push" });

  async function runSearch(params: SearchQuery) {
    setIsLoading(true);
    setError(null);
    const startedAt = performance.now();

    // CRN search is exclusive: a CRN names one section, so send only term + crn
    // and let the server ignore the rest.
    if (params.crn) {
      const crnQuery = new URLSearchParams({ term: params.term, crn: params.crn });
      try {
        const res = await fetch(`/api/search?${crnQuery.toString()}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(err.error ?? "Search failed");
        }
        setResults((await res.json()) as SearchResultsResponse);
        setTookMs(performance.now() - startedAt);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
        setResults(null);
        setTookMs(null);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    const query = new URLSearchParams({
      term: params.term,
      pageOffset: String((params.page - 1) * params.size),
      pageMaxSize: String(params.size),
      openOnly: String(params.openOnly),
    });
    if (params.subject) query.set("subject", params.subject);
    if (params.courseNumber) query.set("courseNumber", params.courseNumber);
    // ALL_CAMPUSES (or empty) means "don't filter by campus" — omit the param.
    if (params.campus && params.campus !== ALL_CAMPUSES)
      query.set("campus", params.campus);
    // Empty college/department means no catalog facet filter — omit.
    if (params.college) query.set("college", params.college);
    if (params.department) query.set("department", params.department);

    try {
      const res = await fetch(`/api/search?${query.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Search failed");
      }
      const data: SearchResultsResponse = await res.json();
      setResults(data);
      setTookMs(performance.now() - startedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
      setTookMs(null);
    } finally {
      setIsLoading(false);
    }
  }

  // The URL is the source of truth: run the search whenever the committed query
  // changes — including on mount, so a shared link reproduces its results.
  useEffect(() => {
    if (!q.term) return;
    runSearch(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    q.term,
    q.subject,
    q.courseNumber,
    q.campus,
    q.college,
    q.department,
    q.openOnly,
    q.crn,
    q.page,
    q.size,
  ]);

  // Committing a new search resets to the first page.
  function handleSearch(params: SearchFormValues) {
    setQ({ ...params, page: 1 });
  }

  // ResultsTable reports the desired 0-based offset; translate to a 1-based page.
  function handlePageChange(pageOffset: number) {
    setQ({ page: Math.floor(pageOffset / q.size) + 1 });
  }

  // Changing rows-per-page resets to the first page.
  function handlePageSizeChange(pageMaxSize: number) {
    setQ({ size: pageMaxSize, page: 1 });
  }

  // Open / navigate the detail dialog. `view` is pushed as its own history entry
  // so Back closes the dialog (or steps to the previously-viewed CRN).
  function openDetail(crn: string) {
    setQ({ view: crn });
  }
  function closeDetail() {
    setQ({ view: "" });
  }

  // Form draft seed + coverage key both derive from the committed URL query.
  const formValues: SearchFormValues = {
    term: q.term,
    subject: q.subject,
    courseNumber: q.courseNumber,
    campus: q.campus,
    college: q.college,
    department: q.department,
    openOnly: q.openOnly,
    crn: q.crn,
  };
  // Remount the form whenever the committed filters change (a new search or a
  // Back/Forward navigation) so its draft re-seeds from the URL. Paging changes
  // only page/size, which aren't in the key, so it doesn't remount the form.
  const formKey = [
    q.term,
    q.subject,
    q.courseNumber,
    q.campus,
    q.college,
    q.department,
    q.openOnly,
    q.crn,
  ].join("|");
  const coverageParams: CoverageParams | null = q.term
    ? {
        term: q.term,
        subject: q.subject,
        courseNumber: q.courseNumber || undefined,
        campus:
          q.campus && q.campus !== ALL_CAMPUSES ? q.campus : undefined,
        college: q.college || undefined,
        department: q.department || undefined,
        openOnly: q.openOnly,
      }
    : null;

  return (
    <div className="space-y-6">
      <SearchForm
        key={formKey}
        terms={terms}
        initialValues={formValues}
        onSearch={handleSearch}
        isLoading={isLoading}
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <ResultsTable
        results={results}
        searchParams={coverageParams}
        tookMs={tookMs}
        isLoading={isLoading}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
        onSelectCrn={openDetail}
      />

      <SectionDialog
        term={q.term}
        crn={q.view || null}
        onSelectCrn={openDetail}
        onClose={closeDetail}
      />
    </div>
  );
}

export function SearchApp(props: SearchAppProps) {
  return (
    <NuqsAdapter>
      <SearchAppInner {...props} />
    </NuqsAdapter>
  );
}
