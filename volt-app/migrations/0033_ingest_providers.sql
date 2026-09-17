-- ===========================================================================
--  LINKED CLOUD ACCOUNTS for cloud to cloud ingest, and the transfer records
--  accelerated providers (Aspera, MASV, Signiant) report into.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS ingest_provider_accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL CHECK (provider IN ('dropbox', 'onedrive', 'gdrive', 'aspera', 'masv', 'signiant')),
    label         TEXT NOT NULL,
    -- OAuth tokens (dropbox, onedrive, gdrive) or API credentials (aspera node
    -- url + user/pass or bearer, masv api key, signiant client id/secret).
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    TIMESTAMPTZ,
    config        JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    linked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingest_provider_accounts ON ingest_provider_accounts (account_id, provider);

-- One row per accelerated transfer we asked a provider to run.
CREATE TABLE IF NOT EXISTS ingest_transfers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,
    provider_account_id UUID REFERENCES ingest_provider_accounts(id) ON DELETE SET NULL,
    external_id   TEXT,                       -- the provider's transfer / package id
    state         TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'running', 'landed', 'failed', 'cancelled')),
    files         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, bytes, relativePath}]
    destination   JSONB NOT NULL DEFAULT '{}'::jsonb,   -- where the provider was told to put them
    spec          JSONB,                      -- what we handed the client to launch
    progress      JSONB,
    error         TEXT,
    landed_paths  JSONB,                      -- local or s3 paths once landed
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingest_transfers ON ingest_transfers (account_id, created_at DESC);
