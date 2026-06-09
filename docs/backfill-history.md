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

### Outstanding (post-cooldown)

- Finish Spring 2026 subjects 93→270 (re-run `sync?term=202630`).
- Mop up Fall 2026's throttled tail (re-run `sync?term=202710` — the retry hardening
  should now carry it through).
- Run the **details** pass for both terms (`sync-details?term=…&sections=0`) to populate
  `course` (college/department/description/prereqs → enables the College/Department
  filters and the details panel's catalog text), `filter_option`, and `instructor`.
