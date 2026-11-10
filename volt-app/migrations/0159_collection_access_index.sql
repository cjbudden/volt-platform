-- volt:no-transaction
-- ============================================================================
--  0159: find collections with access fast (build queue C2). Partial: only
--  collections that carry access, which the collection_items trigger looks
--  for. Built concurrently so writes carry on while it builds.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collections_with_access ON collections(account_id) WHERE access IS NOT NULL;
