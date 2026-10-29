-- 0112: sprite sheets get their own store and table, out of the Image Library (docs/THUMBNAILS.md "Where sprites live").
--
-- Sprite sheets and their WebVTTs are system files: the player's hover previews, the recording
-- and clip timelines and the asset actions read them, nobody picks one as an image. Until now each
-- sheet was a media_files row (kind 'storyboard') under library/{account}/thumbnails/..., so the
-- library filled with them. From here they live under derived/{account}/sprites/ (served by the
-- signed image service like any account image) and are indexed here instead.
--
-- The layout the readers use does not move: storyboards.sheets (live hours) and vod_assets.sprite
-- (uploaded files) still say which sheet covers which time. This table is the inventory: one row
-- per object, its owner, layout, tiles and bytes, so sprites can be counted, listed and removed
-- without walking the store.
--
-- Existing sheets are moved by the application (services/thumbnails/spriteStore.ts
-- relocateLegacySprites), because the files have to move with the keys; it runs in the background
-- after start-up until nothing uses an old key, and drops the sheets' library rows as it goes.

CREATE TABLE IF NOT EXISTS sprite_sheets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('stream','asset')),   -- a live stream's hour, or an asset's own
    kind          TEXT NOT NULL DEFAULT 'sheet' CHECK (kind IN ('sheet','vtt')),
    store_key     TEXT NOT NULL UNIQUE,                                     -- derived/{account}/sprites/...
    stream_kind   TEXT CHECK (stream_kind IN ('channel','event')),
    stream_id     UUID,                                                     -- channels.id or events.id
    storyboard_id UUID REFERENCES storyboards(id) ON DELETE CASCADE,        -- the hour it belongs to
    vod_asset_id  UUID REFERENCES vod_assets(id) ON DELETE CASCADE,         -- the asset it belongs to
    start_ms      BIGINT,                 -- first tile: epoch ms (stream) or ms into the file (asset)
    interval_ms   INTEGER,                -- one tile every interval
    tile_w        INTEGER,
    tile_h        INTEGER,
    cols          INTEGER,
    rows          INTEGER,
    tiles         INTEGER NOT NULL DEFAULT 0,
    width         INTEGER,
    height        INTEGER,
    size_bytes    BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((owner_kind = 'stream' AND stream_id IS NOT NULL) OR (owner_kind = 'asset' AND vod_asset_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_sprite_sheets_account    ON sprite_sheets (account_id, owner_kind);
CREATE INDEX IF NOT EXISTS idx_sprite_sheets_stream     ON sprite_sheets (stream_id, start_ms) WHERE stream_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sprite_sheets_storyboard ON sprite_sheets (storyboard_id) WHERE storyboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sprite_sheets_asset      ON sprite_sheets (vod_asset_id) WHERE vod_asset_id IS NOT NULL;
