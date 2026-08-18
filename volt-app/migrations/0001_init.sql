-- ===========================================================================
-- Volt Streaming — Live Events & Channels Manager
-- Migration 0001: initial schema (PostgreSQL / Amazon RDS)
--
-- Tenancy chain:  accounts -> groups -> events / channels
-- Output profiles (bitrate ladder, packaging, DVR, overlays, codec backend)
-- attach at account level and are referenced by groups, so every event/channel
-- under a group inherits one profile — which is what makes per-account sizing
-- and limits calculable.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------- enums ----------------------------------------------------------
CREATE TYPE billing_mode      AS ENUM ('per_channel', 'per_event', 'enterprise');
CREATE TYPE user_role         AS ENUM ('owner', 'admin', 'operator', 'viewer');
CREATE TYPE user_status       AS ENUM ('active', 'invited', 'disabled');
CREATE TYPE packaging_kind    AS ENUM ('hls', 'dash', 'both');
CREATE TYPE codec_backend     AS ENUM ('x264', 'nvenc');          -- CPU vs GPU encode
-- lifecycle: scheduled -> provisioning (server coming up) -> testing (source in,
-- admin QC/preview only) -> live (public/broadcasting) -> stopping -> ended
CREATE TYPE asset_status      AS ENUM ('scheduled','provisioning','testing','live','stopping','ended','error');
CREATE TYPE purchasing_mode   AS ENUM ('on_demand', 'reserved', 'spot_fallback');
-- Redundancy is OPTIONAL and chosen per channel/event at setup (not on by default):
--   standard         = single input, no failover, no filler.
--   resilient_input  = a BACKUP INPUT source is supplied; we cut to it on primary
--                      loss and fail back on recovery. (transcode: a 2nd mezzanine;
--                      packaging: a 2nd aligned ladder.) There is NO backup OUTPUT —
--                      the output is ours and doesn't fail as a stream; node/container
--                      loss is covered by ECS restart against the S3 origin buffer.
--   full_redundancy  = backup input AND input-loss filler (below).
CREATE TYPE resilience_tier   AS ENUM ('standard', 'resilient_input', 'full_redundancy');
CREATE TYPE input_role        AS ENUM ('primary', 'backup');
-- What the OUTPUT shows when ALL live inputs are down, so the output never stalls.
-- We switch the source to filler and hold until a live input recovers; timestamps
-- and segment numbering stay continuous (transcode: encode filler live; packaging:
-- emit a pre-baked, ladder-matched filler prepared once at setup).
CREATE TYPE input_loss_behavior AS ENUM ('none','slate','vod_loop','last_frame','black');
CREATE TYPE ingest_protocol   AS ENUM ('srt','rtmp','rtmps','hls','dash','ndi','st2110');
CREATE TYPE instance_lifecycle AS ENUM ('spot', 'on_demand');
CREATE TYPE instance_role     AS ENUM ('primary', 'standby', 'captions');
CREATE TYPE vod_kind          AS ENUM ('clip', 'full_event', 'export');
-- Recordings library: an event recording (bounded run) vs a per-day slice of a
-- continuous channel (one recording row per channel per calendar day).
CREATE TYPE recording_kind    AS ENUM ('event', 'channel_day');
CREATE TYPE recording_status  AS ENUM ('recording', 'complete', 'error');
-- Slates & loops (uploaded filler assets), managed separately from VOD.
CREATE TYPE filler_kind       AS ENUM ('slate', 'loop');
CREATE TYPE asset_media_status AS ENUM ('uploading', 'processing', 'ready', 'error');
-- A clip can be delivered as ABR manifests (HLS+DASH off the CMAF chunks, cheap
-- remux) and/or a single progressive MP4 (concatenated from the chunks).
CREATE TYPE clip_output_kind AS ENUM ('manifest', 'progressive', 'both');
CREATE TYPE scheduled_clip_status AS ENUM ('scheduled', 'firing', 'done', 'error', 'cancelled');
-- Distribution: the built-in viewer portal, plus external social platforms.
CREATE TYPE publish_platform AS ENUM ('portal', 'youtube', 'facebook', 'x', 'tiktok', 'dailymotion');
CREATE TYPE publication_status AS ENUM ('pending', 'published', 'failed', 'removed');
CREATE TYPE drm_provider      AS ENUM ('axinom');                 -- extensible: add more vendors later
CREATE TYPE drm_scheme        AS ENUM ('cbcs', 'cenc');           -- cbcs = CMAF multi-DRM (W/PR/FP)
CREATE TYPE workflow_type     AS ENUM ('transcode', 'package_only'); -- package_only = no transcode / no GPU

-- ---------- accounts / auth ------------------------------------------------
-- ENTITLEMENTS vs RUNTIME: max_channels / max_concurrent_sources are the
-- LICENSED CEILINGS the customer pays a subscription for (e.g. "up to 5
-- channels"). They are quotas enforced by admission control — they cost nothing
-- to grant and do NOT provision any server. Actual encoders are only launched
-- when a channel/event is started (see instances), so a 5-channel plan running
-- 1 channel pays for 1. This is what stops idle footprint running 24/7.
CREATE TABLE accounts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT NOT NULL,
    plan_tier               TEXT NOT NULL DEFAULT 'standard',
    billing_mode            billing_mode NOT NULL DEFAULT 'enterprise',
    included_gb             INTEGER NOT NULL DEFAULT 0,
    markup_pct              NUMERIC(5,4) NOT NULL DEFAULT 0.50,  -- stored as fraction
    subscription_fee_month  NUMERIC(10,2) NOT NULL DEFAULT 0,    -- fixed fee for the entitlement
    max_channels            INTEGER NOT NULL DEFAULT 5,          -- LICENSED ceiling (quota)
    max_concurrent_sources  INTEGER NOT NULL DEFAULT 3,          -- LICENSED ceiling (quota)
    max_renditions          INTEGER NOT NULL DEFAULT 5,          -- renditions per package (ladder cap; hard max 8) — bounds container load
    max_asset_hours         INTEGER NOT NULL DEFAULT 12,         -- VOD single-asset cap
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email         CITEXT NOT NULL,
    password_hash TEXT NOT NULL,                                 -- argon2id
    role          user_role NOT NULL DEFAULT 'operator',
    status        user_status NOT NULL DEFAULT 'invited',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (email)
);

CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- ---------- DRM configuration (Axinom multi-DRM) ---------------------------
-- Packager fetches content keys from the Key Service via CPIX/SPEKE v2 (cbcs),
-- encrypts CMAF once for Widevine + PlayReady + FairPlay. Playback licenses are
-- issued by the License Service against a signed entitlement token our API mints
-- with the management key (which lives in Secrets Manager, never in this table).
CREATE TABLE drm_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider            drm_provider NOT NULL DEFAULT 'axinom',
    scheme              drm_scheme NOT NULL DEFAULT 'cbcs',
    systems             JSONB NOT NULL DEFAULT '["widevine","playready","fairplay"]'::jsonb,
    tenant_id           TEXT NOT NULL,                    -- Axinom tenant
    key_service_url     TEXT NOT NULL,                    -- SPEKE v2 endpoint (/SpekeV2)
    license_service_url TEXT NOT NULL,
    management_key_ref  TEXT NOT NULL,                    -- Secrets Manager ARN, NOT the key
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- output profiles (the shared bitrate ladder) --------------------
-- rungs:    [{"height":1080,"bitrate_kbps":5000,"fps":30,"codec":"h264"}, ...]
-- overlays: [{"assetKey":"...png","position":"tr","scalePctWidth":0.12,
--            "opacity":0.85,"marginPx":24,"startMs":null,"endMs":null}, ...]
CREATE TABLE output_profiles (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    rungs         JSONB NOT NULL,
    packaging     packaging_kind NOT NULL DEFAULT 'both',
    workflow_type workflow_type NOT NULL DEFAULT 'transcode',     -- package_only: client sends the ladder, we only chunk (CPU, no GPU)
    codec_backend codec_backend NOT NULL DEFAULT 'nvenc',         -- ignored when workflow_type = package_only
    segment_dur   NUMERIC(4,2) NOT NULL DEFAULT 4.00,            -- seconds
    dvr_window_sec INTEGER NOT NULL DEFAULT 300,                 -- live sliding window
    retention_days INTEGER NOT NULL DEFAULT 30,                  -- VOD retention
    overlays      JSONB NOT NULL DEFAULT '[]'::jsonb,
    drm_enabled   BOOLEAN NOT NULL DEFAULT false,
    drm_config_id UUID REFERENCES drm_configs(id) ON DELETE SET NULL,
    -- live captions / transcription / translation. Segmented WebVTT subtitle
    -- renditions; caption_offset_sec is the playout delay that keeps captions in
    -- sync with AV. The ENGINE is pinned to the account's captions_provider at run
    -- time (see accounts.captions_provider + jobConfig); caption_engine here is a
    -- legacy per-profile hint kept for back-compat. caption_model_size sizes the
    -- self-hosted Whisper add-on (tiny|base|small|medium|large-v3).
    captions_enabled   BOOLEAN NOT NULL DEFAULT false,
    caption_engine     TEXT NOT NULL DEFAULT 'gladia',
    caption_source_lang TEXT NOT NULL DEFAULT 'auto',           -- STT source ('auto' = detect)
    caption_targets    JSONB NOT NULL DEFAULT '[]'::jsonb,      -- translation target lang codes, e.g. ["en","ms","zh","ta"]
    caption_offset_sec INTEGER NOT NULL DEFAULT 0,               -- playout delay for live captions/translation sync
    caption_model_size TEXT NOT NULL DEFAULT 'small',            -- whisper model size for the add-on task
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- groups ---------------------------------------------------------
CREATE TABLE groups (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    output_profile_id UUID REFERENCES output_profiles(id) ON DELETE SET NULL,
    max_concurrent    INTEGER NOT NULL DEFAULT 3,
    max_channels      INTEGER NOT NULL DEFAULT 5,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- events (bounded) & channels (long-running) ---------------------
-- THREE NESTED TIME WINDOWS (this is the key separation):
--   scheduled_start/end : the planned event window the customer enters.
--   server_start/stop    : when the ENCODER actually runs (you pay compute for
--                          this whole span). Widened before/after for setup,
--                          source testing and teardown.
--   public_start/end     : when NON-ADMIN viewers can watch. Sits inside the
--                          server window; before it, the stream is admin-only
--                          for QC (source received? bitrate/quality/stability
--                          OK?). Access is gated on this window.
-- So: server runs [server_start .. server_stop]; admins test from source-up
-- until public_start; the public sees only [public_start .. public_end].
CREATE TABLE events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id         UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    status           asset_status NOT NULL DEFAULT 'scheduled',
    scheduled_start  TIMESTAMPTZ NOT NULL,
    scheduled_end    TIMESTAMPTZ NOT NULL,
    server_start     TIMESTAMPTZ,           -- encoder up (compute billing starts)
    server_stop      TIMESTAMPTZ,           -- encoder down (compute billing ends)
    public_start     TIMESTAMPTZ,           -- becomes viewable to end users
    public_end       TIMESTAMPTZ,           -- no longer viewable to end users
    actual_start     TIMESTAMPTZ,           -- observed first-frame ingested
    actual_end       TIMESTAMPTZ,
    purchasing_mode  purchasing_mode NOT NULL DEFAULT 'spot_fallback',
    resilience_tier  resilience_tier NOT NULL DEFAULT 'standard',
    -- optional redundancy, chosen at setup (see resilience_tier / input_loss_behavior)
    input_failover_enabled BOOLEAN NOT NULL DEFAULT false,      -- use backup-role inputs
    auto_failback          BOOLEAN NOT NULL DEFAULT true,        -- return to primary on recovery
    input_loss_behavior    input_loss_behavior NOT NULL DEFAULT 'none',
    filler_asset_id        UUID,                                 -- slate/loop filler (-> filler_assets.id)
    filler_slate_ref       TEXT,                                 -- slate image URL/ref
    recording_retention_days INTEGER,                            -- retention rule (NULL = keep forever)
    -- custom metadata (assignable schema + values). Defined once at the event and
    -- harvested into the auto-VOD (schema.org VideoObject) when the recording ends.
    -- FK to metadata_schemas added by ALTER below (that table is defined later).
    schema_id        UUID,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (scheduled_end > scheduled_start),
    CHECK (server_stop  IS NULL OR server_start IS NULL OR server_stop  > server_start),
    CHECK (public_end   IS NULL OR public_start IS NULL OR public_end   > public_start)
);
CREATE INDEX idx_events_group  ON events(group_id);
CREATE INDEX idx_events_status ON events(status);

CREATE TABLE channels (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id         UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    status           asset_status NOT NULL DEFAULT 'scheduled',
    enabled          BOOLEAN NOT NULL DEFAULT true,
    purchasing_mode  purchasing_mode NOT NULL DEFAULT 'reserved',
    resilience_tier  resilience_tier NOT NULL DEFAULT 'standard',
    -- optional redundancy, chosen at setup (see resilience_tier / input_loss_behavior)
    input_failover_enabled BOOLEAN NOT NULL DEFAULT false,      -- use backup-role inputs
    auto_failback          BOOLEAN NOT NULL DEFAULT true,        -- return to primary on recovery
    input_loss_behavior    input_loss_behavior NOT NULL DEFAULT 'none',
    filler_asset_id        UUID,                                 -- slate/loop filler (-> filler_assets.id)
    filler_slate_ref       TEXT,                                 -- slate image URL/ref
    recording_retention_days INTEGER,                            -- retention rule (NULL = keep forever)
    -- custom metadata (assignable schema + values), same mechanism as events/vod.
    -- FK to metadata_schemas added by ALTER below (that table is defined later).
    schema_id        UUID,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_channels_group ON channels(group_id);

-- ---------- stream inputs — the SOURCE STREAMS of a channel/event -----------
-- Terminology: an "input" is ONE SOURCE STREAM (one rendition/bitrate). A
-- channel/event (the "package") is made up of one or more of these.
--   * package_only : the client sends a pre-encoded ABR LADDER — one row per
--                    rendition (rendition_label / rendition_bitrate_kbps set).
--   * transcode    : typically ONE mezzanine source row; the ladder is produced.
-- role = primary vs backup. Backup is INPUT-side redundancy (optional): we cut to
-- the backup SOURCE on primary loss, then fail back. There is no backup OUTPUT.
--   * transcode : backup = a second mezzanine (one role='backup' row).
--   * packaging : backup = a full aligned backup LADDER (the primary renditions
--                 duplicated as role='backup', time/GOP-aligned to the primary).
-- If ALL live inputs drop, the channel/event's input_loss_behavior takes over
-- (slate / vod_loop / last_frame) so the OUTPUT keeps advancing — see events/channels.
--
-- CONTAINER BOUNDARY (important): one channel/event = ONE packager/encoder
-- container that ingests ALL of its primary-role source streams TOGETHER and
-- emits ONE synchronised multi-variant (MBR) HLS/DASH manifest. A package's
-- renditions are NEVER split across containers or servers — they must share a
-- timeline to stay ABR-aligned (a player switching bitrate needs segment
-- boundaries to line up). For packaging, the client's incoming renditions must
-- themselves be GOP/keyframe/timestamp aligned so the packager can line them up.
CREATE TABLE stream_inputs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id               UUID REFERENCES events(id)   ON DELETE CASCADE,
    channel_id             UUID REFERENCES channels(id) ON DELETE CASCADE,
    role                   input_role NOT NULL DEFAULT 'primary',  -- primary | backup (redundancy)
    rendition_label        TEXT,       -- e.g. '1080p' (packaging ladder); NULL for a single transcode source
    rendition_bitrate_kbps INTEGER,    -- bitrate this source stream carries (packaging)
    protocol               ingest_protocol NOT NULL,
    ingest_url             TEXT,
    stream_key             TEXT,
    status                 TEXT NOT NULL DEFAULT 'idle',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL))
);
CREATE INDEX idx_inputs_event   ON stream_inputs(event_id);
CREATE INDEX idx_inputs_channel ON stream_inputs(channel_id);

