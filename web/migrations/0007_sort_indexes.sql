-- Sort-matching expression indexes for the read-path search (see
-- docs/plans/d1-read-optimization.md).
--
-- D1 bills "rows read" as rows *scanned*. The search's ORDER BY (Banner's
-- default sort: subject_description, then the displayed catalog course number —
-- an expression, see CATALOG_NUMBER_SQL in lib/db/queries.ts) matched no index,
-- so every search materialized a temp B-tree over the whole term (~9k rows) to
-- emit a 50-row page. These two indexes mirror resolveSort()'s ORDER BY exactly
-- (the expression text must match byte-for-byte) so the planner streams in index
-- order and early-exits at LIMIT:
--
--   idx_cs_sort_subj  — the all-subjects default search (term=? + full order).
--   idx_cs_subj_sort  — the single-subject search: subject_description is
--                       constant under cs.subject = ?, so resolveSort drops it
--                       and the remaining order is this index's tail. Its
--                       (term, subject) prefix also serves every equality lookup
--                       idx_cs_term_subject served, so that index is dropped to
--                       keep the per-insert write cost (1 row written per index
--                       per insert) flat at +1.
--
-- DESC sorts use the same indexes via backward scans — that requires the
-- tiebreaks to mirror the primary sort direction (resolveSort does).

CREATE INDEX idx_cs_sort_subj ON course_section(
  term,
  subject_description,
  trim(substr(subject_course, length(subject) + 1)),
  sequence_number,
  crn
);

CREATE INDEX idx_cs_subj_sort ON course_section(
  term,
  subject,
  trim(substr(subject_course, length(subject) + 1)),
  sequence_number,
  crn
);

DROP INDEX idx_cs_term_subject;
