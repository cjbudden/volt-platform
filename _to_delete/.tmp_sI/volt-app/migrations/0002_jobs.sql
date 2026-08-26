-- ===========================================================================
--  0002 — JOBS
--
--  Every long-running operation in the platform (clip extraction, transcode,
--  thumbnails, waveforms, media moves and restores, publishing, analytics
--  imports) becomes a durable row here.
--
--  What this replaces: two setInterval timers inside the API process, whose
--  only concurrency control was an optimistic `UPDATE … WHERE status='scheduled'`
--  status claim. That pattern has three failure modes we have hit or can hit:
--  a crash between claim and completion strands the row in 'firing' with no
--  reaper to recover it; a failure records `status='error'` with no reason at
--  all; and there is no progress, so the UI can only show a spinner.
--
--  Claiming here is `FOR UPDATE SKIP LOCKED` against a lease, so a worker that
--  dies releases its job when the lease expires rather than holding it forever.
-- ===========================================================================

CREATE TYPE job_state AS ENUM (
  'queued',      -- waiting for a worker
  'running',     -- claimed, lease held
  'succeeded',
  'failed',      -- terminal: attempts exhausted, or a permanent error
  'cancelled'    -- an operator stopped it
);

CREATE TABLE IF NOT EXISTS jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type           TEXT NOT NULL,              -- clip.extract | media.restore | publish.push | …
  state          job_state NOT NULL DEFAULT 'queued',
  priority       INTEGER NOT NULL DEFAULT 100,   -- lower runs first
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  result         JSONB,

  progress_pct   INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  progress_note  TEXT,

  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  last_error     TEXT,
  error_code     TEXT,

  -- Threads one item across ingest, clipping, publishing and playback. Set once
  -- at the head of a chain and copied to every job and event that follows.
  correlation_id UUID,
  -- Denormalised owner so the admin UI can list "everything happening on this
  -- channel" without knowing every payload shape.
  channel_id     UUID REFERENCES channels(id) ON DELETE SET NULL,
  event_id       UUID REFERENCES events(id)   ON DELETE SET NULL,

  claimed_by     TEXT,                        -- worker identity, for diagnosis
  claimed_at     TIMESTAMPTZ,
  lease_until    TIMESTAMPTZ,                 -- past this, the reaper takes it back
  run_after      TIMESTAMPTZ NOT NULL DEFAULT now(),   -- backoff / scheduling
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID,

  -- An idempotency key: re-requesting the same work returns the existing job
  -- instead of queueing a duplicate.
  dedupe_key     TEXT
);

-- The claim query's index: ready work, best priority first, oldest first.
CREATE INDEX IF NOT EXISTS idx_jobs_ready
  ON jobs (priority, run_after, created_at)
  WHERE state = 'queued';

-- The reaper's index: running jobs whose lease has lapsed.
CREATE INDEX IF NOT EXISTS idx_jobs_lease
  ON jobs (lease_until)
  WHERE state = 'running';

CREATE INDEX IF NOT EXISTS idx_jobs_channel ON jobs (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_corr    ON jobs (correlation_id);
CREATE INDEX IF NOT EXISTS idx_jobs_type    ON jobs (type, state);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_dedupe
  ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');

-- Attempt history. A job row shows the current state; this shows what happened
-- on each try, which is what you need when something fails intermittently.
CREATE TABLE IF NOT EXISTS job_attempts (
  id           BIGSERIAL PRIMARY KEY,
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  claimed_by   TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  outcome      TEXT,                          -- succeeded | failed | lease_expired | cancelled
  error        TEXT,
  error_code   TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts (job_id, attempt);

-- ---------------------------------------------------------------------------
-- Two missing indexes found in the audit, on predicates every request touches.
-- ---------------------------------------------------------------------------
-- Every tenant-scoped query in the app joins groups and filters on account_id.
CREATE INDEX IF NOT EXISTS idx_groups_account ON groups (account_id);
-- Every liveness check asks for instances with terminated_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_instances_live
  ON instances (channel_id, event_id) WHERE terminated_at IS NULL;
