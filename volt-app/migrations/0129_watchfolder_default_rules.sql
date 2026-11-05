-- ============================================================================
--  0129: WATCHFOLDER DEFAULT RULES BY FILE TYPE (build queue H2b).
--
--  Every new folder starts with one ordinary rule per file type (images to
--  the Image Library, video to the Media Library). `builtin` names which
--  default a row is, so "Add default rules" on an older folder adds only the
--  ones it lacks and the console can label them. Null on every rule an
--  operator wrote, and on every rule that existed before this release.
--
--  Add only (RELEASING.md "Schema: add only"): one nullable column. Old code
--  never reads it, and the rules it would write are ordinary rules either way.
-- ============================================================================
ALTER TABLE watchfolder_rules ADD COLUMN IF NOT EXISTS builtin text;

COMMENT ON COLUMN watchfolder_rules.builtin IS
  'Which default rule by file type this is (images, video), or null for a rule an operator wrote (build queue H2b).';
