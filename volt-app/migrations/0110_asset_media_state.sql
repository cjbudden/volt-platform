-- ============================================================================
--  0110: IS THERE PLAYABLE MEDIA BEHIND THIS ASSET?
--
--  A library row is a promise. Until now nothing recorded whether it was kept:
--  a clip whose build failed stayed at thumb_status 'processing' forever,
--  pointing at a manifest nobody would write, and QC on it reported "pass"
--  because every check that needs the file was skipped. Sorotan (27 Oct) was
--  exactly that: a 26 s recording gap refused the build, the asset sat in the
--  library looking normal, and the player failed.
--
--  media_state is what the producers of media say happened to it:
--    processing  a build or encode is queued or running
--    ready       the build finished and wrote the files
--    failed      the build failed; media_error says why
--    missing     no build is coming and no media exists
--    unplayable  media exists but QC could not decode it
--  NULL on rows no producer has touched; services/assetReadiness.ts falls back
--  to the evidence on the row for those.
--
--  The derived USAGE STATUS (ready / unchecked / qc_failed / processing /
--  failed / unplayable / no_media) lives in services/assetReadiness.ts, and is
--  what every picker (FAST, loops, blocking) filters on.
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS media_state      TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS media_error      TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS media_error_code TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS media_state_at   TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vod_assets_media_state_ck') THEN
    ALTER TABLE vod_assets ADD CONSTRAINT vod_assets_media_state_ck CHECK (
      media_state IS NULL OR media_state IN ('processing', 'ready', 'failed', 'missing', 'unplayable'));
  END IF;
END $$;

-- BACKFILL, from what actually happened to each clip's build.
-- 1. The latest clip.extract job per asset decides recording-derived clips.
WITH last_job AS (
  SELECT DISTINCT ON (payload->>'vodAssetId')
         payload->>'vodAssetId' AS asset_id, state, last_error, error_code
    FROM jobs
   WHERE type = 'clip.extract' AND payload ? 'vodAssetId'
   ORDER BY payload->>'vodAssetId', created_at DESC
)
UPDATE vod_assets v SET
  media_state = CASE lj.state::text
                  WHEN 'succeeded' THEN 'ready'
                  WHEN 'failed' THEN 'failed'
                  WHEN 'cancelled' THEN 'failed'
                  ELSE 'processing' END,
  media_error = CASE WHEN lj.state::text IN ('failed', 'cancelled')
                     THEN COALESCE(lj.last_error, 'The build was stopped before it finished.') END,
  media_error_code = CASE WHEN lj.state::text IN ('failed', 'cancelled') THEN lj.error_code END,
  media_state_at = now()
FROM last_job lj
WHERE lj.asset_id = v.id::text AND v.media_state IS NULL;

-- 2. A recording-derived clip with no build job at all and no built media is
--    a row nothing will ever fill.
UPDATE vod_assets SET media_state = 'missing', media_state_at = now(),
       media_error = 'No build was ever queued for this clip, so it has no media.'
 WHERE media_state IS NULL AND source_kind = 'recording' AND kind = 'clip'
   AND built_at IS NULL
   AND COALESCE(master_key, '') NOT LIKE '/clips/%'
   AND progressive_key IS NULL AND export_mp3_key IS NULL;

-- 3. QC that "passed" with nothing measured is not a pass. Clear it so the
--    asset reads as not checked until QC runs again with the new rules.
UPDATE vod_assets SET qc_state = NULL, qc_at = NULL
 WHERE qc_state = 'pass' AND media_state IN ('failed', 'missing');

CREATE INDEX IF NOT EXISTS idx_vod_assets_media_state ON vod_assets (media_state);