-- ---------- encoder instances (primary / standby, spot / on-demand) --------
CREATE TABLE instances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID REFERENCES events(id)   ON DELETE SET NULL,
    channel_id      UUID REFERENCES channels(id) ON DELETE SET NULL,
    ec2_instance_id TEXT,
    task_arn        TEXT,                          -- ECS task ARN of the running encoder
    instance_type   TEXT,
    is_gpu          BOOLEAN NOT NULL DEFAULT true,
    lifecycle       instance_lifecycle NOT NULL DEFAULT 'spot',
    role            instance_role NOT NULL DEFAULT 'primary',
    state           TEXT NOT NULL DEFAULT 'pending',
    availability_zone TEXT,
    launched_at     TIMESTAMPTZ,
    terminated_at   TIMESTAMPTZ,
    cost_estimate   NUMERIC(10,4),
    CHECK ((event_id IS NOT NULL) OR (channel_id IS NOT NULL))
);
CREATE INDEX idx_instances_event   ON instances(event_id);
CREATE INDEX idx_instances_channel ON instances(channel_id);

-- ---------- DVR segment index (time-addressable archive for vod-extractor) --
-- One row per segment as it lands in S3, so a wall-clock range resolves to a
-- chunk range by query (see src/services/vod-extractor.ts).
CREATE TABLE segments (
    id             BIGSERIAL PRIMARY KEY,
    event_id       UUID REFERENCES events(id)   ON DELETE CASCADE,
    channel_id     UUID REFERENCES channels(id) ON DELETE CASCADE,
    rendition_id   TEXT NOT NULL,
    seq            BIGINT NOT NULL,
    s3_key         TEXT NOT NULL,
    start_epoch_ms BIGINT NOT NULL,
    duration_ms    INTEGER NOT NULL,
    discontinuity  BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL))
);
-- range query: WHERE owner+rendition AND start_epoch_ms BETWEEN ... ORDER BY seq
CREATE INDEX idx_seg_event   ON segments(event_id,   rendition_id, start_epoch_ms);
CREATE INDEX idx_seg_channel ON segments(channel_id, rendition_id, start_epoch_ms);

-- ---------- Recordings library --------------------------------------------
-- The raw captures. In the S3-origin design the live segments ARE the
-- recording, so every event/channel with output produces one; this table is
-- the browseable index. A bounded EVENT = one row; a continuous CHANNEL is
-- sliced PER CALENDAR DAY (one row per channel per day, day_utc set). Poster /
-- storyboard / thumbs are produced by the CPU thumbnailer on completion.
CREATE TABLE recordings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           recording_kind NOT NULL,
    event_id       UUID REFERENCES events(id)   ON DELETE CASCADE,
    channel_id     UUID REFERENCES channels(id) ON DELETE CASCADE,
    title          TEXT,
    day_utc        DATE,                    -- set for channel_day recordings
    status         recording_status NOT NULL DEFAULT 'recording',
    hi_res_rendition TEXT,                  -- label of the top rendition (thumbnail source)
    master_key     TEXT,                    -- S3 prefix/manifest of the recorded segments
    start_epoch_ms BIGINT NOT NULL,
    end_epoch_ms   BIGINT,                  -- NULL while still recording
    duration_ms    BIGINT,
    retention_days INTEGER,                 -- snapshot of the rule at creation (NULL = keep forever)
    expires_at     TIMESTAMPTZ,             -- when this recording is due for deletion (NULL = never)
    poster_key     TEXT,                    -- single keyscreen still (S3)
    storyboard_key TEXT,                    -- sprite/tile sheet(s) (S3)
    thumbs_vtt_key TEXT,                    -- WebVTT thumbnails for scrubbing (S3)
    thumb_status   asset_media_status NOT NULL DEFAULT 'processing',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL)),
    CHECK (kind <> 'channel_day' OR (channel_id IS NOT NULL AND day_utc IS NOT NULL))
);
CREATE INDEX idx_rec_channel ON recordings(channel_id, day_utc);
CREATE INDEX idx_rec_event   ON recordings(event_id);
-- retention sweep: find recordings due for deletion
CREATE INDEX idx_rec_expiry  ON recordings(expires_at) WHERE expires_at IS NOT NULL;
-- one recording per channel per day
CREATE UNIQUE INDEX uq_rec_channel_day ON recordings(channel_id, day_utc)
    WHERE kind = 'channel_day';

