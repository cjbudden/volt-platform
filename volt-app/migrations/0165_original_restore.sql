-- ============================================================================
--  0165: RESTORE AN ORIGINAL TO THE CLOUD (build queue H3-5b; (e) of H3-5,
--  decided by Christian on 11 Nov 2026).
--
--  An original a retention rule took out of the cloud (0164) comes back from
--  its archive copy: a server at the copy's site reads the copy and uploads
--  it, and the cloud checks it against the archived checksum before the asset
--  points at it again. On the asset: the restore job in flight, the last
--  reason one failed, and when it came back (the rung's clock restarts there,
--  so a restored original is not taken out again on the next pass).
--
--  Add only (RELEASING.md "Schema: add only"): nullable columns.
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_restore_job_id uuid;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_restore_error  text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS original_restored_at    timestamptz;
