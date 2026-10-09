-- ===========================================================================
--  NOTIFICATIONS: retry with a cap and a backoff, and a reason it stopped.
--
--  Retries were unbounded and immediate: a bad address was re-sent every time
--  anybody pressed Retry, for ever. A delivery now carries when it may next be
--  tried and, once it will not be tried again, when and why it was given up
--  (attempt cap reached, or an error that retrying cannot fix, such as a
--  rejected address or a dead device token). Status stays 'failed' for those;
--  gave_up_at is what separates "will retry" from "finished failing", because
--  delivery_status is an enum and a new value cannot be added in a migration
--  transaction.
-- ===========================================================================
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS gave_up_at      TIMESTAMPTZ;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_ref    TEXT;
CREATE INDEX IF NOT EXISTS idx_deliv_due ON notification_deliveries (next_attempt_at)
  WHERE status = 'failed' AND gave_up_at IS NULL;

-- Device tokens for push, registered by the management app per signed-in user.
CREATE TABLE IF NOT EXISTS user_devices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    token       TEXT NOT NULL,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices (user_id);
