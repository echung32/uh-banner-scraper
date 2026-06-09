# Plan: Course Details — Persisting the Additive Banner Endpoints

Status: **planned, not built.** Follows `docs/plans/d1-persistence.md` (the D1 read-model,
which is shipped). This phase persists the Banner data that `searchResults` does *not* already
carry, so the UI can grow past its MVP (descriptions, prerequisites, restrictions, fees,
academic college/department, cross-list/linked sections, and server-driven filter menus).

## Context & decision

The shipped D1 model stores one faithful `CourseSection` per `(term, crn)` (scalar columns +
`raw_json`) and serves search entirely from it. But Banner exposes ~30 endpoints; a field-level
diff of the captured traffic (`scripts/intercepted_calls.json`) against `raw_json` shows three
buckets:

1. **Pure duplicates of `searchResults`** — already in `raw_json`, store nothing new:
   - `getFacultyMeetingTimes` (byte-identical to the embedded `meetingsFaculty` array)
   - `getEnrollmentInfo` (same enrollment/seat/waitlist numbers — we already use it only as a
     live *refresh*, never as new data)
   - `getSectionAttributes` (same as `sectionAttributes[]`)
   - `getClassDetails` (~95% overlap; only adds section "Grade Mode")
2. **Additive — not in `searchResults`** (the point of this phase):

   | Endpoint | Unique data | Grain |
   |---|---|---|
   | `getCourseDescription` | catalog description prose | **course** |
   | `getSectionPrerequisites` | prerequisites | **course** |
   | `getCorequisites` | corequisites | **course** |
   | `getSectionCatalogDetails` | **academic College**, **Department**, grading modes, catalog schedule types, credit breakdown | **course\*** |
   | `getRestrictions` | levels / campuses / cohorts / programs / majors / degrees / classifications | section |
   | `getFees` | course/lab fees (`$` amounts) | section |
   | `getXlstSections` | the actual cross-listed sibling CRNs (`searchResults` has only counts) | section |
   | `getLinkedSections` | the actual linked CRNs (`searchResults` has only `linkIdentifier`) | section |
   | `getSectionBookstoreDetails` | bookstore links (near-static per campus) | section (low value) |
   | `getSyllabus` | syllabus link/text (usually empty) | section (low value) |
   | `contactCard/retrieveData` | faculty title / dept / phone (name+email already in `faculty[]`) | instructor |

   **\* Grain is per (campus, course) — VERIFIED (see Verification).** Every detail endpoint is
   keyed by `courseReferenceNumber` (Banner has no course-keyed endpoint). Live testing showed the
   payloads are uniform across CRNs of a course **within a campus**, but the same
   `subject+course_number` is a **different catalog entry at each campus** (different
   college/department/description/prereqs). So the dedup unit is one representative CRN per
   `(campus, course)`, and `course` is keyed by `(term, campus, subject, course_number)`. The
   `getCourseDescription` section-override slot was empty in all samples (safe at this grain;
   revisit if a later slice finds it populated).
   **Filter-coverage caveat (OBSERVED 2026-06-09 — RE-VERIFY AFTER MAINTENANCE).** Not all `get_*`
   lists returned data. Counts for 202710: `campus`=10, `subject`=275, `attribute`=20, `level`=19,
   `instructionalMethod`=4 — but **`college`=0, `department`=0, `scheduleType`=0, `partOfTerm`=0**
   (all `200 OK` with empty arrays, in the same session where campus/subject were populated). This
   *may* be UH's Banner config, or it may be partial maintenance — **not yet confirmed; see
   "Open items: re-verify after Banner maintenance".** Either way the design is unaffected: the
   **College/Department menus are derived from the ingested `course` catalog** (`SELECT DISTINCT
   college_code/college_name …`, campus-scoped), which works whether or not `get_college` ever
   returns data. `filter_option` still backs the kinds that do return data.

3. **Filter-option lists** — `[{code, description}]` menus that drive dropdowns and are the only
   canonical source for options on terms with no matching sections (and the only place academic
   **College** appears as a list): `get_campus`, `get_college`, `get_department`,
   `get_instructionalMethod`, `get_attribute`, `get_partOfTerm`, `get_scheduleType`, `get_level`,
   `get_session`, `get_building`. (`get_subject` is already persisted as the `subject` table.)

**Architecture decision (confirmed): hybrid + app-native for the new data.**

