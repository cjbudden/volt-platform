-- 0049: image metadata, library search, and encoder storyboards (docs/THUMBNAILS.md).
--
--   * media_files keeps what an image says about itself (EXIF, GPS, IPTC, XMP)
--     next to what we say about it, and where it came from: an upload, a
--     watchfolder, or the encoder.
--   * one search vector per file, kept by a trigger, so a search across names,
--     tags, titles, descriptions, keywords, places, cameras and programme names
--     is one GIN lookup however large the library gets.
--   * storyboards: one row per stream per local hour, the index of the sprite
--     sheets and the WebVTT that hover previews and clip VTTs are built from.

-- ---- media_files: provenance + metadata ----------------------------------------
ALTER TABLE media_files
    ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'upload',   -- upload | watchfolder | encoder
    ADD COLUMN IF NOT EXISTS channel_id   UUID,                             -- encoder images: the channel or event they came from
    ADD COLUMN IF NOT EXISTS captured_at  TIMESTAMPTZ,                      -- encoder images: the instant the frame shows
    ADD COLUMN IF NOT EXISTS taken_at     TIMESTAMPTZ,                      -- photos: DateTimeOriginal
    ADD COLUMN IF NOT EXISTS gps_lat      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS gps_lng      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS gps_alt      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS location     TEXT,                             -- "Sublocation, City, State, Country" as written in the file
    ADD COLUMN IF NOT EXISTS camera       TEXT,                             -- "Make Model"
    ADD COLUMN IF NOT EXISTS title        TEXT,
    ADD COLUMN IF NOT EXISTS description  TEXT,
    ADD COLUMN IF NOT EXISTS keywords     TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS creator      TEXT,
    ADD COLUMN IF NOT EXISTS copyright    TEXT,
    ADD COLUMN IF NOT EXISTS checksum     TEXT,                             -- sha256 of the bytes
    ADD COLUMN IF NOT EXISTS metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS search       TSVECTOR;

-- 'storyboard' joins the kinds; kind is free text, the API validates it.

CREATE OR REPLACE FUNCTION media_files_search_refresh() RETURNS trigger AS $$
BEGIN
  NEW.search :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '') || ' ' || coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ') || ' ' || array_to_string(NEW.keywords, ' ')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.location, '') || ' ' || coalesce(NEW.metadata->>'programme', '')), 'B')
   || setweight(to_tsvector('simple', coalesce(NEW.description, '') || ' ' || coalesce(NEW.camera, '')
        || ' ' || coalesce(NEW.creator, '') || ' ' || coalesce(NEW.metadata->>'channel', '')), 'C')
   || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.path, ''), '[/_.-]+', ' ', 'g')), 'D');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_media_files_search ON media_files;
CREATE TRIGGER trg_media_files_search BEFORE INSERT OR UPDATE ON media_files
  FOR EACH ROW EXECUTE FUNCTION media_files_search_refresh();

-- fill the vector for rows that predate the trigger
UPDATE media_files SET search = NULL WHERE search IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_files_search   ON media_files USING gin (search);
CREATE INDEX IF NOT EXISTS idx_media_files_captured ON media_files (account_id, channel_id, captured_at) WHERE captured_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_taken    ON media_files (account_id, taken_at) WHERE taken_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_geo      ON media_files (account_id, gps_lat, gps_lng) WHERE gps_lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_source   ON media_files (account_id, source);
CREATE INDEX IF NOT EXISTS idx_media_files_checksum ON media_files (account_id, checksum) WHERE checksum IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_folders_path   ON media_folders (account_id, path text_pattern_ops);
-- prefix scans ("everything under thumbnails/news/2026-10-16") for the lazy folder tree
CREATE INDEX IF NOT EXISTS idx_media_files_folder_prefix ON media_files (account_id, folder text_pattern_ops);

-- ---- storyboards: sprite sheets + VTT per stream per local hour -----------------
CREATE TABLE IF NOT EXISTS storyboards (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stream_kind   TEXT NOT NULL CHECK (stream_kind IN ('channel','event')),
    stream_id     UUID NOT NULL,                 -- channels.id or events.id
    unit_start    TIMESTAMPTZ NOT NULL,          -- the local hour this covers, as an instant
    unit_end      TIMESTAMPTZ NOT NULL,
    folder        TEXT NOT NULL,                 -- thumbnails/<stream>/<date>/<HH>
    interval_ms   INTEGER NOT NULL,              -- one tile every interval
    tile_w        INTEGER NOT NULL,
    tile_h        INTEGER NOT NULL,
    cols          INTEGER NOT NULL,
    rows          INTEGER NOT NULL,
    -- [{ "key": "library/<acct>/.../x-m00.jpg", "start_ms": <epoch>, "slots": 60, "filled": [0,1,...] }]
    sheets        JSONB NOT NULL DEFAULT '[]'::jsonb,
    vtt_key       TEXT,
    tiles         INTEGER NOT NULL DEFAULT 0,    -- tiles with a picture
    frames        INTEGER NOT NULL DEFAULT 0,    -- library stills written
    status        TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','complete','empty')),
    built_through TIMESTAMPTZ,                   -- last instant the pass covered
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (stream_id, unit_start)
);
CREATE INDEX IF NOT EXISTS idx_storyboards_stream_time ON storyboards (stream_id, unit_start);
CREATE INDEX IF NOT EXISTS idx_storyboards_account     ON storyboards (account_id, unit_start);
