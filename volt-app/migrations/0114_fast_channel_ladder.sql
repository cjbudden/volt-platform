-- ============================================================================
--  A FAST CHANNEL HAS ONE LADDER, AND EVERY ASSET ON IT IS PACKAGED TO IT.
--
--  The playout splices the assets' own segments into one live playlist per
--  rung (volt-encoder/bin/fast_playout.py). That only works when every asset
--  carries the SAME rungs: one asset with 1080/720/480 beside one with 720/480
--  put 720p segments under a 1080p RESOLUTION and CODECS in the live playlist,
--  and the channel stalled or switched badly at the splice.
--
--  channels.fast_ladder_group_id
--      The channel's ladder (an encode ladder group). NULL means the account's
--      default ladder group, resolved when it is used.
--
--  vod_asset_ladders
--      An asset packaged to one ladder, kept beside its own encode
--      (clips/vod/<asset>/ladders/<variant>/, or vod/<asset>/ladders/<variant>/
--      on the origin bucket). One row per asset, ladder group, segment length
--      and loudness: a slate is cut in 1 s segments, a house spot is brought to
--      broadcast loudness, and both are variants of the same ladder. A row
--      with origin 'main' records that the asset's own encode already matches
--      the ladder, so nothing was re-encoded.
--
--  services/fast/ladder.ts reads and writes both; services/fast/prepare.ts
--  queues the variants a channel needs (job vod.ladder).
-- ============================================================================

ALTER TABLE channels ADD COLUMN IF NOT EXISTS fast_ladder_group_id UUID
  REFERENCES encode_ladder_groups(id) ON DELETE SET NULL;

COMMENT ON COLUMN channels.fast_ladder_group_id IS
  'FAST channels: the ladder every asset on the channel is packaged to. NULL = the account default ladder group.';

CREATE TABLE IF NOT EXISTS vod_asset_ladders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vod_asset_id     UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  ladder_group_id  UUID NOT NULL REFERENCES encode_ladder_groups(id) ON DELETE CASCADE,
  segment_seconds  NUMERIC(5,2) NOT NULL,
  loudnorm         BOOLEAN NOT NULL DEFAULT false,
  -- 'main': the asset's own encode matches; 'variant': encoded for the ladder
  origin           TEXT NOT NULL DEFAULT 'variant' CHECK (origin IN ('main', 'variant')),
  state            TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'encoding', 'ready', 'failed')),
  -- the ladder as it was when this was made: [{height, width, bitrate_kbps}]
  rungs            JSONB NOT NULL DEFAULT '[]'::jsonb,
  fps              NUMERIC(6,3),
  master_key       TEXT,
  mpd_key          TEXT,
  zero_start       BOOLEAN NOT NULL DEFAULT false,
  notes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  error            TEXT,
  job_id           UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vod_asset_id, ladder_group_id, segment_seconds, loudnorm)
);

CREATE INDEX IF NOT EXISTS vod_asset_ladders_group_idx ON vod_asset_ladders (ladder_group_id);
