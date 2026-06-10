# Backfill history

A running log of what has been pulled from the live UH Banner SSB9 server into the
**remote** Cloudflare D1 store (`uh_sis`, database id `04eae271-…`). Each entry records
the term, what passes ran, the resulting row counts, and the date.

Backfills run against a `preview` build with `D1_MODE=remote` and the live
`SIS_BASE_URL`; secrets come from `web/.env` (never committed). Section detail is **not**
backfilled eagerly — it is fetched lazily on first view (`/api/section`, see
`docs/plans/details-ui-and-lazy.md`), so the details pass runs with `sections=0`.

## Live term codes (resolved 2026-06-09 from getTerms)

| Term | Code | View-only |
|------|------|-----------|
| Fall 2026 | `202710` | no (current) |
| Spring 2026 | `202630` | yes (past) |

> Note: the mock SIS uses different codes (202710 Fall / 202730 Spring); these are the
> **real** Banner codes.

## Fixes landed during this backfill

Two bugs in the remote D1 HTTP backend (`lib/db/client.ts` / `upsert.ts`), both latent
because the remote write path had never run before (e2e uses local SQLite; remote D1 was
empty):

1. **Multi-statement batches.** `batch()` concatenated statements into one SQL string
   with a shared params array. Cloudflare's D1 REST `/query` rejects that (*"params with
   multiple statements is not supported"*), so the first sync failed at `upsertSubjects`.
   Fixed by running each batched statement as its own sequential request (order
   preserved; not atomic across a batch — acceptable for idempotent delete-and-replace /
   upserts).

2. **100 bound-parameter cap.** D1 REST `/query` allows at most 100 bound parameters per
   statement (verified: 100 OK, 101 → *"too many SQL variables"*). The fixed-row chunk
   sizes (`SECTION_CHUNK=15` → 15×23 = 345 params) silently failed every insert for any
   subject with >4 sections — the first run looked "successful" but stored only 153
   sections (every subject capped at 4 = ⌊100/23⌋). Fixed by deriving the chunk size from
   each table's column count so `rows × columns ≤ 100`. This was a silent data-loss bug:
   the per-subject failures were swallowed as `partial` and the run still reported `ok`.

## Third issue: Banner IP rate-limiting (external, not a code bug)

After ~45 min of heavy live traffic in one window (Fall ×2 + Spring + several probes),
the live UH Banner server began throttling this IP: new `establishSession` handshakes
first failed, then hung entirely (a fresh single-search probe timed out at 60s). This is
an external rate limit, not a defect. Two takeaways, both now in the code:

- A long single-session run (hundreds of sequential subject searches) gets throttled in
  the **tail** — late subjects come back empty. `syncTerm` now **retries each subject up
  to 3×, re-handshaking with a 2 s backoff** between attempts (the re-handshake is inside
  the try, so a refused handshake fails just that subject, not the whole run).
- The remaining work (finishing Spring's subjects + the details pass, which is far more
  live-fetch-heavy) should run **after a cooldown**, spaced out, ideally one term at a
  time with a higher `delayMs`. Re-running `/api/admin/sync?term=…` is safe and idempotent
  (delete-and-replace per subject), so a later pass mops up the gaps.

## Runs (2026-06-09)

Counts are remote-D1 reads taken after the runs. Section **detail** is intentionally not
backfilled (lazy on first view); the **details** pass (filters + per-(campus,course)
catalog/text + instructors, `sections=0`) is **deferred to a post-cooldown run**, so
`course` / `filter_option` / `instructor` are still empty for these terms.

| Term | Code | sections | subjects w/ sections | faculty | meetings | sync status |
|------|------|---------:|---------------------:|--------:|---------:|-------------|
| Fall 2026 | `202710` | **8,436** | 252 / 275 | 8,249 | 9,984 | `partial` (tail subjects throttled) |
| Spring 2026 | `202630` | **3,466** | 92 / 270 | 3,703 | 4,174 | `error` (Banner stopped responding at subject 92) |

