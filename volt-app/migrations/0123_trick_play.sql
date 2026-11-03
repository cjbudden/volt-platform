-- ============================================================================
--  I-frame trick-play, optional (build queue 3.2b).
--
--  output_profiles.trick_play   the switch: "Trick-play for Apple and smart-TV
--                               players". Off by default: nothing is built or
--                               listed for media of a profile that has it off.
--  accounts.trick_play_default  what a new output profile starts with.
--  vod_iframe_playlists         one I-frame playlist per video rendition of an
--                               on-demand asset, made from the box headers of
--                               the segments players already get (no new media,
--                               nothing re-encoded). Served only while the
--                               asset's switch is on; kept when it is turned
--                               off, so turning it on again costs nothing.
-- ============================================================================
ALTER TABLE output_profiles ADD COLUMN IF NOT EXISTS trick_play boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS trick_play_default boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS vod_iframe_playlists (
  vod_asset_id      uuid NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  -- The variant's media playlist, relative to the master (v720/index.m3u8).
  variant_uri       text NOT NULL,
  playlist          text NOT NULL,
  bandwidth         integer NOT NULL,
  average_bandwidth integer NOT NULL,
  resolution        text,
  codecs            text,
  entries           integer NOT NULL,
  -- The master it was made from: a new build (re-encode) makes a new one.
  source            text,
  built_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vod_asset_id, variant_uri)
);

COMMENT ON COLUMN output_profiles.trick_play IS
  'Trick-play for Apple and smart-TV players (I-frame playlists). Off by default (build queue 3.2b).';
COMMENT ON COLUMN accounts.trick_play_default IS
  'The trick-play switch a new output profile starts with (build queue 3.2b).';
