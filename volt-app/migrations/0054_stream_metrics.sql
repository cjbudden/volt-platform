-- STREAM METRICS (docs/UI_FEEDBACK.md, channel page gates): what the encoder
-- reports on its ten-second heartbeat about its own CPU and the bytes each
-- input has received. {"cpu_pct": 34.5, "cpu_cores": 2, "ingest": {"primary:720p":
-- {"role","label","bytes","bps"}}}. NULL until an encoder that reports it runs.
ALTER TABLE stream_status ADD COLUMN IF NOT EXISTS metrics JSONB;
