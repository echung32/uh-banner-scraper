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

export interface SectionWriteDelta {
  /** new CRNs — insert section + children. */
  newSections: CourseSection[];
  /** structural changes — rewrite section row + children. */
  structuralSections: CourseSection[];
  /** changed but only in non-structural (seat) fields — UPDATE the section row only. */
  seatOnlySections: CourseSection[];
  /** CRNs present in stored but absent from incoming — delete. */
  droppedCrns: string[];
  /** CRNs whose serialized form is byte-identical — skip entirely. */
  unchangedCrns: string[];
}

/**
 * Classifies incoming sections against the stored rows (by raw_json string) for a
 * minimal-write sync: only new/changed rows are written, unchanged rows are skipped,
 * and seat-only changes update the section row without rewriting child rows.
 * `existing` carries each stored CRN's exact raw_json string (= JSON.stringify at
 * write time), so equality with JSON.stringify(incoming) is an exact change test.
 */
export function classifyForWrite(
  existing: Array<{ crn: string; rawJson: string }>,
  incoming: CourseSection[]
): SectionWriteDelta {
  const existingByCrn = new Map(existing.map((e) => [e.crn, e.rawJson]));
  const incomingCrns = new Set(incoming.map((s) => s.courseReferenceNumber));

  const newSections: CourseSection[] = [];
  const structuralSections: CourseSection[] = [];
  const seatOnlySections: CourseSection[] = [];
  const unchangedCrns: string[] = [];

  for (const s of incoming) {
    const stored = existingByCrn.get(s.courseReferenceNumber);
    if (stored === undefined) {
      newSections.push(s);
      continue;
    }
    if (JSON.stringify(s) === stored) {
      unchangedCrns.push(s.courseReferenceNumber);
      continue;
    }
    // Changed: structural vs seat-only. Reparse the stored row to fingerprint it.
    const prev = JSON.parse(stored) as CourseSection;
    if (structuralFingerprint(prev) !== structuralFingerprint(s)) {
      structuralSections.push(s);
    } else {
      seatOnlySections.push(s);
    }
  }

  const droppedCrns: string[] = [];
  for (const e of existing) {
    if (!incomingCrns.has(e.crn)) droppedCrns.push(e.crn);
  }

  return { newSections, structuralSections, seatOnlySections, droppedCrns, unchangedCrns };
}

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
