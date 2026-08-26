--
-- PostgreSQL database dump
--

\restrict VkN6MYGDm0c76ubnUj5EPp2cfw7jhvFu0FOV2IxVBVFLEmE50gUIobLznfFhL6o

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: api_key_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.api_key_kind AS ENUM (
    'secret',
    'publishable'
);


--
-- Name: app_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_type AS ENUM (
    'web',
    'ios',
    'android',
    'tv',
    'roku',
    'server'
);


--
-- Name: asset_media_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.asset_media_status AS ENUM (
    'uploading',
    'processing',
    'ready',
    'error'
);


--
-- Name: asset_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.asset_status AS ENUM (
    'scheduled',
    'provisioning',
    'testing',
    'live',
    'stopping',
    'ended',
    'error'
);


--
-- Name: billing_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.billing_mode AS ENUM (
    'per_channel',
    'per_event',
    'enterprise'
);


--
-- Name: clip_output_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.clip_output_kind AS ENUM (
    'manifest',
    'progressive',
    'both'
);


--
-- Name: codec_backend; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.codec_backend AS ENUM (
    'x264',
    'nvenc'
);


--
-- Name: delivery_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_status AS ENUM (
    'pending',
    'sent',
    'failed'
);


--
-- Name: drm_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.drm_provider AS ENUM (
    'axinom'
);


--
-- Name: drm_scheme; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.drm_scheme AS ENUM (
    'cbcs',
    'cenc'
);


--
-- Name: filler_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.filler_kind AS ENUM (
    'slate',
    'loop'
);


--
-- Name: idp_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idp_kind AS ENUM (
    'oidc',
    'saml'
);


--
-- Name: ingest_protocol; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ingest_protocol AS ENUM (
    'srt',
    'rtmp',
    'rtmps',
    'hls',
    'dash',
    'ndi',
    'st2110'
);


--
-- Name: input_loss_behavior; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.input_loss_behavior AS ENUM (
    'none',
    'slate',
    'vod_loop',
    'last_frame',
    'black'
);


--
-- Name: input_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.input_role AS ENUM (
    'primary',
    'backup'
);


--
-- Name: instance_lifecycle; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.instance_lifecycle AS ENUM (
    'spot',
    'on_demand'
);


--
-- Name: instance_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.instance_role AS ENUM (
    'primary',
    'standby',
    'captions'
);


--
-- Name: notification_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel AS ENUM (
    'email',
    'in_app',
    'push'
);


--
-- Name: packaging_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.packaging_kind AS ENUM (
    'hls',
    'dash',
    'both'
);


--
-- Name: platform_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.platform_role AS ENUM (
    'saas_admin',
    'support',
    'read_only'
);


--
-- Name: programme_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.programme_status AS ENUM (
    'scheduled',
    'live',
    'aired',
    'cancelled'
);


--
-- Name: publication_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.publication_status AS ENUM (
    'pending',
    'published',
    'failed',
    'removed'
);


--
-- Name: publish_platform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.publish_platform AS ENUM (
    'portal',
    'youtube',
    'facebook',
    'x',
    'tiktok',
    'dailymotion'
);


--
-- Name: purchasing_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.purchasing_mode AS ENUM (
    'on_demand',
    'reserved',
    'spot_fallback'
);


--
-- Name: recording_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.recording_kind AS ENUM (
    'event',
    'channel_day'
);


--
-- Name: recording_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.recording_status AS ENUM (
    'recording',
    'complete',
    'error'
);


--
-- Name: resilience_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.resilience_tier AS ENUM (
    'standard',
    'resilient_input',
    'full_redundancy'
);


--
-- Name: scheduled_clip_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.scheduled_clip_status AS ENUM (
    'scheduled',
    'firing',
    'done',
    'error',
    'cancelled'
);


--
-- Name: share_access_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.share_access_type AS ENUM (
    'preview_only',
    'allow_download'
);


--
-- Name: share_resource_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.share_resource_kind AS ENUM (
    'vod',
    'channel',
    'event'
);


--
-- Name: ticket_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_priority AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);


--
-- Name: ticket_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_status AS ENUM (
    'open',
    'pending',
    'resolved',
    'closed'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'owner',
    'admin',
    'operator',
    'viewer'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'invited',
    'disabled'
);


--
-- Name: vod_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.vod_kind AS ENUM (
    'clip',
    'full_event',
    'export'
);


--
-- Name: workflow_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workflow_type AS ENUM (
    'transcode',
    'package_only'
);


--
-- Name: jsonb_bump(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_bump(obj jsonb, key text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT jsonb_set(COALESCE(obj, '{}'::jsonb), ARRAY[key],
                   to_jsonb(COALESCE((obj->>key)::bigint, 0) + 1));
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    plan_tier text DEFAULT 'standard'::text NOT NULL,
    billing_mode public.billing_mode DEFAULT 'enterprise'::public.billing_mode NOT NULL,
    included_gb integer DEFAULT 0 NOT NULL,
    markup_pct numeric(5,4) DEFAULT 0.50 NOT NULL,
    subscription_fee_month numeric(10,2) DEFAULT 0 NOT NULL,
    max_channels integer DEFAULT 5 NOT NULL,
    max_concurrent_sources integer DEFAULT 3 NOT NULL,
    max_renditions integer DEFAULT 5 NOT NULL,
    max_asset_hours integer DEFAULT 12 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_account_id uuid,
    captions_provider text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT accounts_captions_provider_check CHECK ((captions_provider = ANY (ARRAY['none'::text, 'whisper'::text, 'gladia'::text])))
);


--
-- Name: analytics_rollups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_rollups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope text NOT NULL,
    scope_id text,
    bucket_date date NOT NULL,
    total_views bigint DEFAULT 0 NOT NULL,
    unique_views bigint DEFAULT 0 NOT NULL,
    peak_concurrent integer DEFAULT 0 NOT NULL,
    watch_seconds bigint DEFAULT 0 NOT NULL,
    blocked_count bigint DEFAULT 0 NOT NULL,
    by_app jsonb DEFAULT '{}'::jsonb NOT NULL,
    by_device jsonb DEFAULT '{}'::jsonb NOT NULL,
    by_geo jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    app_id uuid,
    kind public.api_key_kind NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_used_at timestamp with time zone,
    request_count bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    type public.app_type NOT NULL,
    restrictions jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    user_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id uuid,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    status public.asset_status DEFAULT 'scheduled'::public.asset_status NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    purchasing_mode public.purchasing_mode DEFAULT 'reserved'::public.purchasing_mode NOT NULL,
    resilience_tier public.resilience_tier DEFAULT 'standard'::public.resilience_tier NOT NULL,
    input_failover_enabled boolean DEFAULT false NOT NULL,
    auto_failback boolean DEFAULT true NOT NULL,
    input_loss_behavior public.input_loss_behavior DEFAULT 'none'::public.input_loss_behavior NOT NULL,
    filler_asset_id uuid,
    filler_slate_ref text,
    recording_retention_days integer,
    schema_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    dvr_window_sec integer,
    dvr_mode text DEFAULT 'sliding'::text NOT NULL,
    geo_mode text DEFAULT 'worldwide'::text NOT NULL,
    geo_countries text[] DEFAULT '{}'::text[] NOT NULL,
    output_ladder jsonb,
    fallback_transcode boolean DEFAULT false NOT NULL,
    CONSTRAINT channels_dvr_mode_chk CHECK ((dvr_mode = ANY (ARRAY['sliding'::text, 'event_start'::text]))),
    CONSTRAINT channels_dvr_window_max CHECK (((dvr_window_sec IS NULL) OR ((dvr_window_sec >= 30) AND (dvr_window_sec <= 14400)))),
    CONSTRAINT channels_geo_mode_chk CHECK ((geo_mode = ANY (ARRAY['worldwide'::text, 'allow'::text, 'block'::text])))
);


