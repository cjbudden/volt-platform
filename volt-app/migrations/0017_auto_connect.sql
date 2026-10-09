-- ============================================================================
--  AUTO CONNECT: SURVIVING A REBOOT.
--
--  The question a restarted control plane could not answer: SHOULD this be
--  running right now?
--
--  It knew `status`, which is a CACHE of what was observed, and it knew the
--  `instances` row, which is a CLAIM that something was launched. Neither is
--  an intent. So after a reboot the system had exactly two behaviours, both
--  wrong: leave everything off until a person notices, or trust the stale
--  `live` flag and believe things are running that are not.
--
--  Worse, the flag is not even reliably present. run-on-mac.sh sets every live
--  channel to 'ended' BEFORE the API boots so the list reads truthfully, which
--  is sensible and which also destroys the only evidence that anything was
--  supposed to be on air. Anything built on `status` would be defeated by a
--  line in a shell script.
--
--  ------------------------------------------------------------------------
--  DESIRED STATE IS A SEPARATE FACT FROM OBSERVED STATE.
--
--  `desired_state` says what an operator (or the schedule) asked for. It moves
--  ONLY on a deliberate act: starting sets it to 'running', a RECORDED STOP
--  sets it to 'stopped'. Nothing observational touches it — a crash, a reaped
--  instance, a status reconciliation and a failed encoder all leave it exactly
--  where it was, which is the entire point. "It is not running and nobody
--  asked it to stop" is then a first-class, queryable condition, and it is
--  precisely the condition auto-connect fires on.
--
--  WHAT COUNTS AS A RECORDED STOP is a decision the code has to make
--  explicitly, not one to infer from a log string. An operator pressing Stop
--  and the scheduler reaching an event's end are recorded stops. An encoder
--  reporting a fatal fault is NOT: that is the case auto-connect exists for,
--  and treating it as a stop would disable recovery exactly when it is needed.
--  See the `intent` argument on Orchestrator.stopStream.
--
--  ------------------------------------------------------------------------
--  RETRIES ARE BOUNDED AND THE REASON IS KEPT.
--
--  A stream that cannot start does not get retried forever: five attempts,
--  twenty seconds apart, then it stops trying and records why. An unbounded
--  retry against a source that is genuinely gone is a loop that launches a
--  container every twenty seconds for as long as the process lives, and every
--  one of those is billable. The attempt counter lives here rather than in
--  memory so a control plane that crashes mid-recovery does not restart the
--  count and loop forever by accident.
--
--  DEFAULT IS ON, as asked. A platform whose channels do not come back after a
--  reboot is the surprising one.
-- ============================================================================

-- ---------- channels --------------------------------------------------------
ALTER TABLE channels ADD COLUMN IF NOT EXISTS auto_connect BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS desired_state TEXT NOT NULL DEFAULT 'stopped'
  CHECK (desired_state IN ('running', 'stopped'));
-- Who recorded the stop, and when. Kept for the operator's benefit: "why is
-- this off?" is otherwise unanswerable after the fact.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS stop_requested_by TEXT;
-- Recovery bookkeeping. Durable so a crash mid-recovery cannot reset the count.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS resume_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS resume_last_attempt_at TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS resume_last_error TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS resume_gave_up_at TIMESTAMPTZ;

-- ---------- events ----------------------------------------------------------
-- The same four ideas, and deliberately the SAME COLUMN NAMES, so the resume
-- pass is one query per kind rather than two dialects of the same thing.
--
-- Events keep their own scheduling on top of this: the tick still provisions
-- an event when its window opens and still stops it when the window closes.
-- Auto-connect is not a second scheduler and does not decide when an event
-- should run. It answers only the reboot question — this event was started and
-- nobody recorded a stop, so put it back — which the schedule cannot answer
-- because "the window is open" is also true of an event a person deliberately
-- stopped mid-flight.
ALTER TABLE events ADD COLUMN IF NOT EXISTS auto_connect BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE events ADD COLUMN IF NOT EXISTS desired_state TEXT NOT NULL DEFAULT 'stopped'
  CHECK (desired_state IN ('running', 'stopped'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS stop_requested_by TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS resume_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS resume_last_attempt_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS resume_last_error TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS resume_gave_up_at TIMESTAMPTZ;

-- ---------- backfill --------------------------------------------------------
-- Anything currently believed to be live was, by definition, started and not
-- stopped. Backfilling it as 'running' is what makes auto-connect work for the
-- streams that are on air at the moment this migration is applied, rather than
-- only for ones started afterwards.
--
-- Note the ordering hazard this avoids: run-on-mac.sh ends live channels
-- BEFORE the API boots, and the API applies migrations on boot, so by the time
-- this runs those rows already say 'ended'. Nothing can be recovered for them,
-- which is correct and unavoidable — there is no record of intent to recover.
-- From the next start onward there will be.
UPDATE channels SET desired_state = 'running' WHERE status = 'live' AND desired_state = 'stopped';
UPDATE events   SET desired_state = 'running' WHERE status = 'live' AND desired_state = 'stopped';

-- An event that has a server_start and no server_stop was started and never
-- stopped, which is the same statement `desired_state='running'` makes. This
-- catches events whose status was reset by a crash or by a cleanup script.
UPDATE events SET desired_state = 'running'
 WHERE server_start IS NOT NULL AND server_stop IS NULL AND desired_state = 'stopped'
   AND scheduled_end > now() - interval '1 day';

-- The resume pass's work list. Partial, because the interesting rows are a
-- tiny minority of the table and this is read every twenty seconds.
CREATE INDEX IF NOT EXISTS idx_channels_resume
  ON channels (resume_last_attempt_at NULLS FIRST)
  WHERE desired_state = 'running' AND auto_connect AND resume_gave_up_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_resume
  ON events (resume_last_attempt_at NULLS FIRST)
  WHERE desired_state = 'running' AND auto_connect AND resume_gave_up_at IS NULL;
