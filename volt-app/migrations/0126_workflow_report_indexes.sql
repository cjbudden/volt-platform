-- volt:no-transaction
-- ===========================================================================
--  0126: INDEXES FOR THE WORKFLOW REPORT (build queue W1).
--
--  The report's rollup (services/workflows/rollup.ts) reads, once a minute,
--  only what finished in the last few minutes: jobs and add-on runs by
--  finished_at, hook events by created_at. Without these each pass would scan
--  the whole of jobs, which grows with every encode, clip and image. Built
--  concurrently so a rolling deploy never blocks writes to these tables.
-- ===========================================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_addon_runs_finished ON addon_runs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wfe_created ON workflow_events (created_at);
