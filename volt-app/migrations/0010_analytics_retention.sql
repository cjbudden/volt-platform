-- ============================================================================
--  ANALYTICS RETENTION — keep the reports, age out the raw.
--
--  The requirement, in the owner's words: reports have to keep working, for as
--  long as anyone wants to look at them. What can age out is the RAW event data
--  the reports were computed from.
--
--  That is only safe if one ordering is guaranteed: a day's summary is SEALED
--  before that day's raw data is deleted. Prune first and summarise later and
--  the number is gone; there is no recovering it, and the report quietly becomes
--  wrong rather than absent, which is worse.
--
--  So a rollup row now knows whether it is final:
--
--    open       the day is still accumulating, or is inside the raw window, so
--               the rollup is RECOMPUTED from raw sessions and is authoritative
--               only as of its last recompute.
--    sealed     the summary has been computed from complete raw data and will
--               never be recomputed. The raw data behind it may now be deleted.
--
--  And the raw window is per account, because a broadcaster with a compliance
--  obligation and one without do not want the same answer.
--
--  UNIQUE VIEWS WERE NOT UNIQUE. The incremental rollup added one to
--  total_views and one to unique_views for every session, so the two columns
--  were always equal and the second was decoration. Uniqueness cannot be counted
--  incrementally from a stream of sessions — it needs the set. It is now
--  computed for real when a day is recomputed, as the count of distinct viewers
--  in the day, and frozen when the day is sealed.
-- ============================================================================

ALTER TABLE analytics_rollups
  ADD COLUMN IF NOT EXISTS sealed      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sealed_at   timestamptz,
  -- What the seal was computed from, so a number can be judged rather than
  -- merely believed: a day sealed from four sessions is a different claim from
  -- a day sealed from forty thousand.
  ADD COLUMN IF NOT EXISTS sessions_counted bigint,
  ADD COLUMN IF NOT EXISTS recomputed_at timestamptz;

-- The finaliser's query: days that are still open, oldest first.
CREATE INDEX IF NOT EXISTS idx_analytics_rollups_open
  ON analytics_rollups (bucket_date)
  WHERE sealed = false;

-- ---------------------------------------------------------------------------
--  How long raw event data is kept, per account.
--
--  Zero would mean "delete immediately", which cannot be right, so the column is
--  constrained: an account either keeps raw data for at least a day, or keeps it
--  forever (NULL). There is no configuration that silently loses today's data.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS analytics_raw_retention_days int DEFAULT 90
    CONSTRAINT analytics_raw_retention_sane CHECK (
      analytics_raw_retention_days IS NULL OR analytics_raw_retention_days >= 1
    );

-- Pruning walks sessions by account and end time; without this it is a scan of
-- every session ever recorded, on a table that only grows.
CREATE INDEX IF NOT EXISTS idx_play_sessions_prune
  ON play_sessions (account_id, started_at)
  WHERE ended_at IS NOT NULL;

-- ---------------------------------------------------------------------------
--  What a publication actually published.
--
--  A publication row said which platform and which asset. It did not say WHICH
--  VERSION of that asset, nor what state it was in when it went out. Both matter
--  the moment a clip is re-cut: "the thing on YouTube was approved" has to stay
--  true about the thing that was actually uploaded, not about whatever the asset
--  became afterwards.
-- ---------------------------------------------------------------------------
ALTER TABLE publications
  ADD COLUMN IF NOT EXISTS published_build_at   timestamptz,   -- vod_assets.built_at at the time
  ADD COLUMN IF NOT EXISTS published_review_state text,
  ADD COLUMN IF NOT EXISTS published_qc_state     text,
  ADD COLUMN IF NOT EXISTS published_by           text,
  ADD COLUMN IF NOT EXISTS published_duration_ms  bigint,
  -- True once the asset has been rebuilt since this publication went out, so the
  -- external copy no longer matches what is here.
  ADD COLUMN IF NOT EXISTS stale                  boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_publications_asset ON publications (vod_asset_id);
CREATE INDEX IF NOT EXISTS idx_publications_stale ON publications (stale) WHERE stale;