--
-- Name: drm_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drm_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider public.drm_provider DEFAULT 'axinom'::public.drm_provider NOT NULL,
    scheme public.drm_scheme DEFAULT 'cbcs'::public.drm_scheme NOT NULL,
    systems jsonb DEFAULT '["widevine", "playready", "fairplay"]'::jsonb NOT NULL,
    tenant_id text NOT NULL,
    key_service_url text NOT NULL,
    license_service_url text NOT NULL,
    management_key_ref text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    status public.asset_status DEFAULT 'scheduled'::public.asset_status NOT NULL,
    scheduled_start timestamp with time zone NOT NULL,
    scheduled_end timestamp with time zone NOT NULL,
    server_start timestamp with time zone,
    server_stop timestamp with time zone,
    public_start timestamp with time zone,
    public_end timestamp with time zone,
    actual_start timestamp with time zone,
    actual_end timestamp with time zone,
    purchasing_mode public.purchasing_mode DEFAULT 'spot_fallback'::public.purchasing_mode NOT NULL,
    resilience_tier public.resilience_tier DEFAULT 'standard'::public.resilience_tier NOT NULL,
    input_failover_enabled boolean DEFAULT false NOT NULL,
    auto_failback boolean DEFAULT true NOT NULL,
    input_loss_behavior public.input_loss_behavior DEFAULT 'none'::public.input_loss_behavior NOT NULL,
    filler_asset_id uuid,
    filler_slate_ref text,
    recording_retention_days integer,
    schema_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT events_check CHECK ((scheduled_end > scheduled_start)),
    CONSTRAINT events_check1 CHECK (((server_stop IS NULL) OR (server_start IS NULL) OR (server_stop > server_start))),
    CONSTRAINT events_check2 CHECK (((public_end IS NULL) OR (public_start IS NULL) OR (public_end > public_start)))
);


--
-- Name: filler_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filler_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    kind public.filler_kind NOT NULL,
    name text NOT NULL,
    source_key text,
    width integer,
    height integer,
    duration_ms bigint,
    poster_key text,
    status public.asset_media_status DEFAULT 'uploading'::public.asset_media_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    output_profile_id uuid,
    max_concurrent integer DEFAULT 3 NOT NULL,
    max_channels integer DEFAULT 5 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid
);


--
-- Name: identity_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    kind public.idp_kind DEFAULT 'oidc'::public.idp_kind NOT NULL,
    provider text NOT NULL,
    issuer text NOT NULL,
    client_id text NOT NULL,
    secret_ref text,
    domains text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid,
    channel_id uuid,
    ec2_instance_id text,
    task_arn text,
    instance_type text,
    is_gpu boolean DEFAULT true NOT NULL,
    lifecycle public.instance_lifecycle DEFAULT 'spot'::public.instance_lifecycle NOT NULL,
    role public.instance_role DEFAULT 'primary'::public.instance_role NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    availability_zone text,
    launched_at timestamp with time zone,
    terminated_at timestamp with time zone,
    cost_estimate numeric(10,4),
    CONSTRAINT instances_check CHECK (((event_id IS NOT NULL) OR (channel_id IS NOT NULL)))
);


--
-- Name: media_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    kind text DEFAULT 'other'::text NOT NULL,
    path text NOT NULL,
    folder text DEFAULT ''::text NOT NULL,
    name text NOT NULL,
    content_type text,
    size_bytes bigint,
    width integer,
    height integer,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    store_key text NOT NULL,
    status public.asset_media_status DEFAULT 'ready'::public.asset_media_status NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: metadata_schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metadata_schemas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    target_kind text DEFAULT 'vod'::text NOT NULL,
    domain text,
    extends_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    account_id uuid NOT NULL,
    recipient text NOT NULL,
    channel public.notification_channel NOT NULL,
    status public.delivery_status DEFAULT 'pending'::public.delivery_status NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    read_at timestamp with time zone,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    key text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    topic text NOT NULL,
    subject text NOT NULL,
    body text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: output_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.output_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    rungs jsonb NOT NULL,
    packaging public.packaging_kind DEFAULT 'both'::public.packaging_kind NOT NULL,
    workflow_type public.workflow_type DEFAULT 'transcode'::public.workflow_type NOT NULL,
    codec_backend public.codec_backend DEFAULT 'nvenc'::public.codec_backend NOT NULL,
    segment_dur numeric(4,2) DEFAULT 4.00 NOT NULL,
    dvr_window_sec integer DEFAULT 300 NOT NULL,
    retention_days integer DEFAULT 30 NOT NULL,
    overlays jsonb DEFAULT '[]'::jsonb NOT NULL,
    drm_enabled boolean DEFAULT false NOT NULL,
    drm_config_id uuid,
    captions_enabled boolean DEFAULT false NOT NULL,
    caption_engine text DEFAULT 'gladia'::text NOT NULL,
    caption_source_lang text DEFAULT 'auto'::text NOT NULL,
    caption_targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    caption_offset_sec integer DEFAULT 0 NOT NULL,
    caption_model_size text DEFAULT 'small'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid
);