Spot-check: a direct live `ICS` search returns `totalCount=206`; remote D1 holds exactly
206 ICS sections for Fall 2026 — byte-for-byte the pipeline works.

## Banner rate-limit policy (what we learned) + mitigations

Banner sits behind **nginx** and throttles **silently** — no `429`, no `Retry-After`, no
`X-RateLimit-*` headers; over-limit requests simply **hang/drop** (probes time out). So
there's nothing to honor programmatically; the only lever is to stay under it. Observed
behavior across the runs:

- **Per session:** a single JSESSIONID degrades after a few hundred requests (each subject
  ≈ 2: `resetDataForm` + `searchResults`). Fall's first run did ~275 subjects on one
  session and the failures were the **alphabetical tail** (S–W, incl. big subjects like
  SOC/SPAN) — i.e. the session got throttled partway, not random drops.
- **Per IP / cumulative:** sustained volume over a ~45-min window (Fall ×2 + Spring +
  probes) escalated to an **IP-level** block — even fresh handshakes hung — that cleared
  after a cooldown (~hours).

Mitigations now in the ingest (all configurable):
- `syncTerm` rotates to a fresh session every `subjectsPerSession` subjects (default 40,
  `?subjectsPerSession=`) **and** by age, keeping per-session requests ≈ 80.
- Per-subject **retry ×3 with a fresh handshake + 2 s backoff** (handshake inside the try
  so a refused one fails only that subject).
- `delayMs` paces inter-subject requests (use ~200 for backfills).
- The details passes rotate by request count too (`CATALOG_PER_SESSION`, `ITEMS_PER_SESSION`).
- Section detail is **lazy** (no eager 6-endpoint-per-CRN pass), removing the heaviest load.

## Cloudflare token interruption (2026-06-09 ~18:00, resolved)

Mid-session the dev container's egress IP changed and the Cloudflare API token (which has
an IP allowlist) started returning `7403` / `9109 — "Cannot use the access token from
location: …"`. The token was active/unexpired — purely an IP-allowlist miss. The user
re-allowlisted the new egress IP and the run resumed. (Lesson: an IP-scoped token + a
dynamic dev-container IP is fragile; prefer an unrestricted token or a stable egress.)

## Completed run #2 — optimized, both terms (2026-06-09 ~21:00–22:40)

With **session rotation by request count** in place, the full backfill ran **clean — every
pass `status: ok`, zero throttling** across ~1.5 h of continuous live traffic:

| Pass | Fall 2026 (`202710`) | Spring 2026 (`202630`) |
|------|----------------------|------------------------|
| Catalog sync (sections) | **9,170** (was 8,436 partial) | **8,757** (was 3,466 error) |
| Filter options | 53 | 53 |
| Course catalog rows (`text=0`, college/dept) | **5,313** — all w/ college & dept | **5,242** — all w/ college & dept |
| Instructor cards | n/a — endpoint down (see below) | n/a |

The College/Department filters and the details panel's catalog facts (college, department,
grading modes, schedule types) are now populated for both terms.

### Instructor contact cards — faculty bannerId is SESSION-SCOPED (root cause found)

The instructors pass wrote nothing because `GET /ssb/contactCard/retrieveData` returned
HTTP 500 for every stored bannerId. The 500 body is a Grails
`ContactCardController.retrieveData` **`ValidationException`** (masked by a secondary
`returnMap()` NoSuchMethod bug). Root cause, confirmed live:

