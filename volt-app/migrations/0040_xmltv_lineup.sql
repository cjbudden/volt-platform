-- ===========================================================================
--  XMLTV IMPORT LINEUP: choosing which of a feed's channels to use, and which
--  Volt channel each one feeds.
--
--  A feed like xmltv.net's Sydney guide carries 47 channels, several with the
--  same name ("7 Sydney" on 7, 70 and 71), radio beside TV. Each of their
--  channels is now in one of three states:
--     used      channel_id set: its programmes go to that Volt channel
--     not used  ignored = true: skipped quietly, no warning on every run
--     waiting   neither: new, nobody has decided; counted and named in the run
--
--  epg_import_sources.new_channels says what a channel the feed has never
--  listed before starts as: 'review' (waiting) or 'ignore' (not used), for
--  big feeds where you only want a few.
--
--  One feed channel per Volt channel within a source: two of their channels
--  writing into one of ours would interleave two schedules.
-- ===========================================================================
ALTER TABLE epg_channel_aliases
  ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lcn TEXT,
  ADD COLUMN IF NOT EXISTS programmes_in_feed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS feed_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS feed_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE epg_import_sources
  ADD COLUMN IF NOT EXISTS new_channels TEXT NOT NULL DEFAULT 'review';
DO $$ BEGIN
  ALTER TABLE epg_import_sources ADD CONSTRAINT epg_import_sources_new_channels_chk CHECK (new_channels IN ('review', 'ignore'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Before the one-per-Volt-channel rule: keep the oldest mapping where two
-- feed channels of one source point at the same Volt channel.
UPDATE epg_channel_aliases a SET channel_id = NULL, mapped_by = NULL
 WHERE a.channel_id IS NOT NULL AND EXISTS (
   SELECT 1 FROM epg_channel_aliases b
    WHERE b.source_id = a.source_id AND b.channel_id = a.channel_id
      AND (b.first_seen_at, b.id) < (a.first_seen_at, a.id));
CREATE UNIQUE INDEX IF NOT EXISTS uq_epg_aliases_source_channel ON epg_channel_aliases (source_id, channel_id) WHERE channel_id IS NOT NULL;
