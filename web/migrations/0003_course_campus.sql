-- Fix the `course` grain: catalog facts are per (term, campus, subject, course).
--
-- Live verification (docs/plans/course-details.md) proved the SAME subject+course
-- (e.g. ICS 211) is offered at multiple campuses with DIFFERENT college /
-- department / description / prerequisites per campus — but uniform WITHIN a
-- campus. The original 0002 `course` PK (term, subject, course_number) collapsed
-- all campuses into one row. Add campus_description to the key.
--
-- `course` carries no production data yet, so drop-and-recreate is safe.

DROP TABLE IF EXISTS course;

CREATE TABLE course (
  term                 TEXT NOT NULL,
  campus_description   TEXT NOT NULL,        -- e.g. "University of Hawaii at Manoa"
  subject              TEXT NOT NULL,
  course_number        TEXT NOT NULL,
  description          TEXT,                 -- getCourseDescription (later slice)
  prerequisites        TEXT,                 -- getSectionPrerequisites (later slice)
  corequisites         TEXT,                 -- getCorequisites (later slice)
  college_code         TEXT,                 -- campus-specific (from getSectionCatalogDetails)
  college_name         TEXT,
  department           TEXT,
  department_code      TEXT,
  grading_modes        TEXT,                 -- JSON array of "Description  CODE" strings
  schedule_types       TEXT,                 -- JSON array of "Description  CODE" strings
  credit_breakdown     TEXT,                 -- JSON object
  raw_description_html TEXT,
  raw_prereq_html      TEXT,
  raw_coreq_html       TEXT,
  raw_catalog_html     TEXT,
  synced_at            INTEGER NOT NULL,
  PRIMARY KEY (term, campus_description, subject, course_number),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);
CREATE INDEX idx_course_college ON course(term, college_code);
CREATE INDEX idx_course_dept ON course(term, department_code);
-- Join key from a section to its course catalog row.
CREATE INDEX idx_course_lookup ON course(term, campus_description, subject, course_number);
