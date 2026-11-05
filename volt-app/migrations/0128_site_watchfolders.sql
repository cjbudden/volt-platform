-- ============================================================================
--  0128: HYBRID SITES 2: on-prem watchfolders, upload to the cloud (build
--  queue H2, HYBRID_SITES.md).
--
--  A `site` watchfolder lives on a customer's storage and is scanned by the
--  site agent there, with the same rules.ts the cloud runs. The cloud keeps
--  the folder, its rules and the queue (watchfolder_items) exactly as for a
--  local folder, so the console's review queue needs nothing new; the agent
--  reports each decision and, for an accepted video file, uploads it.
--
--  PLACEMENT says where the work runs. Only 'upload_cloud' (the agent uploads
--  the source and the cloud encodes it like any upload) is built; the value
--  'encode_site' is allowed here so H4 needs no schema change, and the API
--  refuses it until then. Null on local and S3 folders.
--
--  Add only (RELEASING.md "Schema: add only"): the kind check is widened (old
--  code never writes 'site' and its scan and ingest passes ask for 'local' and
--  's3' by name), three nullable columns.
-- ============================================================================
ALTER TABLE watchfolders DROP CONSTRAINT IF EXISTS watchfolders_kind_check;
ALTER TABLE watchfolders ADD CONSTRAINT watchfolders_kind_check CHECK (kind IN ('local', 's3', 'site'));

ALTER TABLE watchfolders ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE SET NULL;
ALTER TABLE watchfolders ADD COLUMN IF NOT EXISTS placement text
  CHECK (placement IS NULL OR placement IN ('upload_cloud', 'encode_site'));

COMMENT ON COLUMN watchfolders.site_id IS
  'kind site: the Hybrid Site whose agent scans this folder (build queue H2).';
COMMENT ON COLUMN watchfolders.placement IS
  'kind site: upload_cloud (the agent uploads, the cloud encodes) or encode_site (H4, not yet accepted).';

-- The upload that carries an accepted on-prem file to the cloud. Kept on the
-- item so an agent that restarts, or loses its state file, resumes the same
-- upload instead of sending the file again.
ALTER TABLE watchfolder_items ADD COLUMN IF NOT EXISTS upload_session_id uuid REFERENCES upload_sessions(id) ON DELETE SET NULL;
-- The Media Library record an accepted video became (site folders set it; the
-- local path names it in the reason only).
ALTER TABLE watchfolder_items ADD COLUMN IF NOT EXISTS vod_asset_id uuid REFERENCES vod_assets(id) ON DELETE SET NULL;
-- 'return': an operator pressed Reprocess on a refused file of a site folder.
-- The file is on the customer's storage, so the agent moves it back out of the
-- review folder and clears this; until then the row says it is waiting for the site.
ALTER TABLE watchfolder_items ADD COLUMN IF NOT EXISTS site_action text
  CHECK (site_action IS NULL OR site_action IN ('return'));
