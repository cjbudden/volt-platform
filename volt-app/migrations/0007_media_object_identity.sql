-- ============================================================================
--  One media object per logical key per owner — including when the owner is
--  only the stream.
--
--  0006 made the key unique per recording and per asset. Media whose recording
--  row was never written, or has since been deleted, has neither, so it matched
--  nothing on every reconciliation pass and a fresh row was inserted each time:
--  three duplicate objects for one directory after three boots, each carrying
--  its own state and each separately governed by retention.
--
--  Media on disk that nothing claims is not an edge case. It is precisely what a
--  lifecycle exists to surface, so it needs an identity of its own: the stream
--  it belongs to, plus the logical key.
-- ============================================================================

-- Collapse any duplicates that already exist, keeping the oldest row — it is the
-- one carrying the history, and the later ones are copies of a fact, not facts.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY COALESCE(recording_id, vod_asset_id, channel_id, event_id), logical_key
           ORDER BY created_at, id
         ) AS rn
    FROM media_objects
   WHERE recording_id IS NULL AND vod_asset_id IS NULL
)
DELETE FROM media_objects o USING ranked r
 WHERE o.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_objects_channel_key
  ON media_objects (channel_id, logical_key)
  WHERE recording_id IS NULL AND vod_asset_id IS NULL AND channel_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_objects_event_key
  ON media_objects (event_id, logical_key)
  WHERE recording_id IS NULL AND vod_asset_id IS NULL AND event_id IS NOT NULL;
