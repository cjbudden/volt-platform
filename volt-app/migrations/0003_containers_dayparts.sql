-- ===========================================================================
--  0003 — RECORDING CONTAINERS, RECORDING TYPES, DAYPARTS
--
--  Containers group recordings by BROADCAST day, which is not a calendar day:
--  it runs from an anchor hour in the channel's local time (06:00 by decision)
--  to the same hour the next day, and post-midnight content belongs to the
--  previous day.
--
--  Everything here is ADDITIVE. `recordings.day_utc` and its unique index stay
--  exactly as they are during the transition, so no existing row moves and the
--  old roll logic keeps working until the per-channel flag switches it over.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Recording type: derived from the source at creation, stored separately,
-- changeable afterwards. Distinct from recordings.kind, which records how the
-- capture is SLICED and is storage truth.
-- ---------------------------------------------------------------------------
CREATE TYPE recording_type AS ENUM (
  'tv_channel',     -- continuous video channel
  'radio_station',  -- continuous audio with programme / now-playing metadata
  'audio_stream',   -- continuous audio with no programme metadata
  'event',          -- a bounded live event
  'simulcast',      -- a channel carrying another channel's output
  'ad_hoc'          -- an operator-initiated capture outside any schedule
);

CREATE TYPE container_state AS ENUM ('open', 'closed');

-- ---------------------------------------------------------------------------
-- Where the timezone and anchor live.
--
-- They are stored ON THE CONTAINER, not read from the channel at query time, so
-- that editing a channel's timezone or anchor cannot retroactively rewrite which
-- broadcast day historical recordings belong to. The answer is frozen at capture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recording_containers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     UUID REFERENCES channels(id) ON DELETE CASCADE,
  event_id       UUID REFERENCES events(id)   ON DELETE CASCADE,
  recording_type recording_type NOT NULL,
  broadcast_day  DATE NOT NULL,               -- the day the CONTENT belongs to
  tz             TEXT NOT NULL,               -- frozen, e.g. Europe/London
  anchor_hour    SMALLINT NOT NULL DEFAULT 6, -- frozen, local hour the day opens
  starts_at_ms   BIGINT NOT NULL,             -- resolved instants, also frozen
  ends_at_ms     BIGINT NOT NULL,
  state          container_state NOT NULL DEFAULT 'open',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL)),
  CHECK (ends_at_ms > starts_at_ms),
  CHECK (anchor_hour BETWEEN 0 AND 23)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_container_channel_day
  ON recording_containers (channel_id, broadcast_day) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_container_event_day
  ON recording_containers (event_id, broadcast_day) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_container_range
  ON recording_containers (channel_id, starts_at_ms, ends_at_ms);

-- ---------------------------------------------------------------------------
-- Recordings gain their type and their container.
-- ---------------------------------------------------------------------------
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS recording_type recording_type;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS container_id UUID
  REFERENCES recording_containers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_rec_container ON recordings (container_id);

-- Backfill the type from what the source actually is. A radio station is a
-- channel with a radio_config, which is exactly why its captures are stored as
-- kind='channel_day' and why every station used to display as "CHANNEL DAY".
UPDATE recordings r SET recording_type = CASE
    WHEN r.event_id IS NOT NULL THEN 'event'::recording_type
    WHEN EXISTS (SELECT 1 FROM channels c
                  WHERE c.id = r.channel_id AND c.radio_config IS NOT NULL)
      THEN 'radio_station'::recording_type
    ELSE 'tv_channel'::recording_type
  END
 WHERE r.recording_type IS NULL;

-- ---------------------------------------------------------------------------
-- Per-channel broadcast-day configuration.
-- ---------------------------------------------------------------------------
ALTER TABLE channels ADD COLUMN IF NOT EXISTS tz TEXT NOT NULL DEFAULT 'Europe/London';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS broadcast_anchor_hour SMALLINT NOT NULL DEFAULT 6;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS daypart_preset TEXT;

-- ---------------------------------------------------------------------------
-- DAYPARTS — anchor points, nothing else.
--
-- No end time by design: each anchor runs to the next, so a set cannot have a
-- gap or an overlap because neither is representable. They cut no media and
-- create no jobs; they exist to jump the timeline, pre-fill a clip range in one
-- click, and group counts in reports.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dayparts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ordinal      SMALLINT NOT NULL,
  name         TEXT NOT NULL,
  starts_local TIME NOT NULL,               -- local wall clock, e.g. 06:00
  days_mask    SMALLINT NOT NULL DEFAULT 127, -- bit 0 = Monday .. bit 6 = Sunday
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, starts_local, days_mask)
);
CREATE INDEX IF NOT EXISTS idx_dayparts_channel ON dayparts (channel_id, ordinal);
