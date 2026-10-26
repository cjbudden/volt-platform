-- ============================================================================
--  0087 INSTAGRAM (build queue 1.14i).
--
--  Instagram professional accounts (Business or Creator) become publish
--  targets, reached one of two ways, kept per target in `variant`:
--    instagram   Instagram Login (graph.instagram.com, the account's own token)
--    facebook    Facebook Login, for an Instagram account tied to a Page
--                (graph.facebook.com, the Page's token)
--
--  Instagram posts pictures as well as videos, so a publication is now either
--  of a library asset (vod_asset_id) or of an Image Library picture
--  (image_key, the store key). Exactly one of the two.
--
--  Instagram publishes through a container (create, wait until it is
--  finished, publish). `platform_state` keeps the container id on the
--  publication, so a retry after a dropped connection carries on with the same
--  container instead of creating a second post.
--
--  likes and followers: read back with the views, where the platform gives them.
-- ============================================================================
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_platform_check;
ALTER TABLE publications ADD CONSTRAINT publications_platform_check
  CHECK (platform IN ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'instagram', 'app'));
ALTER TABLE publish_targets DROP CONSTRAINT IF EXISTS publish_targets_platform_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_platform_check
  CHECK (platform IN ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'instagram', 'app'));

ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS variant TEXT;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS followers BIGINT;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS followers_synced_at TIMESTAMPTZ;
ALTER TABLE social_oauth_states ADD COLUMN IF NOT EXISTS variant TEXT;

ALTER TABLE publications ALTER COLUMN vod_asset_id DROP NOT NULL;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS image_key TEXT;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS platform_state JSONB;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS likes BIGINT;
DO $$ BEGIN
  ALTER TABLE publications ADD CONSTRAINT publications_subject_chk CHECK ((vod_asset_id IS NOT NULL) <> (image_key IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_pub_image ON publications(image_key) WHERE image_key IS NOT NULL;