-- ---------- Metadata schemas (named, typed field sets for VOD) --------------
-- A tenant defines multiple schemas (Movie, Episode, Clip, News, ...). Each is
-- a list of typed fields; a VOD asset is assigned one schema and its values are
-- validated against it (see src/services/metadataValidator.ts). Fields JSONB:
--   [{ "key":"genre", "label":"Genre", "type":"enum", "required":false,
--      "options":["Drama","Sport"], "multiple":true }, ...]
-- type in: string | text | number | boolean | date | enum | url | tags
CREATE TABLE metadata_schemas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    fields      JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- which entity kind this schema binds to, and its domain (sports/music/…).
    -- 'any' binds to channel|event|vod; propagate event/channel metadata → auto-VOD.
    target_kind TEXT NOT NULL DEFAULT 'vod',   -- vod | event | channel | any
    domain      TEXT,
    -- schema COMPOSITION: inherit fields from a parent, override by key.
    extends_id  UUID REFERENCES metadata_schemas(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, name)
);
CREATE INDEX idx_mdschema_account ON metadata_schemas(account_id);

-- Deferred FKs: events/channels are declared earlier than metadata_schemas, so
-- their schema_id foreign keys are attached here (same pattern as filler_asset_id).
ALTER TABLE events   ADD CONSTRAINT events_schema_fk   FOREIGN KEY (schema_id) REFERENCES metadata_schemas(id) ON DELETE SET NULL;
ALTER TABLE channels ADD CONSTRAINT channels_schema_fk FOREIGN KEY (schema_id) REFERENCES metadata_schemas(id) ON DELETE SET NULL;

-- ---------- Slates & loops (uploaded filler assets) ------------------------
-- Managed separately from VOD. A slate is a still image; a loop is a short
-- video. These are what the redundancy filler (events/channels.filler_asset_id)
-- points at, and what the encoder encodes into the ladder on total input loss.
CREATE TABLE filler_assets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind         filler_kind NOT NULL,
    name         TEXT NOT NULL,
    source_key   TEXT,                      -- S3 key of the uploaded image/video
    width        INTEGER,
    height       INTEGER,
    duration_ms  BIGINT,                    -- loops only
    poster_key   TEXT,
    status       asset_media_status NOT NULL DEFAULT 'uploading',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_filler_account ON filler_assets(account_id, kind);

-- ---------- VOD assets (derived from recordings: auto-publish / clip / export)
-- Every VOD asset is DERIVED from a recording (recording_id). Carries publishing
-- + custom metadata (schema_id + values) + its own keyscreen/storyboard.
CREATE TABLE vod_assets (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       UUID REFERENCES events(id)   ON DELETE CASCADE,
    channel_id     UUID REFERENCES channels(id) ON DELETE CASCADE,
    recording_id   UUID REFERENCES recordings(id) ON DELETE SET NULL,  -- source recording
    kind           vod_kind NOT NULL DEFAULT 'clip',
    title          TEXT,
    master_key     TEXT NOT NULL,           -- S3 key of the VOD master.m3u8
    start_epoch_ms BIGINT NOT NULL,
    end_epoch_ms   BIGINT NOT NULL,
    duration_ms    BIGINT NOT NULL,
    export_mp4_key TEXT,                     -- set once exported to MP4 (download)
    -- delivery formats: which of HLS/DASH/progressive exist for this asset
    output_kind    clip_output_kind NOT NULL DEFAULT 'manifest',
    progressive_key TEXT,                    -- S3 key of the single-file MP4 (if built)
    formats        JSONB NOT NULL DEFAULT '{"hls":true,"dash":true,"progressive":false}'::jsonb,
    portal_visible BOOLEAN NOT NULL DEFAULT false,   -- viewable in the built-in video portal
    -- composed clips: ordered source ranges stitched into one timeline. NULL for a
    -- simple single-recording asset; set when a clip spans one or more recordings.
    --   [{"recording_id":"...","start_ms":0,"end_ms":60000}, ...]
    clip_spec      JSONB,
    -- custom metadata
    schema_id      UUID REFERENCES metadata_schemas(id) ON DELETE SET NULL,
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- values, validated vs schema
    -- keyscreen / storyboard
    poster_key     TEXT,
    storyboard_key TEXT,
    thumbs_vtt_key TEXT,
    thumb_status   asset_media_status NOT NULL DEFAULT 'processing',
    published      BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL))
);
CREATE INDEX idx_vod_recording ON vod_assets(recording_id);
CREATE INDEX idx_vod_event   ON vod_assets(event_id);
CREATE INDEX idx_vod_channel ON vod_assets(channel_id);

-- Redundancy filler now points at filler_assets (slates & loops), added here
-- because filler_assets is defined after events/channels. ON DELETE SET NULL so
-- removing the asset just drops back to the default behavior.
ALTER TABLE events   ADD CONSTRAINT fk_events_filler
    FOREIGN KEY (filler_asset_id) REFERENCES filler_assets(id) ON DELETE SET NULL;
ALTER TABLE channels ADD CONSTRAINT fk_channels_filler
    FOREIGN KEY (filler_asset_id) REFERENCES filler_assets(id) ON DELETE SET NULL;

