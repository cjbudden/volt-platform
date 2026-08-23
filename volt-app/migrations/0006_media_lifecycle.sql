-- ============================================================================
--  MEDIA LIFECYCLE — what a piece of media IS, separately from where it lives.
--
--  Retention today is one line: DELETE FROM recordings WHERE expires_at < now(),
--  with a TODO where the storage cleanup should be. That is not a lifecycle, it
--  is a guillotine, and it gets three things wrong that matter as soon as an
--  archive is real:
--
--    * it conflates the RECORD with the BYTES. Deleting the row loses the
--      knowledge that the media existed, what it was, and what came out of it.
--    * it has one action. Real retention is a ladder: keep it hot for a week,
--      move it to cheap storage for a month, archive it for a year, then delete.
--    * it assumes the bytes are in exactly one place, always readable. Once
--      anything is archived that is false: a copy may be in a tier that needs a
--      restore and hours of waiting before a single byte can be read.
--
--  So the model separates two questions that were tangled together:
--
--    media_objects    WHAT the media is, and CAN IT BE READ RIGHT NOW.
--                     One row per logical thing: a run's rendition, a clip's
--                     MP4. It has an identity, a size, a duration and a state.
--                     It does NOT say where the bytes are.
--
--    media_locations  WHERE a copy of those bytes is, and what reading it costs.
--                     One row per copy. An object can have several at once —
--                     local disk AND S3 — which is exactly why "archived" cannot
--                     be a property of the object alone.
--
--  The state machine answers readability; the tier answers cost and latency. An
--  object on Glacier Instant Retrieval is still `available`, because it can be
--  read now; an object on Deep Archive is `archived`, because it cannot.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  States. Nine, and each one earns its place by being a state something can be
--  STUCK in, or a state that changes what the API is allowed to answer.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE media_state AS ENUM (
    'pending',    -- declared, nothing written yet
    'writing',    -- being written right now (a live run's segments)
    'available',  -- readable, on a tier that serves immediately
    'archiving',  -- a move to an archive tier is in flight
    'archived',   -- NOT readable without a restore first
    'restoring',  -- a restore has been asked for and has not landed
    'restored',   -- temporarily readable; lapses back to archived
    'deleting',   -- deletion in flight
    'deleted'     -- bytes gone; the row is a tombstone and stays
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
--  Tiers. Ordered cheapest-to-read first, because the ordering IS the meaning:
--  everything up to s3_glacier_ir serves a byte range immediately; everything
--  after it needs a restore and a wait.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE storage_tier AS ENUM (
    'local',                -- this box's disk
    's3_standard',
    's3_ia',                -- infrequent access: immediate, cheaper to store
    's3_glacier_ir',        -- Glacier Instant Retrieval: still immediate
    's3_glacier_flexible',  -- minutes to hours after a restore request
    's3_deep_archive'       -- hours; the cheapest and the slowest
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The rungs of a retention ladder. `keep` is a real action, not the absence of
-- one: it lets a rule say "this stage is terminal, stop here" explicitly rather
-- than by omission.
DO $$ BEGIN
  CREATE TYPE retention_action AS ENUM ('keep', 'to_cold', 'to_archive', 'delete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
--  The logical media.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What this media belongs to. Exactly one of these is set, and the row
  -- survives the owner: ON DELETE SET NULL, because bytes can outlive their
  -- bookkeeping and orphaned bytes are precisely what a sweep needs to find.
  recording_id  uuid REFERENCES recordings(id)  ON DELETE SET NULL,
  vod_asset_id  uuid REFERENCES vod_assets(id)  ON DELETE SET NULL,
  channel_id    uuid REFERENCES channels(id)    ON DELETE SET NULL,
  event_id      uuid REFERENCES events(id)      ON DELETE SET NULL,

  -- A stable, human-readable name for the thing, independent of where it lives:
  -- 'run/20260821T031741Z/audio', 'clip/mp4'. This is what survives when every
  -- location is gone and the row is a tombstone.
  logical_key   text NOT NULL,
  kind          text NOT NULL,          -- 'run_rendition' | 'clip_output' | 'export'
  rendition     text,                   -- 'audio', '720p', 'mp4', 'hls'

  state         media_state NOT NULL DEFAULT 'pending',
  bytes         bigint,
  duration_ms   bigint,
  segment_count int,

  -- Content addressing, when we have it. Nullable because a live run's hash is
  -- not known until it closes, and a tier move must be verifiable without one.
  checksum      text,

  -- Retention bookkeeping. `retain_until` is the earliest the NEXT rung may
  -- fire; `hold` is an override that outranks every rule, for a legal hold or an
  -- investigation, and is deliberately a separate column rather than a rule so
  -- that editing rules cannot lift it by accident.
  retain_until  timestamptz,
  hold          boolean NOT NULL DEFAULT false,
  hold_reason   text,

  -- The restore latency model. Only meaningful while archived or restoring.
  restore_requested_at timestamptz,
  restore_expected_by  timestamptz,   -- what the tier promises, not a guarantee
  restore_expires_at   timestamptz,   -- when a restored copy lapses back
  restore_tier         text,          -- 'expedited' | 'standard' | 'bulk'

  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT media_objects_one_owner CHECK (
    (recording_id IS NOT NULL)::int + (vod_asset_id IS NOT NULL)::int <= 1
  )
);

-- One logical object per owner and key. The partial uniques are split because
-- an object may be owned by a recording, an asset, or neither once its owner has
-- been deleted, and a single unique over nullable columns would not hold.
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_objects_recording
  ON media_objects (recording_id, logical_key) WHERE recording_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_objects_asset
  ON media_objects (vod_asset_id, logical_key) WHERE vod_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_objects_state    ON media_objects (state);
CREATE INDEX IF NOT EXISTS idx_media_objects_channel  ON media_objects (channel_id);
-- The sweep's query: things whose next rung is due and that are not on hold.
CREATE INDEX IF NOT EXISTS idx_media_objects_due
  ON media_objects (retain_until)
  WHERE hold = false AND state NOT IN ('deleted', 'deleting');
-- Restores that have not landed: polled while they are outstanding, and empty
-- the rest of the time.
CREATE INDEX IF NOT EXISTS idx_media_objects_restoring
  ON media_objects (restore_expected_by) WHERE state = 'restoring';

-- ---------------------------------------------------------------------------
--  Where the bytes are.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id   uuid NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  tier        storage_tier NOT NULL,

  -- How to find it in that tier: an absolute path for local, a bucket/key for
  -- S3. Kept as plain text rather than parsed, because the only thing that reads
  -- it is the driver for that tier.
  uri         text NOT NULL,
  bytes       bigint,

  -- A copy can be present, being written, or being removed. Separate from the
  -- OBJECT's state: the object is `available` while a copy is still being
  -- written to a second tier.
  present     boolean NOT NULL DEFAULT true,
  verified_at timestamptz,          -- last time the bytes were confirmed there
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,

  CONSTRAINT uq_media_locations UNIQUE (object_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_media_locations_object  ON media_locations (object_id) WHERE present;
CREATE INDEX IF NOT EXISTS idx_media_locations_tier    ON media_locations (tier) WHERE present;

-- ---------------------------------------------------------------------------
--  The ladder.
--
--  A rule is an ordered set of stages: after N days, do X. Attached to a channel,
--  an event, or an account as the default. Stored as rows rather than as JSON so
--  the sweep can ask "which stage is due for this object" in SQL, and so a bad
--  ladder is rejected at write time rather than discovered at sweep time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  channel_id  uuid REFERENCES channels(id) ON DELETE CASCADE,
  event_id    uuid REFERENCES events(id)   ON DELETE CASCADE,
  name        text NOT NULL,
  -- Applies to recordings, to derived assets, or to both. A clip usually
  -- outlives the recording it came from, and one rule for both is how a clip
  -- gets deleted with its source.
  applies_to  text NOT NULL DEFAULT 'recording'
              CHECK (applies_to IN ('recording', 'asset', 'both')),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT retention_rules_one_scope CHECK (
    (account_id IS NOT NULL)::int + (channel_id IS NOT NULL)::int + (event_id IS NOT NULL)::int = 1
  )
);

CREATE TABLE IF NOT EXISTS retention_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id     uuid NOT NULL REFERENCES retention_rules(id) ON DELETE CASCADE,
  -- Age since the media was closed, in days. Stages fire in ascending age.
  after_days  int NOT NULL CHECK (after_days >= 0),
  action      retention_action NOT NULL,
  -- Which tier `to_cold` / `to_archive` mean for this rule. Null takes the
  -- deployment's configured default, so a rule written once stays right when the
  -- deployment's tiers change.
  target_tier storage_tier,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_retention_stage UNIQUE (rule_id, after_days)
);

CREATE INDEX IF NOT EXISTS idx_retention_stages_rule ON retention_stages (rule_id, after_days);
CREATE INDEX IF NOT EXISTS idx_retention_rules_channel ON retention_rules (channel_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_retention_rules_account ON retention_rules (account_id) WHERE enabled;

-- ---------------------------------------------------------------------------
--  What actually happened to it.
--
--  Every transition, with what asked for it. A lifecycle you cannot audit is a
--  lifecycle you cannot trust: when a recording is missing, the first question is
--  always whether a rule deleted it, someone deleted it, or it was never there.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_events (
  id          bigserial PRIMARY KEY,
  object_id   uuid REFERENCES media_objects(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  from_state  media_state,
  to_state    media_state,
  action      text NOT NULL,     -- 'register' | 'to_cold' | 'to_archive' | 'restore' | 'delete' | 'verify' | 'hold'
  tier        storage_tier,
  -- Who or what caused it: 'retention:<rule id>', 'user:<user id>', 'system'.
  actor       text NOT NULL DEFAULT 'system',
  detail      text
);

CREATE INDEX IF NOT EXISTS idx_media_events_object ON media_events (object_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_media_events_at     ON media_events (at DESC);

-- Recordings keep their own expires_at for now: the sweep reads the ladder, and
-- this column becomes a cache of "when does the NEXT rung fire", which is what
-- the existing UI already shows.
ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS next_action     retention_action,
  ADD COLUMN IF NOT EXISTS next_action_at  timestamptz,
  ADD COLUMN IF NOT EXISTS storage_state   media_state;
