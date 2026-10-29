-- 0113: library images can go to the restore bin (docs/IMAGES.md section 18).
--
-- Replacing an image with another (a duplicate, or one a person says is the same picture) points
-- everything that used it at the one that stays and removes it. It goes to the bin, like a deleted
-- asset, so a mistake can be undone: services/media/libraryMoves.ts replaceImages.
ALTER TABLE trash_items DROP CONSTRAINT IF EXISTS trash_items_kind_check;
ALTER TABLE trash_items ADD CONSTRAINT trash_items_kind_check CHECK (kind IN ('recording_media', 'vod_asset', 'media_file'));
