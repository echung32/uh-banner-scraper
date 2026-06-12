import { useEffect, useState } from "react";
import { Check, Link2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionDetails } from "./SectionDetails";
import { formatDays, formatTime } from "@/lib/meetingTime";
import type {
  CourseSection,
  MeetingTime,
  SearchResultsResponse,
} from "@/lib/sis/types";

interface SectionDialogProps {
  /** Current search term; a CRN is unique only within a term. */
  term: string;
  /** The CRN whose detail to show; null = dialog closed. */
  crn: string | null;
  /** Navigate the dialog to another CRN (e.g. a cross-listed sibling). */
  onSelectCrn: (crn: string) => void;
  /** Close the dialog (clears the `view` URL param). */
  onClose: () => void;
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        // The URL already reflects the open CRN via the `view` param, so the
        // current href is the shareable permalink.
        navigator.clipboard?.writeText(window.location.href).then(
          () => setCopied(true),
          () => {}
        );
      }}
      className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      title="Copy a shareable link to this section"
    >
      {copied ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

function HeaderFacts({ section }: { section: CourseSection }) {
  const credits = section.creditHours ?? section.creditHourLow;

  return (
    <div className="space-y-4">
      {/* Identity meta. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <Badge variant="outline" className="font-mono">
          CRN {section.courseReferenceNumber}
        </Badge>
        <span className="text-muted-foreground">Section {section.sequenceNumber}</span>
        {section.campusDescription && (
          <span className="text-muted-foreground">{section.campusDescription}</span>
        )}
        {credits != null && (
          <span className="text-muted-foreground">
            {credits} credit{credits === 1 ? "" : "s"}
          </span>
        )}
        {section.scheduleTypeDescription && (
          <span className="text-muted-foreground">{section.scheduleTypeDescription}</span>
        )}
      </div>

      {/* Enrollment / waitlist, with the open/closed status as the section badge.
          Counts are colored by availability (mirrors the results table). */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Enrollment / Waitlist
          </h4>
          {section.openSection ? (
            <Badge variant="success">Open</Badge>
          ) : (
            <Badge variant="destructive">Closed</Badge>
          )}
        </div>
        <p className="text-sm">
          <span
            className={
              section.seatsAvailable > 0
                ? "text-green-600 dark:text-green-400"
                : "text-red-500"
            }
          >
            {section.enrollment}/{section.maximumEnrollment} enrolled
          </span>
          {" · "}
          {section.waitCapacity > 0 ? (
            <span
              className={
                section.waitAvailable > 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-500"
              }
            >
              {section.waitCount}/{section.waitCapacity} waitlist ({section.waitAvailable} open)
            </span>
          ) : (
            <span className="text-muted-foreground">no waitlist</span>
          )}
        </p>
      </div>
    </div>
  );
}

/** Building (full name when available) + room, or a sensible fallback. */
function formatLocation(mt: MeetingTime): string {
  const place = mt.buildingDescription ?? mt.building;
  if (!place) return mt.room ? `Room ${mt.room}` : "—";
  return mt.room ? `${place} ${mt.room}` : place;
}

function formatDateRange(mt: MeetingTime): string {
  if (!mt.startDate && !mt.endDate) return "—";
  if (mt.startDate === mt.endDate) return mt.startDate ?? "—";
  return `${mt.startDate ?? "?"} – ${mt.endDate ?? "?"}`;
}

function formatTimeRange(mt: MeetingTime): string {
  if (!mt.beginTime && !mt.endTime) return "TBA";
  return `${formatTime(mt.beginTime)}–${formatTime(mt.endTime)}`;
}

/** Dedicated per-meeting view: one row per meeting so days/time, location, and
 *  dates line up instead of being crammed into a single line. */
function MeetingsTable({ meetings }: { meetings: MeetingTime[] }) {
  if (meetings.length === 0) {
    return <p className="text-sm text-muted-foreground">Meeting time TBA.</p>;
  }
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Days</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Dates</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {meetings.map((mt, i) => (
            <TableRow key={i}>
              <TableCell className="text-sm">{formatDays(mt)}</TableCell>
              <TableCell className="whitespace-nowrap text-sm">
                {formatTimeRange(mt)}
              </TableCell>
              <TableCell className="text-sm">{formatLocation(mt)}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {formatDateRange(mt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function SectionDialog({ term, crn, onSelectCrn, onClose }: SectionDialogProps) {
  const [section, setSection] = useState<CourseSection | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!crn || !term) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setSection(null);
    const query = new URLSearchParams({ term, crn });
    fetch(`/api/search?${query.toString()}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Lookup failed"))))
      .then((data: SearchResultsResponse) => {
        if (cancelled) return;
        const found = data.data?.[0] ?? null;
        setSection(found);
        setNotFound(!found);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setNotFound(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [term, crn]);

  return (
    <Dialog open={crn != null} onOpenChange={(open) => !open && onClose()}>
      {/* Anchor near the top (override the base's vertical centering) so the box
          grows downward as data loads in stages — re-centering a growing dialog
          is what makes the open feel jarring. min-h softens the spinner→content
          jump. */}
      <DialogContent className="top-[7vh] max-h-[86vh] min-h-[16rem] max-w-3xl translate-y-0 overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start justify-between gap-4 pr-6">
            <div>
              <DialogTitle className="font-mono">
                {section ? section.subjectCourse : `CRN ${crn ?? ""}`}
              </DialogTitle>
              <DialogDescription>
                {section ? section.courseTitle : "Section details"}
              </DialogDescription>
            </div>
            <CopyLinkButton />
          </div>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading section…
          </div>
        )}

        {notFound && !loading && (
          <p className="py-8 text-sm text-muted-foreground">
            No section with CRN {crn} was found in this term.
          </p>
        )}

        {section && !loading && (
          <>
            <HeaderFacts section={section} />
            <div className="space-y-1">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Meetings
              </h4>
              <MeetingsTable
                meetings={section.meetingsFaculty
                  .map((mf) => mf.meetingTime)
                  .filter((mt): mt is MeetingTime => mt != null)}
              />
            </div>
            <SectionDetails section={section} onSelectCrn={onSelectCrn} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
