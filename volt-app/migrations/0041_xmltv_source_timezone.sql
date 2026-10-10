-- ===========================================================================
--  XMLTV IMPORT: the source's time zone and how its times are read.
--
--  fallback_tz (already there) becomes the SOURCE TIME ZONE: the zone the
--  guide is for. It now wins over each channel's own zone (channels always
--  have a zone, default Europe/London, so as a "fallback" it never applied).
--  It reads times with no offset, decides "today" for {date}/{from}/{to} and
--  the days-ahead window, and is the zone of channels created from the feed.
--  Not set: each channel's own zone for times, UTC for dates.
--
--  time_mode  'offsets'  times are read as stamped (+0000, +1100 ...): the
--                        right choice for a correct feed (xmltv.net's is)
--             'local'    the offsets are ignored and every time is local time
--                        in the source zone (or the channel's): for feeds that
--                        stamp local times as +0000, or carry a wrong offset
-- ===========================================================================
ALTER TABLE epg_import_sources ADD COLUMN IF NOT EXISTS time_mode TEXT NOT NULL DEFAULT 'offsets';
DO $$ BEGIN
  ALTER TABLE epg_import_sources ADD CONSTRAINT epg_import_sources_time_mode_chk CHECK (time_mode IN ('offsets', 'local'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
