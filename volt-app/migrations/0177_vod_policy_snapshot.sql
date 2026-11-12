-- ============================================================================
--  0177: THE ENCODE-TIME POLICY ON THE TITLE (build queue P4).
--  DRM (and later the ladder, captions and trick play) changes the files, so
--  PUBLISHING_POLICIES.md resolves it when the title is ingested and keeps the
--  result on the title: what the policy asked for, which rule said so, and
--  what the files were actually packaged with. A rule changed later is then
--  compared with what the files carry, and the title shows Repackage pending
--  instead of the stamp claiming protection the files do not have.
--  Adds a nullable column only: titles encoded before it read as unrecorded.
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS policy_snapshot jsonb;
COMMENT ON COLUMN vod_assets.policy_snapshot IS
  'Encode-time policy fields at ingest: { at, wanted: { drm }, sources: { drm }, rule, packaged: { drm } }. Build queue P4.';
