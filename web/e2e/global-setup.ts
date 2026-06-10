// Playwright global setup: seed the wrangler local D1 file with a deterministic
// fixture catalog so the read-path tests run entirely from D1 (no live SIS, no
// mock for reads). Mirrors the ICS catalog the mock serves for term 202710.
//
// Runs before the app server starts, in its own process, so the file handle is
// released before `yarn preview` opens it via node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function findLocalD1File(): string {
  const dir = join(
    process.cwd(),
    ".wrangler",
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject"
  );
  const file = readdirSync(dir).find(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite"
  );
  if (!file) {
    throw new Error(
      `No local D1 file in ${dir}. Run: yarn wrangler d1 migrations apply uh_sis --local`
    );
  }
  return join(dir, file);
}

interface SeedFaculty {
  bannerId: string;
  category: string | null;
  courseReferenceNumber: string;
  displayName: string | null;
  emailAddress: string | null;
  primaryIndicator: boolean;
  term: string;
}

function icsSection(
  crn: string,
  courseNumber: string,
  seq: string,
  title: string,
  campusDescription = "University of Hawaii at Manoa"
) {
  const faculty: SeedFaculty[] = [];
  return {
    id: Number(crn),
    term: "202710",
    termDesc: "Fall 2026",
    courseReferenceNumber: crn,
    partOfTerm: "1",
    courseNumber,
    subject: "ICS",
    subjectDescription: "Information & Computer Sciences",
    sequenceNumber: seq,
    campusDescription,
    scheduleTypeDescription: "Lecture",
    courseTitle: title,
    creditHours: 3,
    creditHourLow: 3,
    creditHourHigh: null,
    maximumEnrollment: 40,
    enrollment: 30,
    seatsAvailable: 10,
    waitCapacity: 0,
    waitCount: 0,
    waitAvailable: 0,
    openSection: true,
    linkIdentifier: null,
    isSectionLinked: false,
    subjectCourse: `ICS ${courseNumber}`,
    faculty,
    meetingsFaculty: [],
    reservedSeatSummary: null,
    sectionAttributes: [],
  };
}

const SECTIONS = [
  icsSection("10001", "111", "001", "Intro to Computer Science I"),
  icsSection("10002", "111", "002", "Intro to Computer Science I"),
  icsSection("10003", "141", "001", "Foundations I"),
  icsSection("10004", "211", "001", "Intro to Computer Science II"),
  icsSection("10005", "311", "001", "Algorithms"),
  icsSection("10006", "311", "002", "Algorithms"),
  // A non-Manoa section so the campus filter has something to exclude: the
  // default UH-Manoa search hides it, "All Campuses" reveals it.
  icsSection("10007", "101", "001", "Tools for the Information World", "University of Hawaii at Hilo"),
];

// Give the first section a faculty member so the details panel's instructor card
// (served from the seeded `instructor` row below) has a bannerId to fetch.
SECTIONS[0].faculty = [
  {
    bannerId: "9001",
    category: "01",
    courseReferenceNumber: "10001",
    displayName: "Jane Instructor",
    emailAddress: "jane@hawaii.edu",
    primaryIndicator: true,
    term: "202710",
  },
];

export default function globalSetup() {
  // Ensure the local D1 file exists with the current schema (idempotent).
  execSync("yarn wrangler d1 migrations apply uh_sis --local", {
    stdio: "ignore",
  });

  const db = new DatabaseSync(findLocalD1File(), {
    enableForeignKeyConstraints: false,
  });

  // Clean slate (schema is left intact; migrations already applied).
  for (const table of [
    "section_meeting",
    "section_faculty",
    "section_detail",
    "course_section",
    "course",
    "filter_option",
    "instructor",
    "subject",
    "sync_run",
    "enrollment_snapshot",
    "term",
  ]) {
    db.exec(`DELETE FROM ${table};`);
  }

  const term = db.prepare(
    "INSERT INTO term (code, description, is_view_only, display_order) VALUES (?, ?, 0, ?)"
  );
  // 202710 has the higher display_order so it stays first / the default term for
  // the read-path tests. 202730 exists (no sections) so the ingestion test can
  // sync into it and exercise the seat-refresh cooldown.
  term.run("202710", "Fall 2026", 2);
  term.run("202730", "Spring 2026", 1);

  const insert = db.prepare(
    `INSERT INTO course_section
       (term, crn, subject, subject_description, course_number, sequence_number,
        subject_course, course_title, campus_description, schedule_type_desc,
        maximum_enrollment, enrollment, seats_available, open_section, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = 1_700_000_000_000;
  for (const s of SECTIONS) {
    insert.run(
      s.term,
      s.courseReferenceNumber,
      s.subject,
      s.subjectDescription,
      s.courseNumber,
      s.sequenceNumber,
      s.subjectCourse,
      s.courseTitle,
      s.campusDescription,
      s.scheduleTypeDescription,
      s.maximumEnrollment,
      s.enrollment,
      s.seatsAvailable,
      s.openSection ? 1 : 0,
      JSON.stringify(s),
      now
    );
  }

  // Course catalog rows (what a details sync would produce). College/department
  // are per (campus, course); ICS 311 sits in a different college so the College
  // filter has something to exclude.
  const MANOA = "University of Hawaii at Manoa";
  const NAT_SCI = ["14", "College of Natural Sciences"];
  const ENGR = ["20", "College of Engineering"];
  const COURSES: Array<[string, string, string, string, string]> = [
    [MANOA, "ICS", "111", ...NAT_SCI] as [string, string, string, string, string],
    [MANOA, "ICS", "141", ...NAT_SCI] as [string, string, string, string, string],
    [MANOA, "ICS", "211", ...NAT_SCI] as [string, string, string, string, string],
    [MANOA, "ICS", "311", ...ENGR] as [string, string, string, string, string],
    ["University of Hawaii at Hilo", "ICS", "101", "30", "College of Natural & Health Sciences"] as [string, string, string, string, string],
  ];
  const courseStmt = db.prepare(
    `INSERT INTO course
       (term, campus_description, subject, course_number, college_code, college_name,
        department, department_code, grading_modes, schedule_types, credit_breakdown, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [campus, subject, courseNumber, collegeCode, collegeName] of COURSES) {
    courseStmt.run(
      "202710",
      campus,
      subject,
      courseNumber,
      collegeCode,
      collegeName,
      "Information & Computer Sciences",
      "ICS",
      JSON.stringify(["Letter Plus + Minus  G"]),
      JSON.stringify(["Lecture  LEC"]),
      JSON.stringify({ creditHours: 3 }),
      now
    );
  }

  // Instructor contact card for the faculty seeded on CRN 10001, so the details
  // panel's instructor card renders from D1 (read path; no lazy fetch here).
  db.prepare(
    `INSERT INTO instructor
       (banner_id, display_name, title, department, college, email, raw_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "9001",
    "Jane Instructor",
    "Associate Professor",
    "Information & Computer Sciences",
    "College of Natural Sciences",
    "jane@hawaii.edu",
    "{}",
    now
  );

  db.close();
}
