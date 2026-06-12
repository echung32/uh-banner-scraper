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
import { SectionDetails } from "./SectionDetails";
import { formatMeetingTime } from "@/lib/meetingTime";
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
  const meetings = section.meetingsFaculty
    .map((mf) => mf.meetingTime)
    .filter((mt): mt is MeetingTime => mt != null);
  const primaryFaculty =
    section.faculty.find((f) => f.primaryIndicator) ?? section.faculty[0];
  const credits = section.creditHours ?? section.creditHourLow;

  return (
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
      <span
        className={
          section.seatsAvailable > 0
            ? "text-green-600 dark:text-green-400"
            : "text-red-500"
        }
      >
        {section.enrollment}/{section.maximumEnrollment} enrolled
      </span>
      {section.openSection ? (
        <Badge variant="success">Open</Badge>
      ) : (
        <Badge variant="destructive">Closed</Badge>
      )}
      <span className="w-full text-muted-foreground">
        {meetings.length === 0
          ? "Meeting time TBA"
          : meetings.map((mt) => formatMeetingTime(mt)).join(" · ")}
        {primaryFaculty?.displayName ? ` · ${primaryFaculty.displayName}` : ""}
      </span>
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
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
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
            <SectionDetails section={section} onSelectCrn={onSelectCrn} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
