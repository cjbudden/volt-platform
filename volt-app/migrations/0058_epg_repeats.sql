-- ============================================================================
--  0058  EPG REPEATS, COPY RULES AND UNDO (services/epgRepeat.ts, epgPlace.ts).
--
--  One repeat engine for both levels an operator thinks in:
--    * a PROGRAMME that repeats (kind 'programme', one item), and
--    * a whole DAY that repeats (kind 'day', one item per programme of the
--      source day).
--  Both are a programme_series with a list of items placed at a local wall-clock
--  time on every date the rule produces, so a day repeat and a programme
--  repeat are the same thing with a different number of items, and they meet
--  each other through the same placement rules as Copy day.
--
--  Instances stay ordinary programmes (the store the guide, XMLTV, the player
--  and auto-VOD already read). They carry series_id + series_key + series_date
--  and the idempotent source_ref 'series:<id>:<date>:<key>', so the rolling
--  top-up can run every tick without duplicating anything.
--
--  exdates: occurrences that were removed on purpose ('YYYY-MM-DD#key'). A
--  deleted or replaced occurrence stays gone; the top-up never puts it back.
--
--  epg_batches: what one copy / repeat / clear did, so it can be undone.
-- ============================================================================
ALTER TABLE programme_series ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'programme';
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS rule JSONB;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS tz TEXT;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS until_date DATE;
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS exdates TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS policy TEXT NOT NULL DEFAULT 'replace';
ALTER TABLE programme_series ADD COLUMN IF NOT EXISTS source_date DATE;
DO $$ BEGIN
  ALTER TABLE programme_series ADD CONSTRAINT chk_series_owner CHECK (channel_id IS NOT NULL OR event_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE programme_series ADD CONSTRAINT chk_series_policy CHECK (policy IN ('replace', 'skip', 'keep'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_series_event ON programme_series(event_id);
CREATE INDEX IF NOT EXISTS idx_series_topup ON programme_series(materialized_until) WHERE rule IS NOT NULL;

ALTER TABLE programmes ADD COLUMN IF NOT EXISTS series_key TEXT;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS series_date DATE;
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS series_detached BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_prog_series ON programmes(series_id, series_date) WHERE series_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS epg_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_kind    TEXT NOT NULL,
  owner_id      UUID NOT NULL,
  action        TEXT NOT NULL,              -- copy | repeat | clear
  label         TEXT NOT NULL,
  created_ids   UUID[] NOT NULL DEFAULT '{}',
  removed       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- full rows, to restore
  exdates_added JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{seriesId, value}]
  series_id     UUID,                       -- a repeat this batch created
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_epg_batches_owner ON epg_batches(owner_id, created_at DESC);