- The additive endpoints return **HTML fragments, not JSON** — there is no Banner JSON shape to
  mirror, so a transform is unavoidable. We therefore model them **natively** (a real `college`
  column, course-vs-section grain, sibling CRNs as a list) rather than storing inert blobs.
- The existing `course_section` + `raw_json` search path stays **Banner-faithful and untouched**
  — it backs the current `/api/search` contract and the React `ResultsTable`; re-platforming it
  buys nothing now and would force a UI + API rewrite. New data lands in **new tables**; the read
  hot path is unchanged.
- This reuses the pattern already in the schema — *normalized columns for what we filter/display,
  plus a raw fragment so nothing is ever lost*. Per the storage decision, **every parsed table
  also keeps the raw HTML fragment**, so a feature can ship parsed fields now and we can re-parse
  from raw later without re-hitting Banner.

Net complexity is bounded: additive tables (not a core rewrite), the heavy work (HTML→fields) is
philosophy-independent, and sync/mapping stay thin.

## Schema (`migrations/0002_course_details.sql`)

```sql
-- Course-level facts: one row per (term, campus, subject, course_number). Catalog
-- facts are campus-specific but uniform within a campus (verified), so fetched
-- once per (campus, course) from a representative CRN. (Final PK set by 0003.)
CREATE TABLE course (
  term              TEXT NOT NULL,
  campus_description TEXT NOT NULL,
  subject           TEXT NOT NULL,
  course_number     TEXT NOT NULL,
  description       TEXT,            -- parsed from getCourseDescription
  prerequisites     TEXT,           -- parsed from getSectionPrerequisites
  corequisites      TEXT,           -- parsed from getCorequisites
  college_code      TEXT,           -- "MAN" \ academic college, from getSectionCatalogDetails
  college_name      TEXT,           -- "College of Natural Sciences"
  department        TEXT,           -- "Information & Computer Sciences"
  grading_modes     TEXT,           -- parsed list (JSON array)
  schedule_types    TEXT,           -- catalog schedule types (JSON array)
  credit_breakdown  TEXT,           -- parsed hours breakdown (JSON)
  raw_description_html TEXT,
  raw_prereq_html      TEXT,
  raw_coreq_html       TEXT,
  raw_catalog_html     TEXT,
  synced_at         INTEGER NOT NULL,
  PRIMARY KEY (term, subject, course_number),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);
CREATE INDEX idx_course_college ON course(term, college_code);

-- Section-level facts: one row per (term, crn).
CREATE TABLE section_detail (
  term               TEXT NOT NULL,
  crn                TEXT NOT NULL,
  restrictions_json  TEXT,          -- {levels, campuses, cohorts, programs, majors, ...}
  fees_json          TEXT,          -- [{level, description, amount}]
  cross_list_crns    TEXT,          -- JSON array of sibling CRNs (getXlstSections)
  linked_crns        TEXT,          -- JSON array (getLinkedSections)
  bookstore_json     TEXT,          -- [{campus, url}]
  syllabus_text      TEXT,
  raw_restrictions_html TEXT,
  raw_fees_html         TEXT,
  raw_xlst_html         TEXT,
  raw_linked_html       TEXT,
  raw_bookstore_html    TEXT,
  raw_syllabus_html     TEXT,
  synced_at          INTEGER NOT NULL,
  PRIMARY KEY (term, crn),
  FOREIGN KEY (term, crn) REFERENCES course_section(term, crn) ON DELETE CASCADE
);

-- Canonical dropdown menus (server-driven filters).
CREATE TABLE filter_option (
  term        TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- campus|college|department|instructionalMethod|attribute|
                               -- partOfTerm|scheduleType|level|session|building
  code        TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (term, kind, code),
  FOREIGN KEY (term) REFERENCES term(code) ON DELETE CASCADE
);

-- Optional: instructor contact-card extras (name+email already live in section_faculty).
CREATE TABLE instructor (
  banner_id   TEXT PRIMARY KEY,
  display_name TEXT,
  title       TEXT,
  department  TEXT,
  college     TEXT,
  email       TEXT,
  raw_json    TEXT,
  synced_at   INTEGER NOT NULL
);
```

Booleans `INTEGER`, timestamps epoch-ms, structured sub-objects as JSON `TEXT` — consistent with
`0001_init.sql`. Nothing here touches `course_section`; the search hot path is unaffected.

## SIS client additions (`web/src/lib/sis/client.ts`)

