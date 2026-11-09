-- ============================================================================
--  0147: HYBRID SITES 5a: fall back to cloud encoding (build queue H5,
--  HYBRID_SITES.md "When the site is offline").
--
--  An Encode at site folder's FALLBACK TIME: how long an asset's encode may
--  wait in the site's pool, with no server of the site taking it, before the
--  site is asked to send the original and the cloud encodes it instead
--  (services/sites/siteFallback.ts). NULL, the default, means wait for the
--  site: the original never leaves the customer's network unless a person
--  sets a fallback time on the folder.
--
--  Add only (RELEASING.md "Schema: add only"): one nullable column, which
--  old tasks never read.
-- ============================================================================
ALTER TABLE watchfolders ADD COLUMN IF NOT EXISTS fallback_minutes integer
  CHECK (fallback_minutes IS NULL OR fallback_minutes BETWEEN 5 AND 10080);

COMMENT ON COLUMN watchfolders.fallback_minutes IS
  'kind site, placement encode_site: minutes an encode may wait for a server of the site before the original is sent and encoded in the cloud. NULL waits for the site (build queue H5).';
