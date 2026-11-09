-- volt:no-transaction
-- ============================================================================
--  0149: find the assets whose public status is due to change (build queue
--  P1). Partial: only rows with a next moment. Built concurrently so writes
--  carry on while it builds.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vod_assets_status_until ON vod_assets(status_until) WHERE status_until IS NOT NULL;