-- ---------- Scheduled clips ------------------------------------------------
-- A clipping window set on the live timeline: when end_epoch_ms is reached, the
-- orchestrator cuts the range from the channel/event recording into a VOD asset
-- (output_kind = manifest / progressive / both). vod_asset_id is set on firing.
CREATE TABLE scheduled_clips (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id     UUID REFERENCES channels(id) ON DELETE CASCADE,
    event_id       UUID REFERENCES events(id)   ON DELETE CASCADE,
    title          TEXT NOT NULL,
    start_epoch_ms BIGINT NOT NULL,
    end_epoch_ms   BIGINT NOT NULL,
    output_kind    clip_output_kind NOT NULL DEFAULT 'manifest',
    status         scheduled_clip_status NOT NULL DEFAULT 'scheduled',
    vod_asset_id   UUID REFERENCES vod_assets(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NOT NULL) <> (event_id IS NOT NULL)),
    CHECK (end_epoch_ms > start_epoch_ms)
);
CREATE INDEX idx_sclip_due ON scheduled_clips(end_epoch_ms) WHERE status = 'scheduled';
CREATE INDEX idx_sclip_channel ON scheduled_clips(channel_id);
CREATE INDEX idx_sclip_event   ON scheduled_clips(event_id);

-- ---------- Publishing: portal + social distribution -----------------------
-- publish_targets = the tenant's configured destinations (portal is implicit;
-- social platforms link to a specific account, creds in Secrets Manager).
CREATE TABLE publish_targets (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    platform          publish_platform NOT NULL,
    name              TEXT NOT NULL,                 -- display label
    external_account  TEXT,                          -- channel/page/handle id
    credentials_ref   TEXT,                          -- Secrets Manager ARN (OAuth token), NOT the token
    enabled           BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, platform, name)
);
CREATE INDEX idx_ptarget_account ON publish_targets(account_id, platform);

-- publications = one row per (asset, destination) we published to, tracking the
-- external id/url, status, and view count synced back from the platform.
CREATE TABLE publications (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vod_asset_id   UUID NOT NULL REFERENCES vod_assets(id) ON DELETE CASCADE,
    platform       publish_platform NOT NULL,
    target_id      UUID REFERENCES publish_targets(id) ON DELETE SET NULL,  -- NULL for portal
    external_id    TEXT,                          -- platform's video id
    external_url   TEXT,                          -- public watch URL
    status         publication_status NOT NULL DEFAULT 'pending',
    views          BIGINT NOT NULL DEFAULT 0,     -- synced from the platform
    error          TEXT,
    published_at   TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pub_asset ON publications(vod_asset_id);
CREATE INDEX idx_pub_platform ON publications(platform);

-- ---------- usage metering (feeds billing + pricing engine) ----------------
CREATE TABLE usage_records (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    event_id      UUID REFERENCES events(id)   ON DELETE SET NULL,
    channel_id    UUID REFERENCES channels(id) ON DELETE SET NULL,
    period_start  TIMESTAMPTZ NOT NULL,
    period_end    TIMESTAMPTZ NOT NULL,
    egress_gb     NUMERIC(14,3) NOT NULL DEFAULT 0,
    encode_minutes NUMERIC(12,2) NOT NULL DEFAULT 0,
    peak_viewers  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_usage_account ON usage_records(account_id, period_start);

-- ---------- audit log ------------------------------------------------------
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID REFERENCES accounts(id) ON DELETE SET NULL,
    user_id     UUID REFERENCES users(id)    ON DELETE SET NULL,
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   UUID,
    detail      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_account ON audit_log(account_id, created_at);

-- ---------- live stream status + event log (data plane -> admin) -----------
-- The encoder container reports here through the control-plane ingest endpoint.
--   stream_events : append-only log of every core event (channel start/stop,
--                   source up/down, failover switch, filler engaged/cleared) —
--                   the per-stream history the admin/timeline shows.
--   stream_status : ONE row per channel/event = the latest snapshot the admin
--                   dashboard renders live (is the OUTPUT still available, which
--                   INPUT sources are up, and whether a fallback is in use).
-- Scope to a tenant by joining channel_id/event_id -> group -> account.
CREATE TABLE stream_events (
    id          BIGSERIAL PRIMARY KEY,
    event_id    UUID REFERENCES events(id)   ON DELETE CASCADE,
    channel_id  UUID REFERENCES channels(id) ON DELETE CASCADE,
    seq         BIGINT,                        -- encoder-local monotonic sequence
    type        TEXT NOT NULL,                 -- channel.start | source.down | failover.switch | ...
    detail      JSONB,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),   -- encoder event time (from ts_ms)
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL))
);
CREATE INDEX idx_sev_channel ON stream_events(channel_id, id DESC);
CREATE INDEX idx_sev_event   ON stream_events(event_id, id DESC);

CREATE TABLE stream_status (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id         UUID UNIQUE REFERENCES events(id)   ON DELETE CASCADE,
    channel_id       UUID UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
    output_available BOOLEAN NOT NULL DEFAULT false,     -- manifest still advancing?
    active_source    TEXT    NOT NULL DEFAULT 'primary', -- primary | backup | filler
    fallback_in_use  BOOLEAN NOT NULL DEFAULT false,     -- active_source != primary
    filler_in_use    BOOLEAN NOT NULL DEFAULT false,     -- active_source == filler
    packager_ok      BOOLEAN NOT NULL DEFAULT false,
    sources          JSONB   NOT NULL DEFAULT '{}'::jsonb,-- per-source state map
    last_seq         BIGINT  NOT NULL DEFAULT 0,          -- guards out-of-order reports (within one run)
    boot_ms          BIGINT  NOT NULL DEFAULT 0,          -- encoder boot time; a newer boot always wins
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((event_id IS NOT NULL) <> (channel_id IS NOT NULL))
);

-- ============================================================================
-- EPG / SCHEDULING  (channel programme guide + recurrence + as-run)
-- ----------------------------------------------------------------------------
-- One canonical programme object per channel with a time SPAN. We STORE the
-- guide (map at ingest, serve materialized) rather than computing on the fly, so
-- search / conflict / rights / clipping stay fast at 100s of channels.
-- Time model: end = the NEXT entry's start; authoring may omit ends_at and we
-- resolve+store the effective end. status = plan vs as-run; actual_span carries
-- the observed airing for clipping/VOD.
-- ============================================================================
CREATE TYPE programme_status AS ENUM ('scheduled', 'live', 'aired', 'cancelled');

