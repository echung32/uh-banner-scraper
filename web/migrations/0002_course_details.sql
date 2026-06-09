-- D1 schema, phase 2: the additive Banner data that searchResults does NOT carry.
-- See docs/plans/course-details.md. Hybrid model: course_section + raw_json stays
-- Banner-faithful and untouched; these are NEW native tables. Booleans INTEGER,
-- timestamps epoch-ms, structured sub-objects as JSON TEXT (consistent with 0001).

-- ── course-level catalog facts (one row per term+subject+course) ─────────────
-- Identical across every section of the course. Slice 1 populates the catalog
-- columns (college/department/grading/schedule) from getSectionCatalogDetails;
-- description/prerequisites/corequisites land in a later slice (their per-CRN
-- vs per-course grain is verification-gated — see the plan).
CREATE TABLE course (
  term                 TEXT NOT NULL,
  subject              TEXT NOT NULL,
  course_number        TEXT NOT NULL,
  description          TEXT,                 -- getCourseDescription (later slice)
  prerequisites        TEXT,                 -- getSectionPrerequisites (later slice)
  corequisites         TEXT,                 -- getCorequisites (later slice)
  college_code         TEXT,                 -- e.g. "14"   (from getSectionCatalogDetails)
  college_name         TEXT,                 -- e.g. "College of Natural Sciences"
  department           TEXT,                 -- e.g. "Information & Computer Sciences"
  department_code      TEXT,                 -- e.g. "ICS"
  grading_modes        TEXT,                 -- JSON array of "Description  CODE" strings
  schedule_types       TEXT,                 -- JSON array of "Description  CODE" strings
  credit_breakdown     TEXT,                 -- JSON object (parsed hours)
  raw_description_html TEXT,
  raw_prereq_html      TEXT,
  raw_coreq_html       TEXT,
  raw_catalog_html     TEXT,
  synced_at            INTEGER NOT NULL,
  PRIMARY KEY (term, subject, course_number),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);
CREATE INDEX idx_course_college ON course(term, college_code);
CREATE INDEX idx_course_dept ON course(term, department_code);

-- ── section-level detail (one row per term+crn) ──────────────────────────────
-- Populated in a later slice; created now so 0002 is the single details migration.
CREATE TABLE section_detail (
  term                  TEXT NOT NULL,
  crn                   TEXT NOT NULL,
  restrictions_json     TEXT,               -- {levels, campuses, cohorts, programs, ...}
  fees_json             TEXT,               -- [{level, description, amount}]
  cross_list_crns       TEXT,               -- JSON array of sibling CRNs
  linked_crns           TEXT,               -- JSON array of linked CRNs
  bookstore_json        TEXT,               -- [{campus, url}]
  syllabus_text         TEXT,
  raw_restrictions_html TEXT,
  raw_fees_html         TEXT,
  raw_xlst_html         TEXT,
  raw_linked_html       TEXT,
  raw_bookstore_html    TEXT,
  raw_syllabus_html     TEXT,
  synced_at             INTEGER NOT NULL,
  PRIMARY KEY (term, crn),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);

-- ── canonical filter-option menus (server-driven dropdowns) ───────────────────
CREATE TABLE filter_option (
  term        TEXT NOT NULL,
  kind        TEXT NOT NULL,  -- campus|college|department|instructionalMethod|attribute|
                              -- partOfTerm|scheduleType|level|session|building
  code        TEXT NOT NULL,
  description TEXT,
  display_order INTEGER,      -- preserve Banner's returned order
  PRIMARY KEY (term, kind, code),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);
CREATE INDEX idx_filter_kind ON filter_option(term, kind, display_order);

-- ── instructor contact-card extras (optional; later slice) ───────────────────
CREATE TABLE instructor (
  banner_id    TEXT PRIMARY KEY,
  display_name TEXT,
  title        TEXT,
  department   TEXT,
  college      TEXT,
  email        TEXT,
  raw_json     TEXT,
  synced_at    INTEGER NOT NULL
);
