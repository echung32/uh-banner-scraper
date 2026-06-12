Please backfill these UH Banner terms into the remote D1 store, through the list of terms one by one, from newest term to oldest term, until you either hit rate limit or I ask you to stop.

Follow docs/backfill/summary.md. Specifically:

1. Resolve each term's Banner code from the remote `term` table (query D1 REST with the
   creds in web/.env; match on the `description` column). Don't trust the mock codes.
2. For each term, in order, run from web/ with env loaded and D1_MODE overridden to remote:
     set -a; . ./.env; set +a
     D1_MODE=remote yarn ingest sync         --term <code> --delayMs 200 --subjectsPerSession 40
     D1_MODE=remote yarn ingest sync-details --term <code> --no-sections --no-instructors --no-text --delayMs 150
   (sections, then filters + catalog at text=0; section detail / course text / instructors
   stay lazy/deferred.) Run the big terms in the background and monitor the log.
3. If a sync comes back `partial`/`error` or a term's tail subjects look throttled, pause for
   a cooldown and re-run that term's sync (it's idempotent — delete-and-replace per subject).
4. After all terms, verify against remote D1: each term's `last_synced_at` is set and the
   section/course counts match what the runs reported.
5. Record results in a new date-scoped log docs/backfill/<today>.md (term, code, subjects,
   sections, filter options, catalog courses, status + notes), and update the term-code
   table's "Backfilled" column in docs/backfill/summary.md (add the new log to its Index).
6. Commit the docs + backfill record on a branch (don't touch unrelated working-tree changes).

## Operator notes (for me, not the prompt)

- **Mechanism:** ingestion is the Node CLI `yarn ingest` (`web/scripts/ingest.ts`), *not* the
  `/api/admin/*` HTTP routes (disabled on the Worker). No build/preview needed.
- **Env:** `web/.env` carries `SIS_BASE_URL` + Cloudflare creds but sets `D1_MODE=local`
  (dev default) — always override with `D1_MODE=remote` on the command line.
- **Empty terms are normal:** Apprenticeship / some Extension variants return 0 subjects.
  Still run both passes (filter menus get stored; the term is marked synced → SQL path).
- **Rate limits:** Banner throttles silently (hangs, no 429). Mitigations are built in
  (session rotation, per-subject retry, `delayMs`); space out big runs and re-run on partials.
- **Resolve codes via D1 REST** (no running server needed):
  ```bash
  cd web && set -a && . ./.env && set +a
  curl -s -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" \
    --data '{"sql":"SELECT code, description, is_view_only, last_synced_at FROM term WHERE description LIKE \"%2027%\" ORDER BY code DESC"}'
  ```
- **Optional extras** (only if asked): `--text` (course descriptions/prereqs — ~4× load),
  `yarn ingest refresh-seats --term <code>` (seat-only update), `yarn ingest refresh-terms`
  (repopulate the term list).
