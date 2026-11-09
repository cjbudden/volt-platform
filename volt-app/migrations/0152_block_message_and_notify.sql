-- Build queue P2-2: the block message a viewer is shown when a title cannot
-- play where they are, and their "Notify me" requests.
-- Add only: two nullable or defaulted columns and a new table.

-- The account's block message (null: the default, "Not available in your
-- region") and whether players offer "Notify me". Publishing policies (P3)
-- will set these per policy; until then the account default applies.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS block_message text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS block_notify boolean NOT NULL DEFAULT false;

-- A viewer asking to be told when a title becomes available to them. One row
-- per title and person (a signed-in viewer, or an email address).
CREATE TABLE IF NOT EXISTS availability_notify (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL,
  who         text NOT NULL,           -- 'viewer:<id>' or 'email:<lower-cased address>'
  email       text,
  viewer_id   text,
  country     text,
  reason      text NOT NULL,           -- 'region', 'rights' or 'scheduled'
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  UNIQUE (asset_id, who)
);
CREATE INDEX IF NOT EXISTS idx_availability_notify_account ON availability_notify (account_id, created_at DESC);
