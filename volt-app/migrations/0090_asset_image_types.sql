-- ============================================================================
--  0090: IMAGE TYPES FOR AN ASSET (docs/ASSET_IMAGES.md section 13).
--
--  vod_assets.poster_key stays the asset's PRIMARY image (0072): picked
--  automatically, read by the library grid, the player, app feeds and
--  schema.org. It is called the Thumbnail on video and the Cover on audio.
--
--  On top of it an asset can now carry more images, one per TYPE: content
--  images (cover art on a music video) and publishing images for portals,
--  apps and feeds (poster, hero backdrop, banner, social share card, title
--  art). Each account has its own list of types: the standard ones are seeded
--  (services/media/assetImageRules.ts STANDARD_IMAGE_TYPES) and can be renamed
--  or switched off; the account can add its own (a partner's 4:3 tile, say).
--
--    asset_image_types   the account's types: shape, minimum size, what it
--                        applies to, what it falls back to
--    vod_asset_images    an asset's image of a type: an Image Library key,
--                        the focus point portals crop around, who chose it
--
--  A type with no image of its own is answered with its fallback (in the end
--  the primary image), cropped to the type's shape and marked derived, so a
--  portal always gets the right shape. Nothing is stored for that.
--  All additive.
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_image_types (
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  purpose       TEXT NOT NULL DEFAULT 'publishing' CHECK (purpose IN ('content','publishing')),
  aspect_w      INTEGER CHECK (aspect_w IS NULL OR aspect_w BETWEEN 1 AND 400),
  aspect_h      INTEGER CHECK (aspect_h IS NULL OR aspect_h BETWEEN 1 AND 400),
  min_width     INTEGER NOT NULL DEFAULT 0,
  min_height    INTEGER NOT NULL DEFAULT 0,
  applies_to    TEXT[] NOT NULL DEFAULT '{video,audio}',
  primary_for   TEXT[] NOT NULL DEFAULT '{}',
  fallback      TEXT[] NOT NULL DEFAULT '{primary}',
  transparent   BOOLEAN NOT NULL DEFAULT false,
  is_standard   BOOLEAN NOT NULL DEFAULT false,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort          INTEGER NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key),
  CHECK ((aspect_w IS NULL) = (aspect_h IS NULL))
);

CREATE TABLE IF NOT EXISTS vod_asset_images (
  asset_id      UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type_key      TEXT NOT NULL,
  image_key     TEXT NOT NULL,          -- library/<account>/<path> in the image store
  focus_x       SMALLINT CHECK (focus_x BETWEEN 0 AND 100),
  focus_y       SMALLINT CHECK (focus_y BETWEEN 0 AND 100),
  width         INTEGER,
  height        INTEGER,
  source        TEXT NOT NULL DEFAULT 'manual',   -- manual | frame | api
  chosen_by     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, type_key)
);

-- "Which assets use this library image?" (the library warns before deleting it).
CREATE INDEX IF NOT EXISTS idx_vod_asset_images_key ON vod_asset_images (account_id, image_key);

COMMENT ON TABLE vod_asset_images IS 'An asset''s image of a type other than its primary one (vod_assets.poster_key). Missing types fall back at read time (services/media/assetImageSet.ts).';
