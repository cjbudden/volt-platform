-- ============================================================================
--  0130: IMAGE TYPES FROM A WATCHFOLDER (build queue H2b-3).
--
--  A rule that takes images into the Image Library may name an image type of
--  the account (`image_type`: poster, hero, an account's own type), so a
--  folder whose file names carry no type word still sets it. A type word at
--  the end of the name (`Scrubs-s1-e1_poster.png`) wins over the rule's type
--  when `image_type_from_name` is on, which it is by default.
--
--  On the item: the type the image is meant to be for its asset
--  (`image_type`), and where that stands (`image_attach`): waiting for the
--  video it is named after (up to 24 hours), attached, or unmatched (it stays
--  in the Image Library on its own).
--
--  Add only (RELEASING.md "Schema: add only"): nullable columns and one with
--  a default. Old code never reads them, and an image it takes in simply has
--  no type, as before.
-- ============================================================================
ALTER TABLE watchfolder_rules ADD COLUMN IF NOT EXISTS image_type text;
ALTER TABLE watchfolder_rules ADD COLUMN IF NOT EXISTS image_type_from_name boolean NOT NULL DEFAULT true;
ALTER TABLE watchfolder_items ADD COLUMN IF NOT EXISTS image_type text;
ALTER TABLE watchfolder_items ADD COLUMN IF NOT EXISTS image_attach text;

COMMENT ON COLUMN watchfolder_rules.image_type IS
  'The asset image type (asset_image_types.key) an image this rule accepts is for, or null (build queue H2b-3).';
COMMENT ON COLUMN watchfolder_rules.image_type_from_name IS
  'A type word at the end of the file name (poster, thumbnail, hero...) wins over image_type (build queue H2b-3).';
COMMENT ON COLUMN watchfolder_items.image_type IS
  'The asset image type this image is meant to be, from its name or its rule (build queue H2b-3).';
COMMENT ON COLUMN watchfolder_items.image_attach IS
  'waiting (for the video it is named after, up to 24 hours), attached, or unmatched (build queue H2b-3).';
