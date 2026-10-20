-- ============================================================================
--  0071: MEDIA LIBRARY VIEWS. Grid and list, filters by content type, target
--  metadata, EPG auto-fill and encode facts (volt-app/docs/DESIGN_media_library.md,
--  section "Library views, filters and target metadata").
--
--  All additive. Nothing here changes an existing column or constraint.
--
--  1. ENCODE FACTS AS COLUMNS. The library filters on "top resolution" and
--     "codec". Both are derivable (encode_result for a file, the live output
--     profile for a recording-derived asset), but a filter that has to unpack
--     a JSON array or join to the profile on every row cannot use an index.
--     So the two values are kept on the row by a trigger, from the same
--     sources the asset page reads, and indexed.
--  2. METADATA PROVENANCE. Which fields were filled from which EPG programme,
--     when and by whom. Kept beside the metadata, not in it: metadata is
--     validated strictly against the content type and must only hold its fields.
--  3. INDEXES for the new filters and the common sorts.
-- ============================================================================

ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS top_height INTEGER;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS video_codec TEXT;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS metadata_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN vod_assets.top_height IS
  'Height of the top rendition, kept by trg_vod_assets_encode_facts from encode_result.kept (file encodes) or the live output profile (recording-derived). NULL = not known.';
COMMENT ON COLUMN vod_assets.video_codec IS
  'Video codec of the renditions (h264, hevc, av1), kept by the same trigger. NULL = not known (a package-only source that does not declare it).';
COMMENT ON COLUMN vod_assets.metadata_provenance IS
  'Per metadata field, where its value came from when it was not typed: {"title":{"source":"epg","programmeId":"...","at":"...","by":"..."}}. A field edited by hand loses its entry.';

CREATE OR REPLACE FUNCTION vod_assets_encode_facts() RETURNS trigger AS $fn$
DECLARE
  p RECORD;
BEGIN
  IF NEW.encode_result IS NOT NULL
     AND jsonb_typeof(NEW.encode_result -> 'kept') = 'array'
     AND jsonb_array_length(NEW.encode_result -> 'kept') > 0 THEN
    NEW.top_height := (SELECT max((r ->> 'height')::int) FROM jsonb_array_elements(NEW.encode_result -> 'kept') r);
    -- The file encoder is H.264 by contract (volt-encoder/bin/ladder_args.py);
    -- a result that names its codec wins.
    NEW.video_codec := lower(COALESCE(NEW.encode_result ->> 'codec', 'h264'));
  ELSIF NEW.top_height IS NULL AND (NEW.channel_id IS NOT NULL OR NEW.event_id IS NOT NULL) THEN
    SELECT op.rungs, op.workflow_type::text AS wf INTO p
      FROM groups g JOIN output_profiles op ON op.id = g.output_profile_id
     WHERE g.id = COALESCE((SELECT c.group_id FROM channels c WHERE c.id = NEW.channel_id),
                           (SELECT e.group_id FROM events e WHERE e.id = NEW.event_id));
    IF FOUND AND jsonb_typeof(p.rungs) = 'array' AND jsonb_array_length(p.rungs) > 0 THEN
      NEW.top_height := (SELECT max((r ->> 'height')::int) FROM jsonb_array_elements(p.rungs) r);
      NEW.video_codec := COALESCE(NEW.video_codec,
        lower((SELECT r ->> 'codec' FROM jsonb_array_elements(p.rungs) r ORDER BY (r ->> 'height')::int DESC NULLS LAST LIMIT 1)),
        CASE WHEN p.wf = 'transcode' THEN 'h264' END);
    END IF;
  END IF;
  IF NEW.video_codec IN ('avc', 'avc1', 'x264', 'nvenc') THEN NEW.video_codec := 'h264'; END IF;
  IF NEW.video_codec IN ('h265', 'hvc1', 'hev1', 'x265') THEN NEW.video_codec := 'hevc'; END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vod_assets_encode_facts ON vod_assets;
CREATE TRIGGER trg_vod_assets_encode_facts
  BEFORE INSERT OR UPDATE OF encode_result, channel_id, event_id ON vod_assets
  FOR EACH ROW EXECUTE FUNCTION vod_assets_encode_facts();

-- Backfill: touching the watched columns runs the trigger on existing rows.
UPDATE vod_assets SET encode_result = encode_result WHERE encode_result IS NOT NULL;
UPDATE vod_assets SET channel_id = channel_id WHERE top_height IS NULL AND (channel_id IS NOT NULL OR event_id IS NOT NULL);

-- Filters and sorts the library offers. Assets are owned through the channel
-- or event (recording-derived) or the account (files), so these lead with the
-- filtered column rather than the account.
CREATE INDEX IF NOT EXISTS idx_vod_assets_schema_created ON vod_assets (schema_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vod_assets_top_height ON vod_assets (top_height) WHERE top_height IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vod_assets_video_codec ON vod_assets (video_codec) WHERE video_codec IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vod_assets_duration ON vod_assets (duration_ms);
CREATE INDEX IF NOT EXISTS idx_vod_assets_created ON vod_assets (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC') DESC, id);
-- EPG auto-fill looks programmes up by the clip they produced.
CREATE INDEX IF NOT EXISTS idx_prog_clip_asset ON programmes (clip_asset_id) WHERE clip_asset_id IS NOT NULL;
