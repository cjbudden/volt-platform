-- ============================================================================
--  Filing unfiled recordings on the tick, not only at boot.
--
--  A recording is opened inside a transaction and its broadcast-day container is
--  attached afterwards. Filing used to run once at startup, so a recording opened
--  at 09:00 stayed unfiled until the next restart: invisible to every question
--  asked by broadcast day, and to the provenance chain that reaches a container
--  through it. The orchestrator now files them on its thirty-second tick.
--
--  Which means this predicate is read every thirty seconds. A partial index makes
--  that a lookup on a set that is normally EMPTY, rather than a sequential scan
--  of every recording ever made — the cost of which grows with the archive while
--  the answer stays "none".
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_recordings_unfiled
  ON recordings (start_epoch_ms)
  WHERE container_id IS NULL;
