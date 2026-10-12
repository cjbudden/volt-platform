-- ============================================================================
-- ENCODE ENGINES + WORKFLOW ADD-ONS
--
-- Two extension points, one migration because they ship together.
--
-- 1. ENGINES (volt/ENGINES.md). Which engine encodes a profile's streams.
--    'builtin' (our FFmpeg + Shaka container) is the default and the only one
--    installed; a vendor adapter (MediaLive, Bitmovin, Wowza…) is registered in
--    services/engines/index.ts. engine_bindings remembers the vendor-side
--    resource behind a running task, so stop and liveness can reach it.
--
-- 2. ADD-ONS (volt/WORKFLOWS.md). The base workflow emits HOOKS at real stages
--    (stream started, recording completed, clip ready, QC done, review
--    decided, VOD encoded). An add-on service is an external platform (an AI
--    agent, a transcription house, a QC vendor) that a TRIGGER runs when a hook
--    fires, or an operator runs by hand. Every run is tracked: state, progress,
--    current step, the vendor's own reference, the result, and an event log.
-- ============================================================================

-- ---------- engines -------------------------------------------------------
ALTER TABLE output_profiles ADD COLUMN IF NOT EXISTS encode_engine      TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE output_profiles ADD COLUMN IF NOT EXISTS encode_engine_mode TEXT
  CHECK (encode_engine_mode IS NULL OR encode_engine_mode IN ('encode_only','full'));

CREATE TABLE IF NOT EXISTS engine_bindings (
    task_arn     TEXT PRIMARY KEY,                 -- our packager's arn (encode_only) or engine:<id>:<ref> (full)
    engine_id    TEXT NOT NULL,
    mode         TEXT NOT NULL CHECK (mode IN ('encode_only','full')),
    stream_kind  TEXT NOT NULL CHECK (stream_kind IN ('channel','event')),
    stream_id    UUID NOT NULL,
    external_ref TEXT NOT NULL,                    -- the vendor's id for the job / channel
    meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at   TIMESTAMPTZ,
    stop_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_engine_bindings_ref    ON engine_bindings (engine_id, external_ref);
CREATE INDEX IF NOT EXISTS idx_engine_bindings_stream ON engine_bindings (stream_id, created_at DESC);

-- ---------- workflow hook log ---------------------------------------------
-- Append-only: every hook the base workflow fires, whether or not anything is
-- attached to it. This is what lets the dashboard show where a recording or
-- asset has got to, not only where its add-ons are.
CREATE TABLE IF NOT EXISTS workflow_events (
    id           BIGSERIAL PRIMARY KEY,
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    hook         TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id   UUID NOT NULL,
    channel_id   UUID,
    event_id     UUID,
    title        TEXT,
    data         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wfe_account ON workflow_events (account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_wfe_subject ON workflow_events (subject_type, subject_id, id);

-- ---------- add-on services ------------------------------------------------
CREATE TABLE IF NOT EXISTS addon_services (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT,
    category       TEXT NOT NULL DEFAULT 'other'
                   CHECK (category IN ('ai_agent','transcription','qc','metadata','distribution','other')),
    kind           TEXT NOT NULL DEFAULT 'webhook' CHECK (kind IN ('webhook','demo')),
    endpoint_url   TEXT,                            -- required for kind=webhook
    signing_secret TEXT NOT NULL,                   -- HMAC key for X-Volt-Signature; shown once at creation
    accepts        TEXT[] NOT NULL DEFAULT ARRAY['recording','vod_asset']::text[],
    steps          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- optional declared step labels for the progress view
    timeout_sec    INTEGER NOT NULL DEFAULT 3600 CHECK (timeout_sec BETWEEN 30 AND 86400),
    max_attempts   INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    enabled        BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind <> 'webhook' OR endpoint_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_addon_services_account ON addon_services (account_id);

CREATE TABLE IF NOT EXISTS addon_triggers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    addon_id    UUID NOT NULL REFERENCES addon_services(id) ON DELETE CASCADE,
    hook        TEXT NOT NULL,
    -- {channelIds?:[], eventIds?:[], groupIds?:[]}; empty = every stream in the account
    filter      JSONB NOT NULL DEFAULT '{}'::jsonb,
    options     JSONB NOT NULL DEFAULT '{}'::jsonb, -- passed to the add-on as-is
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_addon_triggers_hook ON addon_triggers (account_id, hook) WHERE enabled;

CREATE TABLE IF NOT EXISTS addon_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    addon_id        UUID NOT NULL REFERENCES addon_services(id) ON DELETE CASCADE,
    trigger_id      UUID REFERENCES addon_triggers(id) ON DELETE SET NULL,  -- NULL = run by hand
    hook            TEXT NOT NULL,                   -- the hook that caused it ('manual' for a hand run)
    subject_type    TEXT NOT NULL,
    subject_id      UUID NOT NULL,
    subject_title   TEXT,
    channel_id      UUID,
    event_id        UUID,
    options         JSONB NOT NULL DEFAULT '{}'::jsonb,
    state           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','dispatched','running','succeeded','failed','cancelled','timed_out')),
    progress_pct    INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
    step            TEXT,
    steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
    external_ref    TEXT,
    result          JSONB,
    error           TEXT,
    callback_hash   TEXT NOT NULL,                   -- sha256 of the per-run callback token
    job_id          UUID,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at   TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    deadline_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addon_runs_account ON addon_runs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_addon_runs_subject ON addon_runs (subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_addon_runs_open    ON addon_runs (deadline_at)
  WHERE state IN ('queued','dispatched','running');

CREATE TABLE IF NOT EXISTS addon_run_events (
    id           BIGSERIAL PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES addon_runs(id) ON DELETE CASCADE,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    type         TEXT NOT NULL,                    -- created | dispatched | progress | state | error | note
    state        TEXT,
    progress_pct INTEGER,
    step         TEXT,
    message      TEXT,
    data         JSONB
);
CREATE INDEX IF NOT EXISTS idx_addon_run_events_run ON addon_run_events (run_id, id);
