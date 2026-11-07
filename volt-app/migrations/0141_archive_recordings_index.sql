-- volt:no-transaction
-- ============================================================================
--  0141: one copy of one stretch of recording per target and kind (build
--  queue H3-7). Partial: only recording copies, which name a stream. Built
--  concurrently so copies of originals carry on while it builds.
-- ============================================================================
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_archive_copies_recording
  ON archive_copies (target_id, stream_id, what, range_start) WHERE stream_id IS NOT NULL;
