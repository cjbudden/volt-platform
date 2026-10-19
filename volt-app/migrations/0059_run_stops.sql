-- ===========================================================================
--  WHY DID EACH RUN END? THE OPERATING REPORT'S SECOND MISSING FACT.
--
--  docs/REQ_stream_reporting.md, acceptance criterion 6: a stop caused by a
--  fault and a stop caused by an operator must be distinguishable in the report
--  without reading a log. The orchestrator already knows (StopIntent:
--  operator | schedule | fault | internal), but it only wrote that intent to
--  places that do not last:
--
--    * channels/events.stop_requested_by is overwritten by the next stop;
--    * the stop.requested line in stream_events cascades away with the channel
--      and can be cleared from the station page with one button.
--
--  So: one row per run that ended, keyed on the instance, written by
--  stopStream at the moment it terminates the task. Same identity rules as
--  usage_accruals (0016) and air_sessions (0023): stream_id and stream_name are
--  snapshotted and carry NO foreign key, so deleting a channel does not delete
--  the record of why its runs ended.
--
--  A run with no row here ended by a path that never reached stopStream (a host
--  lost, a control plane killed). The report says "unknown" for those rather
--  than guessing, which is the same rule as an unmeasured peak.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS run_stops (
    instance_id  UUID PRIMARY KEY,            -- deliberately no FK: instances cascade away with the channel
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stream_kind  TEXT NOT NULL CHECK (stream_kind IN ('channel', 'event')),
    stream_id    UUID NOT NULL,               -- no FK, outlives the stream
    stream_name  TEXT,                        -- snapshot
    intent       TEXT NOT NULL CHECK (intent IN ('operator', 'schedule', 'fault', 'internal')),
    origin       TEXT,                        -- the orchestrator's human-readable reason, e.g. "encoder exited rc=183"
    stopped_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_stops_stream ON run_stops (stream_id, stopped_at DESC);

COMMENT ON TABLE run_stops IS
  'Why each run ended (operator | schedule | fault | internal), one row per terminated instance. FK-free identity so it outlives the stream.';

-- ---------------------------------------------------------------------------
--  AND THE RUN IDENTITY ITSELF MUST OUTLIVE THE CHANNEL.
--
--  usage_accruals.instance_id is ON DELETE SET NULL, and instances cascade away
--  with their channel (0013). So deleting a channel nulls the run key on every
--  accrual it ever had, and a report grouping by instance_id would collapse a
--  year of runs into one. instance_ref is the same id with no foreign key, the
--  same choice stream_id made in 0016. Backfilled for every row that still has
--  its key; rows already nulled before this migration are re-assembled into runs
--  by contiguity in services/streamReport.ts.
-- ---------------------------------------------------------------------------
ALTER TABLE usage_accruals ADD COLUMN IF NOT EXISTS instance_ref UUID;
UPDATE usage_accruals SET instance_ref = instance_id WHERE instance_ref IS NULL AND instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_accruals_stream_run ON usage_accruals (stream_id, instance_ref, from_at);
