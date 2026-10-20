-- ============================================================================
--  0063  THE STATUS EVENT LOG BY TIME (TIMELINE_MODE.md, phase 2).
--
--  The Live Streams timeline draws outages (no source, on filler, packager
--  down, stopped unexpectedly) from stream_events over a window, for a page of
--  streams at once. The log was indexed by stream and id only, so a window
--  read scanned every event the stream ever reported.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sev_channel_ts ON stream_events (channel_id, ts) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sev_event_ts   ON stream_events (event_id, ts)   WHERE event_id IS NOT NULL;
