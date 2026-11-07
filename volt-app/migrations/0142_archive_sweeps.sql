-- ============================================================================
--  MIRROR AND ARCHIVE: NIGHTLY COPIES (build queue H3-8).
--
--  A copy rule's `schedule` moment copies, once a UTC day, everything the
--  rule governs that a target does not hold yet. The walk over an account's
--  assets is done in bounded steps every half hour; this is where each
--  account's walk has got to today (services/archive/sidecars.ts
--  scheduledSweep). Add only: a new table.
-- ============================================================================
CREATE TABLE IF NOT EXISTS archive_sweeps (
  account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  day            date NOT NULL,
  after_created  timestamptz,
  after_id       uuid,
  done           boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
