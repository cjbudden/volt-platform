-- ============================================================================
--  0132: JOB POOLS (build queue H3, HYBRID_SITES.md "Job queue").
--
--  Every job runs in a pool. NULL is the cloud: the in-process workers claim
--  only those, so no existing row needs a backfill and nothing about cloud
--  work changes. `site:<site id>` is a Hybrid Site's pool: only an approved
--  host of that site may lease it, over HTTPS (/api/site-agent/jobs), and
--  never with database access.
--
--  Add only. During a rolling deploy an old task's claim does not filter on
--  the pool, but it only claims the job types it has handlers for, and site
--  jobs are types no cloud worker registers, so an old task never takes one.
-- ============================================================================
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pool TEXT;

COMMENT ON COLUMN jobs.pool IS
  'Who may run the job: NULL is the cloud (in-process workers), site:<site id> a Hybrid Site whose approved hosts lease it over HTTPS (build queue H3).';
