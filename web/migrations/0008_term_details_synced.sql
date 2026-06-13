-- 0008_term_details_synced.sql
-- Tracks the last FULL course-details pass per term, so the scheduled refresh
-- (docs/plans/scheduled-refresh.md, Tier B2) knows when a term's low-volatility
-- details (restrictions/fees/text/instructors) are >7 days stale and need a
-- full re-fetch. NULL = never had a full details pass.
ALTER TABLE term ADD COLUMN last_details_synced_at INTEGER;
