-- Demand-driven, sort-aware page cache for not-yet-backfilled ("dynamic") terms.
--
-- Backfilled terms (term.last_synced_at set) serve searches entirely from
-- course_section via SQL. Dynamic terms instead fill a page at a time from the
-- live Banner API: each request fetches only the offset window(s) the user is
-- viewing, stores the section bodies in course_section, and records the covered
-- window here so a revisit serves from D1.
--
-- Coverage is keyed by sort order — "page 3 by subject" surfaces different rows
-- than "page 3 by seats" — and by the live-applied filters (filter_sig). Windows
-- are a fixed internal size (CHUNK_SIZE in lib/ingest/pageCache.ts), independent
-- of the UI's rows-per-page. crns_json is the ordered CRN list for the window,
-- pointing at course_section by (term, crn). total_count is Banner's reported
-- total for the (term, filter_sig, sort). View-only terms are immutable so a row
-- never goes stale; other terms revalidate after PAGE_TTL_MS (seats change).
CREATE TABLE IF NOT EXISTS search_chunk (
  term            TEXT    NOT NULL,
  filter_sig      TEXT    NOT NULL,
  sort_column     TEXT    NOT NULL,
  sort_direction  TEXT    NOT NULL,
  chunk_index     INTEGER NOT NULL,
  crns_json       TEXT    NOT NULL,
  total_count     INTEGER NOT NULL,
  fetched_at      INTEGER NOT NULL,
  PRIMARY KEY (term, filter_sig, sort_column, sort_direction, chunk_index)
);
