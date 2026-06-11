# Backfill summary

The durable overview of what has been pulled from the live UH Banner SSB9 server into the
**remote** Cloudflare D1 store (`uh_sis`, database id `04eae271-…`). Chronological run
records live in the per-date logs (see [Index](#index)); this file holds the stable
reference: how backfills run, the resolved term codes, current backfill state, and the
hard-won operational learnings.

## How backfills run

Ingestion runs from the **Node CLI** (`yarn ingest`, `web/scripts/ingest.ts`) — not the
Worker. The heavy sync/details passes run for minutes, past the Workers CPU limit, so the
deployed `/api/admin/*` routes are disabled (501) and the CLI drives the same `lib/ingest/*`
functions directly against D1. Set `D1_MODE=remote` and load `.env` for the live
`SIS_BASE_URL` + Cloudflare creds (`.env` is never committed; its own `D1_MODE=local` is
the dev default, so override it on the command line):

```bash
cd web
set -a; . ./.env; set +a
D1_MODE=remote yarn ingest sync         --term <code> --delayMs 200 --subjectsPerSession 40
D1_MODE=remote yarn ingest sync-details --term <code> --no-sections --no-instructors --no-text
```

Commands (`web/scripts/ingest.ts`):

- **Sections:** `yarn ingest sync --term <code> [--delayMs 200] [--subjectsPerSession 40]`
- **Details (filters + catalog, no text):** `yarn ingest sync-details --term <code> --no-sections --no-instructors --no-text`
- **Full catalog incl. text:** drop `--no-text` (≈4× the load — pace it with `--delayMs`)
- **Instructors:** add `--instructors`, drop the `--no-instructors` (currently a no-op — see [2026-06-09](2026-06-09.md))
- **All terms (no backfill):** `yarn ingest refresh-terms`
- **Seat-only refresh:** `yarn ingest refresh-seats --term <code> [--subject ICS] [--crns a,b] [--max N]`

> The old `/api/admin/*` HTTP routes + `preview` build still exist (e2e drives them with
> `INGEST_ON_WORKER=1` against the mock SIS), but production backfills use the CLI.

What a "full" term backfill means today: **sections** (`sync`) + **details with filters +
catalog at `--no-text`** (`sync-details`). Deferred / lazy:

- **Section detail** — lazy on first view (`/api/section`); no eager pass.
- **Course description / prereqs / coreqs** — lazy on first panel view (`COURSE_TEXT_LAZY`); the catalog pass runs `text=0`.
- **Instructor contact cards** — deferred (low value; bannerId is session-scoped). See [2026-06-09](2026-06-09.md).

## Live term codes (resolved from getTerms / remote `term` table)

> The mock SIS uses different codes (202710 Fall / 202730 Spring); these are the **real**
> Banner codes. Term-code scheme: `2026` year stem + a variant suffix (`10` Fall, `30`
> Spring, `40` Summer; `+1` Apprenticeship, `+3` Extension).

| Term | Code | View-only | Backfilled |
|------|------|-----------|-----------|
| Fall 2026 | `202710` | no (current) | ✅ 2026-06-09 |
| Fall 2026 Apprenticeship | `202711` | yes | ✅ 2026-06-11 (empty term) |
| Fall 2026 Extension | `202713` | no | ✅ 2026-06-11 |
| Summer 2026 | `202640` | no | ✅ 2026-06-11 |
| Summer 2026 Extension | `202643` | no | ✅ 2026-06-11 (empty term) |
| Spring 2026 | `202630` | yes (past) | ✅ 2026-06-09 |
| Spring 2026 Apprenticeship | `202631` | yes | ✅ 2026-06-11 (empty term) |
| Spring 2026 Extension | `202633` | yes | ✅ 2026-06-11 |

All 100 Banner terms exist in the `term` table (descriptions + view-only flags), populated
[2026-06-10](2026-06-10.md); only the terms marked ✅ above have a full section backfill
(the "empty term" ones returned 0 sections but are marked synced so they serve from the SQL
path). Everything else fills in on demand via the page cache.

**Historical sweep (sections only):** on [2026-06-11](2026-06-11.md) a bulk newest→oldest
sweep also backfilled **sections** (no catalog/details pass) for the **2024–2025** terms —
Fall 2025 → Fall 2024 plus their Summer/Spring/Extension/Apprenticeship variants (15 terms,
~31k sections) — before Banner throttled on **Spring 2024 (`202430`, partial — needs reset +
re-run)**. **~76 terms remain** (Spring 2024 and older, to Fall 2015 `201610`); re-run
`web/scripts/backfill-sweep.sh` after a cooldown to continue. These have **sections but no
catalog facts** (college/department) until a later details pass.

## Operational learnings

### Remote D1 REST limits (fixed in code)
- **No multi-statement batches** — D1 REST `/query` rejects multiple statements sharing one
  params array; the backend runs each as its own sequential request.
- **100 bound-parameter cap** — chunk sizes are derived from each table's column count so
  `rows × columns ≤ 100`. (Both were silent data-loss bugs; details in [2026-06-09](2026-06-09.md).)

### Banner rate-limit policy
Banner sits behind **nginx** and throttles **silently** — no `429`, no `Retry-After`, no
`X-RateLimit-*`; over-limit requests simply **hang/drop**. Nothing to honor
programmatically; the only lever is to stay under it.

- **Per session:** a single JSESSIONID degrades after a few hundred requests (each subject
  ≈ 2: `resetDataForm` + `searchResults`). The failures show up as the **alphabetical tail**.
- **Per IP / cumulative:** sustained volume over a ~45-min window can escalate to an
  **IP-level** block — even fresh handshakes hang — that clears after a cooldown (~hours).

Mitigations now in the ingest (all configurable):
- `syncTerm` rotates to a fresh session every `subjectsPerSession` subjects (default 40)
  **and** by age, keeping per-session requests ≈ 80.
- Per-subject **retry ×3 with a fresh handshake + 2 s backoff**.
- `delayMs` paces inter-subject requests (use ~200 for backfills).
- The details passes rotate by request count (`CATALOG_PER_SESSION`, `ITEMS_PER_SESSION`).
- Section detail is **lazy** — removes the heaviest per-CRN load.

### Cloudflare token / egress IP
The Cloudflare API token is **IP-allowlisted**; a dev-container egress-IP change returns
`7403` / `9109 — "Cannot use the access token from location"` even though the token is
valid. Re-allowlist the new egress IP, or prefer an unrestricted token / stable egress.

## Index

- [PROMPT.md](PROMPT.md) — reusable prompt for requesting more backfills in a later session.
- [2026-06-09](2026-06-09.md) — first remote backfill: Fall 2026 + Spring 2026; remote-D1
  limit fixes; rate-limit discovery; instructor bannerId root-cause.
- [2026-06-10](2026-06-10.md) — all 100 terms populated (`refresh-terms`); dynamic
  per-subject sync (later superseded by the page cache).
- [2026-06-11](2026-06-11.md) — backfill of the Extension / Apprenticeship / Summer 2026 terms.
