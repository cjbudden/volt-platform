-- ============================================================================
--  0097 THREADS (build queue 1.14j).
--
--  Threads profiles become publish targets. Everything else Threads needs is
--  already there from Instagram (0087): the container id in
--  publications.platform_state, pictures as publications of image_key, and
--  likes and follower counts read back. Only the platform lists change.
-- ============================================================================
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_platform_check;
ALTER TABLE publications ADD CONSTRAINT publications_platform_check
  CHECK (platform IN ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'instagram', 'threads', 'app'));
ALTER TABLE publish_targets DROP CONSTRAINT IF EXISTS publish_targets_platform_check;
ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_platform_check
  CHECK (platform IN ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion', 'instagram', 'threads', 'app'));
