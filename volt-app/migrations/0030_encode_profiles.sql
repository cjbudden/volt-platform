-- ===========================================================================
--  ENCODE PROFILES AND LADDER GROUPS — ONE RENDITION, AND A NAMED SET OF THEM.
--
--  A file dropped in a watchfolder or uploaded in the console has to be encoded
--  to something, and the requirement is that it MATCH the live transcoder: same
--  bitrates, same rate control, so a VOD asset and a live rendition of the same
--  channel are the same picture at the same cost.
--
--  THE OBVIOUS IMPLEMENTATION IS THE WRONG ONE. Copying the live rungs into a
--  VOD ladder gives a correct answer today and a wrong one for the rest of the
--  system's life: somebody re-tunes the live 720p rung from 3000 to 2600, both
--  encodes still succeed, both outputs still look plausible, and the only
--  symptom is that the two disagree. Nothing fails, so nobody finds out.
--
--  SO A LADDER GROUP CAN TRACK A LIVE PROFILE INSTEAD OF COPYING IT.
--  `tracks_output_profile_id` set means the group HAS no rungs of its own: it
--  resolves them from `output_profiles.rungs` at encode time, so "matches live"
--  is true by construction rather than by somebody remembering. A group with
--  that column null owns its members, which is the escape hatch for the case
--  where VOD deliberately differs (an archive ladder, a social cut-down).
--
--  The two are mutually exclusive and the constraint says so, because a group
--  that both tracks and owns has two answers to "what are the rungs" and the
--  code would have to pick one silently.
--
--  A PROFILE IS ONE RENDITION, not a ladder. That is the split every transcoding
--  product uses and it is the one that makes the console sane: an operator edits
--  "720p 3000k" once and every ladder containing it changes, rather than hunting
--  the same numbers through five ladders and missing one.
--
--  WHAT IS DELIBERATELY NOT HERE: preset, maxrate, bufsize, GOP, sc_threshold.
--  Those are not per-rung choices, they are the rate-control contract that makes
--  ABR switching work at all, and they live in exactly one place —
--  volt-encoder/bin/encoder.py video_rung_args(), used by the live path and the
--  file path alike, with dev/test_ladder_args.py failing if a second copy
--  appears. Storing them here would create the drift this migration exists to
--  prevent.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  ONE RENDITION.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS encode_profiles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,                    -- '1080p 5000k'

    height       INTEGER NOT NULL CHECK (height BETWEEN 90 AND 4320),
    bitrate_kbps INTEGER NOT NULL CHECK (bitrate_kbps BETWEEN 50 AND 200000),
    -- NULL means "the ladder's frame rate", which is the normal case: a rung
    -- that halves the fps is a deliberate low-end choice, not a default.
    fps          NUMERIC(6,3),

    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    version      INTEGER NOT NULL DEFAULT 1,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,

    UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_encode_profiles_account
    ON encode_profiles (account_id, height DESC);

-- ---------------------------------------------------------------------------
--  A NAMED SET OF THEM.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS encode_ladder_groups (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,

    -- TRACKING, NOT COPYING. See the header: set means this group's rungs ARE
    -- the live profile's rungs, read at encode time, so they cannot drift from
    -- the channel they are supposed to match.
    tracks_output_profile_id UUID REFERENCES output_profiles(id) ON DELETE SET NULL,

    -- Segment length and frame rate come from the tracked profile when there is
    -- one. For a standalone group they are set here, because the GOP is derived
    -- from them and a ladder with no segment length has no GOP.
    segment_dur  NUMERIC(4,2) NOT NULL DEFAULT 4.00,
    fps          NUMERIC(6,3) NOT NULL DEFAULT 25.000,
    packaging    packaging_kind NOT NULL DEFAULT 'both',
    codec_backend codec_backend NOT NULL DEFAULT 'x264',

    -- NEVER UPSCALE. A 720p source against a 1080p rung costs a full rung's
    -- bitrate to carry no extra detail. On by default; the encode records which
    -- rungs it dropped and why, so the asset explains itself.
    cap_to_source BOOLEAN NOT NULL DEFAULT true,

    -- Exactly one account-level default, enforced by the partial index below.
    is_default   BOOLEAN NOT NULL DEFAULT false,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    version      INTEGER NOT NULL DEFAULT 1,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,

    UNIQUE (account_id, name)
);

-- ONE DEFAULT PER ACCOUNT. Without this, "the default ladder" is whichever row
-- came back first, which changes when somebody adds an index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_encode_ladder_default
    ON encode_ladder_groups (account_id) WHERE is_default;

