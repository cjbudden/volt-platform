-- volt:no-transaction
-- ============================================================================
--  0155: find the published titles waiting to take up a changed rule (build
--  queue P3-4). Partial: only rows that are marked. Built concurrently so
--  writes carry on while it builds.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vod_assets_policy_stale ON vod_assets(policy_stale_at) WHERE policy_stale_at IS NOT NULL;