Add one fetcher per additive endpoint, mirroring `getEnrollmentInfo` (POST
`term`+`courseReferenceNumber`, returns an HTML fragment string):
`getCourseDescription`, `getSectionPrerequisites`, `getCorequisites`, `getSectionCatalogDetails`,
`getRestrictions`, `getFees`, `getXlstSections`, `getLinkedSections`,
`getSectionBookstoreDetails`, `getSyllabus`. Plus `getContactCard(session, bannerId, term)`
(GET, JSON) and a generic `getFilterOptions(session, term, kind)` for the `get_*` lists (GET,
JSON `[{code, description}]`, same shape `getSubjects` already parses).

Each detail fetcher returns the **raw HTML string**; parsing lives in a new
`web/src/lib/sis/parse/` module (one small parser per fragment, regex/`<span id>`-anchored — the
fragments are flat and stable; see the captured samples). Parsers return `{ parsed, raw }`.

## Ingestion (`web/src/lib/ingest/`)

A new `details.ts` orchestrator, invoked **after** `syncTerm` populates `course_section` for a
term (so we know the live CRN/course set):

- **Course-level pass** — `SELECT DISTINCT subject, course_number FROM course_section WHERE
  term=?`; for each course fetch the catalog endpoints from **one representative CRN**, parse,
  upsert `course`. This is the *potential* load win (hundreds of courses vs thousands of CRNs) —
  but it is **gated on the live per-course verification** (Risks/Verification). Until that passes,
  only the catalog-only fields (College/Department/Grading Modes — no section-override slot) use
  the representative-CRN path; `description`/`prerequisites`/`corequisites` fall back to a per-CRN
  fetch so section-specific overrides are never dropped.
- **Section-level pass** — for each CRN fetch the section endpoints, parse, upsert
  `section_detail`. Heaviest path → must be checkpointable and throttled (see Risks).
- **Filter-option pass** — once per term, fetch each `get_*` list, replace `filter_option` rows
  for that `(term, kind)`.
- **Instructor pass (optional)** — dedupe `banner_id`s from `section_faculty`, fetch contact
  cards, upsert `instructor`.

Reuses the existing session lifecycle (one handshake, re-establish past `SESSION_MAX_AGE_MS`),
`startSyncRun`/`finishSyncRun` bookkeeping (new `kind` values: `details`, `filters`), and the
delete-and-replace idiom from `replaceSubjectSections`. New upserts in `upsert.ts`:
`upsertCourse`, `upsertSectionDetail`, `replaceFilterOptions`, `upsertInstructor`.

Admin trigger: extend `POST /api/admin/sync` with a `details=1` (and/or `filters=1`) flag, or a
sibling `POST /api/admin/sync-details`, secret-guarded, same `Content-Type: application/json`
requirement.

## Read path

- `filter_option` → a `getFilterOptions(db, term, kind)` query feeding new menu endpoints
  (`/api/filters?term=&kind=`), so dropdowns (campus, **college**, department, …) become
  server-driven instead of the hardcoded `lib/campuses.ts` constant. The campus filter from the
  prior phase migrates onto this.
- `course` / `section_detail` → a `getCourseDetails(db, term, subject, courseNumber)` and
  `getSectionDetails(db, term, crn)` query, surfaced via `/api/section/[crn]` (or folded into the
  existing search response for a details panel). Existing `/api/search` is unchanged; a details
  view fetches lazily on row expand.

## Phased rollout (slices)

1. **Migration + filter options + academic college/department** — `0002`, the `get_*` list
   fetchers, `filter_option` + the `college`/`department` columns on `course` (from
   `getSectionCatalogDetails`). Unblocks the College/Department/other UI filters immediately;
   lightest Banner load (per-term lists + per-course catalog).
- **1b. College/Department search filters (DONE 2026-06-09)** — derived facets + search join.
2. **Course-level text (DONE 2026-06-09)** — description / prerequisites / corequisites parsed
   (`lib/sis/parse/text.ts`) and fetched in the same per-(campus,course) representative-CRN pass as
   the catalog; stored on `course` (+ `raw_*_html`); surfaced via `/api/course`. Parsers verified
   against live HTML (ICS 111 description, ICS 311 multi-`<pre>` prereqs, empty coreqs → null).
3. **Section-level detail (DONE 2026-06-09)** — per-CRN restrictions / fees / cross-list / linked
   / bookstore / syllabus → `section_detail`, parsed in `lib/sis/parse/sectionDetail.ts`, served
   via `/api/section`. Parsers verified against live data (fee amount is verbatim, e.g. live
   `"US$ 50.00"`). This is the heaviest pass (6 endpoints × every CRN); gated by the
   `sync-details?sections=0` flag.