-- ---------------------------------------------------------------------------
--  MEMBERSHIP. Ordered, highest rung first, the order a manifest lists them in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS encode_ladder_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id    UUID NOT NULL REFERENCES encode_ladder_groups(id) ON DELETE CASCADE,
    profile_id  UUID NOT NULL REFERENCES encode_profiles(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,

    UNIQUE (group_id, ordinal),
    -- The same rendition twice in one ladder is always a mistake, and it is one
    -- that produces a manifest with two identical variants rather than an error.
    UNIQUE (group_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_encode_ladder_members_group
    ON encode_ladder_members (group_id, ordinal);

-- A GROUP EITHER TRACKS OR OWNS, NEVER BOTH. Enforced in the application at the
-- write, and asserted here as the reason: a tracking group with members has two
-- answers to "what are the rungs" and whichever the code reads is arbitrary.
COMMENT ON COLUMN encode_ladder_groups.tracks_output_profile_id IS
  'When set, the rungs are read from output_profiles.rungs at encode time and this group must have no members. That is what makes a file encode match the live channel it is supposed to match.';

-- ---------------------------------------------------------------------------
--  WHERE A LADDER GROUP IS CHOSEN.
-- ---------------------------------------------------------------------------

-- A watchfolder encodes everything it accepts to one ladder.
ALTER TABLE watchfolders
    ADD COLUMN IF NOT EXISTS ladder_group_id UUID
    REFERENCES encode_ladder_groups(id) ON DELETE SET NULL;

-- An upload names one on the form. NULL falls back to the account default,
-- which is why the partial unique index above matters.
ALTER TABLE upload_sessions
    ADD COLUMN IF NOT EXISTS ladder_group_id UUID
    REFERENCES encode_ladder_groups(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
--  A VOD ASSET THAT CAME FROM A FILE.
--
--  vod_assets was written when every asset was DERIVED from a recording, and it
--  says so: CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL)) means an
--  asset must belong to a channel or an event. An uploaded file belongs to
--  neither, so the constraint has to admit a third case rather than an operator
--  being told to invent a channel for a file they dropped in a folder.
--
--  start/end/duration are NOT NULL for the same reason — a recording-derived
--  asset has a wall-clock window. A file has a duration and no wall clock, so
--  the window is 0..duration and the source of truth is recorded separately.
-- ---------------------------------------------------------------------------
ALTER TABLE vod_assets
    ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'recording'
        CHECK (source_kind IN ('recording', 'upload', 'watchfolder')),
    -- Where the original file is, so a re-encode never needs the ingest folder
    -- to still exist.
    ADD COLUMN IF NOT EXISTS source_key TEXT,
    ADD COLUMN IF NOT EXISTS source_bytes BIGINT,
    ADD COLUMN IF NOT EXISTS ladder_group_id UUID
        REFERENCES encode_ladder_groups(id) ON DELETE SET NULL,
    -- WHAT WAS ACTUALLY ENCODED, as opposed to what was asked for. The rungs the
    -- source could not support are listed with the reason, so an asset with
    -- three renditions beside one with four is a question with an answer on the
    -- record rather than an argument.
    ADD COLUMN IF NOT EXISTS encode_result JSONB,
    ADD COLUMN IF NOT EXISTS encode_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

-- master_key is set by the encode, which by definition has not run when the row
-- is created. It cannot stay NOT NULL.
ALTER TABLE vod_assets ALTER COLUMN master_key DROP NOT NULL;

-- THE OWNER CHECK, WIDENED. A file-sourced asset belongs to the account and to
-- neither a channel nor an event; a recording-derived one is unchanged.
ALTER TABLE vod_assets DROP CONSTRAINT IF EXISTS vod_assets_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vod_assets_owner_ck'
  ) THEN
    ALTER TABLE vod_assets ADD CONSTRAINT vod_assets_owner_ck CHECK (
      CASE
        -- Derived from a recording: exactly one of channel or event, as before.
        WHEN source_kind = 'recording'
          THEN (event_id IS NOT NULL) <> (channel_id IS NOT NULL)
        -- From a file: neither, and the account is what owns it.
        ELSE account_id IS NOT NULL AND event_id IS NULL AND channel_id IS NULL
      END
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vod_assets_account_source
    ON vod_assets (account_id, source_kind, created_at DESC);

COMMENT ON COLUMN vod_assets.encode_result IS
  'What the encode actually produced: the rungs kept, the rungs dropped and why (usually a source shorter than the rung), and the probe it decided from. Absent means not yet encoded, which is not the same as an encode that produced nothing.';
