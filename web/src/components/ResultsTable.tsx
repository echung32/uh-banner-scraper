import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CourseSection, MeetingTime, SearchResultsResponse } from "@/lib/sis/types";

interface ResultsTableProps {
  results: SearchResultsResponse | null;
  isLoading: boolean;
  onPageChange: (pageOffset: number) => void;
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
  const primaryFaculty = section.faculty.find((f) => f.primaryIndicator) ?? section.faculty[0];
  const primaryMeeting = section.meetingsFaculty[0]?.meetingTime;

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{section.subject}</TableCell>
      <TableCell className="font-mono font-medium">{section.subjectCourse}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {section.campusDescription ?? "—"}
      </TableCell>
      <TableCell className="text-center">{section.sequenceNumber}</TableCell>
      <TableCell className="max-w-[200px]">
        <span className="line-clamp-2 text-sm">{section.courseTitle}</span>
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
        {primaryMeeting ? formatMeetingTime(primaryMeeting) : "TBA"}
      </TableCell>
      <TableCell className="text-sm">
        {primaryMeeting?.building
          ? `${primaryMeeting.building} ${primaryMeeting.room ?? ""}`.trim()
          : "—"}
      </TableCell>
      <TableCell className="text-center text-sm">
        <span className={section.seatsAvailable > 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}>
          {section.enrollment}/{section.maximumEnrollment}
        </span>
      </TableCell>
      <TableCell>
        {section.openSection ? (
          <Badge variant="success">Open</Badge>
        ) : (
          <Badge variant="destructive">Closed</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: 11 }).map((__, j) => (
            <TableCell key={j}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export function ResultsTable({ results, isLoading, onPageChange }: ResultsTableProps) {
  if (!isLoading && !results) return null;

  const totalCount = results?.totalCount ?? 0;
  const pageOffset = results?.pageOffset ?? 0;
  const pageMaxSize = results?.pageMaxSize ?? 10;
  const totalPages = Math.ceil(totalCount / pageMaxSize);
  const currentPage = Math.floor(pageOffset / pageMaxSize) + 1;

  return (
    <div className="space-y-4">
      {results && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {totalCount === 0
              ? "No results found"
              : `Showing ${pageOffset + 1}–${Math.min(pageOffset + pageMaxSize, totalCount)} of ${totalCount} sections`}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => onPageChange(pageOffset - pageMaxSize)}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <span className="text-xs">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={currentPage >= totalPages}
                onClick={() => onPageChange(pageOffset + pageMaxSize)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Subj</TableHead>
              <TableHead className="w-24">Course</TableHead>
              <TableHead>Campus</TableHead>
              <TableHead className="w-16 text-center">Sec</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-16 text-center">Cr</TableHead>
              <TableHead>Instructor</TableHead>
              <TableHead>Days/Times</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="w-20 text-center">Enrolled</TableHead>
              <TableHead className="w-20">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows />
            ) : results?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
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
  );
}
