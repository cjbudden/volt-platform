-- ============================================================================
--  0136: MIRROR AND ARCHIVE, scheduled re-checks (build queue H3-3).
--
--  Every storage target says how often its verified copies are read back
--  again. A copy on a NAS can be changed or removed by anyone with access to
--  the share, and a copy nobody looks at is a copy nobody can vouch for, so
--  the platform queues an `archive.verify` for each verified copy whose last
--  check is older than this. NULL: never re-checked on a schedule (a check
--  can still be asked for by hand).
--
--  Add only (RELEASING.md "Schema: add only"): one column with a default.
-- ============================================================================
ALTER TABLE archive_targets ADD COLUMN IF NOT EXISTS recheck_days integer DEFAULT 30;

