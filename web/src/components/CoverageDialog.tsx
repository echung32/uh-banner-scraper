import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ALL_CAMPUSES } from "@/lib/campuses";
import { cn } from "@/lib/utils";
import type { CoverageChunk, CoverageDetail, SearchCoverage } from "@/lib/sis/types";

/** Fields that key a search's coverage (sort + the filters the search applied). */
export interface CoverageParams {
  term: string;
  subject: string;
  courseNumber?: string;
  campus?: string;
  college?: string;
  department?: string;
  openOnly: boolean;
  sortColumn?: string;
  sortDirection?: string;
}

interface CoverageDialogProps {
  params: CoverageParams;
  summary: SearchCoverage;
}

function relativeTime(epochMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const DAY = 24 * 60 * 60 * 1000;

/** Recency bucket for a backfill window, keyed on its oldest (stalest) write. */
type AgeBucket = "fresh" | "recent" | "stale" | "old";
const AGE_BUCKETS: { key: AgeBucket; label: string; cls: string }[] = [
  { key: "fresh", label: "< 1 day", cls: "border-emerald-700/40 bg-emerald-500 dark:bg-emerald-600" },
  { key: "recent", label: "< 1 week", cls: "border-lime-700/40 bg-lime-500 dark:bg-lime-600" },
  { key: "stale", label: "< 1 month", cls: "border-amber-700/40 bg-amber-500 dark:bg-amber-600" },
  { key: "old", label: "older", cls: "border-red-700/40 bg-red-500 dark:bg-red-600" },
];

function ageBucket(oldestSyncedAt: number): AgeBucket {
  const age = Date.now() - oldestSyncedAt;
  if (age < DAY) return "fresh";
  if (age < 7 * DAY) return "recent";
  if (age < 30 * DAY) return "stale";
  return "old";
}

function bucketClass(b: AgeBucket): string {
  return AGE_BUCKETS.find((x) => x.key === b)!.cls;
}

function windowRange(chunk: CoverageChunk, chunkSize: number, totalCount: number) {
  const start = chunk.index * chunkSize + 1;
  const end = Math.min((chunk.index + 1) * chunkSize, totalCount);
  return { start, end };
}

function CoverageGrid({ detail }: { detail: CoverageDetail }) {
  const { chunkSize, totalCount, totalChunks, chunks, mode } = detail;

  // Backfill: every window is present and carries its own age → color by bucket.
  if (mode === "backfill") {
    return (
      <div className="flex flex-wrap gap-1">
        {chunks.map((c) => {
          const { start, end } = windowRange(c, chunkSize, totalCount);
          const oldest = c.oldestSyncedAt ?? 0;
          const newest = c.newestSyncedAt ?? oldest;
          const ages =
            oldest === newest
              ? relativeTime(oldest)
              : `oldest ${relativeTime(oldest)}, newest ${relativeTime(newest)}`;
          return (
            <span
              key={c.index}
              title={`Sections ${start}–${end} · ${ages}`}
              className={cn("h-3 w-3 rounded-[3px] border", bucketClass(ageBucket(oldest)))}
            />
          );
        })}
      </div>
    );
  }

  // Page-cache: fixed grid; filled windows are cached, gaps are not.
  const byIndex = new Map(chunks.map((c) => [c.index, c]));
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: totalChunks }).map((_, i) => {
        const start = i * chunkSize + 1;
        const end = Math.min((i + 1) * chunkSize, totalCount);
        const hit = byIndex.get(i);
        const title = hit
          ? `Sections ${start}–${end} · fetched ${relativeTime(hit.fetchedAt ?? 0)}`
          : `Sections ${start}–${end} · not cached`;
        return (
          <span
            key={i}
            title={title}
            className={cn(
              "h-3 w-3 rounded-[3px] border",
              hit
                ? "border-green-700/40 bg-green-500 dark:bg-green-600"
                : "border-border bg-muted"
            )}
          />
        );
      })}
    </div>
  );
}

