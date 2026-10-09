-- ============================================================================
--  RETENTION SWEEP FAIRNESS
--
--  The sweep takes a window of candidates ordered by `updated_at` with a row
--  limit. That ordering is only fair if considering an object changes it, and
--  for the skip paths it does not: an object with no matching rule, or one not
--  yet due, or one on hold, is examined and left exactly as it was. It
--  therefore sorts to the front of the very next sweep, and the one after that,
--  forever.
--
--  Enough such objects and the window is entirely occupied by rows the sweep
--  has already decided to do nothing about, and nothing behind them is ever
--  reached. The counters look healthy throughout, because considered/skipped
--  are both going up; it is the media that never gets considered that is the
--  problem, and it is invisible by construction.
--
--  `last_swept_at` records that the sweep LOOKED, which is the thing the old
--  ordering was trying and failing to express. Every candidate is stamped
--  whether it was acted on or skipped, and the window rotates.
--
--  It is deliberately separate from `updated_at`: updated_at is the object's
--  own modification time and the retention clock's last-resort age anchor, so
--  stamping it here would restart the ageing of everything the sweep looks at,
--  which is a bug this codebase has already had once.
-- ============================================================================

ALTER TABLE media_objects ADD COLUMN IF NOT EXISTS last_swept_at TIMESTAMPTZ;

-- NULLS FIRST is the point of the index: an object never swept is the most
-- overdue thing there is, so it must sort ahead of everything already seen.
CREATE INDEX IF NOT EXISTS idx_media_objects_last_swept
  ON media_objects (last_swept_at NULLS FIRST)
  WHERE state NOT IN ('deleted', 'pending', 'writing');
