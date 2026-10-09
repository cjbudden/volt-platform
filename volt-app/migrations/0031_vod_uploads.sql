-- ===========================================================================
--  UPLOADING A VIDEO FILE.
--
--  The resumable upload already creates its asset row at the START of the
--  upload rather than at the end, and the reason is in services/uploads.ts: an
--  upload that only becomes visible once it finishes is an upload nobody can
--  watch fail. That reasoning is stronger here, not weaker — a filler loop is
--  seconds of video and a programme is an hour, so the window in which the
--  operator can see nothing is the whole afternoon.
--
--  So a 'vod' upload needs the same link a 'filler' upload has, to its own
--  table. `filler_asset_id` cannot serve: it is a foreign key to filler_assets,
--  and pointing it at a vod_assets id would be a reference that resolves to
--  nothing or, worse, to an unrelated row.
-- ===========================================================================

ALTER TABLE upload_sessions
    ADD COLUMN IF NOT EXISTS vod_asset_id UUID
    REFERENCES vod_assets(id) ON DELETE SET NULL;

-- A session points at ONE asset. Both set is a session that has been through two
-- different code paths, which is a bug rather than a state to support.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_one_asset_ck') THEN
    ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_one_asset_ck
      CHECK (NOT (filler_asset_id IS NOT NULL AND vod_asset_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_vod
    ON upload_sessions (vod_asset_id) WHERE vod_asset_id IS NOT NULL;

COMMENT ON COLUMN upload_sessions.vod_asset_id IS
  'The vod_assets row created when the upload was opened, so a large upload is visible and can be seen to fail while its bytes are still in flight.';
