-- ============================================================================
--  0161: SLATES AND LOOPS GET A HOUSE PREVIEW, QC AND AN APPROVAL.
--
--  Christian, 11 Nov: the hover animation made from sprite sheets is too low in
--  quality to judge a loop by, and a loop is never played as uploaded anyway:
--  it is re-encoded to the stream's ladder and cut to whole segments
--  (filler_build.py), so a 13.4 s file plays as 12 s and jumps where it
--  restarts. Before anything goes on air a person should see it as viewers
--  will, read what a machine found, and approve it.
--
--    preview_*   the house preview: the file built in the account's house
--                format by the same encoder and packager the streams use
--                (services/media/fillerPreview.ts), kept under
--                ORIGIN_DIR/filler-preview/<id>/.
--                preview_status null (not made yet) | queued | building | ready | failed.
--    qc_*        what QC found in that preview: pass | warnings | failed, the
--                findings, and the checks that could not run.
--    review_*    pending | approved | rejected, who, when and why. Only an
--                approved slate or loop can be newly given to a channel, event
--                or FAST channel.
--    availability  available | archived (Christian, 11 Nov: basic access
--                control). Archived is kept but out of use: off the pickers,
--                and not given to anything new. Streams already using it keep
--                it until someone changes them.
--    tags        free tags a person gives a slate or loop ("christmas",
--                "sport", "brand A"): a simple grouping to filter the list by,
--                without the weight of a collection (Christian, 11 Nov).
--
--  Existing slates and loops are approved by this migration: they are already
--  in use or were chosen before approval existed, and nothing on air should
--  change because of a release. The default then becomes pending, so every
--  slate or loop added from now on waits for a person. A release still running
--  beside this one inserts rows that take the new default, which is the
--  safe direction.
--
--  Add only: nullable columns, one column with a default, a check (the
--  indexes are 0163).
-- ============================================================================
ALTER TABLE filler_assets
  ADD COLUMN IF NOT EXISTS preview_status    TEXT,
  ADD COLUMN IF NOT EXISTS preview_error     TEXT,
  ADD COLUMN IF NOT EXISTS preview           JSONB,
  ADD COLUMN IF NOT EXISTS preview_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qc_state          TEXT,
  ADD COLUMN IF NOT EXISTS qc_findings       JSONB,
  ADD COLUMN IF NOT EXISTS qc_skipped        JSONB,
  ADD COLUMN IF NOT EXISTS qc_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_state      TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS reviewed_by       UUID,
  ADD COLUMN IF NOT EXISTS reviewed_by_label TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_note       TEXT,
  ADD COLUMN IF NOT EXISTS availability      TEXT NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS archived_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_label TEXT,
  ADD COLUMN IF NOT EXISTS tags              TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE filler_assets ALTER COLUMN review_state SET DEFAULT 'pending';

DO $$ BEGIN
  ALTER TABLE filler_assets ADD CONSTRAINT filler_assets_review_state_chk
    CHECK (review_state IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE filler_assets ADD CONSTRAINT filler_assets_availability_chk
    CHECK (availability IN ('available', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two indexes (tags, and the house preview sweep) are built concurrently
-- in 0163, so building them never blocks writes to filler_assets.

-- Loop sprite sheets claimed one frame more than they held, so the list's hover
-- preview flashed black where it wrapped (services/media/fillerThumbs.ts, fixed
-- in this release). Make loop thumbnails again: the leader sweep picks up rows
-- with no thumb_status. A frame a person chose as the thumbnail is kept.
UPDATE filler_assets SET thumb_status = NULL WHERE kind = 'loop' AND sprite IS NOT NULL;
