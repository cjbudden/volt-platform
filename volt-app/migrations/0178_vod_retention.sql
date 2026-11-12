-- ============================================================================
--  0178: RETENTION FOR VOD TITLES (build queue P5, PUBLISHING_POLICIES.md
--  phase 5). A publishing policy's Retention section (keep for N days from
--  ingest, Available from or Available until) is applied by the hourly sweep
--  (services/media/vodRetention.ts): a title is listed 7 days before it is
--  due, then moved to the restore bin when due, unless a legal hold keeps it
--  or a copy rule's archive copy of its original is not verified yet.
--
--  Adds only: nullable columns on vod_assets and a new log table, so old and
--  new tasks can share the database during a rolling deploy.
-- ============================================================================
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS legal_hold_at      timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS legal_hold_by      text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS legal_hold_reason  text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS retention_due_at   timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS retention_warned_at timestamptz;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS retention_wait_code text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS retention_wait      text;
ALTER TABLE vod_assets ADD COLUMN IF NOT EXISTS retention_checked_at timestamptz;
COMMENT ON COLUMN vod_assets.legal_hold_at IS
  'Set while a legal hold keeps the title from retention (build queue P5). NULL: no hold.';
COMMENT ON COLUMN vod_assets.retention_due_at IS
  'When the publishing policy''s retention deletes the title, as the last sweep worked it out; NULL: kept.';

-- Every warning, wait and removal the sweep makes: the log PUBLISHING_POLICIES.md
-- asks for ("deletion gives a warning list 7 days ahead and is logged"). Kept
-- after the title is gone, so what happened to it has an answer.
CREATE TABLE IF NOT EXISTS vod_retention_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid,
  vod_asset_id uuid NOT NULL,
  title        text,
  event        text NOT NULL,          -- warned | removed | waiting | held | released | failed
  due_at       timestamptz,
  rule         text,                   -- the rung the retention came from
  code         text,
  message      text,
  bin_item_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vod_retention_log_account ON vod_retention_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vod_retention_log_asset ON vod_retention_log(vod_asset_id, created_at DESC);
