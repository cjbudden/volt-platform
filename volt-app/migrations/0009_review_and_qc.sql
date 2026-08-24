-- ============================================================================
--  REVIEW AND QC — deciding whether a clip is fit to publish.
--
--  Publishing is already a separate step from clipping. What was missing is
--  everything between: somebody looking at the thing, an automated pass over it,
--  and a record of both. Without that, "published" means "somebody clicked
--  publish", and the first time a clip goes out with thirty seconds of silence
--  on the end there is nothing to look at afterwards.
--
--  Two halves, and they are not the same thing:
--
--    REVIEW  a person's decision, with a name and a note attached. Approval is
--            an act, not a flag, so it is stored as an event and the current
--            state is derived from the latest one.
--
--    QC      what a machine measured. Silence, black frames, a duration that
--            does not match what was asked for, coverage that was not complete.
--            Findings, not verdicts: QC reports what it saw and how confident it
--            is, and a person decides what that means. A check that blocks
--            publication on its own is a check people learn to route around.
--
--  The gate between them is deliberately soft by default. An operator can
--  publish over a QC warning, and doing so is RECORDED — which is what makes the
--  warning worth reading. A hard block is available per account for the places
--  that need it (compliance, rights), and turning it on is a decision someone
--  makes rather than a default nobody chose.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE review_state AS ENUM (
    'draft',              -- being worked on; not offered for review yet
    'in_review',          -- waiting for somebody
    'changes_requested',  -- looked at, needs a re-cut
    'approved',           -- cleared to publish
    'rejected'            -- will not be published
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qc_severity AS ENUM ('info', 'warning', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE vod_assets
  ADD COLUMN IF NOT EXISTS review_state review_state NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz,
  -- Cached from qc_events so a list view can sort and filter without a join.
  -- Rewritten whenever a QC pass finishes.
  ADD COLUMN IF NOT EXISTS qc_state     text,          -- 'pass' | 'warnings' | 'failed' | null
  ADD COLUMN IF NOT EXISTS qc_at        timestamptz;

CREATE INDEX IF NOT EXISTS idx_vod_assets_review ON vod_assets (review_state, created_at DESC);
-- The review queue: what is waiting for somebody, oldest first.
CREATE INDEX IF NOT EXISTS idx_vod_assets_queue
  ON vod_assets (created_at) WHERE review_state = 'in_review';

-- ---------------------------------------------------------------------------
--  A person's decision, kept as an event.
--
--  The current state is a cache of the latest row here. Keeping the history is
--  the point: "who approved this, and what did they say" is the question asked
--  when something goes out that should not have.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vod_asset_id uuid NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Kept as text as well as a foreign key: a user can be deleted, and "approved
  -- by someone who has since left" still needs a name on it.
  actor_label  text NOT NULL,
  from_state   review_state,
  to_state     review_state NOT NULL,
  note         text,
  -- Set when the decision was taken with QC findings outstanding. This is the
  -- row that makes a soft gate meaningful: overriding is allowed, and it leaves
  -- a mark.
  overrode_qc  boolean NOT NULL DEFAULT false,
  qc_state_at_decision text
);

CREATE INDEX IF NOT EXISTS idx_asset_reviews_asset ON asset_reviews (vod_asset_id, at DESC);

-- ---------------------------------------------------------------------------
--  What a machine measured.
--
--  One row per finding, not one per check: a clip with four separate stretches
--  of silence has four findings, each with its own time range, so an operator
--  can jump to each one rather than being told "silence detected".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qc_events (
  id           bigserial PRIMARY KEY,
  vod_asset_id uuid NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  -- Which pass produced it, so a re-run can replace its own findings without
  -- touching another check's.
  check_name   text NOT NULL,        -- 'silence' | 'black' | 'duration' | 'coverage' | 'loudness'
  severity     qc_severity NOT NULL,
  -- Where in the CLIP, not in the source. A reviewer jumps to it in the player.
  from_ms      bigint,
  to_ms        bigint,
  -- The measured value that triggered it, and what was expected, so a finding
  -- can be judged rather than merely believed.
  measured     text,
  expected     text,
  message      text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qc_events_asset ON qc_events (vod_asset_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_qc_events_check ON qc_events (vod_asset_id, check_name);

-- ---------------------------------------------------------------------------
--  The gate, per account.
--
--  Off by default. A check that blocks publication on its own is a check people
--  learn to route around, so turning this on is a decision someone makes for a
--  reason, not a default nobody chose.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS require_review_to_publish boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS block_publish_on_qc_error boolean NOT NULL DEFAULT false;
