-- ===========================================================================
--  AUTO CONNECT IS ARMED BY A HEALTHY RUN, NOT BY PRESSING START.
--
--  Until now `desired_state = 'running'` was written the moment Start was
--  pressed, and the resume pass treated that as licence to relaunch. So a
--  channel whose very first start failed (a wrong source URL, a relay that
--  was never running) was relaunched five times, twenty seconds apart, before
--  anybody had a chance to read why. Each relaunch overwrote the log with a
--  fresh identical failure, and the reason the operator needed was buried
--  under four copies of itself.
--
--  Auto connect exists for a stream that WAS working and stopped. So the pass
--  now needs proof that it worked: `resume_armed_at` is stamped by the health
--  pass the first time a run shows SERVER, INPUT, ENCODER and OUTPUT all
--  healthy at once. Until then a fault is a failed start, it is left exactly
--  where it fell, and the QC report says what it thinks went wrong.
--
--  Cleared by a person's Start (the new run has to prove itself) and by a
--  person's Stop (nothing should be running). NOT cleared by a fault: a fault
--  after a healthy run is precisely what the stamp is for.
-- ===========================================================================
ALTER TABLE channels ADD COLUMN IF NOT EXISTS resume_armed_at TIMESTAMPTZ;
ALTER TABLE events   ADD COLUMN IF NOT EXISTS resume_armed_at TIMESTAMPTZ;

-- Streams that are on air at upgrade time have evidently proved themselves:
-- arm them, or the first restart after this migration would leave them off.
UPDATE channels SET resume_armed_at = now()
 WHERE desired_state = 'running' AND status = 'live' AND resume_armed_at IS NULL;
UPDATE events SET resume_armed_at = now()
 WHERE desired_state = 'running' AND status = 'live' AND resume_armed_at IS NULL;