-- Recurring series (iCal RRULE) whose instances are MATERIALIZED into programmes.
CREATE TABLE programme_series (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    rrule       TEXT NOT NULL,                          -- e.g. FREQ=DAILY;BYHOUR=16;BYMINUTE=30
    duration_ms BIGINT NOT NULL,                        -- each instance's length
    dtstart     TIMESTAMPTZ NOT NULL,
    template    JSONB NOT NULL DEFAULT '{}'::jsonb,     -- metadata/asset applied to each instance
    materialized_until TIMESTAMPTZ,                     -- rolling horizon watermark
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_series_channel ON programme_series(channel_id);

CREATE TABLE programmes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    series_id   UUID REFERENCES programme_series(id) ON DELETE SET NULL,
    source_ref  TEXT,                                   -- idempotent upsert key (import diff)
    title       TEXT NOT NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,                   -- resolved effective end (stored)
    -- generated range for overlap/conflict + now/next (GiST-indexed)
    span        TSTZRANGE GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
    status      programme_status NOT NULL DEFAULT 'scheduled',
    -- as-run: observed airing (preferred for clipping/VOD when present)
    actual_start TIMESTAMPTZ,
    actual_end   TIMESTAMPTZ,
    -- geo / rights per programme (blackout / replacement) — evaluated at the edge
    geo_mode     TEXT NOT NULL DEFAULT 'worldwide',     -- worldwide | allow | block
    geo_countries TEXT[] NOT NULL DEFAULT '{}',
    replacement_asset_id UUID,                          -- shown in blocked regions (-> vod_assets/filler)
    auto_vod     BOOLEAN NOT NULL DEFAULT false,        -- Live->VOD on airing end
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX idx_prog_channel_start ON programmes(channel_id, starts_at);
CREATE INDEX idx_prog_span_gist     ON programmes USING gist (span);
CREATE INDEX idx_prog_search        ON programmes USING gin (to_tsvector('simple', title));
CREATE UNIQUE INDEX idx_prog_source ON programmes(channel_id, source_ref) WHERE source_ref IS NOT NULL;

-- ============================================================================
-- API KEYS & APPS  (keyed access: playback/access + management)
-- ----------------------------------------------------------------------------
-- To use the APIs (playback + access) a caller registers an APP and includes a
-- key. Two kinds: a server-side ACCOUNT/SECRET key (sk_live_…, management scope)
-- and a client-safe per-app PUBLISHABLE key (pk_…, playback/access scope). The
-- publishable key IDENTIFIES; security is the per-app RESTRICTION (referrer /
-- bundle id / package sig / IP allow-list) + a short-lived playback token minted
-- by /availability and validated at the edge. Only key HASHES are stored.
-- ============================================================================
CREATE TYPE api_key_kind AS ENUM ('secret', 'publishable');
CREATE TYPE app_type     AS ENUM ('web', 'ios', 'android', 'tv', 'roku', 'server');

CREATE TABLE apps (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    type         app_type NOT NULL,
    -- type-specific restriction set (security is the restriction, not key secrecy):
    --   web:{referrers:[]}, ios:{bundleId}, android:{package,sha256:[]},
    --   tv/roku:{appId,platforms:[]}, server:{ipAllowlist:[]}
    restrictions JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_apps_account ON apps(account_id);

CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    app_id       UUID REFERENCES apps(id) ON DELETE CASCADE,   -- null for account/secret keys
    kind         api_key_kind NOT NULL,
    key_prefix   TEXT NOT NULL,                                 -- shown for identification (e.g. pk_live_ab12…)
    key_hash     TEXT NOT NULL,                                 -- sha256 of the full key (never the raw key)
    scopes       TEXT[] NOT NULL DEFAULT '{}',                  -- e.g. {playback} or {management}
    enabled      BOOLEAN NOT NULL DEFAULT true,
    last_used_at TIMESTAMPTZ,
    request_count BIGINT NOT NULL DEFAULT 0,                    -- lightweight per-key metering
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (key_hash)
);
CREATE INDEX idx_apikeys_prefix  ON api_keys(key_prefix);
CREATE INDEX idx_apikeys_account ON api_keys(account_id);

-- ============================================================================
-- SAAS PLATFORM LAYER  (analytics serving store · platform roles · tickets · SSO)
-- ----------------------------------------------------------------------------
-- Data-store split (see docs/SAAS_ARCHITECTURE.md): Postgres holds structured app
-- data + the analytics SERVING layer (sessions + rollups). The raw per-request
-- firehose lives in S3/Athena; realtime concurrency in Redis/Timestream (mirrored
-- here as stream_concurrency for the initial build). Everything tenant-scoped.
-- ============================================================================

-- Platform (SaaS-provider) staff scope, distinct from a tenant's own user roles.
CREATE TYPE platform_role AS ENUM ('saas_admin', 'support', 'read_only');
ALTER TABLE users ADD COLUMN platform_role platform_role;   -- NULL = normal tenant user

-- ---- Analytics serving layer ----------------------------------------------
-- One row per viewing SESSION (keyed by the playback-token session id minted at
-- /availability). Player-agnostic: updated from CDN-log heartbeats / beacons.
CREATE TABLE play_sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    session_key   TEXT NOT NULL,                              -- session id from the playback token
    app_id        UUID REFERENCES apps(id) ON DELETE SET NULL,-- authoritative "by app" dimension
    asset_kind    TEXT NOT NULL,                              -- channel | event | vod
    asset_id      TEXT NOT NULL,
    device_type   TEXT,                                       -- Mobile|Tablet|Desktop|TV|Unknown (UA)
    client_app    TEXT,                                       -- player software (UA) — best-effort, secondary
    referrer_class TEXT,                                      -- native-app|web|datacenter-vpn|unknown
    geo_country   TEXT,
    ip_hash       TEXT,                                       -- hashed/truncated for privacy
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ,
    seconds_watched INTEGER NOT NULL DEFAULT 0,
    max_bitrate_kbps INTEGER,
    ttff_ms       INTEGER,                                    -- QoS: time-to-first-frame proxy
    rebuffer_ms   INTEGER NOT NULL DEFAULT 0,
    bytes         BIGINT NOT NULL DEFAULT 0,
    blocked       BOOLEAN NOT NULL DEFAULT false,             -- geo/rights blocked attempt
    UNIQUE (account_id, session_key)
);
CREATE INDEX idx_sessions_asset   ON play_sessions(account_id, asset_kind, asset_id);
CREATE INDEX idx_sessions_lastseen ON play_sessions(asset_kind, asset_id, last_seen_at);
CREATE INDEX idx_sessions_app     ON play_sessions(account_id, app_id);

-- Rolling realtime concurrency snapshot per stream (mirror of Redis/Timestream).
CREATE TABLE stream_concurrency (
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    asset_kind   TEXT NOT NULL,
    asset_id     TEXT NOT NULL,
    concurrent   INTEGER NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_kind, asset_id)
);