--
-- Name: play_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.play_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    session_key text NOT NULL,
    app_id uuid,
    asset_kind text NOT NULL,
    asset_id text NOT NULL,
    device_type text,
    client_app text,
    referrer_class text,
    geo_country text,
    ip_hash text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    seconds_watched integer DEFAULT 0 NOT NULL,
    max_bitrate_kbps integer,
    ttff_ms integer,
    rebuffer_ms integer DEFAULT 0 NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    blocked boolean DEFAULT false NOT NULL
);


--
-- Name: programme_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.programme_series (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    title text NOT NULL,
    rrule text NOT NULL,
    duration_ms bigint NOT NULL,
    dtstart timestamp with time zone NOT NULL,
    template jsonb DEFAULT '{}'::jsonb NOT NULL,
    materialized_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: programmes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.programmes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    series_id uuid,
    source_ref text,
    title text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    span tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)'::text)) STORED,
    status public.programme_status DEFAULT 'scheduled'::public.programme_status NOT NULL,
    actual_start timestamp with time zone,
    actual_end timestamp with time zone,
    geo_mode text DEFAULT 'worldwide'::text NOT NULL,
    geo_countries text[] DEFAULT '{}'::text[] NOT NULL,
    replacement_asset_id uuid,
    auto_vod boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT programmes_check CHECK ((ends_at > starts_at))
);


--
-- Name: publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vod_asset_id uuid NOT NULL,
    platform public.publish_platform NOT NULL,
    target_id uuid,
    external_id text,
    external_url text,
    status public.publication_status DEFAULT 'pending'::public.publication_status NOT NULL,
    views bigint DEFAULT 0 NOT NULL,
    error text,
    published_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: publish_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publish_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    platform public.publish_platform NOT NULL,
    name text NOT NULL,
    external_account text,
    credentials_ref text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recordings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind public.recording_kind NOT NULL,
    event_id uuid,
    channel_id uuid,
    title text,
    day_utc date,
    status public.recording_status DEFAULT 'recording'::public.recording_status NOT NULL,
    hi_res_rendition text,
    master_key text,
    start_epoch_ms bigint NOT NULL,
    end_epoch_ms bigint,
    duration_ms bigint,
    retention_days integer,
    expires_at timestamp with time zone,
    poster_key text,
    storyboard_key text,
    thumbs_vtt_key text,
    thumb_status public.asset_media_status DEFAULT 'processing'::public.asset_media_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recordings_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL))),
    CONSTRAINT recordings_check1 CHECK (((kind <> 'channel_day'::public.recording_kind) OR ((channel_id IS NOT NULL) AND (day_utc IS NOT NULL))))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduled_clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_clips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid,
    event_id uuid,
    title text NOT NULL,
    start_epoch_ms bigint NOT NULL,
    end_epoch_ms bigint NOT NULL,
    output_kind public.clip_output_kind DEFAULT 'manifest'::public.clip_output_kind NOT NULL,
    status public.scheduled_clip_status DEFAULT 'scheduled'::public.scheduled_clip_status NOT NULL,
    vod_asset_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_clips_check CHECK (((channel_id IS NOT NULL) <> (event_id IS NOT NULL))),
    CONSTRAINT scheduled_clips_check1 CHECK ((end_epoch_ms > start_epoch_ms))
);


--
-- Name: segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segments (
    id bigint NOT NULL,
    event_id uuid,
    channel_id uuid,
    rendition_id text NOT NULL,
    seq bigint NOT NULL,
    s3_key text NOT NULL,
    start_epoch_ms bigint NOT NULL,
    duration_ms integer NOT NULL,
    discontinuity boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT segments_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL)))
);


--
-- Name: segments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.segments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: segments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.segments_id_seq OWNED BY public.segments.id;


--
-- Name: share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    resource_kind public.share_resource_kind NOT NULL,
    resource_id uuid NOT NULL,
    token_prefix text NOT NULL,
    token_hash text NOT NULL,
    label text,
    message text,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    access_type public.share_access_type DEFAULT 'preview_only'::public.share_access_type NOT NULL,
    allow_hi_res boolean DEFAULT false NOT NULL,
    allow_player boolean DEFAULT false NOT NULL,
    allow_metadata boolean DEFAULT false NOT NULL,
    watermark boolean DEFAULT true NOT NULL,
    notify_on_open boolean DEFAULT false NOT NULL,
    pin_hash text,
    expires_at timestamp with time zone NOT NULL,
    max_views integer,
    view_count integer DEFAULT 0 NOT NULL,
    first_opened_at timestamp with time zone,
    last_viewed_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stream_concurrency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_concurrency (
    account_id uuid NOT NULL,
    asset_kind text NOT NULL,
    asset_id text NOT NULL,
    concurrent integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stream_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_events (
    id bigint NOT NULL,
    event_id uuid,
    channel_id uuid,
    seq bigint,
    type text NOT NULL,
    detail jsonb,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stream_events_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL)))
);


--
-- Name: stream_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stream_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stream_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stream_events_id_seq OWNED BY public.stream_events.id;


--
-- Name: stream_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_inputs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid,
    channel_id uuid,
    role public.input_role DEFAULT 'primary'::public.input_role NOT NULL,
    rendition_label text,
    rendition_bitrate_kbps integer,
    protocol public.ingest_protocol NOT NULL,
    ingest_url text,
    stream_key text,
    status text DEFAULT 'idle'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stream_inputs_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL)))
);


--
-- Name: stream_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid,
    channel_id uuid,
    output_available boolean DEFAULT false NOT NULL,
    active_source text DEFAULT 'primary'::text NOT NULL,
    fallback_in_use boolean DEFAULT false NOT NULL,
    filler_in_use boolean DEFAULT false NOT NULL,
    packager_ok boolean DEFAULT false NOT NULL,
    sources jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stream_status_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL)))
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    opened_by uuid,
    subject text NOT NULL,
    body text,
    status public.ticket_status DEFAULT 'open'::public.ticket_status NOT NULL,
    priority public.ticket_priority DEFAULT 'normal'::public.ticket_priority NOT NULL,
    assignee_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    event_id uuid,
    channel_id uuid,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    egress_gb numeric(14,3) DEFAULT 0 NOT NULL,
    encode_minutes numeric(12,2) DEFAULT 0 NOT NULL,
    peak_viewers integer DEFAULT 0 NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    role public.user_role DEFAULT 'operator'::public.user_role NOT NULL,
    status public.user_status DEFAULT 'invited'::public.user_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    platform_role public.platform_role,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_secret_ref text,
    display_name text
);


