-- Marker for the lazy subject-enumeration path (dynamicSync.ensureTermSubjects).
--
-- A not-yet-backfilled term's Subject menu is populated on first access via one
-- getSubjects call. Without a marker, a term that legitimately returns ZERO
-- subjects (e.g. an Extension/Apprenticeship variant) would re-hit Banner on
-- every filters request, since "no subject rows" can't distinguish "never tried"
-- from "tried, empty". subjects_synced_at records that the enumeration ran.
ALTER TABLE term ADD COLUMN subjects_synced_at INTEGER;
