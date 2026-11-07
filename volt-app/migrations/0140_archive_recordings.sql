-- ============================================================================
--  0140: MIRROR AND ARCHIVE, recordings (build queue H3-7, HYBRID_SITES.md
--  "Format for recordings").
--
--  A recording is archived as consolidated files: the top rendition joined
--  without re-encoding, one file per programme when the channel has a guide
--  and one per hour without, each with a metadata sidecar. Such a copy is of
--  a stretch of a channel or event, not of a Media Library asset, so it names
--  the stream and the stretch instead of `vod_asset_id`.
--
--  The cursor remembers, per stream, up to when its recording has been cut
--  into files, so a pass never makes the same file twice and a rule switched
--  on today does not reach back over months of recording.
--
--  Add only (RELEASING.md "Schema: add only"): nullable columns and a new
--  table. The unique index for the new copies is in 0141, built concurrently.
-- ============================================================================
-- The channel or event recorded (either: no foreign key, as for jobs).
ALTER TABLE archive_copies ADD COLUMN IF NOT EXISTS stream_id uuid;
ALTER TABLE archive_copies ADD COLUMN IF NOT EXISTS range_start timestamptz;
ALTER TABLE archive_copies ADD COLUMN IF NOT EXISTS range_end timestamptz;
-- The programme title, when the file is one programme.
ALTER TABLE archive_copies ADD COLUMN IF NOT EXISTS title text;

CREATE TABLE IF NOT EXISTS archive_recording_cursors (
  stream_id   uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Every piece of recording that closed before this has been handed on.
  done_until  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