--
-- Name: vod_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vod_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid,
    channel_id uuid,
    recording_id uuid,
    kind public.vod_kind DEFAULT 'clip'::public.vod_kind NOT NULL,
    title text,
    master_key text NOT NULL,
    start_epoch_ms bigint NOT NULL,
    end_epoch_ms bigint NOT NULL,
    duration_ms bigint NOT NULL,
    export_mp4_key text,
    output_kind public.clip_output_kind DEFAULT 'manifest'::public.clip_output_kind NOT NULL,
    progressive_key text,
    formats jsonb DEFAULT '{"hls": true, "dash": true, "progressive": false}'::jsonb NOT NULL,
    portal_visible boolean DEFAULT false NOT NULL,
    clip_spec jsonb,
    schema_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    poster_key text,
    storyboard_key text,
    thumbs_vtt_key text,
    thumb_status public.asset_media_status DEFAULT 'processing'::public.asset_media_status NOT NULL,
    published boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vod_assets_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL)))
);


--
-- Name: segments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments ALTER COLUMN id SET DEFAULT nextval('public.segments_id_seq'::regclass);


--
-- Name: stream_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events ALTER COLUMN id SET DEFAULT nextval('public.stream_events_id_seq'::regclass);


--
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.accounts (id, name, plan_tier, billing_mode, included_gb, markup_pct, subscription_fee_month, max_channels, max_concurrent_sources, max_renditions, max_asset_hours, created_at, updated_at, parent_account_id, captions_provider) FROM stdin;
0000000a-0000-0000-0000-000000000001	RTM	standard	enterprise	0	0.5000	0.00	5	3	5	12	2026-08-04 15:32:22.563241+00	2026-08-04 15:32:22.563241+00	\N	whisper
\.


--
-- Data for Name: analytics_rollups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analytics_rollups (id, account_id, scope, scope_id, bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo) FROM stdin;
\.


--
-- Data for Name: api_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.api_keys (id, account_id, app_id, kind, key_prefix, key_hash, scopes, enabled, last_used_at, request_count, created_at) FROM stdin;
\.


--
-- Data for Name: apps; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.apps (id, account_id, name, type, restrictions, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_log (id, account_id, user_id, action, entity_type, entity_id, detail, created_at) FROM stdin;
a28a6521-a584-4fee-837a-85f1de64e6b7	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	channel	7f180e33-0bd3-45d6-b838-8b673a97f7b2	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"name": "RTM News 24", "group_id": "0000000d-0000-0000-0000-0000000000d1"}}	2026-08-04 15:33:29.464636+00
912b6739-2898-4711-ac39-030fcd64eeba	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	channel	53c0d5e7-06c7-4245-808b-5bc9d4c5e8b2	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"name": "RTM Sport (packaged)", "group_id": "0000000d-0000-0000-0000-0000000000d2"}}	2026-08-04 15:33:30.043603+00
eb263d74-520e-4812-942f-160e458ef057	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	channel	8554fa8e-dd72-4a8f-969f-8702c247e41f	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"name": "RTM UI Test Channel", "group_id": "0000000d-0000-0000-0000-0000000000d1"}}	2026-08-05 09:53:47.594971+00
81d46bc2-cee6-4788-abbd-871f02734e7d	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	update	channel	7f180e33-0bd3-45d6-b838-8b673a97f7b2	{"actor": "0000000b-0000-0000-0000-000000000001", "changes": {"geo_mode": {"to": "block", "from": "worldwide"}, "geo_countries": {"to": ["MY", "SG"], "from": []}, "dvr_window_sec": {"to": 1800, "from": 3600}}}	2026-08-05 18:18:00.117289+00
fbe2335e-2326-43b2-862f-28645102f254	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	update	output_profile	0000000c-0000-0000-0000-0000000000c1	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"captions": {"enabled": true, "targets": ["en", "ms"]}}}	2026-08-05 18:18:00.124376+00
489a5beb-6aec-4160-a855-7a2848302b04	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	channel	ed16058f-135a-4870-b442-de0359e11991	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"name": "TC Test", "ladder": 3, "sources": 2, "group_id": "0000000d-0000-0000-0000-0000000000d1"}}	2026-08-06 13:04:36.16433+00
3e9c4646-4c30-4509-957b-15225168fba3	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	channel	ad96afa3-b415-4efc-a17f-123b631b95c2	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"name": "PKG Test", "ladder": 3, "sources": 4, "group_id": "0000000d-0000-0000-0000-0000000000d2"}}	2026-08-06 13:04:36.188367+00
a1e4df99-0b7f-4554-8055-84721076eca8	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	media_file	5181ced9-a220-41d6-b3f6-397ea75536d3	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"kind": "slate", "path": "slates/news/evening.png", "bytes": 70}}	2026-08-06 14:21:03.72026+00
0ddca19e-8933-4e03-a65d-023da40e3bf9	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	create	media_file	0aae2c8d-6e15-4291-aeb6-b9713ddc89c3	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"kind": "watermark", "path": "watermarks/bug.png", "bytes": 70}}	2026-08-06 14:21:03.776629+00
837780f1-35ff-48be-aa89-4b70097be2b8	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	update	media_file	5181ced9-a220-41d6-b3f6-397ea75536d3	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"to": "slates/holding/evening.png", "from": "slates/news/evening.png", "kind": "slate"}}	2026-08-06 14:21:03.879548+00
1ad0bd72-bea7-494a-a6e4-07186cec7bd2	0000000a-0000-0000-0000-000000000001	0000000b-0000-0000-0000-000000000001	delete	media_file	5181ced9-a220-41d6-b3f6-397ea75536d3	{"actor": "0000000b-0000-0000-0000-000000000001", "snapshot": {"path": "slates/holding/evening.png", "forced": false}}	2026-08-06 14:21:03.910127+00
\.


--
-- Data for Name: channels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.channels (id, group_id, name, status, enabled, purchasing_mode, resilience_tier, input_failover_enabled, auto_failback, input_loss_behavior, filler_asset_id, filler_slate_ref, recording_retention_days, schema_id, metadata, created_at, updated_at, version, created_by, updated_by, dvr_window_sec, dvr_mode, geo_mode, geo_countries, output_ladder, fallback_transcode) FROM stdin;
\.


--
-- Data for Name: drm_configs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.drm_configs (id, account_id, provider, scheme, systems, tenant_id, key_service_url, license_service_url, management_key_ref, created_at) FROM stdin;
\.


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.events (id, group_id, name, status, scheduled_start, scheduled_end, server_start, server_stop, public_start, public_end, actual_start, actual_end, purchasing_mode, resilience_tier, input_failover_enabled, auto_failback, input_loss_behavior, filler_asset_id, filler_slate_ref, recording_retention_days, schema_id, metadata, created_at, updated_at, version, created_by, updated_by) FROM stdin;
\.


