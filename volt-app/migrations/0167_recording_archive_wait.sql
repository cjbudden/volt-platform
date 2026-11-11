-- ============================================================================
--  0167: RECORDINGS WAIT FOR THEIR ARCHIVE FILE (build queue H3-5c; (3) of
--  H3-5, decided by Christian on 11 Nov 2026).
--
--  A recording's delete rung (a rule, or an expiry set by hand) for a channel
--  or event whose copy rule archives recordings waits until every
--  consolidated archive file covering it is verified: never the only copy.
--  The reason it waits is written on the recording so the console can show
--  it (Storage retention list, the recording page).
--
--  `archived_from` on the stream's cursor: when the copy rule first handed
--  recordings on. Recordings that ended before it were never going to be
--  archived (the pass does not reach back), so they do not wait.
--
--  Add only (RELEASING.md "Schema: add only"): nullable columns.
-- ============================================================================
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS archive_wait_code  text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS archive_wait       text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS archive_checked_at timestamptz;
ALTER TABLE archive_recording_cursors ADD COLUMN IF NOT EXISTS archived_from timestamptz;
