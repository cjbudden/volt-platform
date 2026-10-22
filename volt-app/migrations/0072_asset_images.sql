-- ============================================================================
--  0072: THE IMAGE THAT REPRESENTS AN ASSET (docs/ASSET_IMAGES.md).
--
--  vod_assets.poster_key was already the one image every surface reads (the
--  library grid, the player poster, app feeds, schema.org). It was only ever
--  set for TV recordings (the keyframe nearest the clip start), so radio,
--  songs and uploaded files showed placeholders. It stays the one image; these
--  columns say where it came from and let a person override it for good.
--
--    poster_source      manual | cover_art | programme | station | frame |
--                       live_frame | metadata | none
--    poster_shape       wide (16:9 frame) | square (artwork, station logo)
--    poster_reason      one line for people: "Sharpest well-exposed frame of 12 (01:23)"
--    poster_candidates  frames considered, scored: [{key, atMs, origin, score, notes}]
--    poster_locked      a person chose it: automatic picks never replace it
--    music_lookup       the last song lookup: what matched, how sure, what it filled
--    sprite             an uploaded file's sprite sheets for hover previews
--
--  music_lookups caches a song's MusicBrainz match by normalised artist|title,
--  shared by every account: the same song on a hundred stations is one lookup
--  (MusicBrainz allows one request a second per IP for the whole platform).
--  All additive.
-- ============================================================================

ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS poster_source TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS poster_shape TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS poster_reason TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS poster_candidates JSONB;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS poster_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS poster_picked_at TIMESTAMPTZ;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS music_lookup JSONB;
-- Sprite sheets built from an uploaded file (services/thumbnails/fileSprites.ts):
-- {folder, intervalMs, tileW, tileH, cols, rows, sheets: [{key, from, tiles}]}.
-- Recording-derived assets use the stream's hourly storyboards instead.
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS sprite JSONB;

DO $$ BEGIN
  ALTER TABLE vod_assets ADD CONSTRAINT vod_assets_poster_shape_ck CHECK (poster_shape IS NULL OR poster_shape IN ('wide','square'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN vod_assets.poster_source IS 'Where poster_key came from: manual | cover_art | programme | station | frame | live_frame | metadata | none. NULL = not picked yet (the image worker will).';
COMMENT ON COLUMN vod_assets.poster_locked IS 'A person chose the image. Automatic picks never replace it until they ask for an automatic pick again.';

-- The worker's queue: assets nobody has picked an image for yet.
CREATE INDEX IF NOT EXISTS idx_vod_assets_poster_unpicked ON vod_assets (created_at) WHERE poster_source IS NULL;

CREATE TABLE IF NOT EXISTS music_lookups (
  norm_key            TEXT PRIMARY KEY,
  state               TEXT NOT NULL CHECK (state IN ('hit','miss','error')),
  artist              TEXT,
  title               TEXT,
  album               TEXT,
  released            TEXT,           -- the album's first release date, YYYY or YYYY-MM-DD
  isrc                TEXT,
  genres              TEXT[] NOT NULL DEFAULT '{}',
  label               TEXT,
  length_ms           INTEGER,
  recording_mbid      TEXT,
  release_mbid        TEXT,
  release_group_mbid  TEXT,
  confidence          INTEGER,        -- 0..100, our own score after the version checks
  reason              TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  looked_up_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