-- Historical aggregates (per program/channel/account per day) — dashboard reads.
CREATE TABLE analytics_rollups (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL,                               -- account | channel | event | program
    scope_id     TEXT,
    bucket_date  DATE NOT NULL,
    total_views  BIGINT NOT NULL DEFAULT 0,
    unique_views BIGINT NOT NULL DEFAULT 0,
    peak_concurrent INTEGER NOT NULL DEFAULT 0,
    watch_seconds BIGINT NOT NULL DEFAULT 0,
    blocked_count BIGINT NOT NULL DEFAULT 0,
    by_app       JSONB NOT NULL DEFAULT '{}'::jsonb,          -- {app_id: views}
    by_device    JSONB NOT NULL DEFAULT '{}'::jsonb,
    by_geo       JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (account_id, scope, scope_id, bucket_date)
);
CREATE INDEX idx_rollups_account ON analytics_rollups(account_id, bucket_date);

-- ---- Support tickets -------------------------------------------------------
CREATE TYPE ticket_status   AS ENUM ('open', 'pending', 'resolved', 'closed');
CREATE TYPE ticket_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TABLE support_tickets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    opened_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    subject      TEXT NOT NULL,
    body         TEXT,
    status       ticket_status NOT NULL DEFAULT 'open',
    priority     ticket_priority NOT NULL DEFAULT 'normal',
    assignee_id  UUID REFERENCES users(id) ON DELETE SET NULL,  -- platform staff
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_account ON support_tickets(account_id, status);
CREATE INDEX idx_tickets_status  ON support_tickets(status);

-- ---- SSO / identity providers (OIDC) — schema + plan (flow built next) -----
CREATE TYPE idp_kind AS ENUM ('oidc', 'saml');
CREATE TABLE identity_providers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL = platform-level (SaaS staff)
    kind         idp_kind NOT NULL DEFAULT 'oidc',
    provider     TEXT NOT NULL,                                   -- google | microsoft | okta
    issuer       TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    secret_ref   TEXT,                                            -- Secrets Manager ARN (never the secret)
    domains      TEXT[] NOT NULL DEFAULT '{}',                    -- email domains that auto-route to this IdP
    enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_idp_account ON identity_providers(account_id);

-- Increment obj[key] by 1 (for analytics by_app/by_device/by_geo rollup maps).
CREATE OR REPLACE FUNCTION jsonb_bump(obj jsonb, key text) RETURNS jsonb AS $$
  SELECT jsonb_set(COALESCE(obj, '{}'::jsonb), ARRAY[key],
                   to_jsonb(COALESCE((obj->>key)::bigint, 0) + 1));
$$ LANGUAGE sql IMMUTABLE;

-- ============================================================================
-- SUB-ACCOUNTS + SaaS-admin MFA  (schema + scoping; full wiring is a follow-up)
-- ----------------------------------------------------------------------------
-- Sub-accounts: an account may have a parent. Tenant scoping resolves the SUBTREE
-- so a parent-account admin can see its children, while a sub-account sees only
-- itself. The recursive descendants are computed by services/tenancy.ts.
ALTER TABLE accounts ADD COLUMN parent_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX idx_accounts_parent ON accounts(parent_account_id);

-- ----------------------------------------------------------------------------
-- CAPTIONS master toggle (per overall account)
-- ----------------------------------------------------------------------------
-- Captions/transcription/translation is an OPTIONAL feature decided per account.
-- captions_provider is the master switch: 'none' disables it entirely (a profile's
-- captions_enabled is then ignored); 'whisper' uses the self-hosted faster-whisper
-- engine (no per-minute cost; native X->English translation, other targets need MT);
-- 'gladia' uses the paid streaming STT+MT provider. Each output_profile still opts
-- in via captions_enabled and may name an engine, but it falls back to this default
-- and can never exceed what the account has enabled.
ALTER TABLE accounts ADD COLUMN captions_provider TEXT NOT NULL DEFAULT 'none'
    CHECK (captions_provider IN ('none','whisper','gladia'));

-- SaaS-admin MFA (two-step login): platform staff must complete TOTP after the
-- password step. mfa_secret_ref points at the TOTP secret in Secrets Manager
-- (never the raw secret in the DB). Enforced for users with a platform_role.
ALTER TABLE users ADD COLUMN mfa_enabled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN mfa_secret_ref TEXT;
-- human display name for "shared by ..." attribution on share pages (falls back to email)
ALTER TABLE users ADD COLUMN display_name TEXT;

-- ----------------------------------------------------------------------------
-- SHARE LINKS  (time-limited, standalone, single-resource preview pages)
-- ----------------------------------------------------------------------------
-- A share link is a self-contained, time-boxed grant to view ONE asset on an
-- isolated standalone page (no console, no other views, no login). The raw token
-- is shown once at creation and only its sha256 is stored (same model as api_keys).
-- The public /share/:token surface resolves ONLY this resource and never accepts
-- an admin credential, so a leaked link can reach nothing else in the account.
CREATE TYPE share_resource_kind AS ENUM ('vod', 'channel', 'event');
CREATE TYPE share_access_type   AS ENUM ('preview_only', 'allow_download');

CREATE TABLE share_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    resource_kind   share_resource_kind NOT NULL,
    resource_id     UUID NOT NULL,                 -- vod_assets.id / channels.id / events.id
    token_prefix    TEXT NOT NULL,                 -- first chars, for display/lookup
    token_hash      TEXT NOT NULL UNIQUE,          -- sha256 of the raw token
    label           TEXT,                          -- internal label
    message         TEXT,                          -- note shown to the recipient
    recipients      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- emails the link was sent to
    access_type     share_access_type NOT NULL DEFAULT 'preview_only',
    allow_hi_res    BOOLEAN NOT NULL DEFAULT false, -- downloadable elements (when allow_download)
    allow_player    BOOLEAN NOT NULL DEFAULT false,
    allow_metadata  BOOLEAN NOT NULL DEFAULT false,
    watermark       BOOLEAN NOT NULL DEFAULT true,  -- preview watermarked to the link
    notify_on_open  BOOLEAN NOT NULL DEFAULT false, -- email creator on first open
    pin_hash        TEXT,                           -- optional PIN gate (sha256), null = none
    auth_mode       TEXT NOT NULL DEFAULT 'none',   -- none | pin (creator-set) | email_pin (emailed one-time PIN)
    verify_code_hash TEXT,                          -- sha256 of the emailed one-time PIN
    verify_email    TEXT,                           -- recipient email the PIN went to
    verify_expires_at TIMESTAMPTZ,                  -- emailed PIN validity window
    expires_at      TIMESTAMPTZ NOT NULL,           -- hard stop; link dies after this
    max_views       INTEGER,                        -- optional view cap (null = unlimited)
    view_count      INTEGER NOT NULL DEFAULT 0,
    first_opened_at TIMESTAMPTZ,                     -- set on first successful open
    last_viewed_at  TIMESTAMPTZ,
    revoked         BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_share_links_account  ON share_links(account_id);
