-- volt:no-transaction
-- ============================================================================
--  0134: which assets use a rights profile (build queue R1). Built
--  concurrently so writes to vod_assets carry on while it builds.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS vod_assets_rights_profile_idx ON vod_assets(rights_profile_id);
