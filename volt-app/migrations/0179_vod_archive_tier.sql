-- ============================================================================
--  0179: THE ARCHIVE STORAGE TIER FOR VOD TITLES (build queue P5-3 (a),
--  PUBLISHING_POLICIES.md phase 5). When a publishing policy's Retention
--  section sets Archive storage tier (`retention.archiveTier`: infrequent or
--  glacier), an archived title's packaged media and original in the bucket are
--  moved to that storage class (services/media/vodArchiveTier.ts), and moved
--  back when the title is restored to Draft or Published. Nothing moves unless
--  a policy asks.
--
--  Adds only: nullable columns on vod_assets, so old and new tasks can share
--  the database during a rolling deploy.
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_tier                text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_tier_state          text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_tier_at             timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_tier_error          text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_restore_to          text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_restore_by          text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS archive_restore_expected_by timestamptz;
COMMENT ON COLUMN vod_assets.archive_tier IS
  'The storage class the title''s media is in because it is archived (infrequent or glacier); NULL: the normal class.';
COMMENT ON COLUMN vod_assets.archive_tier_state IS
  'moved | restoring (Glacier restore requested, the title stays archived until it lands) | returning (being moved back to the normal class) | failed';
