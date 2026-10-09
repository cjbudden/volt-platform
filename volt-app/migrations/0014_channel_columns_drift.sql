-- ============================================================================
--  CLOSING THE SCHEMA DRIFT ON `channels`.
--
--  Ten columns existed in every hand-maintained development database and in no
--  migration. They date from before the runner, when the schema was topped up
--  by idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements executed
--  on every boot. When 0001_init.sql was ADOPTED into schema_migrations rather
--  than actually run (its ledger row still reads checksum 'adopted'), those
--  boot-time alters were dropped and the columns they added were never
--  captured anywhere.
--
--  This was invisible for as long as every database in existence had been
--  through the old boot path. It surfaced the moment a database was built from
--  the migrations alone, which is exactly what a new deployment is:
--
--      error: column "on_air" of relation "channels" does not exist
--
--  Nothing here is cosmetic. `on_air` is what the five-gate model reads to
--  decide whether the public gate should be green, amber or red, so without it
--  the health model cannot be computed at all. The watermark columns are read
--  on every channel detail load. A clean deploy would have failed on its first
--  request to a channel.
--
--  Defaults match the values the development schema carries, so this is a
--  no-op on any database that already has them and a repair on any that
--  does not.
-- ============================================================================

ALTER TABLE channels
  -- Published intent: has the operator opened the public URL? Distinct from
  -- "is the output healthy", which is measured, not declared.
  ADD COLUMN IF NOT EXISTS on_air              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS epg_enabled         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS brand_ref           TEXT,
  -- Burn-in watermark. Position is a corner/edge anchor; the rest is how it
  -- sits within that anchor.
  ADD COLUMN IF NOT EXISTS watermark_enabled   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS watermark_ref       TEXT,
  ADD COLUMN IF NOT EXISTS watermark_position  TEXT    NOT NULL DEFAULT 'br',
  ADD COLUMN IF NOT EXISTS watermark_offset_x  INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS watermark_offset_y  INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS watermark_opacity   INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS watermark_scale     INTEGER NOT NULL DEFAULT 12;
