-- ============================================================================
--  0131: A SITE FILE SENT TO REVIEW BY THE CLOUD (build queue H2b-5).
--
--  Images, slates and companions now cross from a Hybrid Site. A companion
--  the cloud cannot attach (over 25 MB, no video in 24 hours, a caption Volt
--  cannot read) goes to Needs review, but its file is on the customer's
--  storage: `site_action = 'review'` asks the site agent to move it into the
--  review folder there, as 'return' asks it to move one back.
--
--  Widens the CHECK only. Old code writes 'return' or null, which both
--  constraints accept, so old and new tasks share the table during a rolling
--  deploy. NOT VALID then VALIDATE: no long lock while existing rows are read.
-- ============================================================================
ALTER TABLE watchfolder_items DROP CONSTRAINT IF EXISTS watchfolder_items_site_action_check;
ALTER TABLE watchfolder_items ADD CONSTRAINT watchfolder_items_site_action_check
  CHECK (site_action IS NULL OR site_action IN ('return', 'review')) NOT VALID;
ALTER TABLE watchfolder_items VALIDATE CONSTRAINT watchfolder_items_site_action_check;

COMMENT ON COLUMN watchfolder_items.site_action IS
  'What the site agent must do with the file on site: return (out of review, Reprocess) or review (into the review folder, sent there by the cloud). Null when nothing is waiting (build queue H2b-5).';
