-- ============================================================================
--  0093: SONG COVERS ARE THEIR OWN KIND, AND TYPED ASSET IMAGES CAN GO TO THE BIN.
--
--  Song artwork (album covers found for songs, covers a station's feed sent,
--  covers a person chose in Find song details) was stored as kind 'poster' or
--  'imported'. It is kind 'cover' from now on (assetImage.ts coverKey,
--  songArtwork.ts, vodImage.ts song/use) and the Image Library filters by it.
--  Existing ones are recognised by what they are: a coverOf mark, or a
--  cover.<ext> in a song folder (media/<artist>/<album>/<song>/).
--
--  vod_asset_images gets an id: the restore bin snapshots an asset's rows by id
--  (media/trash.ts snapshotDelete), so typed images now come back with a
--  restored asset.
-- ============================================================================
UPDATE media_files
   SET kind = 'cover', tags = array_replace(array_replace(tags, 'poster', 'cover'), 'imported', 'cover'), updated_at = now()
 WHERE kind IN ('poster', 'imported', 'other')
   AND (metadata ? 'coverOf'
        OR path ~ '^media/[^/]+/[^/]+/[^/]+/cover\.[A-Za-z0-9]+$');

ALTER TABLE vod_asset_images ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_vod_asset_images_id ON vod_asset_images (id);
