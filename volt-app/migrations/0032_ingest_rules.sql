-- ===========================================================================
--  INGEST RULES, WEBHOOKS, AND WHAT THE INGEST DECIDED.
--
--  Christian, 17 Sep: the uploader is a framework. Every file, from a browser
--  drop to a watchfolder to an Aspera delivery, goes through one ladder
--  (account < content type < source < item) that decides naming, structure,
--  duplicate action, metadata gate, sidecar and webhooks. The rules live
--  here; the decision each file got is stamped on the asset so the library
--  can say why a file is called what it is called.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ingest_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rung        TEXT NOT NULL CHECK (rung IN ('account', 'type', 'source')),
    -- type: metadata_schemas id. source: a watchfolder id, or 'panel', 'api',
    -- or a provider key ('aspera', 'dropbox' ...). NULL for the account rung.
    scope_id    TEXT,
    ordinal     INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    -- WHEN: services/ingest/rules.ts When. NULL always matches.
    "when"      JSONB,
    -- THEN: services/ingest/rules.ts IngestSettings, a partial.
    "then"      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Field defaults a rule stamps on the metadata (a folder that is always NRL).
    metadata_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingest_rules_account ON ingest_rules (account_id, rung, scope_id, ordinal);

CREATE TABLE IF NOT EXISTS ingest_webhooks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    -- HMAC secret; the header is t=<ts>,v1=<hex>, the same scheme as payments.
    secret      TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    events      TEXT[] NOT NULL DEFAULT '{ingested}',
    last_status INTEGER,
    last_at     TIMESTAMPTZ,
    last_error  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vod_assets
    ADD COLUMN IF NOT EXISTS original_filename TEXT,
    ADD COLUMN IF NOT EXISTS original_path     TEXT,
    ADD COLUMN IF NOT EXISTS sha256            TEXT,
    ADD COLUMN IF NOT EXISTS mime              TEXT,
    -- The whole ingest decision: rules matched, naming, duplicate, extraction.
    ADD COLUMN IF NOT EXISTS ingest            JSONB,
    -- Set while the metadata gate holds the asset back from ingest.
    ADD COLUMN IF NOT EXISTS awaiting_metadata TEXT[];

CREATE INDEX IF NOT EXISTS idx_vod_sha256 ON vod_assets (account_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vod_original_name ON vod_assets (account_id, lower(original_filename)) WHERE original_filename IS NOT NULL;

ALTER TABLE upload_sessions
    ADD COLUMN IF NOT EXISTS relative_path TEXT,
    ADD COLUMN IF NOT EXISTS schema_id     UUID REFERENCES metadata_schemas(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'panel';