CREATE INDEX idx_share_links_resource ON share_links(resource_kind, resource_id);
CREATE INDEX idx_share_links_prefix   ON share_links(token_prefix);

-- ============================================================================
-- NOTIFICATIONS  (reusable: event reminders, alerts, publishing, expiry)
-- ----------------------------------------------------------------------------
-- One logical notification fans out to per-recipient × per-channel DELIVERIES
-- with independent status + retry. Channels: email / in_app / push (device
-- management app). Templated with {{var}} substitution from the payload.
-- ============================================================================
CREATE TYPE notification_channel AS ENUM ('email', 'in_app', 'push');
CREATE TYPE delivery_status      AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE notification_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,                       -- e.g. 'event.reminder'
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, key)
);

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    topic       TEXT NOT NULL,                        -- event.reminder | alert | publish | expiry | …
    subject     TEXT NOT NULL,
    body        TEXT,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_account ON notifications(account_id, created_at DESC);

CREATE TABLE notification_deliveries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    recipient     TEXT NOT NULL,                      -- email / user id / device token
    channel       notification_channel NOT NULL,
    status        delivery_status NOT NULL DEFAULT 'pending',
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    read_at       TIMESTAMPTZ,                         -- for in-app inbox
    sent_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_deliv_notif  ON notification_deliveries(notification_id);
CREATE INDEX idx_deliv_inbox  ON notification_deliveries(account_id, recipient, channel) WHERE channel='in_app';
CREATE INDEX idx_deliv_status ON notification_deliveries(status) WHERE status='failed';

-- ============================================================================
-- EDIT + AUDIT FOUNDATION  (optimistic concurrency + who created / changed)
-- ----------------------------------------------------------------------------
-- Every editable record carries a monotonically increasing `version` (used as an
-- ETag for optimistic concurrency so two editors can't silently clobber), plus
-- `created_by` / `updated_by` (the acting user; NULL when a system/API-key made the
-- change — the API-key actor is recorded in audit_log.detail). The per-change diff
-- (which fields changed, from -> to, by whom, when) is written to audit_log by the
-- shared patchEntity()/writeAudit() service. Same pattern extends to any resource.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channels','events','metadata_schemas','output_profiles','groups'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS version    INTEGER NOT NULL DEFAULT 1', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL', t);
  END LOOP;
END $$;

-- ============================================================================
-- CHANNEL DVR WINDOW + SOURCE GEO RULES
-- ----------------------------------------------------------------------------
-- Per-channel DVR (catch-up / scrub-back) window, overriding the output profile's
-- default sliding window. Capped at 4h (14400s) for 24x7 channels — the encoder
-- keeps at most this much live archive addressable for scrub-back. `dvr_mode`:
--   'sliding'      -> rolling window of dvr_window_sec ending at the live edge (24x7)
--   'event_start'  -> scrub back to the start of the event stream (events; the
--                     window grows with the event, no fixed cap)
-- Source geo rules gate where the *source/output* may be consumed, evaluated at the
-- edge (same worldwide|allow|block grammar used per-programme).
DO $$
BEGIN
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS dvr_window_sec INTEGER;              -- NULL -> use profile default
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS dvr_mode       TEXT NOT NULL DEFAULT 'sliding';
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS geo_mode       TEXT NOT NULL DEFAULT 'worldwide';
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS geo_countries  TEXT[] NOT NULL DEFAULT '{}';
  -- guard rails
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_dvr_window_max') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_dvr_window_max
      CHECK (dvr_window_sec IS NULL OR (dvr_window_sec BETWEEN 30 AND 14400));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_dvr_mode_chk') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_dvr_mode_chk CHECK (dvr_mode IN ('sliding','event_start'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_geo_mode_chk') THEN
    ALTER TABLE channels ADD CONSTRAINT channels_geo_mode_chk CHECK (geo_mode IN ('worldwide','allow','block'));
  END IF;
END $$;

-- ============================================================================
-- PER-CHANNEL OUTPUT LADDER + FALLBACK TRANSCODE
-- ----------------------------------------------------------------------------
-- output_ladder: the rendition ladder for THIS channel.
--   transcode    -> the rungs we encode the single source into (user-selected).
--   package_only -> mirror of the sent renditions (for reference/validation).
-- fallback_transcode: package_only only — when the sent ladder is lost and the
--   fallback is a single source/slate/loop, transcode it up to ALL matching
--   bitrates so every output rendition stays continuous.
DO $$
BEGIN
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS output_ladder      JSONB;
  ALTER TABLE channels ADD COLUMN IF NOT EXISTS fallback_transcode BOOLEAN NOT NULL DEFAULT false;
END $$;

-- ============================================================================
-- IMAGE LIBRARY (file manager) — curated images: watermarks, slates, posters,
-- channel brands. Hierarchical (path/folder), searchable (name/tags/kind), backed
-- by the image store (local dir or S3). Bytes live in the store; this is the index.
-- Generated keyframes/storyboards live under a separate 'derived/' store prefix,
-- not here.
CREATE TABLE IF NOT EXISTS media_files (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'other',   -- watermark | slate | poster | brand | keyframe | other
    path         TEXT NOT NULL,                   -- hierarchical key, e.g. 'slates/news/evening.png'
    folder       TEXT NOT NULL DEFAULT '',        -- parent folder ('' = root), e.g. 'slates/news'
    name         TEXT NOT NULL,
    content_type TEXT,
    size_bytes   BIGINT,
    width        INTEGER,
    height       INTEGER,
    tags         TEXT[] NOT NULL DEFAULT '{}',
    store_key    TEXT NOT NULL,                   -- key within the image store backend
    status       asset_media_status NOT NULL DEFAULT 'ready',
    version      INTEGER NOT NULL DEFAULT 1,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, path)
);
CREATE INDEX IF NOT EXISTS idx_media_files_account ON media_files(account_id);
CREATE INDEX IF NOT EXISTS idx_media_files_folder  ON media_files(account_id, folder);
CREATE INDEX IF NOT EXISTS idx_media_files_kind    ON media_files(account_id, kind);

-- explicit (possibly empty) folders, so a hierarchy can exist before it has files
CREATE TABLE IF NOT EXISTS media_folders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,                    -- 'slates/news'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, path)
);
