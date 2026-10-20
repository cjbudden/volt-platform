-- ============================================================================
--  0062  SKIP MARKERS ON ON-DEMAND ASSETS (docs/DESIGN_vod_skip_markers.md).
--
--  Intro, recap and credits ranges on a vod_asset. Found automatically by
--  comparing episodes of the same series (services/introDetect.ts), or set by
--  hand, and editable at any time: the on-demand playlists are annotated when a
--  player asks for them (services/vodMarkers.ts), so an edit reaches the
--  outputs on the next playlist fetch with nothing rebuilt.
--
--  source   auto    written by detection; detection may move it again
--           manual  set or changed by a person; detection never touches it
--  status   active     in the outputs: the player offers Skip
--           suggested  found with low confidence; shown in the console only,
--                      until someone accepts it
-- ============================================================================

CREATE TABLE IF NOT EXISTS vod_markers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vod_asset_id  UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('intro', 'recap', 'credits')),
  start_ms      INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms        INTEGER NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suggested')),
  confidence    REAL,
  -- detection evidence: the episodes it was compared with and what each said
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_ms > start_ms),
  UNIQUE (vod_asset_id, kind)
);

-- Which episodes are compared with which: the series an asset belongs to,
-- worked out at detection time (the episode metadata's series, else the
-- programme title on its channel) and kept so the next episode finds its peers
-- with one indexed read.
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS marker_group TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS markers_detected_at TIMESTAMPTZ;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS markers_note TEXT;
CREATE INDEX IF NOT EXISTS idx_vod_assets_marker_group ON vod_assets (account_id, marker_group) WHERE marker_group IS NOT NULL;

-- An edit drops the cached marker list in every API process (scale/cache.ts),
-- so the next playlist fetch carries it.
DROP TRIGGER IF EXISTS trg_cache_vod_markers ON vod_markers;
CREATE TRIGGER trg_cache_vod_markers
  AFTER INSERT OR UPDATE OR DELETE ON vod_markers
  FOR EACH ROW EXECUTE FUNCTION volt_cache_notify('asset', 'vod_asset_id');
