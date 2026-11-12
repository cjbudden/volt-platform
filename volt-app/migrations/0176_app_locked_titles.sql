-- ============================================================================
--  0176: AN APP CHOOSES UPSELL OR HIDE FOR LOCKED TITLES (build queue C2-4).
--  modules/publicCollections.ts lists a title a package locks for that app
--  and country either as locked, with the packages that unlock it (upsell),
--  or not at all (hide). Upsell is the default because that is what every
--  app already answered before this column existed. The apps trigger from
--  0046 already announces a change, so cached answers follow it at once.
--  Adds a column with a default only.
-- ============================================================================
ALTER TABLE apps ADD COLUMN IF NOT EXISTS locked_titles text NOT NULL DEFAULT 'upsell'
  CHECK (locked_titles IN ('upsell', 'hide'));
COMMENT ON COLUMN apps.locked_titles IS
  'Public catalogue answers for a title a package locks here: upsell (listed as locked, with its packages) or hide (left out). Build queue C2-4.';
