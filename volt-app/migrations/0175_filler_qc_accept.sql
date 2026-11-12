-- ============================================================================
--  0175: A PERSON ACCEPTS QC FINDINGS ON A SLATE OR LOOP, ONE BY ONE
--  (Christian, 12 Nov 2026; services/media/fillerPreview.ts).
--
--  QC's findings on a house preview are findings, not verdicts: a person
--  looks at each one (with the frames at that moment) and accepts it, with a
--  note if they like. Kept apart from qc_findings, keyed by the finding's
--  check and place, so running QC again keeps the acceptances of findings
--  that are still there. A slate or loop whose errors are all accepted can be
--  approved without a separate note.
--
--    qc_accepted   { "<check>:<fromMs>": { "by": label, "at": iso, "note": text } }
--
--  And the names on reviews and archives written so far: they were stored as
--  the user's id, which the page showed as is. Now the display name or email.
--
--  Add only: a column with a default (and the label fix, data only).
-- ============================================================================
ALTER TABLE filler_assets ADD COLUMN IF NOT EXISTS qc_accepted JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE filler_assets f SET reviewed_by_label = COALESCE(NULLIF(u.display_name, ''), u.email::text)
  FROM users u WHERE f.reviewed_by_label = u.id::text;
UPDATE filler_assets f SET archived_by_label = COALESCE(NULLIF(u.display_name, ''), u.email::text)
  FROM users u WHERE f.archived_by_label = u.id::text;
