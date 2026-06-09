# Plan: Details-panel UI, lazy section-detail, and the first two-term backfill

This plan covers three forward-looking items from the course-details phase (slices 1–4
already shipped — data is persisted but mostly not surfaced):

1. **Details-panel UI** — surface the persisted catalog/section/instructor data in the
   search results table.
2. **Lazy section-detail** — fetch per-CRN section detail on first view (cache-on-miss)
   instead of an eager per-CRN backfill pass.
3. **First real backfill** — populate remote D1 for **Spring 2026 + Fall 2026** so the
   end-to-end pipeline is confirmed against the live UH server.

Implemented in that order; (3) runs only after (1) and (2) are green and committed.

## 1. Details-panel UI

The richest data — course description / prerequisites / corequisites, enrollment
restrictions, fees, cross-listed & linked CRNs, bookstore links, syllabus, grading
modes, schedule types, and instructor contact cards — is already stored and served by
`/api/course`, `/api/section`, `/api/instructor`, but the results table only shows the
section row. Add an **expandable row**: clicking a row's chevron opens a panel under it
that lazily fetches and renders the detail.

- **`ResultsTable.tsx`** — add a leading chevron column (colSpan 11 → 12; header,
  skeleton, and empty-state colSpan updated). `SectionRow` becomes stateful (`expanded`);
  when expanded it renders a second `<TableRow>` whose single full-width `<TableCell>`
  hosts `<SectionDetails section={…} />`. Only mounts on expand, so no fetch until asked.
- **`SectionDetails.tsx`** (new React island component) — on mount, fetches in parallel:
  - `/api/course?term&campus&subject&courseNumber` (campus = `section.campusDescription`)
    → description, prereqs, coreqs, college/department, grading modes, schedule types.
  - `/api/section?term&crn` → restrictions, fees, cross-list, linked, bookstore, syllabus.
  - `/api/instructor?bannerId` for each `section.faculty[]` (parallel) → title /
    department / college / email.
  Renders a two-column layout (course-level text left; section facts + instructors
  right). 404 / null fields degrade to an "N/A" / "no additional details" line, never an
  error. Instructor cards are rendered **inline in the panel** (no popover dependency —
  the app has no Radix popover primitive and adding one under Yarn PnP isn't worth it; a
  hover-popover is noted as future polish).

No new dependencies; uses existing shadcn/Tailwind + `lucide-react` icons.

## 2. Lazy section-detail (cache-on-miss)

The per-CRN section pass is the heaviest ingest (6 Banner endpoints × every CRN). Make it
**on-demand** instead of eager: `/api/section` serves from D1 on a hit and, on a miss,
fetches the six fragments live, parses, **stores** them, and returns — so the second view
is a pure D1 hit and a CRN with no detail still stores (all-null) once and never refetches.

- **`src/lib/ingest/sectionLazy.ts`** (new, write-path) — `ensureSectionDetail(db, term,
  crn)`:
  1. Guard: require a `course_section` row for `(term, crn)`; if none → return `null`
     (so a genuinely-unknown CRN still 404s and we never hammer Banner for garbage).
  2. In-flight dedupe map keyed `term:crn` so concurrent first-views share one fetch.
  3. `establishSession(term)` → `Promise.all` of the six fragment fetchers → parse →
     `upsertSectionDetail` → return the stored shape.
  - Gated by `SECTION_LAZY_FETCH` (default on); set to `0` to force pure-D1 behavior.
- **`src/pages/api/section.ts`** — try `fetchSectionDetail` (D1, read path, unchanged);
  on `null`, call `ensureSectionDetail`; still `404` if that returns `null`. The read
  path module (`search.ts`) stays Banner-free — the live fallback lives in the
  write-path module and is only invoked by the route.

Architecture note: this reintroduces a *bounded* live Banner call on the request path for
exactly one endpoint (first view of a section), unlike search which is always D1. On the
eventual Workers migration this needs the handshake to run from an isolate (deferred; see
`docs/plans/workers-migration.md`). The eager pass remains available
(`/api/admin/sync-details` with `sections=1`) for a deliberate full backfill.

## 3. First backfill — Spring 2026 + Fall 2026 (live → remote D1)

Confirm the whole pipeline end to end by populating two real terms. Because section
detail is now lazy (item 2), the backfill **skips the per-CRN section pass** (`sections=0`)
— catalog + filters + course text + instructors only.

Steps (run against a `preview` build with `D1_MODE=remote` + live `SIS_BASE_URL` default):
1. Probe live connectivity and resolve the **real** Banner term codes for "Spring 2026"
   and "Fall 2026" from `getTerms` (don't assume the mock's 2026xx codes).
2. `POST /api/admin/sync?term=<code>&delayMs=…` for each term (full catalog → remote D1).
3. `POST /api/admin/sync-details?term=<code>&sections=0&delayMs=…` for each term
   (filters + per-(campus,course) catalog/text + instructors).
4. Record a **checklist / history** in `docs/backfill-history.md`: term codes, what ran,
   row counts (sections / courses / filter options / instructors), status, timestamp.

Throttled via `delayMs`; `sync_run` rows give resumable observability. Secrets
(`CLOUDFLARE_API_TOKEN`, `ADMIN_SECRET`) are loaded from `web/.env` into the process env
only — never echoed or committed.

## Tests

- **Read-path e2e (`search.spec.ts`)** — expand a section row; assert the panel renders
  catalog facts (college) and lazily-fetched section detail (the mock serves all six
  fragments, so this exercises items 1 **and** 2 together), and an instructor card.
  Requires seeding a faculty member on a seeded section so the instructor card has a
  `bannerId` (add to `global-setup.ts`), and pointing the course/campus keys at the seed.
- **Ingestion e2e (`ingest.spec.ts`)** — unchanged; still covers the eager passes.
- `yarn build` (the real typecheck under PnP) + `yarn test` must be green before the
  backfill.
