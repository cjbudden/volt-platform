-- volt:no-transaction
-- ============================================================================
--  0139: find rule collections fast (build queue C1). Partial: only
--  collections with rules, which the vod_assets trigger and the matching
--  passes look for. Built concurrently so writes carry on while it builds.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collections_with_rules ON collections(account_id) WHERE rules IS NOT NULL;
