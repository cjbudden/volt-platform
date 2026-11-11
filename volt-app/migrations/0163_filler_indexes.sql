-- volt:no-transaction
-- ============================================================================
--  0163: THE TWO FILLER INDEXES OF 0161, BUILT CONCURRENTLY.
--
--  0161 (slates and loops get a house preview, QC and an approval) built them
--  inside its transaction, which blocks writes to filler_assets while they
--  build, and the release check refuses that (RELEASING.md, "Schema: add
--  only"). 0161 had not shipped, so they moved here. IF NOT EXISTS: a database
--  that ran the earlier 0161 already has them, and this is then a no-op.
-- ============================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_filler_tags ON filler_assets USING gin (tags);

-- The leader sweep looks for ready slates and loops with no house preview yet.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_filler_preview_todo ON filler_assets (created_at)
  WHERE status = 'ready' AND preview_status IS NULL;
