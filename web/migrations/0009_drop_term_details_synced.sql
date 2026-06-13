-- 0009_drop_term_details_synced.sql
-- Drops term.last_details_synced_at: the scheduled refresh switched from a
-- "full details pass when >7 days stale" (which this column gated) to a rolling
-- per-run refresh of the K stalest detail rows. The meaningful detail-freshness
-- signal is now MIN(section_detail.synced_at) per term, queried directly.
ALTER TABLE term DROP COLUMN last_details_synced_at;
