-- Build queue 3.2 (a) and (b): frame-accurate access.
--
-- asset_frame_indexes: one row per on-demand asset, the frame index of the
-- rendition players get (services/frames/store.ts). Its own table, not a
-- column on vod_assets, because the index of a long film is tens of kilobytes
-- and every library list selects v.*.
--
-- frame_stills: the exact-frame JPEGs made on request, kept in the image store
-- under derived/<account>/frames/ and removed by the sweep after
-- FRAME_STILL_TTL_DAYS.
CREATE TABLE IF NOT EXISTS asset_frame_indexes (
    vod_asset_id  UUID PRIMARY KEY REFERENCES vod_assets(id) ON DELETE CASCADE,
    state         TEXT NOT NULL CHECK (state IN ('ready', 'none', 'failed')),
    error         TEXT,
    source        TEXT,
    rate_num      INTEGER,
    rate_den      INTEGER,
    total_frames  INTEGER,
    duration_ms   BIGINT,
    index         JSONB,
    built_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS frame_stills (
    store_key   TEXT PRIMARY KEY,
    account_id  UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_frame_stills_age ON frame_stills (created_at);
