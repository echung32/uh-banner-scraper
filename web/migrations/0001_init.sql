-- D1 schema for the UH Banner course-search persistent data layer.
-- See docs/plans/d1-persistence.md. SQLite: booleans are INTEGER (0/1),
-- timestamps are epoch milliseconds (INTEGER).

-- ── terms ──────────────────────────────────────────────────────────────────
CREATE TABLE term (
  code                TEXT PRIMARY KEY,            -- "202710"
  description         TEXT NOT NULL,              -- "Fall 2026" / "Spring 2026 (View Only)"
  is_view_only        INTEGER NOT NULL DEFAULT 0, -- derived from description suffix
  display_order       INTEGER,                    -- stable term dropdown ordering
  last_synced_at      INTEGER,                    -- epoch ms of last successful full sync
  last_seat_refresh_at INTEGER,                   -- epoch ms of last seat-only refresh
  last_sync_status    TEXT,                       -- 'ok' | 'partial' | 'error'
  section_count       INTEGER NOT NULL DEFAULT 0, -- cached count for quick UI
  seeded              INTEGER NOT NULL DEFAULT 0  -- view-only one-time seed completed
);
CREATE INDEX idx_term_view_only ON term(is_view_only);

-- ── subjects per term (ingestion enumeration source + analytics) ─────────────
CREATE TABLE subject (
  term        TEXT NOT NULL,
  code        TEXT NOT NULL,                       -- "ICS"
  description TEXT,                                -- "Information & Computer Sciences"
  PRIMARY KEY (term, code),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);

-- ── course sections (one row per CRN per term) ───────────────────────────────
CREATE TABLE course_section (
  term                TEXT NOT NULL,
  crn                 TEXT NOT NULL,               -- courseReferenceNumber
  subject             TEXT NOT NULL,
  subject_description TEXT,
  course_number       TEXT NOT NULL,
  sequence_number     TEXT,
  subject_course      TEXT,                        -- "ICS 111"
  course_title        TEXT NOT NULL,
  campus_description  TEXT,
  schedule_type_desc  TEXT,
  credit_hours        REAL,
  credit_hour_low     REAL,
  credit_hour_high    REAL,
  maximum_enrollment  INTEGER NOT NULL DEFAULT 0,
  enrollment          INTEGER NOT NULL DEFAULT 0,
  seats_available     INTEGER NOT NULL DEFAULT 0,
  wait_capacity       INTEGER NOT NULL DEFAULT 0,
  wait_count          INTEGER NOT NULL DEFAULT 0,
  wait_available      INTEGER NOT NULL DEFAULT 0,
  open_section        INTEGER NOT NULL DEFAULT 0,  -- boolean
  part_of_term        TEXT,
  raw_json            TEXT NOT NULL,               -- full CourseSection JSON for faithful replay
  synced_at           INTEGER NOT NULL,            -- epoch ms this row last written
  PRIMARY KEY (term, crn),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);
-- Search filter + sort indexes (mirror Banner searchResults params).
CREATE INDEX idx_cs_term_subject ON course_section(term, subject, course_number);
CREATE INDEX idx_cs_term_subj_open ON course_section(term, subject, open_section);
-- Analytics: fill-rate / open-ratio aggregations across a term.
CREATE INDEX idx_cs_term_open ON course_section(term, open_section);

-- ── faculty (analytics projection; hot path reconstructs from raw_json) ──────
CREATE TABLE section_faculty (
  term              TEXT NOT NULL,
  crn               TEXT NOT NULL,
  banner_id         TEXT NOT NULL,
  display_name      TEXT,
  email_address     TEXT,
  primary_indicator INTEGER NOT NULL DEFAULT 0,
  category          TEXT,
  PRIMARY KEY (term, crn, banner_id),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);
CREATE INDEX idx_fac_name ON section_faculty(display_name);

-- ── meetings (analytics projection) ──────────────────────────────────────────
CREATE TABLE section_meeting (
  term          TEXT NOT NULL,
  crn           TEXT NOT NULL,
  meeting_index INTEGER NOT NULL,                  -- ordinal within meetingsFaculty
  begin_time    TEXT,
  end_time      TEXT,
  begin_date    TEXT,
  end_date      TEXT,
  building      TEXT,
  building_desc TEXT,
  room          TEXT,
  campus        TEXT,
  meeting_type  TEXT,
  monday        INTEGER NOT NULL DEFAULT 0,
  tuesday       INTEGER NOT NULL DEFAULT 0,
  wednesday     INTEGER NOT NULL DEFAULT 0,
  thursday      INTEGER NOT NULL DEFAULT 0,
  friday        INTEGER NOT NULL DEFAULT 0,
  saturday      INTEGER NOT NULL DEFAULT 0,
  sunday        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, crn, meeting_index),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);
CREATE INDEX idx_meet_building ON section_meeting(term, building);

-- ── sync run audit (ingestion observability + resumable backfill) ────────────
CREATE TABLE sync_run (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  term              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'full',  -- 'full' | 'seat_refresh' | 'terms'
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  status            TEXT,                          -- 'ok' | 'partial' | 'error'
  subjects_total    INTEGER,
  subjects_done     INTEGER,
  sections_upserted INTEGER,
  error_message     TEXT
);
CREATE INDEX idx_sync_term ON sync_run(term, started_at);

-- ── future analytics: enrollment snapshots over time (planned, not populated) ─
CREATE TABLE enrollment_snapshot (
  term            TEXT NOT NULL,
  crn             TEXT NOT NULL,
  captured_at     INTEGER NOT NULL,                -- epoch ms (one row per revalidation)
  enrollment      INTEGER NOT NULL,
  seats_available INTEGER NOT NULL,
  wait_count      INTEGER NOT NULL,
  PRIMARY KEY (term, crn, captured_at)
);
CREATE INDEX idx_snap_term_time ON enrollment_snapshot(term, captured_at);
