import { useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SectionDetails } from "./SectionDetails";
import { CoverageDialog, type CoverageParams } from "./CoverageDialog";
import { abbreviateCampus } from "@/lib/campuses";
import type { CourseSection, MeetingTime, SearchResultsResponse } from "@/lib/sis/types";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// Total columns including the leading expand toggle — kept in sync with the
// header / skeleton / empty-state colSpans below.
const COLUMN_COUNT = 13;

interface ResultsTableProps {
  results: SearchResultsResponse | null;
  /** Current search's sort + filters, for the cache-coverage grid. */
  searchParams: CoverageParams | null;
  /** Wall-clock duration (ms) of the fetch that produced `results`. */
  tookMs: number | null;
  isLoading: boolean;
  onPageChange: (pageOffset: number) => void;
  onPageSizeChange: (pageMaxSize: number) => void;
}

function formatDays(mt: MeetingTime): string {
  const days = [
    mt.monday && "M",
    mt.tuesday && "T",
    mt.wednesday && "W",
    mt.thursday && "R",
    mt.friday && "F",
    mt.saturday && "Sa",
    mt.sunday && "Su",
  ].filter(Boolean);
  return days.join("") || "—";
}

function formatTime(hhmm: string | null): string {
  if (!hhmm) return "—";
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(2);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m} ${ampm}`;
}

function formatMeetingTime(mt: MeetingTime): string {
  if (!mt.beginTime && !mt.endTime) return "TBA";
  return `${formatDays(mt)} ${formatTime(mt.beginTime)}–${formatTime(mt.endTime)}`;
}

function SectionRow({ section }: { section: CourseSection }) {
  const [expanded, setExpanded] = useState(false);
  const primaryFaculty = section.faculty.find((f) => f.primaryIndicator) ?? section.faculty[0];
  const meetings = section.meetingsFaculty.map((mf) => mf.meetingTime).filter((mt): mt is MeetingTime => mt != null);

  return (
    <>
    <TableRow
      className="cursor-pointer"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
    >
      <TableCell className="w-8">
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${
            expanded ? "" : "-rotate-90"
          }`}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">{section.courseReferenceNumber}</TableCell>
      <TableCell className="font-mono font-medium">{section.subjectCourse}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {section.campusDescription ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-dotted underline-offset-2">
                {abbreviateCampus(section.campusDescription)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{section.campusDescription}</TooltipContent>
          </Tooltip>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-center">{section.sequenceNumber}</TableCell>
      <TableCell>
        <span className="text-sm">{section.courseTitle}</span>
      </TableCell>
      <TableCell className="text-center">
        {section.creditHours ?? section.creditHourLow ?? "—"}
      </TableCell>
      <TableCell>
        {primaryFaculty?.displayName ? (
          <span className="text-sm">{primaryFaculty.displayName}</span>
        ) : (
          <span className="text-muted-foreground text-sm">TBA</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        {meetings.length === 0 ? (
          <span>TBA</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {meetings.map((mt, i) => (
              <span key={i}>{formatMeetingTime(mt)}</span>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {meetings.length === 0 ? (
          <span>—</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {meetings.map((mt, i) => (
              <span key={i}>
                {mt.building ? `${mt.building} ${mt.room ?? ""}`.trim() : "—"}
              </span>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-center text-sm">
        <span className={section.seatsAvailable > 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}>
          {section.enrollment}/{section.maximumEnrollment}
        </span>
      </TableCell>
      <TableCell className="text-center text-sm">
        {section.waitCapacity > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`cursor-help ${
                  section.waitAvailable > 0
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-500"
                }`}
              >
                {section.waitCount}/{section.waitCapacity}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {section.waitAvailable} waitlist seat{section.waitAvailable === 1 ? "" : "s"} available
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {section.openSection ? (
          <Badge variant="success">Open</Badge>
        ) : (
          <Badge variant="destructive">Closed</Badge>
        )}
      </TableCell>
    </TableRow>
    {expanded && (
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell colSpan={COLUMN_COUNT} className="px-6 pt-0 align-top">
          <SectionDetails section={section} />
        </TableCell>
      </TableRow>
    )}
    </>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export function ResultsTable({
  results,
  searchParams,
  tookMs,
  isLoading,
  onPageChange,
  onPageSizeChange,
}: ResultsTableProps) {
  if (!isLoading && !results) return null;

  const totalCount = results?.totalCount ?? 0;
  const pageOffset = results?.pageOffset ?? 0;
  const pageMaxSize = results?.pageMaxSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageMaxSize));
  const currentPage = Math.floor(pageOffset / pageMaxSize) + 1;
  const lastPageOffset = (totalPages - 1) * pageMaxSize;

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-4">
      {results && (
        <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            {totalCount === 0
              ? "No results found"
              : `Showing ${pageOffset + 1}–${Math.min(pageOffset + pageMaxSize, totalCount)} of ${totalCount} sections`}
            {totalCount > 0 && results?.coverage && searchParams && (
              <>
                {" · "}
                <CoverageDialog params={searchParams} summary={results.coverage} />
              </>
            )}
            {tookMs != null && <> · Took {Math.round(tookMs)} ms</>}
          </span>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs">Rows per page</span>
              <Select
                value={String(pageMaxSize)}
                onValueChange={(v) => onPageSizeChange(Number(v))}
              >
                <SelectTrigger className="h-8 w-[72px]" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <span className="text-xs">
              Page {currentPage} of {totalPages}
            </span>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="First page"
                disabled={currentPage <= 1}
                onClick={() => onPageChange(0)}
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Previous page"
                disabled={currentPage <= 1}
                onClick={() => onPageChange(pageOffset - pageMaxSize)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Next page"
                disabled={currentPage >= totalPages}
                onClick={() => onPageChange(pageOffset + pageMaxSize)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Last page"
                disabled={currentPage >= totalPages}
                onClick={() => onPageChange(lastPageOffset)}
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-20">CRN</TableHead>
              <TableHead className="w-24">Course</TableHead>
              <TableHead>Campus</TableHead>
              <TableHead className="w-16 text-center">Sec</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-16 text-center">Cr</TableHead>
              <TableHead>Instructor</TableHead>
              <TableHead>Days/Times</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="w-20 text-center">Enrolled</TableHead>
              <TableHead className="w-20 text-center">Waitlist</TableHead>
              <TableHead className="w-20">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : results?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="h-24 text-center text-muted-foreground">
                  No course sections match your search.
                </TableCell>
              </TableRow>
            ) : (
              results?.data.map((section) => (
                <SectionRow key={section.courseReferenceNumber} section={section} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
    </TooltipProvider>
  );
}
