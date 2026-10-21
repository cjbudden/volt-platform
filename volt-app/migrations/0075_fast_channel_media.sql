-- ============================================================================
--  0075  FAST CHANNEL MEDIA: is a FAST (playlist) channel a video channel or
--        an audio channel. Decides what the builder's library offers: an
--        audio channel takes audio assets only, a video channel takes video
--        assets only. Set when the channel is made; live channels ignore it
--        (their kind is channels.kind, 'tv' or 'radio').
-- ============================================================================
ALTER TABLE channels ADD COLUMN IF NOT EXISTS fast_media TEXT NOT NULL DEFAULT 'video';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_fast_media_ck') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_fast_media_ck CHECK (fast_media IN ('video', 'audio'));
  END IF;
END $$;