**The faculty `bannerId` in `searchResults.faculty[]` is a per-session surrogate token, not a
stable PIDM.** `contactCard/retrieveData` only accepts a bannerId that is present in the
**current session's most-recent search results**; a bannerId from any other (now-expired)
session fails validation → 500. Proof: in one fresh session, search `ICS 111`, take a
faculty bannerId straight from that JSON, and immediately card it → **200 JSON**
("Kyle M. Berney"). The *same person* was `bannerId=7814` in the June-4 capture but `3026`
now — the id rotates per session. So `syncInstructors`, which carded bannerIds stored from
earlier full-sync sessions, could never work. (It's not stale-data-only, not Staff, not
missing headers, not termCode — all of those were ruled out.)

**Implication for a working instructors pass:** it would have to be **search-driven** — per
session, search a subject, read the faculty bannerIds from *those* live results, and card
them in the same session — storing the card keyed by a **stable** field (email), since
bannerId is ephemeral. That's a real rework (email-keyed `instructor` table +
`/api/instructor` by email + panel lookup by email) **plus** the heaviest live Banner load of
any pass.

**Decision (2026-06-09): DEFERRED — and the enrichment is low-value, so this is fine.** The
data students actually want — **instructor name + email — already comes from the section
search itself** (`searchResults.faculty[].displayName` / `.emailAddress`, stored in
`section_faculty` and shown in the panel). The contact card adds only **title / department /
college**, which are **sparse and frequently null** (e.g. real faculty "Kyle M. Berney" has
`title: null`). So the marginal value doesn't justify a search-driven rework + a big Banner
hit. The `instructor` table is intentionally **left empty**; the panel renders instructors
purely from `faculty[]` (the `/api/instructor` route + query remain for a possible future
email-keyed implementation, but the panel no longer calls them). If it's ever wanted, do the
search-driven, email-keyed pass described above.

### Intentionally deferred (lazy / future)

- **Course description / prerequisites / corequisites** — skipped (`text=0`) because they're
  3 of the 4 per-course fetches (~31 k requests) and only feed the panel's text. Best filled
  **lazily on first panel view** (mirroring section detail) — a clean follow-up; `upsertCourse`
  already COALESCEs text so a slim pass never clobbers it. Until then the panel shows
  "No description available".
- **Section detail** — already **lazy** (`/api/section` fetches on first view); no eager pass.

### Resume / refresh commands

- Sections: `POST /api/admin/sync?term=<code>&delayMs=200&subjectsPerSession=40`
- Filters: `POST /api/admin/sync-details?term=<code>&catalog=0&sections=0&instructors=0`
- Catalog (college/dept only): `…/sync-details?term=<code>&filters=0&catalog=1&text=0&sections=0&instructors=0&delayMs=100`
- Full catalog incl. text: same as above with `text=1` (4× the load — pace it)
- Instructors: `…/sync-details?term=<code>&filters=0&catalog=0&sections=0&instructors=1&delayMs=80`
- All terms (no backfill): `POST /api/admin/refresh-terms`

## All terms populated + dynamic per-subject sync (2026-06-10)

`POST /api/admin/refresh-terms` populated the `term` table with **all 100** Banner
terms (Fall 2015 → Fall 2026, incl. Extension / Apprenticeship / Accelerated
variants), descriptions + view-only flags + display order — **no section
backfill**. Only Fall 2026 (`202710`) and Spring 2026 (`202630`) are eagerly
backfilled; every other term has `last_synced_at IS NULL`.

The remaining terms fill in **lazily, per `(term, subject)`, on first search**
(`lib/ingest/dynamicSync.ensureTermSubject`, invoked from `/api/search`): a term
that was never fully synced and a subject with no `subject` row yet → one live
Banner sync of just that subject, stored, then served from D1 forever. A
backfilled term has a `subject` row for every subject, so it never triggers.
Disabled with `DYNAMIC_SYNC=0`.

Verified live: first search of `ICS` in Summer 2026 (`202640`, unsynced) logged a
`[SIS] dynamic sync 202640/ICS` and stored **62** sections; the second search was
a pure `[DB]` hit. (So remote D1 now also holds Summer 2026 ICS — a sample of
dynamic population, not a full backfill of that term.)
