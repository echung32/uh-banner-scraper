/**
 * Conversions between Banner's `CourseSection` shape and D1 rows.
 *
 * The read path reconstructs a `CourseSection` straight from the stored
 * `raw_json` blob (byte-faithful, incl. nested faculty/meetings/attributes).
 * The write path projects scalar columns for filtering/sorting/analytics plus
 * the `raw_json` blob, and derives `section_faculty` / `section_meeting` rows.
 */
import type { CourseSection } from "@/lib/sis/types";

function bool(v: boolean | undefined | null): number {
  return v ? 1 : 0;
}

export interface CourseSectionRow {
  term: string;
  crn: string;
  subject: string;
  subject_description: string | null;
  course_number: string;
  sequence_number: string | null;
  subject_course: string | null;
  course_title: string;
  campus_description: string | null;
  schedule_type_desc: string | null;
  credit_hours: number | null;
  credit_hour_low: number | null;
  credit_hour_high: number | null;
  maximum_enrollment: number;
  enrollment: number;
  seats_available: number;
  wait_capacity: number;
  wait_count: number;
  wait_available: number;
  open_section: number;
  part_of_term: string | null;
  raw_json: string;
  synced_at: number;
}

export interface FacultyRow {
  term: string;
  crn: string;
  banner_id: string;
  display_name: string | null;
  email_address: string | null;
  primary_indicator: number;
  category: string | null;
}

export interface MeetingRow {
  term: string;
  crn: string;
  meeting_index: number;
  begin_time: string | null;
  end_time: string | null;
  begin_date: string | null;
  end_date: string | null;
  building: string | null;
  building_desc: string | null;
  room: string | null;
  campus: string | null;
  meeting_type: string | null;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
}

/** Read path: a stored row → the exact `CourseSection` Banner returned. */
export function rowToCourseSection(row: { raw_json: string }): CourseSection {
  return JSON.parse(row.raw_json) as CourseSection;
}

/** Write path: a `CourseSection` → its scalar row (+ embedded raw_json). */
export function sectionToRow(section: CourseSection, syncedAt: number): CourseSectionRow {
  return {
    term: section.term,
    crn: section.courseReferenceNumber,
    subject: section.subject,
    subject_description: section.subjectDescription,
    course_number: section.courseNumber,
    sequence_number: section.sequenceNumber ?? null,
    subject_course: section.subjectCourse ?? null,
    course_title: section.courseTitle,
    campus_description: section.campusDescription,
    schedule_type_desc: section.scheduleTypeDescription,
    credit_hours: section.creditHours,
    credit_hour_low: section.creditHourLow,
    credit_hour_high: section.creditHourHigh,
    maximum_enrollment: section.maximumEnrollment ?? 0,
    enrollment: section.enrollment ?? 0,
    seats_available: section.seatsAvailable ?? 0,
    wait_capacity: section.waitCapacity ?? 0,
    wait_count: section.waitCount ?? 0,
    wait_available: section.waitAvailable ?? 0,
    open_section: bool(section.openSection),
    part_of_term: section.partOfTerm,
    raw_json: JSON.stringify(section),
    synced_at: syncedAt,
  };
}

/** Write path: faculty projection rows (deduped by bannerId). */
export function sectionToFacultyRows(section: CourseSection): FacultyRow[] {
  const seen = new Set<string>();
  const rows: FacultyRow[] = [];
  for (const f of section.faculty ?? []) {
    if (!f.bannerId || seen.has(f.bannerId)) continue;
    seen.add(f.bannerId);
    rows.push({
      term: section.term,
      crn: section.courseReferenceNumber,
      banner_id: f.bannerId,
      display_name: f.displayName,
      email_address: f.emailAddress,
      primary_indicator: bool(f.primaryIndicator),
      category: f.category,
    });
  }
  return rows;
}

/** Write path: meeting projection rows. */
export function sectionToMeetingRows(section: CourseSection): MeetingRow[] {
  return (section.meetingsFaculty ?? []).map((mf, i) => {
    const m = mf.meetingTime;
    return {
      term: section.term,
      crn: section.courseReferenceNumber,
      meeting_index: i,
      begin_time: m.beginTime,
      end_time: m.endTime,
      begin_date: m.startDate,
      end_date: m.endDate,
      building: m.building,
      building_desc: m.buildingDescription,
      room: m.room,
      campus: m.campus,
      meeting_type: m.meetingTypeDescription ?? m.meetingType,
      monday: bool(m.monday),
      tuesday: bool(m.tuesday),
      wednesday: bool(m.wednesday),
      thursday: bool(m.thursday),
      friday: bool(m.friday),
      saturday: bool(m.saturday),
      sunday: bool(m.sunday),
    };
  });
}

/** Whether a Banner term description marks a view-only (past) term. */
export function isViewOnly(description: string): boolean {
  return /\(View Only\)\s*$/i.test(description);
}
