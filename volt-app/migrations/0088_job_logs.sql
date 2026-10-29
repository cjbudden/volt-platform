-- ============================================================================
--  0088 JOB LOGS (the Encoding queue, docs/ENCODING_QUEUE.md).
--
--  What a job's process printed, kept with the job so the console can show it
--  while the job runs and after it finished, whichever server ran it. Written
--  in batches by services/jobs/jobLog.ts and capped per job (the cap is noted
--  in the log itself), so a chatty encoder cannot fill the database. Goes with
--  its job: jobs are pruned, and their logs with them.
--
--  attempt   which run of the job wrote the line (a retry starts a new run)
--  stream    'out' | 'err' (the process's own streams), 'step' (a stage the
--            handler announces: "encoding 1080p 720p", "sprite sheets: 4"),
--            'warn' (a step that failed without failing the job)
-- ============================================================================
CREATE TABLE IF NOT EXISTS job_logs (
  job_id   UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  attempt  INTEGER NOT NULL DEFAULT 1,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  stream   TEXT NOT NULL DEFAULT 'out' CHECK (stream IN ('out', 'err', 'step', 'warn')),
  line     TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
