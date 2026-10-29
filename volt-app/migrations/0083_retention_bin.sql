-- RETENTION THAT KEEPS WHAT CLIPS NEED, A RESTORE BIN, AND MANUAL EXPIRY (25 Oct 2026).
-- docs/RETENTION.md.
--
-- 1. When a recording's media is deleted by retention, the segments clips were cut from
--    (with a segment either side) stay, with their thumbnails; everything else goes,
--    including stills, unused sprite sheets and their Image Library rows. The media object
--    is then held, its reason saying what was kept.
-- 2. Nothing removed by retention, the cleanup script or a library delete is destroyed at
--    once: files move into the bin (VOLT_TRASH_DIR, images under trash/ in the image
--    store) and the rows removed are kept here, so the item can be restored for
--    VOLT_TRASH_DAYS (7 by default). The purge after that is the real deletion.
-- 3. A recording's expiry can be set by hand: delete_after overrides the rule's delete
--    stage (earlier or later); the retention list orders by it.

CREATE TABLE IF NOT EXISTS trash_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID REFERENCES accounts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('recording_media', 'vod_asset')),
  subject_id    UUID,                       -- the recording or the asset
  label         TEXT NOT NULL,
  reason        TEXT,                       -- 'retention rule "News", 30 days' | 'deleted by jo@x' | 'cleanup script'
  bytes         BIGINT NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  -- [{ "from": "<dir>", "to": "<dir in the bin>" }]: a tree moved into the bin; restore
  -- walks `to` and puts every file back under `from`.
  files         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "from": "<image key>", "to": "trash/<id>/<image key>" }] in the image store
  images        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "table": "media_files", "row": {...} }] removed rows, parents before children;
  -- [{ "table", "column", "ids" }] links that were set to NULL by the delete
  rows          JSONB NOT NULL DEFAULT '[]'::jsonb,
  relinks       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- what restoring must also undo (objects to mark available again, the run to rescan)
  restore_hint  JSONB NOT NULL DEFAULT '{}'::jsonb,
  state         TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'restored', 'purged')),
  purge_after   TIMESTAMPTZ NOT NULL,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at   TIMESTAMPTZ,
  restored_by   TEXT,
  purged_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trash_items_account ON trash_items(account_id, created_at DESC) WHERE state = 'held';
CREATE INDEX IF NOT EXISTS trash_items_purge ON trash_items(purge_after) WHERE state = 'held';

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS delete_after TIMESTAMPTZ;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS delete_after_by TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS delete_after_note TEXT;
CREATE INDEX IF NOT EXISTS recordings_delete_after ON recordings(delete_after) WHERE delete_after IS NOT NULL;
