-- Build queue 3.2 follow-up (Christian, 2 Nov): every frame still keeps the
-- bucket and folder it was written to, and the folder's media object, so the
-- clean-up (the retention sweep and the TTL prune) can always find it.
--
-- bucket           the S3 bucket of the image store; NULL on a local store
-- folder           the folder key inside the image store, e.g.
--                  derived/<account>/frames/assets/<asset>/<version>
-- bytes            the still's size, summed onto the folder's media object
-- media_object_id  the folder's media_objects row (kind 'frame_stills'), whose
--                  location is the folder's full address
ALTER TABLE frame_stills ADD COLUMN IF NOT EXISTS bucket TEXT;
ALTER TABLE frame_stills ADD COLUMN IF NOT EXISTS folder TEXT;
ALTER TABLE frame_stills ADD COLUMN IF NOT EXISTS bytes INTEGER;
ALTER TABLE frame_stills ADD COLUMN IF NOT EXISTS media_object_id UUID REFERENCES media_objects(id) ON DELETE SET NULL;

-- Stills made before this have no recorded folder: it is the key's directory.
UPDATE frame_stills SET folder = regexp_replace(store_key, '/[^/]+$', '') WHERE folder IS NULL;

CREATE INDEX IF NOT EXISTS idx_frame_stills_object ON frame_stills (media_object_id);
CREATE INDEX IF NOT EXISTS idx_frame_stills_folder ON frame_stills (folder);
