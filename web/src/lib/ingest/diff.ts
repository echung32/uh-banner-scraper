/**
 * Section-core diff for the scheduled refresh (docs/plans/scheduled-refresh.md,
 * Tier B1). A Tier A full sync re-pulls every section's searchResults row; this
 * classifies each CRN as new / dropped / structurally-changed so only meaningful
 * changes trigger an (expensive) detail re-fetch.
 *
 * "Structural" deliberately EXCLUDES the seat/enrollment fields, which change on
 * almost every sync as students register and would otherwise make every section
 * look changed. The detail endpoints (restrictions/fees/cross-list/text) never
 * depend on seat counts, so a seat-only delta is correctly ignored here.
 */
import type { CourseSection } from "@/lib/sis/types";

export interface SectionDiff {
  newCrns: string[];
  droppedCrns: string[];
  structuralCrns: string[];
}

/**
 * Deterministic fingerprint of the section-detail-relevant fields. Built from an
 * explicit allow-list (not a deny-list) so adding a volatile field to
 * CourseSection later can't silently start triggering refetches. Seat fields
 * (enrollment, seatsAvailable, waitCount, waitCapacity, waitAvailable,
 * openSection) are intentionally absent.
 */
export function structuralFingerprint(s: CourseSection): string {
  return JSON.stringify({
    title: s.courseTitle,
    schedule: s.scheduleTypeDescription,
    credits: [s.creditHours, s.creditHourLow, s.creditHourHigh],
    partOfTerm: s.partOfTerm,
    campus: s.campusDescription,
    subjectCourse: s.subjectCourse,
    seq: s.sequenceNumber,
    link: [s.linkIdentifier, s.isSectionLinked],
    attrs: s.sectionAttributes
      .map((a) => a.code)
      .slice()
      .sort(),
    faculty: (s.faculty ?? [])
      .map((f) => `${f.bannerId}:${f.displayName ?? ""}`)
      .slice()
      .sort(),
    meetings: (s.meetingsFaculty ?? [])
      .map((m) => {
        const mt = m.meetingTime;
        return [
          mt.beginTime,
          mt.endTime,
          mt.building,
          mt.room,
          mt.monday,
          mt.tuesday,
          mt.wednesday,
          mt.thursday,
          mt.friday,
          mt.saturday,
          mt.sunday,
        ].join("|");
      })
      .slice()
      .sort(),
  });
}

export function classifySectionChanges(
  existing: CourseSection[],
  incoming: CourseSection[]
): SectionDiff {
  const existingByCrn = new Map(
    existing.map((s) => [s.courseReferenceNumber, s])
  );
  const incomingByCrn = new Map(
    incoming.map((s) => [s.courseReferenceNumber, s])
  );

  const newCrns: string[] = [];
  const structuralCrns: string[] = [];
  for (const [crn, inc] of incomingByCrn) {
    const prev = existingByCrn.get(crn);
    if (!prev) {
      newCrns.push(crn);
    } else if (structuralFingerprint(prev) !== structuralFingerprint(inc)) {
      structuralCrns.push(crn);
    }
  }
  const droppedCrns: string[] = [];
  for (const crn of existingByCrn.keys()) {
    if (!incomingByCrn.has(crn)) droppedCrns.push(crn);
  }
  return { newCrns, droppedCrns, structuralCrns };
}
