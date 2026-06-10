-- Drop the bookstore columns from section_detail.
--
-- The bookstore fragment (getSectionBookstoreDetails) is low-value — it links to
-- the UH bookstore's generic per-term page, not anything section-specific worth
-- surfacing — so it's removed from both the UI and the store. SQLite (and D1)
-- support ALTER TABLE ... DROP COLUMN (3.35+); each drop is its own statement.

ALTER TABLE section_detail DROP COLUMN bookstore_json;
ALTER TABLE section_detail DROP COLUMN raw_bookstore_html;
