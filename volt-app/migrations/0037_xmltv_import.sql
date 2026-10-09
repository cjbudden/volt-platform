-- ===========================================================================
--  XMLTV IMPORT: a customer's or a guide provider's XMLTV, as programmes.
--
--  epg_import_sources  one per guide we take in: a URL polled on an interval,
--                      or files uploaded by hand. Carries the fallback zone for
--                      times with no offset and how much history to keep.
--  epg_channel_aliases their channel ids, per source, mapped to ours. Kept
--                      across re-imports and editable, because their ids are
--                      theirs and change when they change provider. A row with
--                      no channel_id is a channel we saw but nobody has mapped:
--                      its programmes are counted and skipped, not guessed.
--  epg_import_runs     what each run did: counts, warnings, the error if any.
--
--  Imported programmes carry source_ref 'xmltv:<source id>:<their channel>:<start>'
--  so a re-import is an upsert, and a programme that disappeared from the file
--  inside the window the file covers is removed: a nightly refresh is a diff,
--  not a pile of duplicates.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS epg_import_sources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('url', 'upload')),
    url             TEXT,
    refresh_hours   INTEGER CHECK (refresh_hours IS NULL OR refresh_hours BETWEEN 1 AND 168),
    fallback_tz     TEXT,
    keep_past_days  INTEGER NOT NULL DEFAULT 1 CHECK (keep_past_days BETWEEN 0 AND 365),
    lang            TEXT,
    auto_map        BOOLEAN NOT NULL DEFAULT true,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    next_run_at     TIMESTAMPTZ,
    running_since   TIMESTAMPTZ,
    last_run_at     TIMESTAMPTZ,
    last_status     TEXT,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind <> 'url' OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_epg_import_sources_account ON epg_import_sources (account_id);
CREATE INDEX IF NOT EXISTS idx_epg_import_sources_due ON epg_import_sources (next_run_at) WHERE enabled AND kind = 'url';

CREATE TABLE IF NOT EXISTS epg_channel_aliases (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_id     UUID NOT NULL REFERENCES epg_import_sources(id) ON DELETE CASCADE,
    external_id   TEXT NOT NULL,
    display_name  TEXT,
    icon          TEXT,
    channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
    mapped_by     TEXT,                 -- 'auto:xmltv_id' | 'auto:name' | 'user'
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_programmes INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_epg_aliases_channel ON epg_channel_aliases (channel_id);

CREATE TABLE IF NOT EXISTS epg_import_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    UUID NOT NULL REFERENCES epg_import_sources(id) ON DELETE CASCADE,
    trigger      TEXT NOT NULL,          -- schedule | manual | upload
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'warnings', 'failed')),
    counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings     JSONB NOT NULL DEFAULT '[]'::jsonb,
    error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_epg_import_runs_source ON epg_import_runs (source_id, started_at DESC);
