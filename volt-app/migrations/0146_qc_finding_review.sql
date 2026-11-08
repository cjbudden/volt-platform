-- ============================================================================
--  QC FINDING REVIEW: a person's verdict on each thing QC found.
--
--  QC reports findings, a person decides what they mean. Until now the only
--  decision available was approving the whole asset over a failed QC. Each
--  finding can now be reviewed on its own, after jumping to it in the player:
--
--    accepted    looked at it, it is fine (deliberate black, a quiet ending)
--    confirmed   looked at it, it is a real problem
--
--  vod_assets.qc_state stays the state every gate reads (publishing,
--  readiness, the review queue), and now discounts accepted findings: an
--  asset whose every error has been accepted no longer reads as failed.
--  qc_machine_state keeps what the checks themselves said, so the override
--  is always visible.
--
--  Verdicts carry over a re-run when the same finding comes back (same check,
--  severity and measurement, at the same place within a second).
--
--  Add only: new nullable columns.
-- ============================================================================
ALTER TABLE qc_events
  ADD COLUMN IF NOT EXISTS review_state text CHECK (review_state IN ('accepted', 'confirmed')),
  ADD COLUMN IF NOT EXISTS review_note  text,
  ADD COLUMN IF NOT EXISTS reviewed_by  text,
  ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz;

ALTER TABLE vod_assets
  ADD COLUMN IF NOT EXISTS qc_machine_state text;   -- 'pass' | 'warnings' | 'failed', before any verdict

UPDATE vod_assets SET qc_machine_state = qc_state WHERE qc_machine_state IS NULL AND qc_state IS NOT NULL;
