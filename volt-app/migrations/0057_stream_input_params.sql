-- ============================================================================
--  0057  PER-PROTOCOL SOURCE SETTINGS (docs/SOURCES.md).
--
--  Each protocol has its own requirements: SRT caller/listener, latency and
--  passphrase; NDI discovery server and groups; ST 2110 SDP and
--  receive interface. They are kept with the input and
--  handed to the encoder with it. Only keys the protocol defines are stored
--  (services/ingestProtocols.ts cleanParams).
-- ============================================================================
ALTER TABLE stream_inputs ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