function BackfillBody({ detail }: { detail: CoverageDetail }) {
  const oldest = detail.chunks.reduce(
    (m, c) => Math.min(m, c.oldestSyncedAt ?? Infinity),
    Infinity
  );
  const newest = detail.chunks.reduce((m, c) => Math.max(m, c.newestSyncedAt ?? 0), 0);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Last full sync</dt>
        <dd>{detail.lastSyncedAt ? relativeTime(detail.lastSyncedAt) : "—"}</dd>
        <dt className="text-muted-foreground">Last seat refresh</dt>
        <dd>{detail.lastSeatRefreshAt ? relativeTime(detail.lastSeatRefreshAt) : "never"}</dd>
        <dt className="text-muted-foreground">Sections</dt>
        <dd>
          {detail.totalCount.toLocaleString()} in {detail.totalChunks} window
          {detail.totalChunks === 1 ? "" : "s"}
        </dd>
      </dl>
      <CoverageGrid detail={detail} />
      {oldest !== Infinity && (
        <p className="text-xs text-muted-foreground">
          Slices span {relativeTime(oldest)} – {relativeTime(newest)}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {AGE_BUCKETS.map((b) => (
          <span key={b.key} className="flex items-center gap-1.5">
            <span className={cn("h-3 w-3 rounded-[3px] border", b.cls)} />
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function PageCacheBody({ detail }: { detail: CoverageDetail }) {
  const cached = detail.chunks.reduce((n, c) => n + c.count, 0);
  const pct = detail.totalChunks > 0 ? Math.round((detail.chunks.length / detail.totalChunks) * 100) : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-sm">
        <span>
          <span className="font-medium text-foreground">{cached.toLocaleString()}</span> of{" "}
          {detail.totalCount.toLocaleString()} sections cached
        </span>
        <span className="text-muted-foreground">
          {detail.chunks.length} / {detail.totalChunks} windows ({pct}%)
        </span>
      </div>
      <CoverageGrid detail={detail} />
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] border border-green-700/40 bg-green-500 dark:bg-green-600" />
          cached
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] border border-border bg-muted" />
          not cached
        </span>
      </div>
    </div>
  );
}

export function CoverageDialog({ params, summary }: CoverageDialogProps) {
  const [detail, setDetail] = useState<CoverageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBackfill = summary.mode === "backfill";

  async function loadDetail() {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      term: params.term,
      openOnly: String(params.openOnly),
      sortColumn: params.sortColumn ?? "subjectDescription",
      sortDirection: params.sortDirection ?? "asc",
    });
    if (params.subject) query.set("subject", params.subject);
    if (params.courseNumber) query.set("courseNumber", params.courseNumber);
    // campus/college/department shape the backfill row set; match the search.
    if (params.campus && params.campus !== ALL_CAMPUSES) query.set("campus", params.campus);
    if (params.college) query.set("college", params.college);
    if (params.department) query.set("department", params.department);
    try {
      const res = await fetch(`/api/coverage?${query.toString()}`);
      if (!res.ok) throw new Error("Failed to load coverage");
      setDetail((await res.json()) as CoverageDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load coverage");
    } finally {
      setLoading(false);
    }
  }

  function onOpenChange(open: boolean) {
    if (open) loadDetail();
  }

  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground"
          title={
            isBackfill
              ? "View how fresh each 50-section window is"
              : "View which 50-section windows are cached"
          }
        >
          {isBackfill ? "Freshness" : `${summary.cachedCount.toLocaleString()} cached`}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isBackfill ? "Data freshness" : "Cache coverage"}</DialogTitle>
          <DialogDescription>
            {isBackfill
              ? `Each cell is one ${summary.chunkSize}-section window; color shows how recently that slice was last written from Banner (a full sync or a seat refresh)${summary.isViewOnly ? ". This is a past, view-only term — a fixed snapshot" : ""}. Specific to the current sort and filters.`
              : `Each cell is one ${summary.chunkSize}-section window fetched from the live SIS. Coverage is specific to the current sort and filters — changing either starts a fresh set of windows.`}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {detail && !loading && detail.totalCount > 0 && (
          isBackfill ? <BackfillBody detail={detail} /> : <PageCacheBody detail={detail} />
        )}
        {detail && !loading && detail.totalCount === 0 && (
          <p className="text-sm text-muted-foreground">No sections to report.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
