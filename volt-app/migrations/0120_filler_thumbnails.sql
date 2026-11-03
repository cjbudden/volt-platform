-- ============================================================================
--  0120: SLATES AND LOOPS GET THUMBNAILS LIKE MEDIA ASSETS (docs/THUMBNAILS.md).
--
--  Loops & Fillers showed each loop by loading the whole source video into a
--  <video> per row, and a slate by loading the full image. Now each one gets
--  what an uploaded media asset gets, made from its own file by the
--  filler.thumbs job (services/media/fillerThumbs.ts):
--
--    poster_key         the thumbnail: the best of a dozen frames for a loop
--                       (scored like asset frames), the image itself scaled
--                       for a slate. Picked automatically unless a person
--                       chose one of the frames (poster_source 'manual').
--    poster_candidates  the scored frames a person can choose from (loops).
--    sprite             sprite sheets for hover and scrub previews (loops), in
--                       the same layout as vod_assets.sprite, so the same VTT
--                       builder serves them.
--    thumb_status       null (not made yet) | ready | failed, thumb_error why.
--    probe              the file as delivered, read at the same time: container,
--                       video codec, profile, level, resolution, frame rate,
--                       scan, pixel format, colour, bitrate; audio codec,
--                       channels, sample rate, bitrate.
--
--  Sprite sheets are indexed in sprite_sheets like an asset's, owner 'filler'.
-- ============================================================================
ALTER TABLE filler_assets
  ADD COLUMN IF NOT EXISTS poster_source     TEXT,
  ADD COLUMN IF NOT EXISTS poster_candidates JSONB,
  ADD COLUMN IF NOT EXISTS sprite            JSONB,
  ADD COLUMN IF NOT EXISTS thumb_status      TEXT,
  ADD COLUMN IF NOT EXISTS thumb_error       TEXT,
  ADD COLUMN IF NOT EXISTS thumbs_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS probe             JSONB;

ALTER TABLE sprite_sheets ADD COLUMN IF NOT EXISTS filler_asset_id UUID REFERENCES filler_assets(id) ON DELETE CASCADE;
ALTER TABLE sprite_sheets DROP CONSTRAINT IF EXISTS sprite_sheets_owner_kind_check;
ALTER TABLE sprite_sheets ADD CONSTRAINT sprite_sheets_owner_kind_check CHECK (owner_kind IN ('stream','asset','filler'));
ALTER TABLE sprite_sheets DROP CONSTRAINT IF EXISTS sprite_sheets_check;
ALTER TABLE sprite_sheets ADD CONSTRAINT sprite_sheets_check CHECK (
     (owner_kind = 'stream' AND stream_id IS NOT NULL)
  OR (owner_kind = 'asset'  AND vod_asset_id IS NOT NULL)
  OR (owner_kind = 'filler' AND filler_asset_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_sprite_sheets_filler ON sprite_sheets (filler_asset_id) WHERE filler_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_filler_thumbs_todo ON filler_assets (created_at) WHERE status = 'ready' AND thumb_status IS NULL;