4. **Instructor contact cards (DONE 2026-06-09)** — per-`banner_id` `contactCard/retrieveData`
   (JSON) → `instructor`, served via `/api/instructor`. Gated by `sync-details?instructors=0`.
   Live gotchas (fixed): the section's **current** `banner_id` must be used (older ids 500), and
   `deptAndCollegeInformation` is an **array of objects** (nested `college` + optional
   `department`), not a string; UH usually leaves `title` null.

## Filter-list coverage — RESOLVED (it's UH config, not maintenance)

Re-probed 2026-06-09 while Banner was **fully up** (campus=10, subject=275, attribute=20,
level=19, instructionalMethod=4 all populated in the same session). The empty lists came back
**identically empty**: `get_college`=0, `get_department`=0, `get_scheduleType`=0,
`get_partOfTerm`=0, `get_session`=0, `get_building`=0. Since the rest of Banner was clearly
serving data, this is **UH's Banner configuration, not an outage** — these autocomplete lists are
disabled/empty in UH's deployment. Conclusion: the catalog-derived `getCatalogFacet` menus
(College/Department from the ingested `course` table) are the **permanent** source, not a
fallback; `filter_option` only ever carries campus/subject/attribute/level/instructionalMethod.
A future Schedule-Type or Part-of-Term filter would likewise need a derived source (e.g. DISTINCT
from `course_section.schedule_type_desc` / `part_of_term`), not `get_scheduleType`/`get_partOfTerm`.

## Risks

- **Banner load / rate limits.** Section-level passes are per-CRN across many endpoints — the
  heaviest path yet. Mitigate: course-level dedup (the big win), aggressive throttle + resumable
  `sync_run` checkpoints, run details as a deliberate off-cadence backfill (view-only terms are
  one-shot; recent terms refresh far less often than seats). Consider fetching only a subset of
  section endpoints on the regular cadence and the rest lazily/on-demand.
- **HTML fragment brittleness.** Parsers key off stable `<span id>`/`status-bold` anchors; storing
  `raw_*_html` means a parser change can re-derive fields from D1 without re-hitting Banner.
- **Storage growth + D1 limits.** Raw HTML per course/section adds rows-written and DB size —
  re-check the D1 daily-write cap and size ceiling before the full backfill (same caveat as
  `0001`).
- **Lazy vs eager.** Section detail (restrictions/fees) may be better fetched **on demand** (cache
  into `section_detail` on first view) than eagerly for every CRN — decide per slice in step 3.

## Verification

- **Live per-course identity — DONE (2026-06-09, Banner back up).** Ran
  `web/scripts/verify-per-course.mjs` against the live SIS for ICS 111 / 211 / 311. Findings:
  - **Uniform *within* a campus.** All catalog/description/prereq/coreq fragments were identical
    across multiple CRNs of the same course at the same campus (ICS 111 ×3, ICS 311 ×2, ICS 211
    Manoa ×2). So one representative CRN per (campus, course) is safe.
  - **DIFFERENT *across* campuses.** ICS 211 runs at 6 campuses; each has a **different** college,
    department, description, and prerequisites (Manoa→College of Natural Sciences; Hawaii
    CC→Business Education; etc.). The same `subject+course_number` is a *different catalog entry*
    per campus.
  - **Consequence (fixed):** the `course` grain is **`(term, campus, subject, course_number)`**,
    not `(term, subject, course_number)`. Migration `0003_course_campus.sql` adds
    `campus_description` to the `course` PK; the catalog pass groups by campus and fetches one
    representative CRN per (campus, course); `getCourseCatalog`/`/api/course` require a `campus`.
    The original 0002 key would have collapsed all campuses into whichever CRN `MIN(crn)` picked.
  - Description's section-override slot was empty in every sample (never diverged within a
    campus), so it is also safe at the (campus, course) grain for now; revisit if a later slice
    finds a populated override.
- Apply `0002` local + remote; spot-check a parsed `course`/`section_detail` round-trips and the
  `raw_*_html` is retained.
- Extend `web/e2e/mock-sis-server.mjs` with the additive endpoints (HTML fixtures from the
  captured samples) and `web/e2e/ingest.spec.ts` to assert the course-level dedup (N courses
  fetched once, not per CRN), `filter_option` rows, and parsed fields.
- Confirm `/api/search` and the existing read-path e2e are **unchanged** (no regression to the
  Banner-faithful hot path).
- `yarn build` clean.
