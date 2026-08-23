-- ============================================================================
--  Collapse media objects that describe the same media twice.
--
--  A run is often on disk before its recording row exists — the encoder writes
--  segments, the row is opened in a separate transaction — and it is on disk
--  after that row is deleted. Registration keyed the object to the stream in
--  those cases and to the recording otherwise, and looked in only one of the two
--  places. So a run reconciled before its recording appeared, and again after,
--  produced TWO objects for one directory: same bytes, two histories, two
--  separate retention futures, and a storage page listing the same run twice.
--
--  The code now adopts the orphan when the recording turns up. This collapses
--  the pairs that already exist, keeping the row that carries the recording link
--  and folding the orphan's history into it — history is the part that cannot be
--  reconstructed, so it is the part that must not be dropped.
-- ============================================================================

WITH pairs AS (
  SELECT claimed.id AS keep_id, orphan.id AS drop_id
    FROM media_objects claimed
    JOIN media_objects orphan
      ON orphan.logical_key = claimed.logical_key
     AND orphan.id <> claimed.id
     AND orphan.recording_id IS NULL
     AND orphan.vod_asset_id IS NULL
     AND COALESCE(orphan.channel_id, orphan.event_id)
       = COALESCE(claimed.channel_id, claimed.event_id)
   WHERE claimed.recording_id IS NOT NULL
)
UPDATE media_events e SET object_id = p.keep_id
  FROM pairs p WHERE e.object_id = p.drop_id;

WITH pairs AS (
  SELECT claimed.id AS keep_id, orphan.id AS drop_id
    FROM media_objects claimed
    JOIN media_objects orphan
      ON orphan.logical_key = claimed.logical_key
     AND orphan.id <> claimed.id
     AND orphan.recording_id IS NULL
     AND orphan.vod_asset_id IS NULL
     AND COALESCE(orphan.channel_id, orphan.event_id)
       = COALESCE(claimed.channel_id, claimed.event_id)
   WHERE claimed.recording_id IS NOT NULL
)
DELETE FROM media_objects o USING pairs p WHERE o.id = p.drop_id;
