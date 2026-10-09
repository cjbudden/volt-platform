-- ===========================================================================
--  SOCIAL PUBLISHING, for real: linked accounts with their OAuth tokens, a
--  post (title, caption, tags, privacy) per publication, and progress.
--
--  Tokens are stored ENCRYPTED (AES-256-GCM, services/social/crypto.ts) in the
--  row, not as a pointer to a secret store that nothing reads: the stub's
--  credentials_ref column is kept for a deployment that does move them to
--  Secrets Manager, and is otherwise unused.
--
--  mode 'sandbox' is an account that behaves like the platform without calling
--  it: link, publish with progress, a watch URL, views that move. It is how the
--  whole flow is tested before the platform app credentials exist, and it is
--  labelled as a sandbox everywhere it appears.
-- ===========================================================================
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live';
DO $$ BEGIN
  ALTER TABLE publish_targets ADD CONSTRAINT publish_targets_mode_chk CHECK (mode IN ('live', 'sandbox'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS access_token_enc  TEXT;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS token_expires_at  TIMESTAMPTZ;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS scopes            TEXT[];
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS account_label     TEXT;   -- @handle / channel name shown to people
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS avatar_url        TEXT;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS link_status       TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS link_detail       TEXT;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS linked_by         UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE publish_targets ADD COLUMN IF NOT EXISTS linked_at         TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ptarget_external ON publish_targets (account_id, platform, external_account, mode)
  WHERE external_account IS NOT NULL;

ALTER TABLE publications ADD COLUMN IF NOT EXISTS post      JSONB;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS progress  INTEGER;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS stage     TEXT;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS job_id    UUID;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS attempts  INTEGER NOT NULL DEFAULT 0;

-- OAuth round trips in flight. The browser leaves with `state` = this id and
-- comes back with it; the row says whose account and holds the PKCE verifier,
-- so neither travels in the URL. Ten minutes, then useless.
CREATE TABLE IF NOT EXISTS social_oauth_states (
    id            TEXT PRIMARY KEY,
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    platform      TEXT NOT NULL,
    code_verifier TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
