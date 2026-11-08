-- ============================================================================
--  RECORDING REMOVALS: the record that outlives the recording.
--
--  Once retention has removed a recording's media, its row drops out of the
--  Recordings tables (a removed recording is not something to open). What
--  must NOT drop out is the knowledge that it existed, that it expired, which
--  rule or date removed it, whether the removal worked and what was taken.
--  This table holds that, one row per attempt, and survives the recording
--  row itself (no foreign key on purpose).
--
--  Add only: a new table and its indexes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS recording_removals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid,
  recording_id   uuid NOT NULL,
  source_id      uuid,
  source_name    text,
  source_type    text,
  title          text,
  start_epoch_ms bigint,
  end_epoch_ms   bigint,
  duration_ms    bigint,
  expired_at     timestamptz,
  trigger        text NOT NULL,          -- rule | manual | legacy
  rule_name      text,
  reason         text,
  outcome        text NOT NULL,          -- removed | kept_for_clips | failed
  removed        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error          text,
  actor          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recording_removals_account ON recording_removals(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_removals_recording ON recording_removals(recording_id, created_at DESC);
