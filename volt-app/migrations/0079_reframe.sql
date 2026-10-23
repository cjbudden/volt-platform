-- ============================================================================
--  0079 REFRAME: social formats (9:16, 1:1, 4:5) made from a 16:9 asset by
--  following what is in the picture (volt/REFRAME.md).
--
--  Three things, kept apart on purpose:
--   reframe_settings  the account's choices: which formats, what to keep in
--                     frame, how the camera may move, when it runs, and which
--                     format each social platform receives.
--   vod_tracks        the analysis of one asset: where its shots cut and where
--                     each face is, sample by sample. The full track store is a
--                     sidecar file (tracks_key); the row holds the summary the
--                     console lists. Written once per analysis, read by every
--                     format, and by anything else that needs a position later
--                     (a blur that follows a face, graphics that avoid one).
--   vod_formats       one framing path per asset per format: time-coded crop
--                     keyframes, the operator's per-shot choices, whether a
--                     person changed it, whether it is approved, and the file
--                     rendered from it.
-- ============================================================================
CREATE TABLE IF NOT EXISTS reframe_settings (
  account_id  UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS vod_tracks (
  vod_asset_id  UUID PRIMARY KEY REFERENCES vod_assets(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  tracks_key    TEXT,                -- /clips/... path of the full track store (JSON)
  summary       JSONB,               -- source, shots, subjects, engine: what the console lists
  error         TEXT,
  job_id        UUID,
  analysed_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vod_formats (
  vod_asset_id    UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  format          TEXT NOT NULL CHECK (format IN ('9x16', '1x1', '4x5')),
  path            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- keys, shots, confidence (services/reframe/framing.ts)
  overrides       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per shot: { "<shot>": { "follow": "<subject>|group|centre" } }
  edited          BOOLEAN NOT NULL DEFAULT false,       -- a person moved a keyframe: re-analysis keeps it
  review          TEXT NOT NULL DEFAULT 'pending' CHECK (review IN ('pending', 'approved')),
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  render_state    TEXT NOT NULL DEFAULT 'none' CHECK (render_state IN ('none', 'queued', 'rendering', 'ready', 'failed', 'stale')),
  output_key      TEXT,
  width           INTEGER,
  height          INTEGER,
  bytes           BIGINT,
  render_seconds  NUMERIC,
  render_error    TEXT,
  rendered_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vod_asset_id, format)
);
CREATE INDEX IF NOT EXISTS vod_formats_render_state_idx ON vod_formats (render_state) WHERE render_state IN ('queued', 'rendering');
