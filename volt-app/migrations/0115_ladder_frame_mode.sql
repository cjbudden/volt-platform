-- ============================================================================
--  A LADDER CAN MAKE FIXED SIZES (services/encode/ladder.ts fitToSource).
--
--  frame_mode
--    'scale'  as before: each rung is the source scaled to the rung's height
--             (its width follows the source's shape), and with cap_to_source
--             the rungs above the source are not encoded.
--    'box'    every rung at its own 16:9 size (1920x1080, 1280x720...), the
--             picture fitted inside with bars where its shape differs, and
--             every rung encoded. What a FAST channel needs from every title,
--             so a title ingested with a 'box' ladder can go to air on a
--             channel with the same ladder without being encoded again.
-- ============================================================================
ALTER TABLE encode_ladder_groups ADD COLUMN IF NOT EXISTS frame_mode TEXT NOT NULL DEFAULT 'scale';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encode_ladder_groups_frame_mode_ck') THEN
    ALTER TABLE encode_ladder_groups ADD CONSTRAINT encode_ladder_groups_frame_mode_ck CHECK (frame_mode IN ('scale', 'box'));
  END IF;
END $$;
COMMENT ON COLUMN encode_ladder_groups.frame_mode IS
  'scale: rungs follow the source shape (and cap_to_source drops rungs above it); box: every rung at its fixed 16:9 size, letterboxed, none dropped.';
