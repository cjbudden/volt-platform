-- ===========================================================================
--  PLAYER GRAPHICS SETTINGS, per channel and per event.
--
--  Overrides only: an empty object means the defaults in
--  services/graphicTriggers.ts (DEFAULT_GRAPHICS), which today is "Up next" on,
--  two minutes before a programme ends, for twelve seconds. Stored as JSONB so a
--  new graphic type is a new key, not a migration.
--
--    { "upNext": { "enabled": true, "leadSec": 120, "durationSec": 12 } }
--
--  The triggers built from this travel IN the delivered manifests
--  (EXT-X-DATERANGE / DASH EventStream), so a change here reaches viewers through
--  the encoder's next manifest write. The existing cache triggers on channels and
--  events (0046) already announce a change to this column as asset:<id>.
-- ===========================================================================
ALTER TABLE channels ADD COLUMN IF NOT EXISTS graphics JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE events   ADD COLUMN IF NOT EXISTS graphics JSONB NOT NULL DEFAULT '{}'::jsonb;