--
-- Data for Name: filler_assets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.filler_assets (id, account_id, kind, name, source_key, width, height, duration_ms, poster_key, status, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.groups (id, account_id, name, output_profile_id, max_concurrent, max_channels, created_at, version, created_by, updated_by) FROM stdin;
0000000d-0000-0000-0000-0000000000d1	0000000a-0000-0000-0000-000000000001	RTM Transcode	0000000c-0000-0000-0000-0000000000c1	5	10	2026-08-04 15:32:39.480476+00	1	\N	\N
0000000d-0000-0000-0000-0000000000d2	0000000a-0000-0000-0000-000000000001	RTM Packaging	0000000c-0000-0000-0000-0000000000c2	5	10	2026-08-04 15:32:39.480476+00	1	\N	\N
\.


--
-- Data for Name: identity_providers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_providers (id, account_id, kind, provider, issuer, client_id, secret_ref, domains, enabled, created_at) FROM stdin;
\.


--
-- Data for Name: instances; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.instances (id, event_id, channel_id, ec2_instance_id, task_arn, instance_type, is_gpu, lifecycle, role, state, availability_zone, launched_at, terminated_at, cost_estimate) FROM stdin;
\.


--
-- Data for Name: media_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_files (id, account_id, kind, path, folder, name, content_type, size_bytes, width, height, tags, store_key, status, version, created_by, updated_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: media_folders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_folders (id, account_id, path, created_at) FROM stdin;
\.


--
-- Data for Name: metadata_schemas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metadata_schemas (id, account_id, name, description, fields, target_kind, domain, extends_id, created_at, updated_at, version, created_by, updated_by) FROM stdin;
\.


--
-- Data for Name: notification_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_deliveries (id, notification_id, account_id, recipient, channel, status, attempts, last_error, read_at, sent_at, created_at) FROM stdin;
\.


--
-- Data for Name: notification_templates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_templates (id, account_id, key, subject, body, created_at) FROM stdin;
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notifications (id, account_id, topic, subject, body, payload, created_at) FROM stdin;
\.


--
-- Data for Name: output_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.output_profiles (id, account_id, name, rungs, packaging, workflow_type, codec_backend, segment_dur, dvr_window_sec, retention_days, overlays, drm_enabled, drm_config_id, captions_enabled, caption_engine, caption_source_lang, caption_targets, caption_offset_sec, caption_model_size, created_at, updated_at, version, created_by, updated_by) FROM stdin;
0000000c-0000-0000-0000-0000000000c2	0000000a-0000-0000-0000-000000000001	Package passthrough	[]	both	package_only	nvenc	4.00	300	30	[]	f	\N	f	gladia	auto	[]	0	small	2026-08-04 15:32:39.479794+00	2026-08-04 15:32:39.479794+00	1	\N	\N
0000000c-0000-0000-0000-0000000000c1	0000000a-0000-0000-0000-000000000001	Transcode HD	[{"height": 1080, "bitrate_kbps": 5000}, {"height": 720, "bitrate_kbps": 2800}, {"height": 480, "bitrate_kbps": 1200}]	both	transcode	x264	4.00	300	30	[]	f	\N	f	gladia	auto	[]	0	small	2026-08-04 15:32:39.477179+00	2026-08-05 18:18:00.123603+00	1	\N	\N
\.


--
-- Data for Name: play_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.play_sessions (id, account_id, session_key, app_id, asset_kind, asset_id, device_type, client_app, referrer_class, geo_country, ip_hash, started_at, last_seen_at, ended_at, seconds_watched, max_bitrate_kbps, ttff_ms, rebuffer_ms, bytes, blocked) FROM stdin;
\.


--
-- Data for Name: programme_series; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.programme_series (id, channel_id, title, rrule, duration_ms, dtstart, template, materialized_until, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: programmes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.programmes (id, channel_id, series_id, source_ref, title, starts_at, ends_at, status, actual_start, actual_end, geo_mode, geo_countries, replacement_asset_id, auto_vod, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: publications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.publications (id, vod_asset_id, platform, target_id, external_id, external_url, status, views, error, published_at, last_synced_at, created_at) FROM stdin;
\.


--
-- Data for Name: publish_targets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.publish_targets (id, account_id, platform, name, external_account, credentials_ref, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: recordings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recordings (id, kind, event_id, channel_id, title, day_utc, status, hi_res_rendition, master_key, start_epoch_ms, end_epoch_ms, duration_ms, retention_days, expires_at, poster_key, storyboard_key, thumbs_vtt_key, thumb_status, created_at) FROM stdin;
\.


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at) FROM stdin;
ebcbb7d8-8224-4bff-bd54-e1292c7da3bc	0000000b-0000-0000-0000-000000000001	b640a3697c142165740057c4a6d1b51a9b8bbc02f55028c8263ae76510220ac3	2026-08-18 15:32:52.464593+00	\N	2026-08-04 15:32:52.464593+00
34d45cf1-69d0-4132-ab45-4b374617a973	0000000b-0000-0000-0000-000000000001	9193fe350901fa2d5a7a0aca7a76643c04d5fc338e340fde069f2bdf1ef80013	2026-08-18 15:33:27.669108+00	\N	2026-08-04 15:33:27.669108+00
2e990561-74f3-47d9-87e5-3b82aa2fd6d2	0000000b-0000-0000-0000-000000000001	cb535ee7749b7c178627dfeadd44220a52df358368ebee736a8c69b2a261d03d	2026-08-19 09:52:08.446429+00	\N	2026-08-05 09:52:08.446429+00
8a918f32-afa5-459e-9081-516c326150ac	0000000b-0000-0000-0000-000000000001	77e11ee6bce70ca4da6238f200244bc9f570551d026403674582395986c5bc15	2026-08-19 09:52:47.632246+00	\N	2026-08-05 09:52:47.632246+00
2a0bb254-cf75-452a-b619-4e159c9379c3	0000000b-0000-0000-0000-000000000001	df5c6b00ce22c08a9125ff0e4a284797e393072b0c91ade9c13da88b2ea39e6e	2026-08-19 09:53:46.367399+00	\N	2026-08-05 09:53:46.367399+00
46b2c927-9836-41f6-ae9a-3381817458cf	0000000b-0000-0000-0000-000000000001	e7e553bce13488d52b8a9d9cd8494fd5dfe96f03757d3e61d3cdd8103be63d38	2026-08-19 18:04:51.565329+00	\N	2026-08-05 18:04:51.565329+00
81238595-948f-47c9-a4c5-eedc8c90b4b4	0000000b-0000-0000-0000-000000000001	04e312406fb531db70a0c1e404c92b31bb5080c0f7743e49fb676c99c87357ad	2026-08-19 18:12:30.33038+00	\N	2026-08-05 18:12:30.33038+00
3260c554-07e8-4c87-94de-f1dacfddb88d	0000000b-0000-0000-0000-000000000001	50649f300cbfb325fc29c6bbc3943bff2d89ea0d1520dcc2804a55cff229d419	2026-08-19 18:14:39.352001+00	\N	2026-08-05 18:14:39.352001+00
84af73af-4954-439a-8a63-c91decfca9ad	0000000b-0000-0000-0000-000000000001	24acb6bdc9576d6c2d4573e60f8dd72b6697086b711eefbdaaed106f95f0b1b3	2026-08-19 18:16:10.923268+00	\N	2026-08-05 18:16:10.923268+00
adc88012-903c-4ad9-b5c6-f33fd2048452	0000000b-0000-0000-0000-000000000001	30ee72db559ed64aa11434ed2d44b9273bf27efe9bb8ebba1fbe89fc5354a61d	2026-08-19 18:17:18.23038+00	\N	2026-08-05 18:17:18.23038+00
3f30b81c-b23f-4fb3-a97f-2f0941797170	0000000b-0000-0000-0000-000000000001	47a9ee108014db494eab11f86ef37b972ba7c2a46e399210df20a70165e6ee01	2026-08-19 18:18:00.048369+00	\N	2026-08-05 18:18:00.048369+00
8523d4ba-e6c8-4de9-bed8-641946409e97	0000000b-0000-0000-0000-000000000001	3dc44deb9e1c5cde5372a9b2cb428d76d198d7ca7cf77d9554c027d8d978dd3a	2026-08-20 06:20:58.504062+00	\N	2026-08-06 06:20:58.504062+00
337aaab4-68e3-4b51-bf11-b1ad034609cc	0000000b-0000-0000-0000-000000000001	dc07c3991534260f9cb897e3a15594d4706815c94cdf26c6ec11ec4ec857c8c3	2026-08-20 13:04:35.882188+00	\N	2026-08-06 13:04:35.882188+00
bfd3ea04-447a-4913-9e07-a89e21ba026c	0000000b-0000-0000-0000-000000000001	df8a8342bfab4e31ec6a79412444758bc9016fd14ccc47f8753442d1434afd16	2026-08-20 13:54:31.018011+00	\N	2026-08-06 13:54:31.018011+00
b451a52b-0d01-4bcc-b04b-cb235ee540ff	0000000b-0000-0000-0000-000000000001	a437740c59a29147904a019c01244bccfd14104dceee186f065b0c6bbd33a23c	2026-08-20 14:21:03.691052+00	\N	2026-08-06 14:21:03.691052+00
\.


--
-- Data for Name: scheduled_clips; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.scheduled_clips (id, channel_id, event_id, title, start_epoch_ms, end_epoch_ms, output_kind, status, vod_asset_id, created_at) FROM stdin;
\.


--
-- Data for Name: segments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.segments (id, event_id, channel_id, rendition_id, seq, s3_key, start_epoch_ms, duration_ms, discontinuity, created_at) FROM stdin;
\.


--
-- Data for Name: share_links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.share_links (id, account_id, resource_kind, resource_id, token_prefix, token_hash, label, message, recipients, access_type, allow_hi_res, allow_player, allow_metadata, watermark, notify_on_open, pin_hash, expires_at, max_views, view_count, first_opened_at, last_viewed_at, revoked, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: stream_concurrency; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_concurrency (account_id, asset_kind, asset_id, concurrent, updated_at) FROM stdin;
\.


--
-- Data for Name: stream_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_events (id, event_id, channel_id, seq, type, detail, ts, received_at) FROM stdin;
\.


--
-- Data for Name: stream_inputs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_inputs (id, event_id, channel_id, role, rendition_label, rendition_bitrate_kbps, protocol, ingest_url, stream_key, status, created_at) FROM stdin;
\.


--
-- Data for Name: stream_status; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_status (id, event_id, channel_id, output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, last_seq, updated_at) FROM stdin;
\.


--
-- Data for Name: support_tickets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_tickets (id, account_id, opened_by, subject, body, status, priority, assignee_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: usage_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usage_records (id, account_id, event_id, channel_id, period_start, period_end, egress_gb, encode_minutes, peak_viewers) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, account_id, email, password_hash, role, status, created_at, platform_role, mfa_enabled, mfa_secret_ref, display_name) FROM stdin;
0000000b-0000-0000-0000-000000000001	0000000a-0000-0000-0000-000000000001	admin@rtm.example	$argon2id$v=19$m=65536,t=3,p=4$UES66rUN8AT12SN2HK6+Bw$cg75uZi+LcsflyGd17JmS3tjFPNuLeQoLIArffysOzM	owner	active	2026-08-04 15:32:22.565197+00	\N	f	\N	RTM Admin
\.


--
-- Data for Name: vod_assets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vod_assets (id, event_id, channel_id, recording_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, export_mp4_key, output_kind, progressive_key, formats, portal_visible, clip_spec, schema_id, metadata, poster_key, storyboard_key, thumbs_vtt_key, thumb_status, published, created_at, updated_at) FROM stdin;
\.


--
-- Name: segments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.segments_id_seq', 1, false);


--
-- Name: stream_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stream_events_id_seq', 1, false);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: analytics_rollups analytics_rollups_account_id_scope_scope_id_bucket_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_rollups
    ADD CONSTRAINT analytics_rollups_account_id_scope_scope_id_bucket_date_key UNIQUE (account_id, scope, scope_id, bucket_date);


--
-- Name: analytics_rollups analytics_rollups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_rollups
    ADD CONSTRAINT analytics_rollups_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: drm_configs drm_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drm_configs
    ADD CONSTRAINT drm_configs_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: filler_assets filler_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filler_assets
    ADD CONSTRAINT filler_assets_pkey PRIMARY KEY (id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: identity_providers identity_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_providers
    ADD CONSTRAINT identity_providers_pkey PRIMARY KEY (id);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: media_files media_files_account_id_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_account_id_path_key UNIQUE (account_id, path);


--
-- Name: media_files media_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_pkey PRIMARY KEY (id);


--
-- Name: media_folders media_folders_account_id_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_account_id_path_key UNIQUE (account_id, path);


--
-- Name: media_folders media_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_pkey PRIMARY KEY (id);


--
-- Name: metadata_schemas metadata_schemas_account_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metadata_schemas
    ADD CONSTRAINT metadata_schemas_account_id_name_key UNIQUE (account_id, name);


--
-- Name: metadata_schemas metadata_schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metadata_schemas
    ADD CONSTRAINT metadata_schemas_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_account_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_account_id_key_key UNIQUE (account_id, key);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: output_profiles output_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.output_profiles
    ADD CONSTRAINT output_profiles_pkey PRIMARY KEY (id);


--
-- Name: play_sessions play_sessions_account_id_session_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.play_sessions
    ADD CONSTRAINT play_sessions_account_id_session_key_key UNIQUE (account_id, session_key);


--
-- Name: play_sessions play_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.play_sessions
    ADD CONSTRAINT play_sessions_pkey PRIMARY KEY (id);


--
-- Name: programme_series programme_series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programme_series
    ADD CONSTRAINT programme_series_pkey PRIMARY KEY (id);


--
-- Name: programmes programmes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programmes
    ADD CONSTRAINT programmes_pkey PRIMARY KEY (id);


--
-- Name: publications publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (id);


--
-- Name: publish_targets publish_targets_account_id_platform_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_targets
    ADD CONSTRAINT publish_targets_account_id_platform_name_key UNIQUE (account_id, platform, name);


--
-- Name: publish_targets publish_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_targets
    ADD CONSTRAINT publish_targets_pkey PRIMARY KEY (id);


--
-- Name: recordings recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: scheduled_clips scheduled_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_clips
    ADD CONSTRAINT scheduled_clips_pkey PRIMARY KEY (id);


--
-- Name: segments segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_pkey PRIMARY KEY (id);


--
-- Name: share_links share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_pkey PRIMARY KEY (id);


--
-- Name: share_links share_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_token_hash_key UNIQUE (token_hash);


--
-- Name: stream_concurrency stream_concurrency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_concurrency
    ADD CONSTRAINT stream_concurrency_pkey PRIMARY KEY (asset_kind, asset_id);


--
-- Name: stream_events stream_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events
    ADD CONSTRAINT stream_events_pkey PRIMARY KEY (id);


--
-- Name: stream_inputs stream_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_inputs
    ADD CONSTRAINT stream_inputs_pkey PRIMARY KEY (id);


--
-- Name: stream_status stream_status_channel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_status
    ADD CONSTRAINT stream_status_channel_id_key UNIQUE (channel_id);


--
-- Name: stream_status stream_status_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_status
    ADD CONSTRAINT stream_status_event_id_key UNIQUE (event_id);


--
-- Name: stream_status stream_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_status
    ADD CONSTRAINT stream_status_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: usage_records usage_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vod_assets vod_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_pkey PRIMARY KEY (id);


--
-- Name: idx_accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_parent ON public.accounts USING btree (parent_account_id);


--
-- Name: idx_apikeys_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apikeys_account ON public.api_keys USING btree (account_id);


--
-- Name: idx_apikeys_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apikeys_prefix ON public.api_keys USING btree (key_prefix);


--
-- Name: idx_apps_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_apps_account ON public.apps USING btree (account_id);


--
-- Name: idx_audit_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_account ON public.audit_log USING btree (account_id, created_at);


--
-- Name: idx_channels_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_group ON public.channels USING btree (group_id);


--
-- Name: idx_deliv_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliv_inbox ON public.notification_deliveries USING btree (account_id, recipient, channel) WHERE (channel = 'in_app'::public.notification_channel);


--
-- Name: idx_deliv_notif; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliv_notif ON public.notification_deliveries USING btree (notification_id);


--
-- Name: idx_deliv_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliv_status ON public.notification_deliveries USING btree (status) WHERE (status = 'failed'::public.delivery_status);


--
-- Name: idx_events_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_group ON public.events USING btree (group_id);


--
-- Name: idx_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_status ON public.events USING btree (status);


--
-- Name: idx_filler_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_filler_account ON public.filler_assets USING btree (account_id, kind);


--
-- Name: idx_idp_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_account ON public.identity_providers USING btree (account_id);


--
-- Name: idx_inputs_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inputs_channel ON public.stream_inputs USING btree (channel_id);


--
-- Name: idx_inputs_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inputs_event ON public.stream_inputs USING btree (event_id);


--
-- Name: idx_instances_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_channel ON public.instances USING btree (channel_id);


--
-- Name: idx_instances_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_event ON public.instances USING btree (event_id);


--
-- Name: idx_mdschema_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mdschema_account ON public.metadata_schemas USING btree (account_id);


--
-- Name: idx_media_files_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_account ON public.media_files USING btree (account_id);


--
-- Name: idx_media_files_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_folder ON public.media_files USING btree (account_id, folder);


--
-- Name: idx_media_files_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_kind ON public.media_files USING btree (account_id, kind);


--
-- Name: idx_notif_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_account ON public.notifications USING btree (account_id, created_at DESC);


--
-- Name: idx_prog_channel_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_channel_start ON public.programmes USING btree (channel_id, starts_at);


--
-- Name: idx_prog_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_search ON public.programmes USING gin (to_tsvector('simple'::regconfig, title));


--
-- Name: idx_prog_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_prog_source ON public.programmes USING btree (channel_id, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: idx_prog_span_gist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_span_gist ON public.programmes USING gist (span);


--
-- Name: idx_ptarget_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ptarget_account ON public.publish_targets USING btree (account_id, platform);


--
-- Name: idx_pub_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_asset ON public.publications USING btree (vod_asset_id);


--
-- Name: idx_pub_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_platform ON public.publications USING btree (platform);


--
-- Name: idx_rec_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_channel ON public.recordings USING btree (channel_id, day_utc);


--
-- Name: idx_rec_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_event ON public.recordings USING btree (event_id);


--
-- Name: idx_rec_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_expiry ON public.recordings USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_refresh_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_user ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_rollups_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollups_account ON public.analytics_rollups USING btree (account_id, bucket_date);


--
-- Name: idx_sclip_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sclip_channel ON public.scheduled_clips USING btree (channel_id);


--
-- Name: idx_sclip_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sclip_due ON public.scheduled_clips USING btree (end_epoch_ms) WHERE (status = 'scheduled'::public.scheduled_clip_status);


--
-- Name: idx_sclip_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sclip_event ON public.scheduled_clips USING btree (event_id);


--
-- Name: idx_seg_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seg_channel ON public.segments USING btree (channel_id, rendition_id, start_epoch_ms);


--
-- Name: idx_seg_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seg_event ON public.segments USING btree (event_id, rendition_id, start_epoch_ms);


--
-- Name: idx_series_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_series_channel ON public.programme_series USING btree (channel_id);


--
-- Name: idx_sessions_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_app ON public.play_sessions USING btree (account_id, app_id);


--
-- Name: idx_sessions_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_asset ON public.play_sessions USING btree (account_id, asset_kind, asset_id);


--
-- Name: idx_sessions_lastseen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_lastseen ON public.play_sessions USING btree (asset_kind, asset_id, last_seen_at);


--
-- Name: idx_sev_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sev_channel ON public.stream_events USING btree (channel_id, id DESC);


--
-- Name: idx_sev_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sev_event ON public.stream_events USING btree (event_id, id DESC);


--
-- Name: idx_share_links_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_links_account ON public.share_links USING btree (account_id);


--
-- Name: idx_share_links_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_links_prefix ON public.share_links USING btree (token_prefix);


--
-- Name: idx_share_links_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_links_resource ON public.share_links USING btree (resource_kind, resource_id);


--
-- Name: idx_tickets_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_account ON public.support_tickets USING btree (account_id, status);


--
-- Name: idx_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_status ON public.support_tickets USING btree (status);


--
-- Name: idx_usage_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_account ON public.usage_records USING btree (account_id, period_start);


--
-- Name: idx_vod_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_channel ON public.vod_assets USING btree (channel_id);


--
-- Name: idx_vod_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_event ON public.vod_assets USING btree (event_id);


--
-- Name: idx_vod_recording; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_recording ON public.vod_assets USING btree (recording_id);


--
-- Name: uq_rec_channel_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_rec_channel_day ON public.recordings USING btree (channel_id, day_utc) WHERE (kind = 'channel_day'::public.recording_kind);


--
-- Name: accounts accounts_parent_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_parent_account_id_fkey FOREIGN KEY (parent_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: analytics_rollups analytics_rollups_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_rollups
    ADD CONSTRAINT analytics_rollups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: apps apps_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channels channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channels channels_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: channels channels_schema_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_schema_fk FOREIGN KEY (schema_id) REFERENCES public.metadata_schemas(id) ON DELETE SET NULL;


--
-- Name: channels channels_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: drm_configs drm_configs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drm_configs
    ADD CONSTRAINT drm_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: events events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: events events_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: events events_schema_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_schema_fk FOREIGN KEY (schema_id) REFERENCES public.metadata_schemas(id) ON DELETE SET NULL;


--
-- Name: events events_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: filler_assets filler_assets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filler_assets
    ADD CONSTRAINT filler_assets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: channels fk_channels_filler; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT fk_channels_filler FOREIGN KEY (filler_asset_id) REFERENCES public.filler_assets(id) ON DELETE SET NULL;


--
-- Name: events fk_events_filler; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT fk_events_filler FOREIGN KEY (filler_asset_id) REFERENCES public.filler_assets(id) ON DELETE SET NULL;


--
-- Name: groups groups_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: groups groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: groups groups_output_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_output_profile_id_fkey FOREIGN KEY (output_profile_id) REFERENCES public.output_profiles(id) ON DELETE SET NULL;


--
-- Name: groups groups_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: identity_providers identity_providers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_providers
    ADD CONSTRAINT identity_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: instances instances_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: instances instances_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: media_files media_files_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: media_files media_files_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: media_files media_files_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: media_folders media_folders_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: metadata_schemas metadata_schemas_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metadata_schemas
    ADD CONSTRAINT metadata_schemas_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: metadata_schemas metadata_schemas_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metadata_schemas
    ADD CONSTRAINT metadata_schemas_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: metadata_schemas metadata_schemas_extends_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metadata_schemas
    ADD CONSTRAINT metadata_schemas_extends_id_fkey FOREIGN KEY (extends_id) REFERENCES public.metadata_schemas(id) ON DELETE SET NULL;


--
-- Name: metadata_schemas metadata_schemas_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metadata_schemas
    ADD CONSTRAINT metadata_schemas_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_deliveries notification_deliveries_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_templates notification_templates_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: output_profiles output_profiles_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.output_profiles
    ADD CONSTRAINT output_profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: output_profiles output_profiles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.output_profiles
    ADD CONSTRAINT output_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: output_profiles output_profiles_drm_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.output_profiles
    ADD CONSTRAINT output_profiles_drm_config_id_fkey FOREIGN KEY (drm_config_id) REFERENCES public.drm_configs(id) ON DELETE SET NULL;


--
-- Name: output_profiles output_profiles_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.output_profiles
    ADD CONSTRAINT output_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: play_sessions play_sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.play_sessions
    ADD CONSTRAINT play_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: play_sessions play_sessions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.play_sessions
    ADD CONSTRAINT play_sessions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE SET NULL;


--
-- Name: programme_series programme_series_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programme_series
    ADD CONSTRAINT programme_series_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: programmes programmes_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programmes
    ADD CONSTRAINT programmes_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: programmes programmes_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programmes
    ADD CONSTRAINT programmes_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.programme_series(id) ON DELETE SET NULL;


--
-- Name: publications publications_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.publish_targets(id) ON DELETE SET NULL;


--
-- Name: publications publications_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


--
-- Name: publish_targets publish_targets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_targets
    ADD CONSTRAINT publish_targets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: recordings recordings_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: recordings recordings_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: scheduled_clips scheduled_clips_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_clips
    ADD CONSTRAINT scheduled_clips_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: scheduled_clips scheduled_clips_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_clips
    ADD CONSTRAINT scheduled_clips_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: scheduled_clips scheduled_clips_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_clips
    ADD CONSTRAINT scheduled_clips_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE SET NULL;


--
-- Name: segments segments_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: segments segments_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments
    ADD CONSTRAINT segments_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stream_concurrency stream_concurrency_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_concurrency
    ADD CONSTRAINT stream_concurrency_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: stream_events stream_events_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events
    ADD CONSTRAINT stream_events_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: stream_events stream_events_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events
    ADD CONSTRAINT stream_events_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: stream_inputs stream_inputs_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_inputs
    ADD CONSTRAINT stream_inputs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: stream_inputs stream_inputs_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_inputs
    ADD CONSTRAINT stream_inputs_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: stream_status stream_status_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_status
    ADD CONSTRAINT stream_status_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: stream_status stream_status_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_status
    ADD CONSTRAINT stream_status_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: usage_records usage_records_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: usage_records usage_records_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: usage_records usage_records_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: users users_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;


--
-- Name: vod_assets vod_assets_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.metadata_schemas(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict VkN6MYGDm0c76ubnUj5EPp2cfw7jhvFu0FOV2IxVBVFLEmE50gUIobLznfFhL6o

