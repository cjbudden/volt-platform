-- ============================================================================
--  0091: COMPANION FILES (docs/COMPANION_FILES.md).
--
--  Files that travel with an asset without being its media: caption files
--  (SRT, WebVTT, TTML) that become subtitle tracks in its HLS and DASH
--  manifests, metadata sidecars (JSON, XML / NFO, CSV) whose values a person
--  reviews and applies to the asset's fields, and anything else kept for
--  download. The original bytes are kept as uploaded; captions also keep a
--  clean WebVTT in asset time (offset applied), which is what players get.
--  All additive.
-- ============================================================================

CREATE TABLE IF NOT EXISTS vod_asset_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('captions','metadata','other')),
  format        TEXT NOT NULL,                 -- srt | vtt | ttml | json | xml | csv | tsv | unknown
  name          TEXT NOT NULL,                 -- the file name as uploaded
  store_key     TEXT NOT NULL,                 -- companions/<account>/<asset>/<id>/<name>, the original bytes
  vtt_key       TEXT,                          -- captions: the clean WebVTT players get
  content_type  TEXT,
  bytes         INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT,
  encoding      TEXT,                          -- utf-8 | windows-1252 (old SRTs)
  language      TEXT,                          -- BCP 47: en, fr, pt-BR
  label         TEXT,                          -- the track name viewers see
  is_default    BOOLEAN NOT NULL DEFAULT false,
  forced        BOOLEAN NOT NULL DEFAULT false,
  sdh           BOOLEAN NOT NULL DEFAULT false,
  enabled       BOOLEAN NOT NULL DEFAULT true, -- captions: offered to viewers
  offset_ms     INTEGER NOT NULL DEFAULT 0,    -- added to every cue (negative for files timed from 10:00:00:00)
  report        JSONB,                         -- captions: the check; metadata: what was read
  applied       JSONB,                         -- metadata: the last apply (fields, by, at)
  source        TEXT NOT NULL DEFAULT 'upload',-- upload | api | watchfolder
  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vod_asset_files_asset ON vod_asset_files (asset_id, kind);
-- One default caption track per asset.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vod_asset_files_default ON vod_asset_files (asset_id) WHERE is_default AND kind = 'captions';
-- The same bytes twice on one asset is the same file.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vod_asset_files_sha ON vod_asset_files (asset_id, sha256) WHERE sha256 IS NOT NULL;
