--
-- PostgreSQL database dump
--

\restrict QcqWltrhAK3gfbeIxAdJJqZ0whYALtiFqPNWWdUceyM0gz14PXHp9HFfPrz02M0

-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

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
-- Name: container_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.container_state AS ENUM (
    'open',
    'closed'
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
    'st2110',
    'icecast'
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
-- Name: job_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_state AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled'
);


--
-- Name: media_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.media_state AS ENUM (
    'pending',
    'writing',
    'available',
    'archiving',
    'archived',
    'restoring',
    'restored',
    'deleting',
    'deleted'
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
-- Name: qc_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.qc_severity AS ENUM (
    'info',
    'warning',
    'error'
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
-- Name: recording_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.recording_type AS ENUM (
    'tv_channel',
    'radio_station',
    'audio_stream',
    'event',
    'simulcast',
    'ad_hoc'
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
-- Name: retention_action; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.retention_action AS ENUM (
    'keep',
    'to_cold',
    'to_archive',
    'delete'
);


--
-- Name: review_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_state AS ENUM (
    'draft',
    'in_review',
    'changes_requested',
    'approved',
    'rejected'
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
-- Name: storage_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.storage_tier AS ENUM (
    'local',
    's3_standard',
    's3_ia',
    's3_glacier_ir',
    's3_glacier_flexible',
    's3_deep_archive'
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
-- Name: upload_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.upload_state AS ENUM (
    'open',
    'assembling',
    'complete',
    'aborted',
    'expired'
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
-- Name: gfx_frozen_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.gfx_frozen_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'gfx_template_versions' THEN
    IF OLD.status = 'published' AND (NEW.manifest IS DISTINCT FROM OLD.manifest
        OR NEW.version IS DISTINCT FROM OLD.version OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes) THEN
      RAISE EXCEPTION 'gfx: version % is published and cannot change', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- gfx_files
  IF EXISTS (SELECT 1 FROM gfx_template_versions v
              WHERE v.id = COALESCE(NEW.version_id, OLD.version_id) AND v.status = 'published') THEN
    RAISE EXCEPTION 'gfx: files of a published version cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;


--
-- Name: jsonb_add(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_add(a jsonb, b jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM (
      SELECT k, SUM(v::numeric) AS v
        FROM (
          SELECT key AS k, value::text AS v FROM jsonb_each(COALESCE(a, '{}'::jsonb))
          UNION ALL
          SELECT key, value::text FROM jsonb_each(COALESCE(b, '{}'::jsonb))
        ) s
       GROUP BY k
    ) t
$$;


--
-- Name: jsonb_bump(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jsonb_bump(obj jsonb, key text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT jsonb_set(COALESCE(obj, '{}'::jsonb), ARRAY[key],
                   to_jsonb(COALESCE((obj->>key)::bigint, 0) + 1));
$$;


--
-- Name: media_files_search_refresh(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_files_search_refresh() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.search :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '') || ' ' || coalesce(NEW.title, '')), 'A')
   || setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ') || ' ' || array_to_string(NEW.keywords, ' ')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.location, '') || ' ' || coalesce(NEW.metadata->>'programme', '')), 'B')
   || setweight(to_tsvector('simple', coalesce(NEW.description, '') || ' ' || coalesce(NEW.camera, '')
        || ' ' || coalesce(NEW.creator, '') || ' ' || coalesce(NEW.metadata->>'channel', '')), 'C')
   || setweight(to_tsvector('simple', regexp_replace(coalesce(NEW.path, ''), '[/_.-]+', ' ', 'g')), 'D');
  RETURN NEW;
END $$;


--
-- Name: vod_assets_encode_facts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vod_assets_encode_facts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  p RECORD;
BEGIN
  IF NEW.encode_result IS NOT NULL
     AND jsonb_typeof(NEW.encode_result -> 'kept') = 'array'
     AND jsonb_array_length(NEW.encode_result -> 'kept') > 0 THEN
    NEW.top_height := (SELECT max((r ->> 'height')::int) FROM jsonb_array_elements(NEW.encode_result -> 'kept') r);
    -- The file encoder is H.264 by contract (volt-encoder/bin/ladder_args.py);
    -- a result that names its codec wins.
    NEW.video_codec := lower(COALESCE(NEW.encode_result ->> 'codec', 'h264'));
  ELSIF NEW.top_height IS NULL AND (NEW.channel_id IS NOT NULL OR NEW.event_id IS NOT NULL) THEN
    SELECT op.rungs, op.workflow_type::text AS wf INTO p
      FROM groups g JOIN output_profiles op ON op.id = g.output_profile_id
     WHERE g.id = COALESCE((SELECT c.group_id FROM channels c WHERE c.id = NEW.channel_id),
                           (SELECT e.group_id FROM events e WHERE e.id = NEW.event_id));
    IF FOUND AND jsonb_typeof(p.rungs) = 'array' AND jsonb_array_length(p.rungs) > 0 THEN
      NEW.top_height := (SELECT max((r ->> 'height')::int) FROM jsonb_array_elements(p.rungs) r);
      NEW.video_codec := COALESCE(NEW.video_codec,
        lower((SELECT r ->> 'codec' FROM jsonb_array_elements(p.rungs) r ORDER BY (r ->> 'height')::int DESC NULLS LAST LIMIT 1)),
        CASE WHEN p.wf = 'transcode' THEN 'h264' END);
    END IF;
  END IF;
  IF NEW.video_codec IN ('avc', 'avc1', 'x264', 'nvenc') THEN NEW.video_codec := 'h264'; END IF;
  IF NEW.video_codec IN ('h265', 'hvc1', 'hev1', 'x265') THEN NEW.video_codec := 'hevc'; END IF;
  RETURN NEW;
END
$$;


--
-- Name: volt_cache_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.volt_cache_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  i   int;
  pfx text;
  col text;
  v   text;
BEGIN
  -- TG_ARGV holds pairs: tag prefix, column name.
  FOR i IN 0 .. (TG_NARGS / 2 - 1) LOOP
    pfx := TG_ARGV[i * 2];
    col := TG_ARGV[i * 2 + 1];
    IF TG_OP <> 'INSERT' THEN
      EXECUTE format('SELECT ($1).%I::text', col) INTO v USING OLD;
      IF v IS NOT NULL THEN PERFORM pg_notify('volt_cache', pfx || ':' || v); END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      EXECUTE format('SELECT ($1).%I::text', col) INTO v USING NEW;
      IF v IS NOT NULL THEN PERFORM pg_notify('volt_cache', pfx || ':' || v); END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $_$;


--
-- Name: volt_viewer_revoke_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.volt_viewer_revoke_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'viewers' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.password_changed_at IS DISTINCT FROM OLD.password_changed_at THEN
      PERFORM pg_notify('volt_viewer_revoke', NEW.id::text);
    END IF;
  ELSE
    -- entitlements: a revoke or a shortened validity
    IF TG_OP = 'DELETE' THEN
      PERFORM pg_notify('volt_viewer_revoke', OLD.viewer_id::text);
    ELSIF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
      PERFORM pg_notify('volt_viewer_revoke', NEW.viewer_id::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;


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
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_account_id uuid,
    captions_provider text DEFAULT 'none'::text NOT NULL,
    require_review_to_publish boolean DEFAULT false NOT NULL,
    block_publish_on_qc_error boolean DEFAULT false NOT NULL,
    analytics_raw_retention_days integer DEFAULT 90,
    require_admin_mfa boolean DEFAULT false NOT NULL,
    brand_logo_ref text,
    brand_primary text,
    brand_secondary text,
    geo_access jsonb,
    CONSTRAINT accounts_captions_provider_check CHECK ((captions_provider = ANY (ARRAY['none'::text, 'whisper'::text, 'gladia'::text]))),
    CONSTRAINT analytics_raw_retention_sane CHECK (((analytics_raw_retention_days IS NULL) OR (analytics_raw_retention_days >= 1)))
);


--
-- Name: ad_beacons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_beacons (
    id bigint NOT NULL,
    channel_id uuid NOT NULL,
    break_id uuid,
    session_id text NOT NULL,
    pod_index integer NOT NULL,
    ad_id text,
    creative_key text,
    event text NOT NULL,
    url_index integer NOT NULL,
    url text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    status integer,
    ok boolean,
    error text,
    elapsed_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);


--
-- Name: ad_beacons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ad_beacons_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ad_beacons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ad_beacons_id_seq OWNED BY public.ad_beacons.id;


--
-- Name: ad_creatives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_creatives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    creative_key text NOT NULL,
    source_url text,
    ad_system text,
    title text,
    vod_asset_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    duration_ms integer,
    error text,
    plays bigint DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ad_creatives_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'conditioning'::text, 'ready'::text, 'error'::text, 'rejected'::text])))
);


--
-- Name: ad_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_decisions (
    id bigint NOT NULL,
    channel_id uuid NOT NULL,
    break_id uuid,
    session_id text,
    ad_server_id uuid,
    elapsed_ms integer,
    requests integer,
    break_ms integer NOT NULL,
    ad_ms integer DEFAULT 0 NOT NULL,
    house_ms integer DEFAULT 0 NOT NULL,
    slate_ms integer DEFAULT 0 NOT NULL,
    fallback text,
    problems jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ad_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ad_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ad_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ad_decisions_id_seq OWNED BY public.ad_decisions.id;


--
-- Name: ad_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    vendor text DEFAULT 'vast'::text NOT NULL,
    tag_template text NOT NULL,
    timeout_ms integer DEFAULT 1500 NOT NULL,
    max_wrappers integer DEFAULT 5 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ad_servers_max_wrappers_check CHECK (((max_wrappers >= 0) AND (max_wrappers <= 10))),
    CONSTRAINT ad_servers_timeout_ms_check CHECK (((timeout_ms >= 200) AND (timeout_ms <= 5000))),
    CONSTRAINT ad_servers_vendor_check CHECK ((vendor = ANY (ARRAY['vast'::text, 'gam'::text, 'freewheel'::text, 'springserve'::text, 'magnite'::text, 'publica'::text, 'beachfront'::text, 'other'::text])))
);


--
-- Name: addon_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addon_run_events (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    state text,
    progress_pct integer,
    step text,
    message text,
    data jsonb
);


--
-- Name: addon_run_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.addon_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: addon_run_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.addon_run_events_id_seq OWNED BY public.addon_run_events.id;


--
-- Name: addon_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addon_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    addon_id uuid NOT NULL,
    trigger_id uuid,
    hook text NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    subject_title text,
    channel_id uuid,
    event_id uuid,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    progress_pct integer DEFAULT 0 NOT NULL,
    step text,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    external_ref text,
    result jsonb,
    error text,
    callback_hash text NOT NULL,
    job_id uuid,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    deadline_at timestamp with time zone NOT NULL,
    CONSTRAINT addon_runs_progress_pct_check CHECK (((progress_pct >= 0) AND (progress_pct <= 100))),
    CONSTRAINT addon_runs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'dispatched'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text])))
);


--
-- Name: addon_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addon_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    category text DEFAULT 'other'::text NOT NULL,
    kind text DEFAULT 'webhook'::text NOT NULL,
    endpoint_url text,
    signing_secret text NOT NULL,
    accepts text[] DEFAULT ARRAY['recording'::text, 'vod_asset'::text] NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    timeout_sec integer DEFAULT 3600 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT addon_services_category_check CHECK ((category = ANY (ARRAY['ai_agent'::text, 'transcription'::text, 'qc'::text, 'metadata'::text, 'distribution'::text, 'other'::text]))),
    CONSTRAINT addon_services_check CHECK (((kind <> 'webhook'::text) OR (endpoint_url IS NOT NULL))),
    CONSTRAINT addon_services_kind_check CHECK ((kind = ANY (ARRAY['webhook'::text, 'demo'::text]))),
    CONSTRAINT addon_services_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10))),
    CONSTRAINT addon_services_timeout_sec_check CHECK (((timeout_sec >= 30) AND (timeout_sec <= 86400)))
);


--
-- Name: addon_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addon_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    addon_id uuid NOT NULL,
    hook text NOT NULL,
    filter jsonb DEFAULT '{}'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: air_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.air_sessions (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    stream_kind text NOT NULL,
    stream_id uuid NOT NULL,
    stream_name text NOT NULL,
    channel_id uuid,
    event_id uuid,
    from_at timestamp with time zone DEFAULT now() NOT NULL,
    to_at timestamp with time zone,
    seconds integer,
    opened_by text,
    closed_by text,
    close_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT air_sessions_check CHECK (((to_at IS NULL) OR (to_at >= from_at))),
    CONSTRAINT air_sessions_stream_kind_check CHECK ((stream_kind = ANY (ARRAY['channel'::text, 'radio'::text, 'event'::text])))
);


--
-- Name: TABLE air_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.air_sessions IS 'One row per window of public delivery. to_at NULL means on air now. Identity is snapshotted and FK-free so the record outlives the stream it describes.';


--
-- Name: air_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.air_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: air_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.air_sessions_id_seq OWNED BY public.air_sessions.id;


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
    by_geo jsonb DEFAULT '{}'::jsonb NOT NULL,
    sealed boolean DEFAULT false NOT NULL,
    sealed_at timestamp with time zone,
    sessions_counted bigint,
    recomputed_at timestamp with time zone
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
-- Name: asset_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vod_asset_id uuid NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    actor_label text NOT NULL,
    from_state public.review_state,
    to_state public.review_state NOT NULL,
    note text,
    overrode_qc boolean DEFAULT false NOT NULL,
    qc_state_at_decision text
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
-- Name: channel_ads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_ads (
    channel_id uuid NOT NULL,
    mode text DEFAULT 'off'::text NOT NULL,
    policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    ad_server_id uuid,
    house_ads jsonb DEFAULT '[]'::jsonb NOT NULL,
    decision_scope text DEFAULT 'session'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_ads_decision_scope_check CHECK ((decision_scope = ANY (ARRAY['channel'::text, 'session'::text]))),
    CONSTRAINT channel_ads_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'markers'::text, 'stitched'::text])))
);


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'tv'::text NOT NULL,
    radio_config jsonb,
    status public.asset_status DEFAULT 'scheduled'::public.asset_status NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    purchasing_mode public.purchasing_mode DEFAULT 'reserved'::public.purchasing_mode NOT NULL,
    resilience_tier public.resilience_tier DEFAULT 'standard'::public.resilience_tier NOT NULL,
    input_failover_enabled boolean DEFAULT false NOT NULL,
    auto_failback boolean DEFAULT true NOT NULL,
    input_loss_behavior public.input_loss_behavior DEFAULT 'none'::public.input_loss_behavior NOT NULL,
    filler_asset_id uuid,
    filler_slate_ref text,
    recording_enabled boolean DEFAULT true NOT NULL,
    recording_retention_days integer,
    recording_retention_sec bigint,
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
    tz text DEFAULT 'Europe/London'::text NOT NULL,
    broadcast_anchor_hour smallint DEFAULT 6 NOT NULL,
    daypart_preset text,
    on_air boolean DEFAULT false NOT NULL,
    epg_enabled boolean DEFAULT true NOT NULL,
    brand_ref text,
    watermark_enabled boolean DEFAULT false NOT NULL,
    watermark_ref text,
    watermark_position text DEFAULT 'br'::text NOT NULL,
    watermark_offset_x integer DEFAULT 24 NOT NULL,
    watermark_offset_y integer DEFAULT 24 NOT NULL,
    watermark_opacity integer DEFAULT 100 NOT NULL,
    watermark_scale integer DEFAULT 12 NOT NULL,
    auto_connect boolean DEFAULT true NOT NULL,
    desired_state text DEFAULT 'stopped'::text NOT NULL,
    stop_requested_at timestamp with time zone,
    stop_requested_by text,
    resume_attempts integer DEFAULT 0 NOT NULL,
    resume_last_attempt_at timestamp with time zone,
    resume_last_error text,
    resume_gave_up_at timestamp with time zone,
    relay_id uuid,
    resume_armed_at timestamp with time zone,
    filler_build jsonb,
    xmltv_id text,
    guide_icon_ref text,
    graphics jsonb DEFAULT '{}'::jsonb NOT NULL,
    origin text DEFAULT 'live'::text NOT NULL,
    fast_media text DEFAULT 'video'::text NOT NULL,
    CONSTRAINT channels_desired_state_check CHECK ((desired_state = ANY (ARRAY['running'::text, 'stopped'::text]))),
    CONSTRAINT channels_dvr_mode_chk CHECK ((dvr_mode = ANY (ARRAY['sliding'::text, 'event_start'::text]))),
    CONSTRAINT channels_dvr_window_max CHECK (((dvr_window_sec IS NULL) OR ((dvr_window_sec >= 30) AND (dvr_window_sec <= 14400)))),
    CONSTRAINT channels_fast_media_ck CHECK ((fast_media = ANY (ARRAY['video'::text, 'audio'::text]))),
    CONSTRAINT channels_geo_mode_chk CHECK ((geo_mode = ANY (ARRAY['worldwide'::text, 'allow'::text, 'block'::text]))),
    CONSTRAINT channels_kind_check CHECK ((kind = ANY (ARRAY['tv'::text, 'radio'::text]))),
    CONSTRAINT channels_origin_ck CHECK ((origin = ANY (ARRAY['live'::text, 'playlist'::text])))
);


--
-- Name: clip_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clip_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vod_asset_id uuid NOT NULL,
    ordinal integer NOT NULL,
    recording_id uuid,
    container_id uuid,
    run_id text NOT NULL,
    block_index integer DEFAULT 0 NOT NULL,
    rendition text NOT NULL,
    first_seq integer NOT NULL,
    last_seq integer NOT NULL,
    segment_count integer NOT NULL,
    source_from_ms bigint NOT NULL,
    source_to_ms bigint NOT NULL,
    clip_offset_ms bigint NOT NULL,
    duration_ms bigint NOT NULL,
    partial_head boolean DEFAULT false NOT NULL,
    partial_tail boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clip_segments_seq_order CHECK ((last_seq >= first_seq)),
    CONSTRAINT clip_segments_time_order CHECK ((source_to_ms > source_from_ms))
);


--
-- Name: compute_hosts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compute_hosts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    instance_type text,
    region text,
    availability_zone text,
    lifecycle text,
    vcpus integer,
    memory_mib integer,
    state text DEFAULT 'up'::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_metric_at timestamp with time zone,
    role text DEFAULT 'compute'::text NOT NULL,
    CONSTRAINT compute_hosts_kind_check CHECK ((kind = ANY (ARRAY['ec2'::text, 'fargate'::text, 'local'::text]))),
    CONSTRAINT compute_hosts_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['spot'::text, 'on_demand'::text]))),
    CONSTRAINT compute_hosts_role_check CHECK ((role = ANY (ARRAY['compute'::text, 'relay'::text]))),
    CONSTRAINT compute_hosts_state_check CHECK ((state = ANY (ARRAY['up'::text, 'gone'::text])))
);


--
-- Name: compute_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compute_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instance_type text NOT NULL,
    lifecycle text DEFAULT 'on_demand'::text NOT NULL,
    region text,
    usd_per_hour numeric(10,5) NOT NULL,
    indicative boolean DEFAULT true NOT NULL,
    effective_from timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    note text,
    CONSTRAINT compute_rates_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['spot'::text, 'on_demand'::text])))
);


--
-- Name: cost_actuals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_actuals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_month date NOT NULL,
    category text NOT NULL,
    usd numeric(12,2) NOT NULL,
    source text,
    note text,
    entered_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cost_actuals_category_check CHECK ((category = ANY (ARRAY['compute'::text, 'relay'::text, 'egress'::text, 'storage'::text, 'other'::text])))
);


--
-- Name: dayparts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dayparts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    ordinal smallint NOT NULL,
    name text NOT NULL,
    starts_local time without time zone NOT NULL,
    days_mask smallint DEFAULT 127 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: egress_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.egress_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    region text,
    usd_per_gb numeric(10,5) NOT NULL,
    indicative boolean DEFAULT true NOT NULL,
    effective_from timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    note text
);


--
-- Name: encode_ladder_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encode_ladder_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    tracks_output_profile_id uuid,
    segment_dur numeric(4,2) DEFAULT 4.00 NOT NULL,
    fps numeric(6,3) DEFAULT 25.000 NOT NULL,
    packaging public.packaging_kind DEFAULT 'both'::public.packaging_kind NOT NULL,
    codec_backend public.codec_backend DEFAULT 'x264'::public.codec_backend NOT NULL,
    cap_to_source boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid
);


--
-- Name: COLUMN encode_ladder_groups.tracks_output_profile_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.encode_ladder_groups.tracks_output_profile_id IS 'When set, the rungs are read from output_profiles.rungs at encode time and this group must have no members. That is what makes a file encode match the live channel it is supposed to match.';


--
-- Name: encode_ladder_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encode_ladder_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    ordinal integer NOT NULL
);


--
-- Name: encode_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encode_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    height integer NOT NULL,
    bitrate_kbps integer NOT NULL,
    fps numeric(6,3),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT encode_profiles_bitrate_kbps_check CHECK (((bitrate_kbps >= 50) AND (bitrate_kbps <= 200000))),
    CONSTRAINT encode_profiles_height_check CHECK (((height >= 90) AND (height <= 4320)))
);


--
-- Name: engine_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engine_bindings (
    task_arn text NOT NULL,
    engine_id text NOT NULL,
    mode text NOT NULL,
    stream_kind text NOT NULL,
    stream_id uuid NOT NULL,
    external_ref text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stopped_at timestamp with time zone,
    stop_reason text,
    CONSTRAINT engine_bindings_mode_check CHECK ((mode = ANY (ARRAY['encode_only'::text, 'full'::text]))),
    CONSTRAINT engine_bindings_stream_kind_check CHECK ((stream_kind = ANY (ARRAY['channel'::text, 'event'::text])))
);


--
-- Name: entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entitlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    viewer_id uuid NOT NULL,
    purchase_id uuid,
    product_id uuid,
    grants jsonb NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    revoked_at timestamp with time zone,
    note text
);


--
-- Name: epg_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epg_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    action text NOT NULL,
    label text NOT NULL,
    created_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    removed jsonb DEFAULT '[]'::jsonb NOT NULL,
    exdates_added jsonb DEFAULT '[]'::jsonb NOT NULL,
    series_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    undone_at timestamp with time zone
);


--
-- Name: epg_channel_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epg_channel_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    source_id uuid NOT NULL,
    external_id text NOT NULL,
    display_name text,
    icon text,
    channel_id uuid,
    mapped_by text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_programmes integer DEFAULT 0 NOT NULL,
    ignored boolean DEFAULT false NOT NULL,
    lcn text,
    programmes_in_feed integer DEFAULT 0 NOT NULL,
    feed_from timestamp with time zone,
    feed_to timestamp with time zone,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: epg_feeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epg_feeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    token_prefix text NOT NULL,
    token_hash text NOT NULL,
    channel_ids uuid[],
    include_events boolean DEFAULT false NOT NULL,
    past_days integer DEFAULT 1 NOT NULL,
    future_days integer DEFAULT 7 NOT NULL,
    time_basis text DEFAULT 'scheduled'::text NOT NULL,
    tz_mode text DEFAULT 'local'::text NOT NULL,
    lang text,
    enabled boolean DEFAULT true NOT NULL,
    last_polled_at timestamp with time zone,
    poll_count bigint DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT epg_feeds_future_days_check CHECK (((future_days >= 1) AND (future_days <= 62))),
    CONSTRAINT epg_feeds_past_days_check CHECK (((past_days >= 0) AND (past_days <= 31))),
    CONSTRAINT epg_feeds_time_basis_check CHECK ((time_basis = ANY (ARRAY['scheduled'::text, 'asrun'::text]))),
    CONSTRAINT epg_feeds_tz_mode_check CHECK ((tz_mode = ANY (ARRAY['local'::text, 'utc'::text])))
);


--
-- Name: epg_import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epg_import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    trigger text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    CONSTRAINT epg_import_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'warnings'::text, 'failed'::text])))
);


--
-- Name: epg_import_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epg_import_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    url text,
    refresh_hours integer,
    fallback_tz text,
    keep_past_days integer DEFAULT 1 NOT NULL,
    lang text,
    auto_map boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    running_since timestamp with time zone,
    last_run_at timestamp with time zone,
    last_status text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_mode text DEFAULT 'single'::text NOT NULL,
    days_ahead integer DEFAULT 7 NOT NULL,
    min_days_ahead integer DEFAULT 5 NOT NULL,
    date_format text DEFAULT 'YYYY-MM-DD'::text NOT NULL,
    request_headers text,
    etag text,
    last_modified text,
    conditional_url text,
    coverage_until timestamp with time zone,
    coverage_low_since timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    new_channels text DEFAULT 'review'::text NOT NULL,
    time_mode text DEFAULT 'offsets'::text NOT NULL,
    CONSTRAINT epg_import_sources_check CHECK (((kind <> 'url'::text) OR (url IS NOT NULL))),
    CONSTRAINT epg_import_sources_date_format_chk CHECK ((date_format = ANY (ARRAY['YYYY-MM-DD'::text, 'YYYYMMDD'::text, 'DD/MM/YYYY'::text, 'unix'::text]))),
    CONSTRAINT epg_import_sources_days_chk CHECK ((((days_ahead >= 1) AND (days_ahead <= 21)) AND ((min_days_ahead >= 0) AND (min_days_ahead <= 21)) AND (min_days_ahead <= days_ahead))),
    CONSTRAINT epg_import_sources_keep_past_days_check CHECK (((keep_past_days >= 0) AND (keep_past_days <= 365))),
    CONSTRAINT epg_import_sources_kind_check CHECK ((kind = ANY (ARRAY['url'::text, 'upload'::text]))),
    CONSTRAINT epg_import_sources_new_channels_chk CHECK ((new_channels = ANY (ARRAY['review'::text, 'ignore'::text]))),
    CONSTRAINT epg_import_sources_refresh_hours_check CHECK (((refresh_hours IS NULL) OR ((refresh_hours >= 1) AND (refresh_hours <= 168)))),
    CONSTRAINT epg_import_sources_request_mode_chk CHECK ((request_mode = ANY (ARRAY['single'::text, 'per_day'::text]))),
    CONSTRAINT epg_import_sources_time_mode_chk CHECK ((time_mode = ANY (ARRAY['offsets'::text, 'local'::text])))
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
    recording_enabled boolean DEFAULT true NOT NULL,
    recording_retention_days integer,
    recording_retention_sec bigint,
    auto_vod boolean DEFAULT true NOT NULL,
    schema_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    auto_connect boolean DEFAULT true NOT NULL,
    desired_state text DEFAULT 'stopped'::text NOT NULL,
    stop_requested_at timestamp with time zone,
    stop_requested_by text,
    resume_attempts integer DEFAULT 0 NOT NULL,
    resume_last_attempt_at timestamp with time zone,
    resume_last_error text,
    resume_gave_up_at timestamp with time zone,
    resume_armed_at timestamp with time zone,
    filler_build jsonb,
    xmltv_id text,
    expected_viewers integer,
    graphics jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT events_check CHECK ((scheduled_end > scheduled_start)),
    CONSTRAINT events_check1 CHECK (((server_stop IS NULL) OR (server_start IS NULL) OR (server_stop > server_start))),
    CONSTRAINT events_check2 CHECK (((public_end IS NULL) OR (public_start IS NULL) OR (public_end > public_start))),
    CONSTRAINT events_desired_state_check CHECK ((desired_state = ANY (ARRAY['running'::text, 'stopped'::text])))
);


--
-- Name: fast_lineups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fast_lineups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    name text DEFAULT 'Lineup'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    epoch timestamp with time zone NOT NULL,
    epoch_cycle integer DEFAULT 0 NOT NULL,
    epoch_slot integer DEFAULT 0 NOT NULL,
    series_start jsonb DEFAULT '{}'::jsonb NOT NULL,
    zone text DEFAULT 'UTC'::text NOT NULL,
    slots jsonb DEFAULT '[]'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    applied_from timestamp with time zone,
    applied_until timestamp with time zone,
    applied_at timestamp with time zone,
    previous_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fast_lineups_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
);


--
-- Name: fast_playouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fast_playouts (
    channel_id uuid NOT NULL,
    launcher text NOT NULL,
    task_ref text,
    status text DEFAULT 'starting'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    last_pdt timestamp with time zone,
    media_sequence bigint,
    state jsonb,
    unreadable jsonb DEFAULT '[]'::jsonb NOT NULL,
    restarts integer DEFAULT 0 NOT NULL,
    error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fast_playouts_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'running'::text, 'stopped'::text, 'failed'::text])))
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    bytes bigint,
    content_type text,
    filename text,
    uploaded_at timestamp with time zone,
    error text
);


--
-- Name: fleet_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fleet_plans (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    plan jsonb NOT NULL,
    servers_saved integer DEFAULT 0 NOT NULL,
    hosts_considered integer DEFAULT 0 NOT NULL,
    CONSTRAINT fleet_plans_kind_check CHECK ((kind = 'consolidation'::text))
);


--
-- Name: fleet_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fleet_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fleet_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fleet_plans_id_seq OWNED BY public.fleet_plans.id;


--
-- Name: gfx_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    setup_id uuid NOT NULL,
    channel_id uuid,
    event_id uuid,
    targets text DEFAULT 'player'::text NOT NULL,
    run_mode text DEFAULT 'manual'::text NOT NULL,
    rule jsonb DEFAULT '{}'::jsonb NOT NULL,
    clear_in_ads boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gfx_assignments_check CHECK (((channel_id IS NULL) <> (event_id IS NULL))),
    CONSTRAINT gfx_assignments_run_mode_check CHECK ((run_mode = ANY (ARRAY['always'::text, 'rule'::text, 'trigger'::text, 'manual'::text]))),
    CONSTRAINT gfx_assignments_targets_check CHECK ((targets = ANY (ARRAY['player'::text, 'burn'::text, 'both'::text])))
);


--
-- Name: gfx_data_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_data_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    url text,
    every_sec integer DEFAULT 5 NOT NULL,
    on_stale text DEFAULT 'hold'::text NOT NULL,
    stale_after_sec integer DEFAULT 60 NOT NULL,
    payload jsonb,
    last_ok_at timestamp with time zone,
    last_error text,
    last_polled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gfx_data_sources_check CHECK (((kind = 'push'::text) OR (url IS NOT NULL))),
    CONSTRAINT gfx_data_sources_every_sec_check CHECK (((every_sec >= 1) AND (every_sec <= 3600))),
    CONSTRAINT gfx_data_sources_kind_check CHECK ((kind = ANY (ARRAY['json'::text, 'rss'::text, 'push'::text]))),
    CONSTRAINT gfx_data_sources_on_stale_check CHECK ((on_stale = ANY (ARRAY['hold'::text, 'hide'::text])))
);


--
-- Name: gfx_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_files (
    version_id uuid NOT NULL,
    path text NOT NULL,
    content_type text NOT NULL,
    sha256 text NOT NULL,
    size_bytes integer NOT NULL,
    content bytea NOT NULL
);


--
-- Name: gfx_impressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_impressions (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    assignment_id uuid,
    channel_id uuid,
    event_id uuid,
    app_id uuid,
    session_id text NOT NULL,
    origin text,
    shown_at timestamp with time zone DEFAULT now() NOT NULL,
    on_screen_ms integer
);


--
-- Name: gfx_impressions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gfx_impressions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gfx_impressions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gfx_impressions_id_seq OWNED BY public.gfx_impressions.id;


--
-- Name: gfx_rundown_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_rundown_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    event_id uuid NOT NULL,
    "position" integer NOT NULL,
    segment text DEFAULT ''::text NOT NULL,
    title text NOT NULL,
    setup_id uuid NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    cue jsonb DEFAULT '{"kind": "manual"}'::jsonb NOT NULL,
    stays_sec integer,
    status text DEFAULT 'ready'::text NOT NULL,
    taken_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gfx_rundown_items_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'on_air'::text, 'done'::text, 'skipped'::text])))
);


--
-- Name: gfx_setups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_setups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    note text,
    template_id uuid NOT NULL,
    version_id uuid NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    placement jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gfx_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_snapshots (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    channel_id uuid,
    event_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    state jsonb NOT NULL,
    CONSTRAINT gfx_snapshots_check CHECK (((channel_id IS NULL) <> (event_id IS NULL)))
);


--
-- Name: gfx_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gfx_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gfx_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gfx_snapshots_id_seq OWNED BY public.gfx_snapshots.id;


--
-- Name: gfx_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_state (
    assignment_id uuid NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    overrides text[] DEFAULT '{}'::text[] NOT NULL,
    on_air boolean DEFAULT false NOT NULL,
    rundown_item_id uuid,
    off_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: gfx_state_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_state_log (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    assignment_id uuid,
    event_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    field text,
    old_value jsonb,
    new_value jsonb
);


--
-- Name: gfx_state_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gfx_state_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gfx_state_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gfx_state_log_id_seq OWNED BY public.gfx_state_log.id;


--
-- Name: gfx_template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_template_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    version integer,
    status text DEFAULT 'draft'::text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    file_count integer DEFAULT 0 NOT NULL,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    CONSTRAINT gfx_template_versions_check CHECK (((status = 'draft'::text) = (version IS NULL))),
    CONSTRAINT gfx_template_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: gfx_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gfx_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    name text NOT NULL,
    kind text DEFAULT 'other'::text NOT NULL,
    source text DEFAULT 'paste'::text NOT NULL,
    duplicated_from uuid,
    archived_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gfx_templates_kind_check CHECK ((kind = ANY (ARRAY['scorebug'::text, 'lower_third'::text, 'ticker'::text, 'bug'::text, 'full_frame'::text, 'other'::text]))),
    CONSTRAINT gfx_templates_source_check CHECK ((source = ANY (ARRAY['volt'::text, 'upload'::text, 'paste'::text, 'duplicate'::text])))
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
    updated_by uuid,
    is_default boolean DEFAULT false NOT NULL
);


--
-- Name: host_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_samples (
    id bigint NOT NULL,
    host_id uuid NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    cpu_pct numeric(5,2),
    mem_pct numeric(5,2),
    net_in_bps bigint,
    net_out_bps bigint,
    tasks_on_host integer,
    CONSTRAINT host_samples_source_check CHECK ((source = ANY (ARRAY['cloudwatch'::text, 'onbox'::text, 'task_stats'::text])))
);


--
-- Name: host_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.host_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: host_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.host_samples_id_seq OWNED BY public.host_samples.id;


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
-- Name: ingest_provider_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_provider_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider text NOT NULL,
    label text NOT NULL,
    access_token text,
    refresh_token text,
    expires_at timestamp with time zone,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    linked_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingest_provider_accounts_provider_check CHECK ((provider = ANY (ARRAY['dropbox'::text, 'onedrive'::text, 'gdrive'::text, 'aspera'::text, 'masv'::text, 'signiant'::text])))
);


--
-- Name: ingest_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    rung text NOT NULL,
    scope_id text,
    ordinal integer DEFAULT 0 NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "when" jsonb,
    "then" jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingest_rules_rung_check CHECK ((rung = ANY (ARRAY['account'::text, 'type'::text, 'source'::text])))
);


--
-- Name: ingest_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider text NOT NULL,
    provider_account_id uuid,
    external_id text,
    state text DEFAULT 'created'::text NOT NULL,
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    destination jsonb DEFAULT '{}'::jsonb NOT NULL,
    spec jsonb,
    progress jsonb,
    error text,
    landed_paths jsonb,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ingest_transfers_state_check CHECK ((state = ANY (ARRAY['created'::text, 'running'::text, 'landed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: ingest_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    secret text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    events text[] DEFAULT '{ingested}'::text[] NOT NULL,
    last_status integer,
    last_at timestamp with time zone,
    last_error text,
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
    host_id uuid,
    container_instance_arn text,
    capacity_provider text,
    task_kind text,
    cpu_units integer,
    memory_mib integer,
    metered_through timestamp with time zone,
    est_cpu_units integer,
    est_memory_mib integer,
    est_gpu_share numeric(6,3),
    est_net_in_bps bigint,
    est_net_out_bps bigint,
    reserved_gpus integer,
    load_basis text,
    load_signature text,
    assigned_host_id uuid,
    placement_decision jsonb,
    moved_at timestamp with time zone,
    CONSTRAINT instances_check CHECK (((event_id IS NOT NULL) OR (channel_id IS NOT NULL))),
    CONSTRAINT instances_task_kind_check CHECK ((task_kind = ANY (ARRAY['transcode'::text, 'package_only'::text, 'radio'::text, 'captions'::text, 'thumbnailer'::text])))
);


--
-- Name: job_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_attempts (
    id bigint NOT NULL,
    job_id uuid NOT NULL,
    attempt integer NOT NULL,
    claimed_by text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    outcome text,
    error text,
    error_code text
);


--
-- Name: job_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_attempts_id_seq OWNED BY public.job_attempts.id;


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    state public.job_state DEFAULT 'queued'::public.job_state NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    progress_pct integer DEFAULT 0 NOT NULL,
    progress_note text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    last_error text,
    error_code text,
    correlation_id uuid,
    channel_id uuid,
    event_id uuid,
    claimed_by text,
    claimed_at timestamp with time zone,
    lease_until timestamp with time zone,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    dedupe_key text,
    CONSTRAINT jobs_progress_pct_check CHECK (((progress_pct >= 0) AND (progress_pct <= 100)))
);


--
-- Name: listener_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listener_sessions (
    id bigint NOT NULL,
    channel_id uuid,
    account_id uuid NOT NULL,
    stream_ref uuid,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone DEFAULT now() NOT NULL,
    seconds integer NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    bitrate_kbps integer,
    ip_hash text,
    user_agent text,
    geo_country text,
    ended_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT listener_sessions_check CHECK ((ended_at >= started_at))
);


--
-- Name: listener_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.listener_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: listener_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.listener_sessions_id_seq OWNED BY public.listener_sessions.id;


--
-- Name: media_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_events (
    id bigint NOT NULL,
    object_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    from_state public.media_state,
    to_state public.media_state,
    action text NOT NULL,
    tier public.storage_tier,
    actor text DEFAULT 'system'::text NOT NULL,
    detail text
);


--
-- Name: media_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.media_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: media_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.media_events_id_seq OWNED BY public.media_events.id;


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
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'upload'::text NOT NULL,
    channel_id uuid,
    captured_at timestamp with time zone,
    taken_at timestamp with time zone,
    gps_lat double precision,
    gps_lng double precision,
    gps_alt double precision,
    location text,
    camera text,
    title text,
    description text,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    creator text,
    copyright text,
    checksum text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    search tsvector
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
-- Name: media_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    object_id uuid NOT NULL,
    tier public.storage_tier NOT NULL,
    uri text NOT NULL,
    bytes bigint,
    present boolean DEFAULT true NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone
);


--
-- Name: media_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recording_id uuid,
    vod_asset_id uuid,
    channel_id uuid,
    event_id uuid,
    logical_key text NOT NULL,
    kind text NOT NULL,
    rendition text,
    state public.media_state DEFAULT 'pending'::public.media_state NOT NULL,
    bytes bigint,
    duration_ms bigint,
    segment_count integer,
    checksum text,
    retain_until timestamp with time zone,
    hold boolean DEFAULT false NOT NULL,
    hold_reason text,
    restore_requested_at timestamp with time zone,
    restore_expected_by timestamp with time zone,
    restore_expires_at timestamp with time zone,
    restore_tier text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_swept_at timestamp with time zone,
    CONSTRAINT media_objects_one_owner CHECK (((((recording_id IS NOT NULL))::integer + ((vod_asset_id IS NOT NULL))::integer) <= 1))
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
    updated_by uuid,
    is_standard boolean DEFAULT false NOT NULL,
    standard_key text,
    schema_org_type text,
    applies_to text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: mfa_backup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfa_backup_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal_kind text NOT NULL,
    principal_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mfa_backup_codes_principal_kind_check CHECK ((principal_kind = ANY (ARRAY['user'::text, 'viewer'::text])))
);


--
-- Name: music_lookups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_lookups (
    norm_key text NOT NULL,
    state text NOT NULL,
    artist text,
    title text,
    album text,
    released text,
    isrc text,
    genres text[] DEFAULT '{}'::text[] NOT NULL,
    label text,
    length_ms integer,
    recording_mbid text,
    release_mbid text,
    release_group_mbid text,
    confidence integer,
    reason text,
    attempts integer DEFAULT 0 NOT NULL,
    looked_up_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text,
    cover_url text,
    link text,
    providers_tried text,
    CONSTRAINT music_lookups_state_check CHECK ((state = ANY (ARRAY['hit'::text, 'miss'::text, 'error'::text])))
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    next_attempt_at timestamp with time zone,
    gave_up_at timestamp with time zone,
    provider_ref text
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
    updated_by uuid,
    encode_engine text DEFAULT 'builtin'::text NOT NULL,
    encode_engine_mode text,
    CONSTRAINT output_profiles_encode_engine_mode_check CHECK (((encode_engine_mode IS NULL) OR (encode_engine_mode = ANY (ARRAY['encode_only'::text, 'full'::text]))))
);


--
-- Name: payment_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret_ref text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_providers_provider_check CHECK ((provider = ANY (ARRAY['stripe'::text, 'appstore'::text, 'googleplay'::text, 'manual'::text])))
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
-- Name: player_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    channel_id uuid,
    name text DEFAULT 'Default'::text NOT NULL,
    layout text DEFAULT 'card'::text NOT NULL,
    primary_color text DEFAULT '#3f7bff'::text NOT NULL,
    secondary_color text DEFAULT '#0f1218'::text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    fallback_title text,
    fallback_text text,
    fallback_artwork_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_configs_layout_check CHECK ((layout = ANY (ARRAY['card'::text, 'bar'::text, 'hero'::text, 'stage'::text, 'video'::text, 'event'::text, 'audio_square'::text, 'audio_wave'::text, 'audio_nowplaying'::text, 'audio_radio'::text])))
);


--
-- Name: player_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.player_events (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    channel_id uuid,
    app_id uuid,
    session_id text NOT NULL,
    event text NOT NULL,
    origin text,
    layout text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: player_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.player_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: player_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.player_events_id_seq OWNED BY public.player_events.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    term jsonb NOT NULL,
    grants jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_rule text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: programme_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.programme_series (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid,
    title text NOT NULL,
    rrule text NOT NULL,
    duration_ms bigint NOT NULL,
    dtstart timestamp with time zone NOT NULL,
    template jsonb DEFAULT '{}'::jsonb NOT NULL,
    materialized_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    event_id uuid,
    kind text DEFAULT 'programme'::text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    rule jsonb,
    tz text,
    start_date date,
    until_date date,
    exdates text[] DEFAULT '{}'::text[] NOT NULL,
    policy text DEFAULT 'replace'::text NOT NULL,
    source_date date,
    CONSTRAINT chk_series_owner CHECK (((channel_id IS NOT NULL) OR (event_id IS NOT NULL))),
    CONSTRAINT chk_series_policy CHECK ((policy = ANY (ARRAY['replace'::text, 'skip'::text, 'keep'::text])))
);


--
-- Name: programmes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.programmes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid,
    event_id uuid,
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
    replacement_kind text DEFAULT 'none'::text NOT NULL,
    replacement_ref text,
    clip_status text DEFAULT 'none'::text NOT NULL,
    clip_asset_id uuid,
    clip_error text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_viewers integer,
    series_key text,
    series_date date,
    series_detached boolean DEFAULT false NOT NULL,
    CONSTRAINT programmes_check CHECK ((ends_at > starts_at)),
    CONSTRAINT programmes_check1 CHECK (((channel_id IS NOT NULL) OR (event_id IS NOT NULL)))
);


--
-- Name: publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vod_asset_id uuid NOT NULL,
    platform text NOT NULL,
    target_id uuid,
    external_id text,
    external_url text,
    status text DEFAULT 'pending'::text NOT NULL,
    views bigint DEFAULT 0 NOT NULL,
    error text,
    published_at timestamp with time zone,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_build_at timestamp with time zone,
    published_review_state text,
    published_qc_state text,
    published_by text,
    published_duration_ms bigint,
    stale boolean DEFAULT false NOT NULL,
    app_id uuid,
    post jsonb,
    progress integer,
    stage text,
    job_id uuid,
    attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT publications_platform_check CHECK ((platform = ANY (ARRAY['portal'::text, 'youtube'::text, 'facebook'::text, 'x'::text, 'tiktok'::text, 'dailymotion'::text, 'app'::text]))),
    CONSTRAINT publications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'failed'::text, 'removed'::text, 'withdrawn'::text])))
);


--
-- Name: publish_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publish_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    platform text NOT NULL,
    name text NOT NULL,
    external_account text,
    credentials_ref text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mode text DEFAULT 'live'::text NOT NULL,
    access_token_enc text,
    refresh_token_enc text,
    token_expires_at timestamp with time zone,
    scopes text[],
    account_label text,
    avatar_url text,
    link_status text DEFAULT 'connected'::text NOT NULL,
    link_detail text,
    linked_by uuid,
    linked_at timestamp with time zone,
    CONSTRAINT publish_targets_mode_chk CHECK ((mode = ANY (ARRAY['live'::text, 'sandbox'::text]))),
    CONSTRAINT publish_targets_platform_check CHECK ((platform = ANY (ARRAY['portal'::text, 'youtube'::text, 'facebook'::text, 'x'::text, 'tiktok'::text, 'dailymotion'::text, 'app'::text])))
);


--
-- Name: publishing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publishing_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT publishing_rules_check CHECK (((scope_kind = 'account'::text) = (scope_id IS NULL))),
    CONSTRAINT publishing_rules_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['account'::text, 'schema'::text, 'owner'::text])))
);


--
-- Name: purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    viewer_id uuid NOT NULL,
    product_id uuid NOT NULL,
    provider text NOT NULL,
    provider_txn_id text NOT NULL,
    status text NOT NULL,
    amount_cents integer,
    currency text,
    purchased_at timestamp with time zone DEFAULT now() NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    raw jsonb,
    CONSTRAINT purchases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'refunded'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: qc_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_events (
    id bigint NOT NULL,
    vod_asset_id uuid NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    check_name text NOT NULL,
    severity public.qc_severity NOT NULL,
    from_ms bigint,
    to_ms bigint,
    measured text,
    expected text,
    message text NOT NULL
);


--
-- Name: qc_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.qc_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qc_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.qc_events_id_seq OWNED BY public.qc_events.id;


--
-- Name: rate_gates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_gates (
    name text NOT NULL,
    next_at timestamp with time zone DEFAULT now() NOT NULL,
    calls bigint DEFAULT 0 NOT NULL,
    day date DEFAULT CURRENT_DATE NOT NULL,
    day_calls integer DEFAULT 0 NOT NULL
);


--
-- Name: recording_containers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recording_containers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid,
    event_id uuid,
    recording_type public.recording_type NOT NULL,
    broadcast_day date NOT NULL,
    tz text NOT NULL,
    anchor_hour smallint DEFAULT 6 NOT NULL,
    starts_at_ms bigint NOT NULL,
    ends_at_ms bigint NOT NULL,
    state public.container_state DEFAULT 'open'::public.container_state NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT recording_containers_anchor_hour_check CHECK (((anchor_hour >= 0) AND (anchor_hour <= 23))),
    CONSTRAINT recording_containers_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL))),
    CONSTRAINT recording_containers_check1 CHECK ((ends_at_ms > starts_at_ms))
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
    recording_type public.recording_type,
    container_id uuid,
    next_action public.retention_action,
    next_action_at timestamp with time zone,
    storage_state public.media_state,
    CONSTRAINT recordings_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL))),
    CONSTRAINT recordings_check1 CHECK (((kind <> 'channel_day'::public.recording_kind) OR ((channel_id IS NOT NULL) AND (day_utc IS NOT NULL))))
);


--
-- Name: reframe_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reframe_settings (
    account_id uuid NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    amr text[] DEFAULT '{pwd}'::text[] NOT NULL
);


--
-- Name: relay_accruals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relay_accruals (
    id bigint NOT NULL,
    relay_id uuid,
    host_id uuid,
    relay_ref uuid,
    relay_name text,
    instance_type text,
    lifecycle text,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    seconds integer NOT NULL,
    bytes_out bigint,
    peak_listeners integer,
    usd_per_hour numeric(10,5),
    usd_per_gb numeric(10,5),
    est_compute_usd numeric(12,6),
    est_egress_usd numeric(12,6),
    est_usd numeric(12,6),
    indicative boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relay_accruals_check CHECK ((to_at > from_at))
);


--
-- Name: relay_accruals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.relay_accruals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: relay_accruals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.relay_accruals_id_seq OWNED BY public.relay_accruals.id;


--
-- Name: relays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    host_id uuid,
    source_host text NOT NULL,
    source_port integer DEFAULT 8000 NOT NULL,
    source_user text DEFAULT 'source'::text NOT NULL,
    tls boolean DEFAULT false NOT NULL,
    secret_ref text,
    public_base text,
    admin_base text,
    admin_user text,
    max_listeners integer,
    state text DEFAULT 'active'::text NOT NULL,
    region text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relays_state_check CHECK ((state = ANY (ARRAY['active'::text, 'draining'::text, 'offline'::text])))
);


--
-- Name: retention_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    channel_id uuid,
    event_id uuid,
    name text NOT NULL,
    applies_to text DEFAULT 'recording'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_rules_applies_to_check CHECK ((applies_to = ANY (ARRAY['recording'::text, 'asset'::text, 'both'::text]))),
    CONSTRAINT retention_rules_one_scope CHECK ((((((account_id IS NOT NULL))::integer + ((channel_id IS NOT NULL))::integer) + ((event_id IS NOT NULL))::integer) = 1))
);


--
-- Name: retention_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    after_days integer NOT NULL,
    action public.retention_action NOT NULL,
    target_tier public.storage_tier,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_stages_after_days_check CHECK ((after_days >= 0))
);


--
-- Name: run_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_stops (
    instance_id uuid NOT NULL,
    account_id uuid NOT NULL,
    stream_kind text NOT NULL,
    stream_id uuid NOT NULL,
    stream_name text,
    intent text NOT NULL,
    origin text,
    stopped_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_stops_intent_check CHECK ((intent = ANY (ARRAY['operator'::text, 'schedule'::text, 'fault'::text, 'internal'::text]))),
    CONSTRAINT run_stops_stream_kind_check CHECK ((stream_kind = ANY (ARRAY['channel'::text, 'event'::text])))
);


--
-- Name: TABLE run_stops; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.run_stops IS 'Why each run ended (operator | schedule | fault | internal), one row per terminated instance. FK-free identity so it outlives the stream.';


--
-- Name: saas_signups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saas_signups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    name text,
    company text,
    plan_key text,
    mode text NOT NULL,
    status text DEFAULT 'lead'::text NOT NULL,
    account_id uuid,
    user_id uuid,
    checkout_session_id text,
    stripe_customer_id text,
    stripe_subscription_id text,
    source jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT saas_signups_mode_check CHECK ((mode = ANY (ARRAY['waitlist'::text, 'open'::text, 'paid'::text]))),
    CONSTRAINT saas_signups_status_check CHECK ((status = ANY (ARRAY['lead'::text, 'invited'::text, 'checkout'::text, 'active'::text, 'cancelled'::text])))
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
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_ms integer,
    checksum text
);


--
-- Name: security_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    principal_kind text NOT NULL,
    principal_id uuid NOT NULL,
    purpose text NOT NULL,
    channel text NOT NULL,
    target text NOT NULL,
    code_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_codes_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text]))),
    CONSTRAINT security_codes_principal_kind_check CHECK ((principal_kind = ANY (ARRAY['user'::text, 'viewer'::text])))
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
    auth_mode text DEFAULT 'none'::text NOT NULL,
    verify_code_hash text,
    verify_email text,
    verify_expires_at timestamp with time zone,
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
-- Name: social_oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_oauth_states (
    id text NOT NULL,
    account_id uuid NOT NULL,
    user_id uuid,
    platform text NOT NULL,
    code_verifier text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: song_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.song_details (
    account_id uuid NOT NULL,
    norm_key text NOT NULL,
    artist text NOT NULL,
    title text NOT NULL,
    album text,
    released text,
    label text,
    isrc text,
    genres text[] DEFAULT '{}'::text[] NOT NULL,
    image_key text,
    provider text NOT NULL,
    link text,
    terms text,
    chosen_by text,
    chosen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: storyboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storyboards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    stream_kind text NOT NULL,
    stream_id uuid NOT NULL,
    unit_start timestamp with time zone NOT NULL,
    unit_end timestamp with time zone NOT NULL,
    folder text NOT NULL,
    interval_ms integer NOT NULL,
    tile_w integer NOT NULL,
    tile_h integer NOT NULL,
    cols integer NOT NULL,
    rows integer NOT NULL,
    sheets jsonb DEFAULT '[]'::jsonb NOT NULL,
    vtt_key text,
    tiles integer DEFAULT 0 NOT NULL,
    frames integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    built_through timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storyboards_status_check CHECK ((status = ANY (ARRAY['building'::text, 'complete'::text, 'empty'::text]))),
    CONSTRAINT storyboards_stream_kind_check CHECK ((stream_kind = ANY (ARRAY['channel'::text, 'event'::text])))
);


--
-- Name: stream_breaks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_breaks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid,
    event_id uuid,
    programme_id uuid,
    source text DEFAULT 'manual'::text NOT NULL,
    source_ref text,
    starts_at timestamp with time zone NOT NULL,
    duration_ms integer NOT NULL,
    "position" text DEFAULT 'live'::text NOT NULL,
    at_asset_ms integer,
    status text DEFAULT 'scheduled'::text NOT NULL,
    hide_graphics boolean DEFAULT true NOT NULL,
    scte_event_id bigint,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stream_breaks_check CHECK (((channel_id IS NOT NULL) <> (event_id IS NOT NULL))),
    CONSTRAINT stream_breaks_duration_ms_check CHECK ((duration_ms > 0)),
    CONSTRAINT stream_breaks_position_check CHECK (("position" = ANY (ARRAY['mid'::text, 'end'::text, 'live'::text]))),
    CONSTRAINT stream_breaks_source_check CHECK ((source = ANY (ARRAY['fast'::text, 'scte35'::text, 'manual'::text, 'api'::text]))),
    CONSTRAINT stream_breaks_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'aired'::text, 'cancelled'::text])))
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
-- Name: stream_concurrency_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_concurrency_parts (
    process_id text NOT NULL,
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
    probe jsonb,
    probed_at timestamp with time zone,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
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
    boot_ms bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    degraded_outputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    metrics jsonb,
    CONSTRAINT stream_status_check CHECK (((event_id IS NOT NULL) <> (channel_id IS NOT NULL)))
);


--
-- Name: COLUMN stream_status.degraded_outputs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stream_status.degraded_outputs IS 'Outputs the RUNNING encoder dropped, as {output: reason}. Cleared on channel.start: a new run makes its own decisions and must not inherit the last one''s.';


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
-- Name: track_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.track_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    norm_key text NOT NULL,
    artist text,
    title text,
    album text,
    release_group_mbid text,
    recording_mbid text,
    artwork_url text,
    year integer,
    provider text,
    state text DEFAULT 'hit'::text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    looked_up_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_sample text,
    CONSTRAINT track_metadata_state_check CHECK ((state = ANY (ARRAY['hit'::text, 'miss'::text, 'error'::text])))
);


--
-- Name: upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    opened_by uuid,
    token text NOT NULL,
    purpose text DEFAULT 'filler'::text NOT NULL,
    filler_kind public.filler_kind,
    filler_asset_id uuid,
    filename text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    total_bytes bigint NOT NULL,
    chunk_size integer NOT NULL,
    chunk_count integer NOT NULL,
    received integer[] DEFAULT '{}'::integer[] NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    state public.upload_state DEFAULT 'open'::public.upload_state NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    ladder_group_id uuid,
    vod_asset_id uuid,
    relative_path text,
    schema_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'panel'::text NOT NULL,
    CONSTRAINT upload_sessions_chunk_count_check CHECK ((chunk_count > 0)),
    CONSTRAINT upload_sessions_chunk_size_check CHECK ((chunk_size > 0)),
    CONSTRAINT upload_sessions_one_asset_ck CHECK ((NOT ((filler_asset_id IS NOT NULL) AND (vod_asset_id IS NOT NULL)))),
    CONSTRAINT upload_sessions_total_bytes_check CHECK ((total_bytes > 0))
);


--
-- Name: COLUMN upload_sessions.vod_asset_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.upload_sessions.vod_asset_id IS 'The vod_assets row created when the upload was opened, so a large upload is visible and can be seen to fail while its bytes are still in flight.';


--
-- Name: usage_accruals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_accruals (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    instance_id uuid,
    channel_id uuid,
    event_id uuid,
    host_id uuid,
    stream_id uuid,
    stream_name text,
    task_kind text,
    instance_type text,
    lifecycle text,
    from_at timestamp with time zone NOT NULL,
    to_at timestamp with time zone NOT NULL,
    seconds integer NOT NULL,
    usd_per_hour numeric(10,5),
    est_usd numeric(12,6) DEFAULT 0 NOT NULL,
    indicative boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    instance_ref uuid,
    CONSTRAINT usage_accruals_check CHECK ((to_at >= from_at)),
    CONSTRAINT usage_accruals_seconds_check CHECK ((seconds >= 0))
);


--
-- Name: usage_accruals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.usage_accruals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usage_accruals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.usage_accruals_id_seq OWNED BY public.usage_accruals.id;


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
    peak_viewers integer DEFAULT 0 NOT NULL,
    period_kind text DEFAULT 'day'::text NOT NULL,
    compute_seconds bigint DEFAULT 0 NOT NULL,
    servers_used integer DEFAULT 0 NOT NULL,
    task_runs integer DEFAULT 0 NOT NULL,
    est_usd numeric(12,4) DEFAULT 0 NOT NULL,
    indicative boolean DEFAULT true NOT NULL,
    by_task_kind jsonb,
    computed_at timestamp with time zone,
    CONSTRAINT usage_records_period_kind_check CHECK ((period_kind = ANY (ARRAY['day'::text, 'week'::text, 'month'::text, 'year'::text])))
);


--
-- Name: user_access_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_access_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    user_id uuid NOT NULL,
    account_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by uuid,
    verified_at timestamp with time zone,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_access_links_kind_check CHECK ((kind = ANY (ARRAY['invite'::text, 'password_reset'::text])))
);


--
-- Name: user_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    token text NOT NULL,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);


--
-- Name: user_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_members (
    user_id uuid NOT NULL,
    group_id uuid NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    role_key text,
    tier public.user_role DEFAULT 'operator'::public.user_role NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
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
    user_group_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    platform_role public.platform_role,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_secret_ref text,
    display_name text,
    email_verified_at timestamp with time zone,
    phone text,
    phone_verified_at timestamp with time zone,
    mfa_email_enabled boolean DEFAULT false NOT NULL,
    mfa_sms_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: viewer_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.viewer_refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    viewer_id uuid NOT NULL,
    app_id uuid,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    user_agent text,
    amr text[] DEFAULT '{pwd}'::text[] NOT NULL
);


--
-- Name: viewers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.viewers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    external_id text NOT NULL,
    email text,
    groups text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    password_hash text,
    display_name text,
    avatar_ref text,
    profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    source text DEFAULT 'external'::text NOT NULL,
    email_verified_at timestamp with time zone,
    reset_code_hash text,
    reset_expires_at timestamp with time zone,
    password_changed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    phone text,
    phone_verified_at timestamp with time zone,
    mfa_email_enabled boolean DEFAULT false NOT NULL,
    mfa_sms_enabled boolean DEFAULT false NOT NULL,
    totp_secret text,
    totp_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT viewers_source_chk CHECK ((source = ANY (ARRAY['hosted'::text, 'external'::text]))),
    CONSTRAINT viewers_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'deleted'::text])))
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
    master_key text,
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
    source_block_count integer,
    source_run_count integer,
    source_container_count integer,
    source_segment_count integer,
    source_gap_ms bigint,
    source_coverage_pct numeric(5,1),
    build_strategy text,
    built_at timestamp with time zone,
    review_state public.review_state DEFAULT 'draft'::public.review_state NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    qc_state text,
    qc_at timestamp with time zone,
    export_mp3_key text,
    export_m4a_key text,
    availability_override jsonb DEFAULT '{}'::jsonb NOT NULL,
    availability jsonb,
    availability_sources jsonb,
    availability_state text DEFAULT 'draft'::text NOT NULL,
    available_from timestamp with time zone,
    available_until timestamp with time zone,
    withdrawn_at timestamp with time zone,
    withdrawn_by text,
    account_id uuid,
    source_kind text DEFAULT 'recording'::text NOT NULL,
    source_key text,
    source_bytes bigint,
    ladder_group_id uuid,
    encode_result jsonb,
    encode_job_id uuid,
    original_filename text,
    original_path text,
    sha256 text,
    mime text,
    ingest jsonb,
    awaiting_metadata text[],
    marker_group text,
    markers_detected_at timestamp with time zone,
    markers_note text,
    break_cues_ms integer[] DEFAULT '{}'::integer[] NOT NULL,
    top_height integer,
    video_codec text,
    metadata_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    poster_source text,
    poster_shape text,
    poster_reason text,
    poster_candidates jsonb,
    poster_locked boolean DEFAULT false NOT NULL,
    poster_picked_at timestamp with time zone,
    music_lookup jsonb,
    sprite jsonb,
    media_facts jsonb,
    CONSTRAINT vod_assets_availability_state_check CHECK ((availability_state = ANY (ARRAY['draft'::text, 'scheduled'::text, 'available'::text, 'expired'::text, 'withdrawn'::text]))),
    CONSTRAINT vod_assets_owner_ck CHECK (
CASE
    WHEN (source_kind = 'recording'::text) THEN ((event_id IS NOT NULL) <> (channel_id IS NOT NULL))
    ELSE ((account_id IS NOT NULL) AND (event_id IS NULL) AND (channel_id IS NULL))
END),
    CONSTRAINT vod_assets_poster_shape_ck CHECK (((poster_shape IS NULL) OR (poster_shape = ANY (ARRAY['wide'::text, 'square'::text])))),
    CONSTRAINT vod_assets_source_kind_check CHECK ((source_kind = ANY (ARRAY['recording'::text, 'upload'::text, 'watchfolder'::text])))
);


--
-- Name: COLUMN vod_assets.encode_result; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.encode_result IS 'What the encode actually produced: the rungs kept, the rungs dropped and why (usually a source shorter than the rung), and the probe it decided from. Absent means not yet encoded, which is not the same as an encode that produced nothing.';


--
-- Name: COLUMN vod_assets.top_height; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.top_height IS 'Height of the top rendition, kept by trg_vod_assets_encode_facts from encode_result.kept (file encodes) or the live output profile (recording-derived). NULL = not known.';


--
-- Name: COLUMN vod_assets.video_codec; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.video_codec IS 'Video codec of the renditions (h264, hevc, av1), kept by the same trigger. NULL = not known (a package-only source that does not declare it).';


--
-- Name: COLUMN vod_assets.metadata_provenance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.metadata_provenance IS 'Per metadata field, where its value came from when it was not typed: {"title":{"source":"epg","programmeId":"...","at":"...","by":"..."}}. A field edited by hand loses its entry.';


--
-- Name: COLUMN vod_assets.poster_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.poster_source IS 'Where poster_key came from: manual | cover_art | programme | station | frame | live_frame | metadata | none. NULL = not picked yet (the image worker will).';


--
-- Name: COLUMN vod_assets.poster_locked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.poster_locked IS 'A person chose the image. Automatic picks never replace it until they ask for an automatic pick again.';


--
-- Name: COLUMN vod_assets.media_facts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vod_assets.media_facts IS 'ffprobe of the delivered renditions: {how, at, video[{label,codec,profile,level,width,height,fps}], audio[{label,codec,channels,sampleRate,bitrateKbps,language}], subtitles[{codec,language}], run?, runs?}. NULL = not read yet.';


--
-- Name: vod_formats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vod_formats (
    vod_asset_id uuid NOT NULL,
    format text NOT NULL,
    path jsonb DEFAULT '{}'::jsonb NOT NULL,
    overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    edited boolean DEFAULT false NOT NULL,
    review text DEFAULT 'pending'::text NOT NULL,
    approved_at timestamp with time zone,
    approved_by text,
    render_state text DEFAULT 'none'::text NOT NULL,
    output_key text,
    width integer,
    height integer,
    bytes bigint,
    render_seconds numeric,
    render_error text,
    rendered_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vod_formats_format_check CHECK ((format = ANY (ARRAY['9x16'::text, '1x1'::text, '4x5'::text]))),
    CONSTRAINT vod_formats_render_state_check CHECK ((render_state = ANY (ARRAY['none'::text, 'queued'::text, 'rendering'::text, 'ready'::text, 'failed'::text, 'stale'::text]))),
    CONSTRAINT vod_formats_review_check CHECK ((review = ANY (ARRAY['pending'::text, 'approved'::text])))
);


--
-- Name: vod_markers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vod_markers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vod_asset_id uuid NOT NULL,
    kind text NOT NULL,
    start_ms integer NOT NULL,
    end_ms integer NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    confidence real,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vod_markers_check CHECK ((end_ms > start_ms)),
    CONSTRAINT vod_markers_kind_check CHECK ((kind = ANY (ARRAY['intro'::text, 'recap'::text, 'credits'::text]))),
    CONSTRAINT vod_markers_source_check CHECK ((source = ANY (ARRAY['auto'::text, 'manual'::text]))),
    CONSTRAINT vod_markers_start_ms_check CHECK ((start_ms >= 0)),
    CONSTRAINT vod_markers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suggested'::text])))
);


--
-- Name: vod_tracks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vod_tracks (
    vod_asset_id uuid NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    tracks_key text,
    summary jsonb,
    error text,
    job_id uuid,
    analysed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vod_tracks_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: watchfolder_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchfolder_items (
    id bigint NOT NULL,
    watchfolder_id uuid NOT NULL,
    account_id uuid NOT NULL,
    object_key text NOT NULL,
    checksum text,
    size_bytes bigint,
    status text DEFAULT 'seen'::text NOT NULL,
    matched_rule_id uuid,
    target_kind text,
    workflow text,
    media_file_id uuid,
    reason text,
    quarantine_key text,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution_note text,
    CONSTRAINT watchfolder_items_status_check CHECK ((status = ANY (ARRAY['seen'::text, 'ingested'::text, 'quarantined'::text, 'failed'::text, 'reprocessed'::text, 'removed'::text])))
);


--
-- Name: TABLE watchfolder_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.watchfolder_items IS 'One row per object seen in a watchfolder: the idempotency log and the QC queue in one table, because they are the same fact.';


--
-- Name: watchfolder_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.watchfolder_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: watchfolder_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.watchfolder_items_id_seq OWNED BY public.watchfolder_items.id;


--
-- Name: watchfolder_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchfolder_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    watchfolder_id uuid NOT NULL,
    ordinal integer NOT NULL,
    name text NOT NULL,
    match_type text DEFAULT 'glob'::text NOT NULL,
    pattern text NOT NULL,
    target_kind text NOT NULL,
    workflow text,
    action text DEFAULT 'accept'::text NOT NULL,
    reject_reason text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watchfolder_rules_action_check CHECK ((action = ANY (ARRAY['accept'::text, 'reject'::text]))),
    CONSTRAINT watchfolder_rules_match_type_check CHECK ((match_type = ANY (ARRAY['glob'::text, 'regex'::text, 'extension'::text, 'prefix'::text, 'suffix'::text])))
);


--
-- Name: watchfolders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.watchfolders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'local'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    default_target_kind text,
    quarantine_path text DEFAULT '_review'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_scan_at timestamp with time zone,
    last_scan_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid,
    updated_by uuid,
    ladder_group_id uuid,
    CONSTRAINT watchfolders_kind_check CHECK ((kind = ANY (ARRAY['local'::text, 's3'::text])))
);


--
-- Name: workflow_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_events (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    hook text NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    channel_id uuid,
    event_id uuid,
    title text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_events_id_seq OWNED BY public.workflow_events.id;


--
-- Name: ad_beacons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_beacons ALTER COLUMN id SET DEFAULT nextval('public.ad_beacons_id_seq'::regclass);


--
-- Name: ad_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_decisions ALTER COLUMN id SET DEFAULT nextval('public.ad_decisions_id_seq'::regclass);


--
-- Name: addon_run_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_run_events ALTER COLUMN id SET DEFAULT nextval('public.addon_run_events_id_seq'::regclass);


--
-- Name: air_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.air_sessions ALTER COLUMN id SET DEFAULT nextval('public.air_sessions_id_seq'::regclass);


--
-- Name: fleet_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_plans ALTER COLUMN id SET DEFAULT nextval('public.fleet_plans_id_seq'::regclass);


--
-- Name: gfx_impressions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions ALTER COLUMN id SET DEFAULT nextval('public.gfx_impressions_id_seq'::regclass);


--
-- Name: gfx_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_snapshots ALTER COLUMN id SET DEFAULT nextval('public.gfx_snapshots_id_seq'::regclass);


--
-- Name: gfx_state_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state_log ALTER COLUMN id SET DEFAULT nextval('public.gfx_state_log_id_seq'::regclass);


--
-- Name: host_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_samples ALTER COLUMN id SET DEFAULT nextval('public.host_samples_id_seq'::regclass);


--
-- Name: job_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_attempts ALTER COLUMN id SET DEFAULT nextval('public.job_attempts_id_seq'::regclass);


--
-- Name: listener_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listener_sessions ALTER COLUMN id SET DEFAULT nextval('public.listener_sessions_id_seq'::regclass);


--
-- Name: media_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_events ALTER COLUMN id SET DEFAULT nextval('public.media_events_id_seq'::regclass);


--
-- Name: player_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_events ALTER COLUMN id SET DEFAULT nextval('public.player_events_id_seq'::regclass);


--
-- Name: qc_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_events ALTER COLUMN id SET DEFAULT nextval('public.qc_events_id_seq'::regclass);


--
-- Name: relay_accruals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_accruals ALTER COLUMN id SET DEFAULT nextval('public.relay_accruals_id_seq'::regclass);


--
-- Name: segments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segments ALTER COLUMN id SET DEFAULT nextval('public.segments_id_seq'::regclass);


--
-- Name: stream_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_events ALTER COLUMN id SET DEFAULT nextval('public.stream_events_id_seq'::regclass);


--
-- Name: usage_accruals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals ALTER COLUMN id SET DEFAULT nextval('public.usage_accruals_id_seq'::regclass);


--
-- Name: watchfolder_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items ALTER COLUMN id SET DEFAULT nextval('public.watchfolder_items_id_seq'::regclass);


--
-- Name: workflow_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events ALTER COLUMN id SET DEFAULT nextval('public.workflow_events_id_seq'::regclass);


--
-- Data for Name: accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.accounts (id, name, plan_tier, billing_mode, included_gb, markup_pct, subscription_fee_month, max_channels, max_concurrent_sources, max_renditions, max_asset_hours, status, created_at, updated_at, parent_account_id, captions_provider, require_review_to_publish, block_publish_on_qc_error, analytics_raw_retention_days, require_admin_mfa, brand_logo_ref, brand_primary, brand_secondary, geo_access) FROM stdin;
06df1746-3123-4d83-b99d-a887cbbc17ca	RTM	standard	enterprise	0	0.5000	0.00	20	5	5	12	active	2026-08-04 15:32:22.563241+00	2026-08-04 15:32:22.563241+00	\N	whisper	f	f	90	f	\N	\N	\N	\N
\.


--
-- Data for Name: ad_beacons; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ad_beacons (id, channel_id, break_id, session_id, pod_index, ad_id, creative_key, event, url_index, url, due_at, status, ok, error, elapsed_ms, created_at, sent_at) FROM stdin;
\.


--
-- Data for Name: ad_creatives; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ad_creatives (id, account_id, creative_key, source_url, ad_system, title, vod_asset_id, status, duration_ms, error, plays, first_seen_at, last_seen_at) FROM stdin;
\.


--
-- Data for Name: ad_decisions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ad_decisions (id, channel_id, break_id, session_id, ad_server_id, elapsed_ms, requests, break_ms, ad_ms, house_ms, slate_ms, fallback, problems, created_at) FROM stdin;
\.


--
-- Data for Name: ad_servers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ad_servers (id, account_id, name, vendor, tag_template, timeout_ms, max_wrappers, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: addon_run_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.addon_run_events (id, run_id, ts, type, state, progress_pct, step, message, data) FROM stdin;
\.


--
-- Data for Name: addon_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.addon_runs (id, account_id, addon_id, trigger_id, hook, subject_type, subject_id, subject_title, channel_id, event_id, options, state, progress_pct, step, steps, external_ref, result, error, callback_hash, job_id, created_by, created_at, dispatched_at, updated_at, finished_at, deadline_at) FROM stdin;
\.


--
-- Data for Name: addon_services; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.addon_services (id, account_id, name, description, category, kind, endpoint_url, signing_secret, accepts, steps, timeout_sec, max_attempts, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: addon_triggers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.addon_triggers (id, account_id, addon_id, hook, filter, options, enabled, created_at) FROM stdin;
\.


--
-- Data for Name: air_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.air_sessions (id, account_id, stream_kind, stream_id, stream_name, channel_id, event_id, from_at, to_at, seconds, opened_by, closed_by, close_reason, created_at) FROM stdin;
\.


--
-- Data for Name: analytics_rollups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.analytics_rollups (id, account_id, scope, scope_id, bucket_date, total_views, unique_views, peak_concurrent, watch_seconds, blocked_count, by_app, by_device, by_geo, sealed, sealed_at, sessions_counted, recomputed_at) FROM stdin;
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
-- Data for Name: asset_reviews; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.asset_reviews (id, vod_asset_id, at, actor_id, actor_label, from_state, to_state, note, overrode_qc, qc_state_at_decision) FROM stdin;
\.


--
-- Data for Name: audit_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_log (id, account_id, user_id, action, entity_type, entity_id, detail, created_at) FROM stdin;
a28a6521-a584-4fee-837a-85f1de64e6b7	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	channel	7f180e33-0bd3-45d6-b838-8b673a97f7b2	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"name": "RTM News 24", "group_id": "ae4f0d4d-3ddc-4043-8591-449eccdf9b3c"}}	2026-08-04 15:33:29.464636+00
912b6739-2898-4711-ac39-030fcd64eeba	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	channel	53c0d5e7-06c7-4245-808b-5bc9d4c5e8b2	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"name": "RTM Sport (packaged)", "group_id": "e84e4321-195b-4633-bd1f-d78c1d8f0431"}}	2026-08-04 15:33:30.043603+00
eb263d74-520e-4812-942f-160e458ef057	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	channel	8554fa8e-dd72-4a8f-969f-8702c247e41f	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"name": "RTM UI Test Channel", "group_id": "ae4f0d4d-3ddc-4043-8591-449eccdf9b3c"}}	2026-08-05 09:53:47.594971+00
81d46bc2-cee6-4788-abbd-871f02734e7d	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	update	channel	7f180e33-0bd3-45d6-b838-8b673a97f7b2	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "changes": {"geo_mode": {"to": "block", "from": "worldwide"}, "geo_countries": {"to": ["MY", "SG"], "from": []}, "dvr_window_sec": {"to": 1800, "from": 3600}}}	2026-08-05 18:18:00.117289+00
489a5beb-6aec-4160-a855-7a2848302b04	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	channel	ed16058f-135a-4870-b442-de0359e11991	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"name": "TC Test", "ladder": 3, "sources": 2, "group_id": "ae4f0d4d-3ddc-4043-8591-449eccdf9b3c"}}	2026-08-06 13:04:36.16433+00
3e9c4646-4c30-4509-957b-15225168fba3	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	channel	ad96afa3-b415-4efc-a17f-123b631b95c2	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"name": "PKG Test", "ladder": 3, "sources": 4, "group_id": "e84e4321-195b-4633-bd1f-d78c1d8f0431"}}	2026-08-06 13:04:36.188367+00
a1e4df99-0b7f-4554-8055-84721076eca8	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	media_file	5181ced9-a220-41d6-b3f6-397ea75536d3	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"kind": "slate", "path": "slates/news/evening.png", "bytes": 70}}	2026-08-06 14:21:03.72026+00
0ddca19e-8933-4e03-a65d-023da40e3bf9	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	create	media_file	0aae2c8d-6e15-4291-aeb6-b9713ddc89c3	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"kind": "watermark", "path": "watermarks/bug.png", "bytes": 70}}	2026-08-06 14:21:03.776629+00
837780f1-35ff-48be-aa89-4b70097be2b8	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	update	media_file	5181ced9-a220-41d6-b3f6-397ea75536d3	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"to": "slates/holding/evening.png", "from": "slates/news/evening.png", "kind": "slate"}}	2026-08-06 14:21:03.879548+00
1ad0bd72-bea7-494a-a6e4-07186cec7bd2	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	delete	media_file	5181ced9-a220-41d6-b3f6-397ea75536d3	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"path": "slates/holding/evening.png", "forced": false}}	2026-08-06 14:21:03.910127+00
fbe2335e-2326-43b2-862f-28645102f254	06df1746-3123-4d83-b99d-a887cbbc17ca	c7db1658-3f70-4996-af60-8335ed337479	update	output_profile	b31fd13f-2111-4f1a-a43d-d2afe8f642b7	{"actor": "c7db1658-3f70-4996-af60-8335ed337479", "snapshot": {"captions": {"enabled": true, "targets": ["en", "ms"]}}}	2026-08-05 18:18:00.124376+00
\.


--
-- Data for Name: channel_ads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.channel_ads (channel_id, mode, policy, ad_server_id, house_ads, decision_scope, updated_at) FROM stdin;
\.


--
-- Data for Name: channels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.channels (id, group_id, name, kind, radio_config, status, enabled, purchasing_mode, resilience_tier, input_failover_enabled, auto_failback, input_loss_behavior, filler_asset_id, filler_slate_ref, recording_enabled, recording_retention_days, recording_retention_sec, schema_id, metadata, created_at, updated_at, version, created_by, updated_by, dvr_window_sec, dvr_mode, geo_mode, geo_countries, output_ladder, fallback_transcode, tz, broadcast_anchor_hour, daypart_preset, on_air, epg_enabled, brand_ref, watermark_enabled, watermark_ref, watermark_position, watermark_offset_x, watermark_offset_y, watermark_opacity, watermark_scale, auto_connect, desired_state, stop_requested_at, stop_requested_by, resume_attempts, resume_last_attempt_at, resume_last_error, resume_gave_up_at, relay_id, resume_armed_at, filler_build, xmltv_id, guide_icon_ref, graphics, origin, fast_media) FROM stdin;
\.


--
-- Data for Name: clip_segments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.clip_segments (id, vod_asset_id, ordinal, recording_id, container_id, run_id, block_index, rendition, first_seq, last_seq, segment_count, source_from_ms, source_to_ms, clip_offset_ms, duration_ms, partial_head, partial_tail, created_at) FROM stdin;
\.


--
-- Data for Name: compute_hosts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.compute_hosts (id, kind, external_id, instance_type, region, availability_zone, lifecycle, vcpus, memory_mib, state, first_seen_at, last_seen_at, last_metric_at, role) FROM stdin;
\.


--
-- Data for Name: compute_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.compute_rates (id, instance_type, lifecycle, region, usd_per_hour, indicative, effective_from, note) FROM stdin;
d637c7a0-418a-4dc4-94c9-1653861c9dab	c6i.large	on_demand	\N	0.08500	t	-infinity	seeded from services/billing.ts
da7c0e7d-b457-4f97-8caa-03863ae73f85	c6i.large	spot	\N	0.02550	t	-infinity	seeded, ~30% of on-demand
32e1f416-34f0-434d-ab78-c4d826869d8e	c6i.xlarge	on_demand	\N	0.17000	t	-infinity	seeded from services/billing.ts
80216b74-4fab-48fc-92fe-2d2e98036f83	c6i.xlarge	spot	\N	0.05100	t	-infinity	seeded, ~30% of on-demand
a1d5e746-f190-4a35-8472-f28dd6e970b6	c6i.2xlarge	on_demand	\N	0.34000	t	-infinity	seeded from services/billing.ts
9634aa96-05d0-49a4-9ba1-2f9173558661	c6i.2xlarge	spot	\N	0.10200	t	-infinity	seeded, ~30% of on-demand
75270d29-1e73-424c-9d84-d3a3f374044c	t3.small	on_demand	\N	0.02080	t	-infinity	radio station, seeded
7e250dd8-889b-44e4-a77b-949b3a87f013	t3.small	spot	\N	0.00624	t	-infinity	radio station, seeded
587759e0-ac21-4496-a971-5ee789d47523	g4dn.xlarge	on_demand	\N	0.52600	t	-infinity	captions add-on (GPU), seeded
a09d38e5-998e-4a4f-8482-374c769512f9	g4dn.xlarge	spot	\N	0.15780	t	-infinity	captions add-on (GPU), seeded
3cccfd5f-dd15-4787-98c7-8070d132fc30	c6in.large	on_demand	\N	0.11340	t	-infinity	icecast relay, network-optimised, seeded
c794a195-8052-4a02-8815-ac315283edc7	c6in.large	spot	\N	0.03402	t	-infinity	icecast relay, seeded, ~30% of on-demand
2ff2a72a-31de-4638-9398-fb741ae42c60	t3.medium	on_demand	\N	0.04160	t	-infinity	small icecast relay, seeded
891a34f3-4501-4206-83c0-c7d5d00f6f31	t3.medium	spot	\N	0.01248	t	-infinity	small icecast relay, seeded, ~30%
\.


--
-- Data for Name: cost_actuals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cost_actuals (id, period_month, category, usd, source, note, entered_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: dayparts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.dayparts (id, channel_id, ordinal, name, starts_local, days_mask, created_at) FROM stdin;
\.


--
-- Data for Name: drm_configs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.drm_configs (id, account_id, provider, scheme, systems, tenant_id, key_service_url, license_service_url, management_key_ref, created_at) FROM stdin;
\.


--
-- Data for Name: egress_rates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.egress_rates (id, region, usd_per_gb, indicative, effective_from, note) FROM stdin;
fba99233-35cc-491d-9b0a-bf34194560b7	\N	0.09000	t	-infinity	seeded: common first-tier cloud egress, replace with the contracted rate
\.


--
-- Data for Name: encode_ladder_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.encode_ladder_groups (id, account_id, name, description, tracks_output_profile_id, segment_dur, fps, packaging, codec_backend, cap_to_source, is_default, created_at, updated_at, version, created_by, updated_by) FROM stdin;
\.


--
-- Data for Name: encode_ladder_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.encode_ladder_members (id, group_id, profile_id, ordinal) FROM stdin;
\.


--
-- Data for Name: encode_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.encode_profiles (id, account_id, name, height, bitrate_kbps, fps, notes, created_at, updated_at, version, created_by, updated_by) FROM stdin;
\.


--
-- Data for Name: engine_bindings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.engine_bindings (task_arn, engine_id, mode, stream_kind, stream_id, external_ref, meta, created_at, stopped_at, stop_reason) FROM stdin;
\.


--
-- Data for Name: entitlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.entitlements (id, account_id, viewer_id, purchase_id, product_id, grants, valid_from, valid_until, revoked_at, note) FROM stdin;
\.


--
-- Data for Name: epg_batches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.epg_batches (id, account_id, owner_kind, owner_id, action, label, created_ids, removed, exdates_added, series_id, created_by, created_at, undone_at) FROM stdin;
\.


--
-- Data for Name: epg_channel_aliases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.epg_channel_aliases (id, account_id, source_id, external_id, display_name, icon, channel_id, mapped_by, last_seen_at, last_programmes, ignored, lcn, programmes_in_feed, feed_from, feed_to, first_seen_at) FROM stdin;
\.


--
-- Data for Name: epg_feeds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.epg_feeds (id, account_id, name, token_prefix, token_hash, channel_ids, include_events, past_days, future_days, time_basis, tz_mode, lang, enabled, last_polled_at, poll_count, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: epg_import_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.epg_import_runs (id, source_id, trigger, started_at, finished_at, status, counts, warnings, error) FROM stdin;
\.


--
-- Data for Name: epg_import_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.epg_import_sources (id, account_id, name, kind, url, refresh_hours, fallback_tz, keep_past_days, lang, auto_map, enabled, next_run_at, running_since, last_run_at, last_status, last_error, created_at, updated_at, request_mode, days_ahead, min_days_ahead, date_format, request_headers, etag, last_modified, conditional_url, coverage_until, coverage_low_since, consecutive_failures, new_channels, time_mode) FROM stdin;
\.


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.events (id, group_id, name, status, scheduled_start, scheduled_end, server_start, server_stop, public_start, public_end, actual_start, actual_end, purchasing_mode, resilience_tier, input_failover_enabled, auto_failback, input_loss_behavior, filler_asset_id, filler_slate_ref, recording_enabled, recording_retention_days, recording_retention_sec, auto_vod, schema_id, metadata, created_at, updated_at, version, created_by, updated_by, auto_connect, desired_state, stop_requested_at, stop_requested_by, resume_attempts, resume_last_attempt_at, resume_last_error, resume_gave_up_at, resume_armed_at, filler_build, xmltv_id, expected_viewers, graphics) FROM stdin;
\.


--
-- Data for Name: fast_lineups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fast_lineups (id, channel_id, name, version, status, epoch, epoch_cycle, epoch_slot, series_start, zone, slots, settings, applied_from, applied_until, applied_at, previous_id, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: fast_playouts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fast_playouts (channel_id, launcher, task_ref, status, started_at, last_seen_at, last_pdt, media_sequence, state, unreadable, restarts, error, updated_at) FROM stdin;
\.


--
-- Data for Name: filler_assets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.filler_assets (id, account_id, kind, name, source_key, width, height, duration_ms, poster_key, status, created_at, updated_at, bytes, content_type, filename, uploaded_at, error) FROM stdin;
\.


--
-- Data for Name: fleet_plans; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.fleet_plans (id, at, kind, plan, servers_saved, hosts_considered) FROM stdin;
\.


--
-- Data for Name: gfx_assignments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_assignments (id, account_id, setup_id, channel_id, event_id, targets, run_mode, rule, clear_in_ads, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: gfx_data_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_data_sources (id, account_id, name, kind, url, every_sec, on_stale, stale_after_sec, payload, last_ok_at, last_error, last_polled_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: gfx_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_files (version_id, path, content_type, sha256, size_bytes, content) FROM stdin;
\.


--
-- Data for Name: gfx_impressions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_impressions (id, account_id, assignment_id, channel_id, event_id, app_id, session_id, origin, shown_at, on_screen_ms) FROM stdin;
\.


--
-- Data for Name: gfx_rundown_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_rundown_items (id, account_id, event_id, "position", segment, title, setup_id, "values", cue, stays_sec, status, taken_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: gfx_setups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_setups (id, account_id, name, note, template_id, version_id, fields, placement, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: gfx_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_snapshots (id, account_id, channel_id, event_id, at, state) FROM stdin;
\.


--
-- Data for Name: gfx_state; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_state (assignment_id, "values", overrides, on_air, rundown_item_id, off_at, updated_at, updated_by) FROM stdin;
\.


--
-- Data for Name: gfx_state_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_state_log (id, account_id, assignment_id, event_id, at, actor, action, field, old_value, new_value) FROM stdin;
\.


--
-- Data for Name: gfx_template_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_template_versions (id, template_id, version, status, manifest, checks, size_bytes, file_count, note, created_by, created_at, published_at, published_by) FROM stdin;
\.


--
-- Data for Name: gfx_templates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.gfx_templates (id, account_id, name, kind, source, duplicated_from, archived_at, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.groups (id, account_id, name, output_profile_id, max_concurrent, max_channels, created_at, version, created_by, updated_by, is_default) FROM stdin;
ae4f0d4d-3ddc-4043-8591-449eccdf9b3c	06df1746-3123-4d83-b99d-a887cbbc17ca	RTM Transcode	b31fd13f-2111-4f1a-a43d-d2afe8f642b7	5	10	2026-08-04 15:32:39.480476+00	1	\N	\N	t
e84e4321-195b-4633-bd1f-d78c1d8f0431	06df1746-3123-4d83-b99d-a887cbbc17ca	RTM Packaging	e5b1b2d6-ffcb-401a-9f89-775afbb4d1b2	5	10	2026-08-04 15:32:39.480476+00	1	\N	\N	f
\.


--
-- Data for Name: host_samples; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.host_samples (id, host_id, at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host) FROM stdin;
\.


--
-- Data for Name: identity_providers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.identity_providers (id, account_id, kind, provider, issuer, client_id, secret_ref, domains, enabled, created_at) FROM stdin;
\.


--
-- Data for Name: ingest_provider_accounts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ingest_provider_accounts (id, account_id, provider, label, access_token, refresh_token, expires_at, config, enabled, linked_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: ingest_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ingest_rules (id, account_id, rung, scope_id, ordinal, name, enabled, "when", "then", metadata_defaults, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: ingest_transfers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ingest_transfers (id, account_id, provider, provider_account_id, external_id, state, files, destination, spec, progress, error, landed_paths, created_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: ingest_webhooks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ingest_webhooks (id, account_id, name, url, secret, enabled, events, last_status, last_at, last_error, created_at) FROM stdin;
\.


--
-- Data for Name: instances; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.instances (id, event_id, channel_id, ec2_instance_id, task_arn, instance_type, is_gpu, lifecycle, role, state, availability_zone, launched_at, terminated_at, cost_estimate, host_id, container_instance_arn, capacity_provider, task_kind, cpu_units, memory_mib, metered_through, est_cpu_units, est_memory_mib, est_gpu_share, est_net_in_bps, est_net_out_bps, reserved_gpus, load_basis, load_signature, assigned_host_id, placement_decision, moved_at) FROM stdin;
\.


--
-- Data for Name: job_attempts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.job_attempts (id, job_id, attempt, claimed_by, started_at, finished_at, outcome, error, error_code) FROM stdin;
\.


--
-- Data for Name: jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.jobs (id, type, state, priority, payload, result, progress_pct, progress_note, attempts, max_attempts, last_error, error_code, correlation_id, channel_id, event_id, claimed_by, claimed_at, lease_until, run_after, started_at, finished_at, created_at, created_by, dedupe_key) FROM stdin;
\.


--
-- Data for Name: listener_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.listener_sessions (id, channel_id, account_id, stream_ref, started_at, ended_at, seconds, bytes, bitrate_kbps, ip_hash, user_agent, geo_country, ended_reason, created_at) FROM stdin;
\.


--
-- Data for Name: media_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_events (id, object_id, at, from_state, to_state, action, tier, actor, detail) FROM stdin;
\.


--
-- Data for Name: media_files; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_files (id, account_id, kind, path, folder, name, content_type, size_bytes, width, height, tags, store_key, status, version, created_by, updated_by, created_at, updated_at, source, channel_id, captured_at, taken_at, gps_lat, gps_lng, gps_alt, location, camera, title, description, keywords, creator, copyright, checksum, metadata, search) FROM stdin;
\.


--
-- Data for Name: media_folders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_folders (id, account_id, path, created_at) FROM stdin;
\.


--
-- Data for Name: media_locations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_locations (id, object_id, tier, uri, bytes, present, verified_at, created_at, removed_at) FROM stdin;
\.


--
-- Data for Name: media_objects; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.media_objects (id, recording_id, vod_asset_id, channel_id, event_id, logical_key, kind, rendition, state, bytes, duration_ms, segment_count, checksum, retain_until, hold, hold_reason, restore_requested_at, restore_expected_by, restore_expires_at, restore_tier, last_error, created_at, updated_at, last_swept_at) FROM stdin;
\.


--
-- Data for Name: metadata_schemas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metadata_schemas (id, account_id, name, description, fields, target_kind, domain, extends_id, created_at, updated_at, version, created_by, updated_by, is_standard, standard_key, schema_org_type, applies_to) FROM stdin;
\.


--
-- Data for Name: mfa_backup_codes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.mfa_backup_codes (id, principal_kind, principal_id, code_hash, used_at, created_at) FROM stdin;
\.


--
-- Data for Name: music_lookups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.music_lookups (norm_key, state, artist, title, album, released, isrc, genres, label, length_ms, recording_mbid, release_mbid, release_group_mbid, confidence, reason, attempts, looked_up_at, provider, cover_url, link, providers_tried) FROM stdin;
\.


--
-- Data for Name: notification_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_deliveries (id, notification_id, account_id, recipient, channel, status, attempts, last_error, read_at, sent_at, created_at, next_attempt_at, gave_up_at, provider_ref) FROM stdin;
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

COPY public.output_profiles (id, account_id, name, rungs, packaging, workflow_type, codec_backend, segment_dur, dvr_window_sec, retention_days, overlays, drm_enabled, drm_config_id, captions_enabled, caption_engine, caption_source_lang, caption_targets, caption_offset_sec, caption_model_size, created_at, updated_at, version, created_by, updated_by, encode_engine, encode_engine_mode) FROM stdin;
b31fd13f-2111-4f1a-a43d-d2afe8f642b7	06df1746-3123-4d83-b99d-a887cbbc17ca	Transcode HD	[{"height": 1080, "bitrate_kbps": 5000}, {"height": 720, "bitrate_kbps": 2800}, {"height": 480, "bitrate_kbps": 1200}]	both	transcode	x264	4.00	300	30	[]	f	\N	f	gladia	auto	[]	0	small	2026-08-04 15:32:39.477179+00	2026-08-05 18:18:00.123603+00	1	\N	\N	builtin	\N
e5b1b2d6-ffcb-401a-9f89-775afbb4d1b2	06df1746-3123-4d83-b99d-a887cbbc17ca	Package passthrough	[]	both	package_only	nvenc	4.00	300	30	[]	f	\N	f	gladia	auto	[]	0	small	2026-08-04 15:32:39.479794+00	2026-08-04 15:32:39.479794+00	1	\N	\N	builtin	\N
\.


--
-- Data for Name: payment_providers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_providers (id, account_id, provider, config, secret_ref, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: play_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.play_sessions (id, account_id, session_key, app_id, asset_kind, asset_id, device_type, client_app, referrer_class, geo_country, ip_hash, started_at, last_seen_at, ended_at, seconds_watched, max_bitrate_kbps, ttff_ms, rebuffer_ms, bytes, blocked) FROM stdin;
\.


--
-- Data for Name: player_configs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.player_configs (id, account_id, channel_id, name, layout, primary_color, secondary_color, options, fallback_title, fallback_text, fallback_artwork_url, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: player_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.player_events (id, account_id, channel_id, app_id, session_id, event, origin, layout, detail, at) FROM stdin;
\.


--
-- Data for Name: products; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.products (id, account_id, key, name, term, grants, provider_ids, source_rule, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: programme_series; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.programme_series (id, channel_id, title, rrule, duration_ms, dtstart, template, materialized_until, created_at, updated_at, event_id, kind, items, rule, tz, start_date, until_date, exdates, policy, source_date) FROM stdin;
\.


--
-- Data for Name: programmes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.programmes (id, channel_id, event_id, series_id, source_ref, title, starts_at, ends_at, status, actual_start, actual_end, geo_mode, geo_countries, replacement_asset_id, auto_vod, replacement_kind, replacement_ref, clip_status, clip_asset_id, clip_error, metadata, created_at, updated_at, expected_viewers, series_key, series_date, series_detached) FROM stdin;
\.


--
-- Data for Name: publications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.publications (id, vod_asset_id, platform, target_id, external_id, external_url, status, views, error, published_at, last_synced_at, created_at, published_build_at, published_review_state, published_qc_state, published_by, published_duration_ms, stale, app_id, post, progress, stage, job_id, attempts) FROM stdin;
\.


--
-- Data for Name: publish_targets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.publish_targets (id, account_id, platform, name, external_account, credentials_ref, enabled, created_at, updated_at, mode, access_token_enc, refresh_token_enc, token_expires_at, scopes, account_label, avatar_url, link_status, link_detail, linked_by, linked_at) FROM stdin;
\.


--
-- Data for Name: publishing_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.publishing_rules (id, account_id, scope_kind, scope_id, settings, created_by, updated_by, version, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: purchases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.purchases (id, account_id, viewer_id, product_id, provider, provider_txn_id, status, amount_cents, currency, purchased_at, period_start, period_end, raw) FROM stdin;
\.


--
-- Data for Name: qc_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.qc_events (id, vod_asset_id, at, check_name, severity, from_ms, to_ms, measured, expected, message) FROM stdin;
\.


--
-- Data for Name: rate_gates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rate_gates (name, next_at, calls, day, day_calls) FROM stdin;
\.


--
-- Data for Name: recording_containers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recording_containers (id, channel_id, event_id, recording_type, broadcast_day, tz, anchor_hour, starts_at_ms, ends_at_ms, state, created_at, closed_at) FROM stdin;
\.


--
-- Data for Name: recordings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.recordings (id, kind, event_id, channel_id, title, day_utc, status, hi_res_rendition, master_key, start_epoch_ms, end_epoch_ms, duration_ms, retention_days, expires_at, poster_key, storyboard_key, thumbs_vtt_key, thumb_status, created_at, recording_type, container_id, next_action, next_action_at, storage_state) FROM stdin;
\.


--
-- Data for Name: reframe_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.reframe_settings (account_id, settings, updated_at, updated_by) FROM stdin;
\.


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at, amr) FROM stdin;
ebcbb7d8-8224-4bff-bd54-e1292c7da3bc	c7db1658-3f70-4996-af60-8335ed337479	b640a3697c142165740057c4a6d1b51a9b8bbc02f55028c8263ae76510220ac3	2026-08-18 15:32:52.464593+00	\N	2026-08-04 15:32:52.464593+00	{pwd}
34d45cf1-69d0-4132-ab45-4b374617a973	c7db1658-3f70-4996-af60-8335ed337479	9193fe350901fa2d5a7a0aca7a76643c04d5fc338e340fde069f2bdf1ef80013	2026-08-18 15:33:27.669108+00	\N	2026-08-04 15:33:27.669108+00	{pwd}
2e990561-74f3-47d9-87e5-3b82aa2fd6d2	c7db1658-3f70-4996-af60-8335ed337479	cb535ee7749b7c178627dfeadd44220a52df358368ebee736a8c69b2a261d03d	2026-08-19 09:52:08.446429+00	\N	2026-08-05 09:52:08.446429+00	{pwd}
8a918f32-afa5-459e-9081-516c326150ac	c7db1658-3f70-4996-af60-8335ed337479	77e11ee6bce70ca4da6238f200244bc9f570551d026403674582395986c5bc15	2026-08-19 09:52:47.632246+00	\N	2026-08-05 09:52:47.632246+00	{pwd}
2a0bb254-cf75-452a-b619-4e159c9379c3	c7db1658-3f70-4996-af60-8335ed337479	df5c6b00ce22c08a9125ff0e4a284797e393072b0c91ade9c13da88b2ea39e6e	2026-08-19 09:53:46.367399+00	\N	2026-08-05 09:53:46.367399+00	{pwd}
46b2c927-9836-41f6-ae9a-3381817458cf	c7db1658-3f70-4996-af60-8335ed337479	e7e553bce13488d52b8a9d9cd8494fd5dfe96f03757d3e61d3cdd8103be63d38	2026-08-19 18:04:51.565329+00	\N	2026-08-05 18:04:51.565329+00	{pwd}
81238595-948f-47c9-a4c5-eedc8c90b4b4	c7db1658-3f70-4996-af60-8335ed337479	04e312406fb531db70a0c1e404c92b31bb5080c0f7743e49fb676c99c87357ad	2026-08-19 18:12:30.33038+00	\N	2026-08-05 18:12:30.33038+00	{pwd}
3260c554-07e8-4c87-94de-f1dacfddb88d	c7db1658-3f70-4996-af60-8335ed337479	50649f300cbfb325fc29c6bbc3943bff2d89ea0d1520dcc2804a55cff229d419	2026-08-19 18:14:39.352001+00	\N	2026-08-05 18:14:39.352001+00	{pwd}
84af73af-4954-439a-8a63-c91decfca9ad	c7db1658-3f70-4996-af60-8335ed337479	24acb6bdc9576d6c2d4573e60f8dd72b6697086b711eefbdaaed106f95f0b1b3	2026-08-19 18:16:10.923268+00	\N	2026-08-05 18:16:10.923268+00	{pwd}
adc88012-903c-4ad9-b5c6-f33fd2048452	c7db1658-3f70-4996-af60-8335ed337479	30ee72db559ed64aa11434ed2d44b9273bf27efe9bb8ebba1fbe89fc5354a61d	2026-08-19 18:17:18.23038+00	\N	2026-08-05 18:17:18.23038+00	{pwd}
3f30b81c-b23f-4fb3-a97f-2f0941797170	c7db1658-3f70-4996-af60-8335ed337479	47a9ee108014db494eab11f86ef37b972ba7c2a46e399210df20a70165e6ee01	2026-08-19 18:18:00.048369+00	\N	2026-08-05 18:18:00.048369+00	{pwd}
8523d4ba-e6c8-4de9-bed8-641946409e97	c7db1658-3f70-4996-af60-8335ed337479	3dc44deb9e1c5cde5372a9b2cb428d76d198d7ca7cf77d9554c027d8d978dd3a	2026-08-20 06:20:58.504062+00	\N	2026-08-06 06:20:58.504062+00	{pwd}
337aaab4-68e3-4b51-bf11-b1ad034609cc	c7db1658-3f70-4996-af60-8335ed337479	dc07c3991534260f9cb897e3a15594d4706815c94cdf26c6ec11ec4ec857c8c3	2026-08-20 13:04:35.882188+00	\N	2026-08-06 13:04:35.882188+00	{pwd}
bfd3ea04-447a-4913-9e07-a89e21ba026c	c7db1658-3f70-4996-af60-8335ed337479	df8a8342bfab4e31ec6a79412444758bc9016fd14ccc47f8753442d1434afd16	2026-08-20 13:54:31.018011+00	\N	2026-08-06 13:54:31.018011+00	{pwd}
b451a52b-0d01-4bcc-b04b-cb235ee540ff	c7db1658-3f70-4996-af60-8335ed337479	a437740c59a29147904a019c01244bccfd14104dceee186f065b0c6bbd33a23c	2026-08-20 14:21:03.691052+00	\N	2026-08-06 14:21:03.691052+00	{pwd}
\.


--
-- Data for Name: relay_accruals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.relay_accruals (id, relay_id, host_id, relay_ref, relay_name, instance_type, lifecycle, from_at, to_at, seconds, bytes_out, peak_listeners, usd_per_hour, usd_per_gb, est_compute_usd, est_egress_usd, est_usd, indicative, created_at) FROM stdin;
\.


--
-- Data for Name: relays; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.relays (id, name, host_id, source_host, source_port, source_user, tls, secret_ref, public_base, admin_base, admin_user, max_listeners, state, region, note, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: retention_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.retention_rules (id, account_id, channel_id, event_id, name, applies_to, enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: retention_stages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.retention_stages (id, rule_id, after_days, action, target_tier, created_at) FROM stdin;
\.


--
-- Data for Name: run_stops; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.run_stops (instance_id, account_id, stream_kind, stream_id, stream_name, intent, origin, stopped_at) FROM stdin;
\.


--
-- Data for Name: saas_signups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.saas_signups (id, email, name, company, plan_key, mode, status, account_id, user_id, checkout_session_id, stripe_customer_id, stripe_subscription_id, source, ip, user_agent, created_at, updated_at, activated_at) FROM stdin;
\.


--
-- Data for Name: scheduled_clips; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.scheduled_clips (id, channel_id, event_id, title, start_epoch_ms, end_epoch_ms, output_kind, status, vod_asset_id, created_at) FROM stdin;
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (id, applied_at, duration_ms, checksum) FROM stdin;
0001_init.sql	2026-10-25 16:59:45.335288+00	260	988f7843
0002_jobs.sql	2026-10-25 16:59:45.604633+00	19	afc5427f
0003_containers_dayparts.sql	2026-10-25 16:59:45.625162+00	14	06e21ae1
0004_clip_provenance.sql	2026-10-25 16:59:45.642007+00	11	246e511b
0005_unfiled_recordings_index.sql	2026-10-25 16:59:45.654297+00	2	c45d604b
0006_media_lifecycle.sql	2026-10-25 16:59:45.65716+00	29	4d052748
0007_media_object_identity.sql	2026-10-25 16:59:45.688449+00	5	23e52f46
0008_media_orphan_adoption.sql	2026-10-25 16:59:45.695562+00	2	b412c8d4
0009_review_and_qc.sql	2026-10-25 16:59:45.698724+00	14	125a7448
0010_analytics_retention.sql	2026-10-25 16:59:45.714845+00	7	33a830a7
0011_rollup_uniqueness.sql	2026-10-25 16:59:45.723028+00	4	0eeb4379
0012_upload_sessions.sql	2026-10-25 16:59:45.728746+00	10	c56a6104
0013_instance_owner_cascade.sql	2026-10-25 16:59:45.740664+00	4	def72026
0014_channel_columns_drift.sql	2026-10-25 16:59:45.746097+00	3	ab491eb5
0015_retention_sweep_fairness.sql	2026-10-25 16:59:45.751304+00	2	36fe8380
0016_fleet_and_metering.sql	2026-10-25 16:59:45.75498+00	29	02205f7d
0017_auto_connect.sql	2026-10-25 16:59:45.786023+00	8	63eafdb1
0018_player_and_track_metadata.sql	2026-10-25 16:59:45.797554+00	22	3a6b7592
0019_player_stage_layout.sql	2026-10-25 16:59:45.821926+00	2	1fbd0642
0020_degraded_outputs.sql	2026-10-25 16:59:45.82571+00	1	96de0df9
0021_relay_fleet.sql	2026-10-25 16:59:45.828616+00	22	3ee0800a
0022_listener_sessions.sql	2026-10-25 16:59:45.853045+00	8	7400b110
0023_air_sessions.sql	2026-10-25 16:59:45.862683+00	7	c2a37a8b
0024_auto_connect_armed.sql	2026-10-25 16:59:45.871691+00	2	de7959ab
0025_audio_export_keys.sql	2026-10-25 16:59:45.874582+00	1	98c0b9a2
0026_content_types.sql	2026-10-25 16:59:45.87624+00	2	209ba76f
0027_publishing_rules.sql	2026-10-25 16:59:45.879475+00	26	a695f69a
0028_access_rules_payments.sql	2026-10-25 16:59:45.911739+00	22	c7d67e7a
0029_watchfolders.sql	2026-10-25 16:59:45.93598+00	18	4904110e
0030_encode_profiles.sql	2026-10-25 16:59:45.955575+00	23	5204a91a
0031_vod_uploads.sql	2026-10-25 16:59:45.98034+00	3	df813d48
0032_ingest_rules.sql	2026-10-25 16:59:45.984511+00	11	efb02f46
0033_ingest_providers.sql	2026-10-25 16:59:45.99779+00	10	2fd50087
0034_source_probe_filler.sql	2026-10-25 16:59:46.009623+00	3	eac1c98d
0035_xmltv_export.sql	2026-10-25 16:59:46.013596+00	7	d2fae178
0036_notification_delivery.sql	2026-10-25 16:59:46.022381+00	7	2792991e
0037_xmltv_import.sql	2026-10-25 16:59:46.031651+00	15	0ddaec31
0038_social_publishing.sql	2026-10-25 16:59:46.048351+00	7	865220ae
0039_xmltv_import_api.sql	2026-10-25 16:59:46.059705+00	4	cf60b562
0040_xmltv_lineup.sql	2026-10-25 16:59:46.064732+00	4	a7bc32c9
0041_xmltv_source_timezone.sql	2026-10-25 16:59:46.069884+00	1	538b8af4
0042_channel_guide_icon.sql	2026-10-25 16:59:46.072115+00	1	edbfaf37
0043_metadata_name_is_entity_name.sql	2026-10-25 16:59:46.074115+00	1	6bba7e33
0044_engines_and_addons.sql	2026-10-25 16:59:46.076225+00	28	25c338c8
0045_stream_placement.sql	2026-10-25 16:59:46.106894+00	9	f37e3e0d
0046_viewer_path_scale.sql	2026-10-25 16:59:46.116865+00	7	d3a56827
0047_access_roles_and_viewer_accounts.sql	2026-10-25 16:59:46.125285+00	15	f5fafbf6
0048_identity_security.sql	2026-10-25 16:59:46.142072+00	13	8ff57a40
0049_media_metadata_and_storyboards.sql	2026-10-25 16:59:46.156159+00	17	85de3cb8
0050_audit_log_report.sql	2026-10-25 16:59:46.175467+00	3	1bc6c795
0051_plan_and_group_allocation.sql	2026-10-25 16:59:46.180123+00	3	866349cb
0052_account_branding.sql	2026-10-25 16:59:46.184667+00	1	9c78c90f
0053_account_geo_access.sql	2026-10-25 16:59:46.186695+00	1	511550d7
0054_stream_metrics.sql	2026-10-25 16:59:46.188833+00	1	a2085ebe
0055_player_sdk_skins.sql	2026-10-25 16:59:46.190275+00	1	4cee6075
0056_player_event_skin.sql	2026-10-25 16:59:46.192373+00	1	fea524e0
0057_stream_input_params.sql	2026-10-25 16:59:46.194183+00	0	5f1c4cd1
0058_epg_repeats.sql	2026-10-25 16:59:46.19596+00	11	58d1ae05
0059_run_stops.sql	2026-10-25 16:59:46.208193+00	7	b4d627b2
0060_player_graphics.sql	2026-10-25 16:59:46.216853+00	2	c0cea5b5
0061_player_radio_skin.sql	2026-10-25 16:59:46.219434+00	1	d56b8976
0062_vod_markers.sql	2026-10-25 16:59:46.221742+00	10	30e3af66
0063_stream_events_time.sql	2026-10-25 16:59:46.232958+00	3	a93bee67
0064_graphics.sql	2026-10-25 16:59:46.23745+00	52	71751621
0065_fast_channels.sql	2026-10-25 16:59:46.292474+00	37	9e4c39d9
0066_graphics_player.sql	2026-10-25 16:59:46.332789+00	15	ebe23881
0067_fast_playouts.sql	2026-10-25 16:59:46.349653+00	4	4b8285e6
0071_vod_library_views.sql	2026-10-25 16:59:46.355471+00	10	b1eb3e03
0072_asset_images.sql	2026-10-25 16:59:46.367515+00	6	b2dc2bd6
0073_music_providers.sql	2026-10-25 16:59:46.375376+00	4	4e2394cb
0074_song_details.sql	2026-10-25 16:59:46.381068+00	4	0b46d314
0075_fast_channel_media.sql	2026-10-25 16:59:46.386576+00	2	c5254672
0076_onboarding.sql	2026-10-25 16:59:46.389868+00	25	c7be4324
0077_vod_media_facts.sql	2026-10-25 16:59:46.415937+00	1	06ebb9a7
0078_ad_beacons.sql	2026-10-25 16:59:46.41777+00	8	dc508d76
0079_reframe.sql	2026-10-25 16:59:46.426529+00	11	8ea580a4
\.


--
-- Data for Name: security_codes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.security_codes (id, principal_kind, principal_id, purpose, channel, target, code_hash, attempts, expires_at, consumed_at, created_at) FROM stdin;
\.


--
-- Data for Name: segments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.segments (id, event_id, channel_id, rendition_id, seq, s3_key, start_epoch_ms, duration_ms, discontinuity, created_at) FROM stdin;
\.


--
-- Data for Name: share_links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.share_links (id, account_id, resource_kind, resource_id, token_prefix, token_hash, label, message, recipients, access_type, allow_hi_res, allow_player, allow_metadata, watermark, notify_on_open, pin_hash, auth_mode, verify_code_hash, verify_email, verify_expires_at, expires_at, max_views, view_count, first_opened_at, last_viewed_at, revoked, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: social_oauth_states; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.social_oauth_states (id, account_id, user_id, platform, code_verifier, created_at) FROM stdin;
\.


--
-- Data for Name: song_details; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.song_details (account_id, norm_key, artist, title, album, released, label, isrc, genres, image_key, provider, link, terms, chosen_by, chosen_at) FROM stdin;
\.


--
-- Data for Name: storyboards; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.storyboards (id, account_id, stream_kind, stream_id, unit_start, unit_end, folder, interval_ms, tile_w, tile_h, cols, rows, sheets, vtt_key, tiles, frames, status, built_through, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: stream_breaks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_breaks (id, channel_id, event_id, programme_id, source, source_ref, starts_at, duration_ms, "position", at_asset_ms, status, hide_graphics, scte_event_id, meta, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: stream_concurrency; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_concurrency (account_id, asset_kind, asset_id, concurrent, updated_at) FROM stdin;
\.


--
-- Data for Name: stream_concurrency_parts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_concurrency_parts (process_id, account_id, asset_kind, asset_id, concurrent, updated_at) FROM stdin;
\.


--
-- Data for Name: stream_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_events (id, event_id, channel_id, seq, type, detail, ts, received_at) FROM stdin;
\.


--
-- Data for Name: stream_inputs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_inputs (id, event_id, channel_id, role, rendition_label, rendition_bitrate_kbps, protocol, ingest_url, stream_key, status, created_at, probe, probed_at, params) FROM stdin;
\.


--
-- Data for Name: stream_status; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.stream_status (id, event_id, channel_id, output_available, active_source, fallback_in_use, filler_in_use, packager_ok, sources, last_seq, boot_ms, updated_at, degraded_outputs, metrics) FROM stdin;
\.


--
-- Data for Name: support_tickets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_tickets (id, account_id, opened_by, subject, body, status, priority, assignee_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: track_metadata; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.track_metadata (id, norm_key, artist, title, album, release_group_mbid, recording_mbid, artwork_url, year, provider, state, attempts, looked_up_at, raw_sample) FROM stdin;
\.


--
-- Data for Name: upload_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.upload_sessions (id, account_id, opened_by, token, purpose, filler_kind, filler_asset_id, filename, content_type, total_bytes, chunk_size, chunk_count, received, received_bytes, state, error, created_at, updated_at, expires_at, ladder_group_id, vod_asset_id, relative_path, schema_id, metadata, source) FROM stdin;
\.


--
-- Data for Name: usage_accruals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usage_accruals (id, account_id, instance_id, channel_id, event_id, host_id, stream_id, stream_name, task_kind, instance_type, lifecycle, from_at, to_at, seconds, usd_per_hour, est_usd, indicative, created_at, instance_ref) FROM stdin;
\.


--
-- Data for Name: usage_records; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usage_records (id, account_id, event_id, channel_id, period_start, period_end, egress_gb, encode_minutes, peak_viewers, period_kind, compute_seconds, servers_used, task_runs, est_usd, indicative, by_task_kind, computed_at) FROM stdin;
\.


--
-- Data for Name: user_access_links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_access_links (id, kind, user_id, account_id, token_hash, expires_at, created_by, verified_at, consumed_at, revoked_at, created_at) FROM stdin;
\.


--
-- Data for Name: user_devices; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_devices (id, account_id, user_id, platform, token, label, created_at, last_seen_at) FROM stdin;
\.


--
-- Data for Name: user_group_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_group_members (user_id, group_id, granted_by, granted_at) FROM stdin;
\.


--
-- Data for Name: user_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_groups (id, account_id, name, description, permissions, created_at, is_system, role_key, tier, updated_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, account_id, email, password_hash, role, status, user_group_id, created_at, platform_role, mfa_enabled, mfa_secret_ref, display_name, email_verified_at, phone, phone_verified_at, mfa_email_enabled, mfa_sms_enabled) FROM stdin;
c7db1658-3f70-4996-af60-8335ed337479	06df1746-3123-4d83-b99d-a887cbbc17ca	admin@rtm.example	$argon2id$v=19$m=65536,t=3,p=4$UES66rUN8AT12SN2HK6+Bw$cg75uZi+LcsflyGd17JmS3tjFPNuLeQoLIArffysOzM	owner	active	\N	2026-08-04 15:32:22.565197+00	\N	f	\N	RTM Admin	\N	\N	\N	f	f
\.


--
-- Data for Name: viewer_refresh_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.viewer_refresh_tokens (id, viewer_id, app_id, token_hash, created_at, expires_at, revoked_at, user_agent, amr) FROM stdin;
\.


--
-- Data for Name: viewers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.viewers (id, account_id, external_id, email, groups, created_at, last_seen_at, password_hash, display_name, avatar_ref, profile, status, source, email_verified_at, reset_code_hash, reset_expires_at, password_changed_at, updated_at, phone, phone_verified_at, mfa_email_enabled, mfa_sms_enabled, totp_secret, totp_enabled) FROM stdin;
\.


--
-- Data for Name: vod_assets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vod_assets (id, event_id, channel_id, recording_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, export_mp4_key, output_kind, progressive_key, formats, portal_visible, clip_spec, schema_id, metadata, poster_key, storyboard_key, thumbs_vtt_key, thumb_status, published, created_at, updated_at, source_block_count, source_run_count, source_container_count, source_segment_count, source_gap_ms, source_coverage_pct, build_strategy, built_at, review_state, reviewed_by, reviewed_at, qc_state, qc_at, export_mp3_key, export_m4a_key, availability_override, availability, availability_sources, availability_state, available_from, available_until, withdrawn_at, withdrawn_by, account_id, source_kind, source_key, source_bytes, ladder_group_id, encode_result, encode_job_id, original_filename, original_path, sha256, mime, ingest, awaiting_metadata, marker_group, markers_detected_at, markers_note, break_cues_ms, top_height, video_codec, metadata_provenance, poster_source, poster_shape, poster_reason, poster_candidates, poster_locked, poster_picked_at, music_lookup, sprite, media_facts) FROM stdin;
\.


--
-- Data for Name: vod_formats; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vod_formats (vod_asset_id, format, path, overrides, edited, review, approved_at, approved_by, render_state, output_key, width, height, bytes, render_seconds, render_error, rendered_at, updated_at) FROM stdin;
\.


--
-- Data for Name: vod_markers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vod_markers (id, vod_asset_id, kind, start_ms, end_ms, source, status, confidence, detail, updated_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: vod_tracks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.vod_tracks (vod_asset_id, state, tracks_key, summary, error, job_id, analysed_at, updated_at) FROM stdin;
\.


--
-- Data for Name: watchfolder_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.watchfolder_items (id, watchfolder_id, account_id, object_key, checksum, size_bytes, status, matched_rule_id, target_kind, workflow, media_file_id, reason, quarantine_key, seen_at, resolved_at, resolved_by, resolution_note) FROM stdin;
\.


--
-- Data for Name: watchfolder_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.watchfolder_rules (id, watchfolder_id, ordinal, name, match_type, pattern, target_kind, workflow, action, reject_reason, enabled, created_at) FROM stdin;
\.


--
-- Data for Name: watchfolders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.watchfolders (id, account_id, name, kind, config, default_target_kind, quarantine_path, enabled, last_scan_at, last_scan_error, created_at, updated_at, version, created_by, updated_by, ladder_group_id) FROM stdin;
\.


--
-- Data for Name: workflow_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.workflow_events (id, account_id, hook, subject_type, subject_id, channel_id, event_id, title, data, created_at) FROM stdin;
\.


--
-- Name: ad_beacons_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ad_beacons_id_seq', 1, false);


--
-- Name: ad_decisions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ad_decisions_id_seq', 1, false);


--
-- Name: addon_run_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.addon_run_events_id_seq', 1, false);


--
-- Name: air_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.air_sessions_id_seq', 1, false);


--
-- Name: fleet_plans_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.fleet_plans_id_seq', 1, false);


--
-- Name: gfx_impressions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.gfx_impressions_id_seq', 1, false);


--
-- Name: gfx_snapshots_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.gfx_snapshots_id_seq', 1, false);


--
-- Name: gfx_state_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.gfx_state_log_id_seq', 1, false);


--
-- Name: host_samples_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.host_samples_id_seq', 1, false);


--
-- Name: job_attempts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.job_attempts_id_seq', 1, false);


--
-- Name: listener_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.listener_sessions_id_seq', 1, false);


--
-- Name: media_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.media_events_id_seq', 1, false);


--
-- Name: player_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.player_events_id_seq', 1, false);


--
-- Name: qc_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.qc_events_id_seq', 1, false);


--
-- Name: relay_accruals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.relay_accruals_id_seq', 1, false);


--
-- Name: segments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.segments_id_seq', 1, false);


--
-- Name: stream_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.stream_events_id_seq', 1, false);


--
-- Name: usage_accruals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.usage_accruals_id_seq', 1, false);


--
-- Name: watchfolder_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.watchfolder_items_id_seq', 1, false);


--
-- Name: workflow_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.workflow_events_id_seq', 1, false);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: ad_beacons ad_beacons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_beacons
    ADD CONSTRAINT ad_beacons_pkey PRIMARY KEY (id);


--
-- Name: ad_beacons ad_beacons_session_id_break_id_pod_index_event_url_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_beacons
    ADD CONSTRAINT ad_beacons_session_id_break_id_pod_index_event_url_index_key UNIQUE (session_id, break_id, pod_index, event, url_index);


--
-- Name: ad_creatives ad_creatives_account_id_creative_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_creatives
    ADD CONSTRAINT ad_creatives_account_id_creative_key_key UNIQUE (account_id, creative_key);


--
-- Name: ad_creatives ad_creatives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_creatives
    ADD CONSTRAINT ad_creatives_pkey PRIMARY KEY (id);


--
-- Name: ad_decisions ad_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_decisions
    ADD CONSTRAINT ad_decisions_pkey PRIMARY KEY (id);


--
-- Name: ad_servers ad_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_servers
    ADD CONSTRAINT ad_servers_pkey PRIMARY KEY (id);


--
-- Name: addon_run_events addon_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_run_events
    ADD CONSTRAINT addon_run_events_pkey PRIMARY KEY (id);


--
-- Name: addon_runs addon_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_runs
    ADD CONSTRAINT addon_runs_pkey PRIMARY KEY (id);


--
-- Name: addon_services addon_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_services
    ADD CONSTRAINT addon_services_pkey PRIMARY KEY (id);


--
-- Name: addon_triggers addon_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_triggers
    ADD CONSTRAINT addon_triggers_pkey PRIMARY KEY (id);


--
-- Name: air_sessions air_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.air_sessions
    ADD CONSTRAINT air_sessions_pkey PRIMARY KEY (id);


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
-- Name: asset_reviews asset_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_reviews
    ADD CONSTRAINT asset_reviews_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: channel_ads channel_ads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ads
    ADD CONSTRAINT channel_ads_pkey PRIMARY KEY (channel_id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: clip_segments clip_segments_ordinal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_segments
    ADD CONSTRAINT clip_segments_ordinal_unique UNIQUE (vod_asset_id, ordinal);


--
-- Name: clip_segments clip_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_segments
    ADD CONSTRAINT clip_segments_pkey PRIMARY KEY (id);


--
-- Name: compute_hosts compute_hosts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compute_hosts
    ADD CONSTRAINT compute_hosts_pkey PRIMARY KEY (id);


--
-- Name: compute_rates compute_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compute_rates
    ADD CONSTRAINT compute_rates_pkey PRIMARY KEY (id);


--
-- Name: cost_actuals cost_actuals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_actuals
    ADD CONSTRAINT cost_actuals_pkey PRIMARY KEY (id);


--
-- Name: dayparts dayparts_channel_id_starts_local_days_mask_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dayparts
    ADD CONSTRAINT dayparts_channel_id_starts_local_days_mask_key UNIQUE (channel_id, starts_local, days_mask);


--
-- Name: dayparts dayparts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dayparts
    ADD CONSTRAINT dayparts_pkey PRIMARY KEY (id);


--
-- Name: drm_configs drm_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drm_configs
    ADD CONSTRAINT drm_configs_pkey PRIMARY KEY (id);


--
-- Name: egress_rates egress_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.egress_rates
    ADD CONSTRAINT egress_rates_pkey PRIMARY KEY (id);


--
-- Name: encode_ladder_groups encode_ladder_groups_account_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_groups
    ADD CONSTRAINT encode_ladder_groups_account_id_name_key UNIQUE (account_id, name);


--
-- Name: encode_ladder_groups encode_ladder_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_groups
    ADD CONSTRAINT encode_ladder_groups_pkey PRIMARY KEY (id);


--
-- Name: encode_ladder_members encode_ladder_members_group_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_members
    ADD CONSTRAINT encode_ladder_members_group_id_ordinal_key UNIQUE (group_id, ordinal);


--
-- Name: encode_ladder_members encode_ladder_members_group_id_profile_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_members
    ADD CONSTRAINT encode_ladder_members_group_id_profile_id_key UNIQUE (group_id, profile_id);


--
-- Name: encode_ladder_members encode_ladder_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_members
    ADD CONSTRAINT encode_ladder_members_pkey PRIMARY KEY (id);


--
-- Name: encode_profiles encode_profiles_account_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_profiles
    ADD CONSTRAINT encode_profiles_account_id_name_key UNIQUE (account_id, name);


--
-- Name: encode_profiles encode_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_profiles
    ADD CONSTRAINT encode_profiles_pkey PRIMARY KEY (id);


--
-- Name: engine_bindings engine_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_bindings
    ADD CONSTRAINT engine_bindings_pkey PRIMARY KEY (task_arn);


--
-- Name: entitlements entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlements
    ADD CONSTRAINT entitlements_pkey PRIMARY KEY (id);


--
-- Name: epg_batches epg_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_batches
    ADD CONSTRAINT epg_batches_pkey PRIMARY KEY (id);


--
-- Name: epg_channel_aliases epg_channel_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_channel_aliases
    ADD CONSTRAINT epg_channel_aliases_pkey PRIMARY KEY (id);


--
-- Name: epg_channel_aliases epg_channel_aliases_source_id_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_channel_aliases
    ADD CONSTRAINT epg_channel_aliases_source_id_external_id_key UNIQUE (source_id, external_id);


--
-- Name: epg_feeds epg_feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_feeds
    ADD CONSTRAINT epg_feeds_pkey PRIMARY KEY (id);


--
-- Name: epg_feeds epg_feeds_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_feeds
    ADD CONSTRAINT epg_feeds_token_hash_key UNIQUE (token_hash);


--
-- Name: epg_import_runs epg_import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_import_runs
    ADD CONSTRAINT epg_import_runs_pkey PRIMARY KEY (id);


--
-- Name: epg_import_sources epg_import_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_import_sources
    ADD CONSTRAINT epg_import_sources_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: fast_lineups fast_lineups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_lineups
    ADD CONSTRAINT fast_lineups_pkey PRIMARY KEY (id);


--
-- Name: fast_playouts fast_playouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_playouts
    ADD CONSTRAINT fast_playouts_pkey PRIMARY KEY (channel_id);


--
-- Name: filler_assets filler_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filler_assets
    ADD CONSTRAINT filler_assets_pkey PRIMARY KEY (id);


--
-- Name: fleet_plans fleet_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fleet_plans
    ADD CONSTRAINT fleet_plans_pkey PRIMARY KEY (id);


--
-- Name: gfx_assignments gfx_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_assignments
    ADD CONSTRAINT gfx_assignments_pkey PRIMARY KEY (id);


--
-- Name: gfx_data_sources gfx_data_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_data_sources
    ADD CONSTRAINT gfx_data_sources_pkey PRIMARY KEY (id);


--
-- Name: gfx_files gfx_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_files
    ADD CONSTRAINT gfx_files_pkey PRIMARY KEY (version_id, path);


--
-- Name: gfx_impressions gfx_impressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions
    ADD CONSTRAINT gfx_impressions_pkey PRIMARY KEY (id);


--
-- Name: gfx_rundown_items gfx_rundown_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_rundown_items
    ADD CONSTRAINT gfx_rundown_items_pkey PRIMARY KEY (id);


--
-- Name: gfx_setups gfx_setups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_setups
    ADD CONSTRAINT gfx_setups_pkey PRIMARY KEY (id);


--
-- Name: gfx_snapshots gfx_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_snapshots
    ADD CONSTRAINT gfx_snapshots_pkey PRIMARY KEY (id);


--
-- Name: gfx_state_log gfx_state_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state_log
    ADD CONSTRAINT gfx_state_log_pkey PRIMARY KEY (id);


--
-- Name: gfx_state gfx_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state
    ADD CONSTRAINT gfx_state_pkey PRIMARY KEY (assignment_id);


--
-- Name: gfx_template_versions gfx_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_template_versions
    ADD CONSTRAINT gfx_template_versions_pkey PRIMARY KEY (id);


--
-- Name: gfx_templates gfx_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_templates
    ADD CONSTRAINT gfx_templates_pkey PRIMARY KEY (id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: host_samples host_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_samples
    ADD CONSTRAINT host_samples_pkey PRIMARY KEY (id);


--
-- Name: identity_providers identity_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_providers
    ADD CONSTRAINT identity_providers_pkey PRIMARY KEY (id);


--
-- Name: ingest_provider_accounts ingest_provider_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_provider_accounts
    ADD CONSTRAINT ingest_provider_accounts_pkey PRIMARY KEY (id);


--
-- Name: ingest_rules ingest_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_rules
    ADD CONSTRAINT ingest_rules_pkey PRIMARY KEY (id);


--
-- Name: ingest_transfers ingest_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_transfers
    ADD CONSTRAINT ingest_transfers_pkey PRIMARY KEY (id);


--
-- Name: ingest_webhooks ingest_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_webhooks
    ADD CONSTRAINT ingest_webhooks_pkey PRIMARY KEY (id);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: job_attempts job_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: listener_sessions listener_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listener_sessions
    ADD CONSTRAINT listener_sessions_pkey PRIMARY KEY (id);


--
-- Name: media_events media_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_events
    ADD CONSTRAINT media_events_pkey PRIMARY KEY (id);


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
-- Name: media_locations media_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_locations
    ADD CONSTRAINT media_locations_pkey PRIMARY KEY (id);


--
-- Name: media_objects media_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_pkey PRIMARY KEY (id);


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
-- Name: mfa_backup_codes mfa_backup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_backup_codes
    ADD CONSTRAINT mfa_backup_codes_pkey PRIMARY KEY (id);


--
-- Name: music_lookups music_lookups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_lookups
    ADD CONSTRAINT music_lookups_pkey PRIMARY KEY (norm_key);


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
-- Name: payment_providers payment_providers_account_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_providers
    ADD CONSTRAINT payment_providers_account_id_provider_key UNIQUE (account_id, provider);


--
-- Name: payment_providers payment_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_providers
    ADD CONSTRAINT payment_providers_pkey PRIMARY KEY (id);


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
-- Name: player_configs player_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_configs
    ADD CONSTRAINT player_configs_pkey PRIMARY KEY (id);


--
-- Name: player_events player_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_events
    ADD CONSTRAINT player_events_pkey PRIMARY KEY (id);


--
-- Name: products products_account_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_account_id_key_key UNIQUE (account_id, key);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


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
-- Name: publishing_rules publishing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publishing_rules
    ADD CONSTRAINT publishing_rules_pkey PRIMARY KEY (id);


--
-- Name: purchases purchases_account_id_provider_provider_txn_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_account_id_provider_provider_txn_id_key UNIQUE (account_id, provider, provider_txn_id);


--
-- Name: purchases purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);


--
-- Name: qc_events qc_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_events
    ADD CONSTRAINT qc_events_pkey PRIMARY KEY (id);


--
-- Name: rate_gates rate_gates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_gates
    ADD CONSTRAINT rate_gates_pkey PRIMARY KEY (name);


--
-- Name: recording_containers recording_containers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_containers
    ADD CONSTRAINT recording_containers_pkey PRIMARY KEY (id);


--
-- Name: recordings recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_pkey PRIMARY KEY (id);


--
-- Name: reframe_settings reframe_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reframe_settings
    ADD CONSTRAINT reframe_settings_pkey PRIMARY KEY (account_id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: relay_accruals relay_accruals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_accruals
    ADD CONSTRAINT relay_accruals_pkey PRIMARY KEY (id);


--
-- Name: relays relays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relays
    ADD CONSTRAINT relays_pkey PRIMARY KEY (id);


--
-- Name: retention_rules retention_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_rules
    ADD CONSTRAINT retention_rules_pkey PRIMARY KEY (id);


--
-- Name: retention_stages retention_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_stages
    ADD CONSTRAINT retention_stages_pkey PRIMARY KEY (id);


--
-- Name: run_stops run_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_stops
    ADD CONSTRAINT run_stops_pkey PRIMARY KEY (instance_id);


--
-- Name: saas_signups saas_signups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_signups
    ADD CONSTRAINT saas_signups_pkey PRIMARY KEY (id);


--
-- Name: scheduled_clips scheduled_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_clips
    ADD CONSTRAINT scheduled_clips_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);


--
-- Name: security_codes security_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_codes
    ADD CONSTRAINT security_codes_pkey PRIMARY KEY (id);


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
-- Name: social_oauth_states social_oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_oauth_states
    ADD CONSTRAINT social_oauth_states_pkey PRIMARY KEY (id);


--
-- Name: song_details song_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.song_details
    ADD CONSTRAINT song_details_pkey PRIMARY KEY (account_id, norm_key);


--
-- Name: storyboards storyboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storyboards
    ADD CONSTRAINT storyboards_pkey PRIMARY KEY (id);


--
-- Name: storyboards storyboards_stream_id_unit_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storyboards
    ADD CONSTRAINT storyboards_stream_id_unit_start_key UNIQUE (stream_id, unit_start);


--
-- Name: stream_breaks stream_breaks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_breaks
    ADD CONSTRAINT stream_breaks_pkey PRIMARY KEY (id);


--
-- Name: stream_concurrency_parts stream_concurrency_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_concurrency_parts
    ADD CONSTRAINT stream_concurrency_parts_pkey PRIMARY KEY (asset_kind, asset_id, process_id);


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
-- Name: track_metadata track_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.track_metadata
    ADD CONSTRAINT track_metadata_pkey PRIMARY KEY (id);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: upload_sessions upload_sessions_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_token_unique UNIQUE (token);


--
-- Name: media_locations uq_media_locations; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_locations
    ADD CONSTRAINT uq_media_locations UNIQUE (object_id, tier);


--
-- Name: retention_stages uq_retention_stage; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_stages
    ADD CONSTRAINT uq_retention_stage UNIQUE (rule_id, after_days);


--
-- Name: usage_accruals usage_accruals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals
    ADD CONSTRAINT usage_accruals_pkey PRIMARY KEY (id);


--
-- Name: usage_records usage_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_records
    ADD CONSTRAINT usage_records_pkey PRIMARY KEY (id);


--
-- Name: user_access_links user_access_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_links
    ADD CONSTRAINT user_access_links_pkey PRIMARY KEY (id);


--
-- Name: user_access_links user_access_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_links
    ADD CONSTRAINT user_access_links_token_hash_key UNIQUE (token_hash);


--
-- Name: user_devices user_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_pkey PRIMARY KEY (id);


--
-- Name: user_devices user_devices_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_token_key UNIQUE (token);


--
-- Name: user_group_members user_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_pkey PRIMARY KEY (user_id, group_id);


--
-- Name: user_groups user_groups_account_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_account_id_name_key UNIQUE (account_id, name);


--
-- Name: user_groups user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_pkey PRIMARY KEY (id);


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
-- Name: viewer_refresh_tokens viewer_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_refresh_tokens
    ADD CONSTRAINT viewer_refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: viewer_refresh_tokens viewer_refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_refresh_tokens
    ADD CONSTRAINT viewer_refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: viewers viewers_account_id_external_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewers
    ADD CONSTRAINT viewers_account_id_external_id_key UNIQUE (account_id, external_id);


--
-- Name: viewers viewers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewers
    ADD CONSTRAINT viewers_pkey PRIMARY KEY (id);


--
-- Name: vod_assets vod_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_pkey PRIMARY KEY (id);


--
-- Name: vod_formats vod_formats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_formats
    ADD CONSTRAINT vod_formats_pkey PRIMARY KEY (vod_asset_id, format);


--
-- Name: vod_markers vod_markers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_markers
    ADD CONSTRAINT vod_markers_pkey PRIMARY KEY (id);


--
-- Name: vod_markers vod_markers_vod_asset_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_markers
    ADD CONSTRAINT vod_markers_vod_asset_id_kind_key UNIQUE (vod_asset_id, kind);


--
-- Name: vod_tracks vod_tracks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_tracks
    ADD CONSTRAINT vod_tracks_pkey PRIMARY KEY (vod_asset_id);


--
-- Name: watchfolder_items watchfolder_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items
    ADD CONSTRAINT watchfolder_items_pkey PRIMARY KEY (id);


--
-- Name: watchfolder_rules watchfolder_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_rules
    ADD CONSTRAINT watchfolder_rules_pkey PRIMARY KEY (id);


--
-- Name: watchfolder_rules watchfolder_rules_watchfolder_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_rules
    ADD CONSTRAINT watchfolder_rules_watchfolder_id_ordinal_key UNIQUE (watchfolder_id, ordinal);


--
-- Name: watchfolders watchfolders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolders
    ADD CONSTRAINT watchfolders_pkey PRIMARY KEY (id);


--
-- Name: workflow_events workflow_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (id);


--
-- Name: groups_account_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX groups_account_name ON public.groups USING btree (account_id, lower(name));


--
-- Name: idx_accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_parent ON public.accounts USING btree (parent_account_id);


--
-- Name: idx_ad_beacons_break; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ad_beacons_break ON public.ad_beacons USING btree (break_id);


--
-- Name: idx_ad_beacons_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ad_beacons_channel ON public.ad_beacons USING btree (channel_id, created_at);


--
-- Name: idx_ad_decisions_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ad_decisions_channel ON public.ad_decisions USING btree (channel_id, created_at);


--
-- Name: idx_ad_servers_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ad_servers_account ON public.ad_servers USING btree (account_id);


--
-- Name: idx_addon_run_events_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addon_run_events_run ON public.addon_run_events USING btree (run_id, id);


--
-- Name: idx_addon_runs_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addon_runs_account ON public.addon_runs USING btree (account_id, created_at DESC);


--
-- Name: idx_addon_runs_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addon_runs_open ON public.addon_runs USING btree (deadline_at) WHERE (state = ANY (ARRAY['queued'::text, 'dispatched'::text, 'running'::text]));


--
-- Name: idx_addon_runs_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addon_runs_subject ON public.addon_runs USING btree (subject_type, subject_id, created_at DESC);


--
-- Name: idx_addon_services_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addon_services_account ON public.addon_services USING btree (account_id);


--
-- Name: idx_addon_triggers_hook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_addon_triggers_hook ON public.addon_triggers USING btree (account_id, hook) WHERE enabled;


--
-- Name: idx_air_sessions_account_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_air_sessions_account_period ON public.air_sessions USING btree (account_id, from_at DESC);


--
-- Name: idx_air_sessions_stream; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_air_sessions_stream ON public.air_sessions USING btree (stream_id, from_at DESC);


--
-- Name: idx_analytics_rollups_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_rollups_open ON public.analytics_rollups USING btree (bucket_date) WHERE (sealed = false);


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
-- Name: idx_asset_reviews_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_reviews_asset ON public.asset_reviews USING btree (vod_asset_id, at DESC);


--
-- Name: idx_audit_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_account ON public.audit_log USING btree (account_id, created_at);


--
-- Name: idx_audit_account_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_account_action ON public.audit_log USING btree (account_id, action, created_at DESC);


--
-- Name: idx_audit_account_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_account_entity ON public.audit_log USING btree (account_id, entity_type, entity_id, created_at DESC);


--
-- Name: idx_audit_account_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_account_user ON public.audit_log USING btree (account_id, user_id, created_at DESC);


--
-- Name: idx_breaks_channel_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_breaks_channel_start ON public.stream_breaks USING btree (channel_id, starts_at);


--
-- Name: idx_breaks_event_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_breaks_event_start ON public.stream_breaks USING btree (event_id, starts_at);


--
-- Name: idx_breaks_source_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_breaks_source_ref ON public.stream_breaks USING btree (channel_id, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: idx_channels_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_group ON public.channels USING btree (group_id);


--
-- Name: idx_channels_relay; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_relay ON public.channels USING btree (relay_id) WHERE (relay_id IS NOT NULL);


--
-- Name: idx_channels_resume; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_resume ON public.channels USING btree (resume_last_attempt_at NULLS FIRST) WHERE ((desired_state = 'running'::text) AND auto_connect AND (resume_gave_up_at IS NULL));


--
-- Name: idx_clip_segments_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clip_segments_asset ON public.clip_segments USING btree (vod_asset_id, ordinal);


--
-- Name: idx_clip_segments_container; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clip_segments_container ON public.clip_segments USING btree (container_id);


--
-- Name: idx_clip_segments_recording; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clip_segments_recording ON public.clip_segments USING btree (recording_id);


--
-- Name: idx_clip_segments_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clip_segments_run ON public.clip_segments USING btree (run_id, first_seq);


--
-- Name: idx_compute_hosts_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_compute_hosts_external ON public.compute_hosts USING btree (kind, external_id);


--
-- Name: idx_compute_hosts_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compute_hosts_live ON public.compute_hosts USING btree (last_seen_at DESC) WHERE (state = 'up'::text);


--
-- Name: idx_compute_hosts_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compute_hosts_role ON public.compute_hosts USING btree (role, state);


--
-- Name: idx_compute_rates_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compute_rates_lookup ON public.compute_rates USING btree (instance_type, lifecycle, effective_from DESC);


--
-- Name: idx_conc_parts_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conc_parts_updated ON public.stream_concurrency_parts USING btree (updated_at);


--
-- Name: idx_container_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_container_range ON public.recording_containers USING btree (channel_id, starts_at_ms, ends_at_ms);


--
-- Name: idx_cost_actuals_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cost_actuals_period ON public.cost_actuals USING btree (period_month, category);


--
-- Name: idx_dayparts_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dayparts_channel ON public.dayparts USING btree (channel_id, ordinal);


--
-- Name: idx_deliv_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliv_due ON public.notification_deliveries USING btree (next_attempt_at) WHERE ((status = 'failed'::public.delivery_status) AND (gave_up_at IS NULL));


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
-- Name: idx_egress_rates_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_egress_rates_lookup ON public.egress_rates USING btree (region, effective_from DESC);


--
-- Name: idx_encode_ladder_members_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encode_ladder_members_group ON public.encode_ladder_members USING btree (group_id, ordinal);


--
-- Name: idx_encode_profiles_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encode_profiles_account ON public.encode_profiles USING btree (account_id, height DESC);


--
-- Name: idx_engine_bindings_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_engine_bindings_ref ON public.engine_bindings USING btree (engine_id, external_ref);


--
-- Name: idx_engine_bindings_stream; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_engine_bindings_stream ON public.engine_bindings USING btree (stream_id, created_at DESC);


--
-- Name: idx_entitlements_viewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entitlements_viewer ON public.entitlements USING btree (viewer_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_epg_aliases_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epg_aliases_channel ON public.epg_channel_aliases USING btree (channel_id);


--
-- Name: idx_epg_batches_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epg_batches_owner ON public.epg_batches USING btree (owner_id, created_at DESC);


--
-- Name: idx_epg_feeds_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epg_feeds_account ON public.epg_feeds USING btree (account_id);


--
-- Name: idx_epg_import_runs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epg_import_runs_source ON public.epg_import_runs USING btree (source_id, started_at DESC);


--
-- Name: idx_epg_import_sources_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epg_import_sources_account ON public.epg_import_sources USING btree (account_id);


--
-- Name: idx_epg_import_sources_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epg_import_sources_due ON public.epg_import_sources USING btree (next_run_at) WHERE (enabled AND (kind = 'url'::text));


--
-- Name: idx_events_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_group ON public.events USING btree (group_id);


--
-- Name: idx_events_resume; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_resume ON public.events USING btree (resume_last_attempt_at NULLS FIRST) WHERE ((desired_state = 'running'::text) AND auto_connect AND (resume_gave_up_at IS NULL));


--
-- Name: idx_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_status ON public.events USING btree (status);


--
-- Name: idx_fast_lineups_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fast_lineups_channel ON public.fast_lineups USING btree (channel_id, status);


--
-- Name: idx_fast_lineups_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fast_lineups_one_active ON public.fast_lineups USING btree (channel_id) WHERE (status = 'active'::text);


--
-- Name: idx_filler_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_filler_account ON public.filler_assets USING btree (account_id, kind);


--
-- Name: idx_fleet_plans_kind_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fleet_plans_kind_at ON public.fleet_plans USING btree (kind, at DESC);


--
-- Name: idx_gfx_assign_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_assign_channel ON public.gfx_assignments USING btree (channel_id) WHERE (channel_id IS NOT NULL);


--
-- Name: idx_gfx_assign_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_assign_event ON public.gfx_assignments USING btree (event_id) WHERE (event_id IS NOT NULL);


--
-- Name: idx_gfx_assign_setup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_assign_setup ON public.gfx_assignments USING btree (setup_id);


--
-- Name: idx_gfx_impr_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_impr_account ON public.gfx_impressions USING btree (account_id, shown_at DESC);


--
-- Name: idx_gfx_impr_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_impr_assignment ON public.gfx_impressions USING btree (assignment_id, shown_at DESC);


--
-- Name: idx_gfx_log_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_log_assignment ON public.gfx_state_log USING btree (assignment_id, at DESC);


--
-- Name: idx_gfx_log_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_log_event ON public.gfx_state_log USING btree (event_id, at DESC) WHERE (event_id IS NOT NULL);


--
-- Name: idx_gfx_rundown_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_rundown_event ON public.gfx_rundown_items USING btree (event_id, "position");


--
-- Name: idx_gfx_setups_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_setups_account ON public.gfx_setups USING btree (account_id);


--
-- Name: idx_gfx_setups_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_setups_version ON public.gfx_setups USING btree (version_id);


--
-- Name: idx_gfx_snap_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_snap_at ON public.gfx_snapshots USING btree (at);


--
-- Name: idx_gfx_snap_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_snap_channel ON public.gfx_snapshots USING btree (channel_id, at DESC) WHERE (channel_id IS NOT NULL);


--
-- Name: idx_gfx_snap_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_snap_event ON public.gfx_snapshots USING btree (event_id, at DESC) WHERE (event_id IS NOT NULL);


--
-- Name: idx_gfx_sources_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_sources_account ON public.gfx_data_sources USING btree (account_id);


--
-- Name: idx_gfx_templates_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gfx_templates_account ON public.gfx_templates USING btree (account_id) WHERE (archived_at IS NULL);


--
-- Name: idx_groups_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_groups_account ON public.groups USING btree (account_id);


--
-- Name: idx_host_samples_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_host_samples_at ON public.host_samples USING btree (at);


--
-- Name: idx_host_samples_host_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_host_samples_host_at ON public.host_samples USING btree (host_id, at DESC);


--
-- Name: idx_idp_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_account ON public.identity_providers USING btree (account_id);


--
-- Name: idx_ingest_provider_accounts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_provider_accounts ON public.ingest_provider_accounts USING btree (account_id, provider);


--
-- Name: idx_ingest_rules_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_rules_account ON public.ingest_rules USING btree (account_id, rung, scope_id, ordinal);


--
-- Name: idx_ingest_transfers; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_transfers ON public.ingest_transfers USING btree (account_id, created_at DESC);


--
-- Name: idx_inputs_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inputs_channel ON public.stream_inputs USING btree (channel_id);


--
-- Name: idx_inputs_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inputs_event ON public.stream_inputs USING btree (event_id);


--
-- Name: idx_instances_assigned_host; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_assigned_host ON public.instances USING btree (assigned_host_id) WHERE (terminated_at IS NULL);


--
-- Name: idx_instances_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_channel ON public.instances USING btree (channel_id);


--
-- Name: idx_instances_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_event ON public.instances USING btree (event_id);


--
-- Name: idx_instances_host; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_host ON public.instances USING btree (host_id);


--
-- Name: idx_instances_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_live ON public.instances USING btree (channel_id, event_id) WHERE (terminated_at IS NULL);


--
-- Name: idx_instances_load_signature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_load_signature ON public.instances USING btree (load_signature) WHERE (load_signature IS NOT NULL);


--
-- Name: idx_instances_meter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instances_meter ON public.instances USING btree (metered_through NULLS FIRST) WHERE ((state <> 'terminated'::text) OR (metered_through IS NULL) OR (metered_through < terminated_at));


--
-- Name: idx_job_attempts_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_attempts_job ON public.job_attempts USING btree (job_id, attempt);


--
-- Name: idx_jobs_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_channel ON public.jobs USING btree (channel_id, created_at DESC);


--
-- Name: idx_jobs_corr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_corr ON public.jobs USING btree (correlation_id);


--
-- Name: idx_jobs_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_lease ON public.jobs USING btree (lease_until) WHERE (state = 'running'::public.job_state);


--
-- Name: idx_jobs_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_ready ON public.jobs USING btree (priority, run_after, created_at) WHERE (state = 'queued'::public.job_state);


--
-- Name: idx_jobs_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_type ON public.jobs USING btree (type, state);


--
-- Name: idx_listener_sessions_account_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_listener_sessions_account_window ON public.listener_sessions USING btree (account_id, started_at);


--
-- Name: idx_listener_sessions_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_listener_sessions_channel ON public.listener_sessions USING btree (channel_id, started_at DESC);


--
-- Name: idx_listener_sessions_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_listener_sessions_window ON public.listener_sessions USING btree (started_at);


--
-- Name: idx_mdschema_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mdschema_account ON public.metadata_schemas USING btree (account_id);


--
-- Name: idx_mdschema_standard_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mdschema_standard_key ON public.metadata_schemas USING btree (account_id, standard_key) WHERE (standard_key IS NOT NULL);


--
-- Name: idx_media_events_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_events_at ON public.media_events USING btree (at DESC);


--
-- Name: idx_media_events_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_events_object ON public.media_events USING btree (object_id, at DESC);


--
-- Name: idx_media_files_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_account ON public.media_files USING btree (account_id);


--
-- Name: idx_media_files_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_captured ON public.media_files USING btree (account_id, channel_id, captured_at) WHERE (captured_at IS NOT NULL);


--
-- Name: idx_media_files_checksum; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_checksum ON public.media_files USING btree (account_id, checksum) WHERE (checksum IS NOT NULL);


--
-- Name: idx_media_files_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_folder ON public.media_files USING btree (account_id, folder);


--
-- Name: idx_media_files_folder_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_folder_prefix ON public.media_files USING btree (account_id, folder text_pattern_ops);


--
-- Name: idx_media_files_geo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_geo ON public.media_files USING btree (account_id, gps_lat, gps_lng) WHERE (gps_lat IS NOT NULL);


--
-- Name: idx_media_files_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_kind ON public.media_files USING btree (account_id, kind);


--
-- Name: idx_media_files_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_search ON public.media_files USING gin (search);


--
-- Name: idx_media_files_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_source ON public.media_files USING btree (account_id, source);


--
-- Name: idx_media_files_taken; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_taken ON public.media_files USING btree (account_id, taken_at) WHERE (taken_at IS NOT NULL);


--
-- Name: idx_media_folders_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_folders_path ON public.media_folders USING btree (account_id, path text_pattern_ops);


--
-- Name: idx_media_locations_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_locations_object ON public.media_locations USING btree (object_id) WHERE present;


--
-- Name: idx_media_locations_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_locations_tier ON public.media_locations USING btree (tier) WHERE present;


--
-- Name: idx_media_objects_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_objects_channel ON public.media_objects USING btree (channel_id);


--
-- Name: idx_media_objects_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_objects_due ON public.media_objects USING btree (retain_until) WHERE ((hold = false) AND (state <> ALL (ARRAY['deleted'::public.media_state, 'deleting'::public.media_state])));


--
-- Name: idx_media_objects_last_swept; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_objects_last_swept ON public.media_objects USING btree (last_swept_at NULLS FIRST) WHERE (state <> ALL (ARRAY['deleted'::public.media_state, 'pending'::public.media_state, 'writing'::public.media_state]));


--
-- Name: idx_media_objects_restoring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_objects_restoring ON public.media_objects USING btree (restore_expected_by) WHERE (state = 'restoring'::public.media_state);


--
-- Name: idx_media_objects_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_objects_state ON public.media_objects USING btree (state);


--
-- Name: idx_notif_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_account ON public.notifications USING btree (account_id, created_at DESC);


--
-- Name: idx_play_sessions_prune; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_play_sessions_prune ON public.play_sessions USING btree (account_id, started_at) WHERE (ended_at IS NOT NULL);


--
-- Name: idx_player_configs_account_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_player_configs_account_default ON public.player_configs USING btree (account_id) WHERE (channel_id IS NULL);


--
-- Name: idx_player_configs_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_player_configs_channel ON public.player_configs USING btree (channel_id) WHERE (channel_id IS NOT NULL);


--
-- Name: idx_player_events_account_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_events_account_at ON public.player_events USING btree (account_id, at DESC);


--
-- Name: idx_player_events_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_events_at ON public.player_events USING btree (at);


--
-- Name: idx_player_events_channel_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_events_channel_at ON public.player_events USING btree (channel_id, at DESC);


--
-- Name: idx_player_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_player_events_session ON public.player_events USING btree (session_id, at);


--
-- Name: idx_prog_channel_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_channel_start ON public.programmes USING btree (channel_id, starts_at);


--
-- Name: idx_prog_clip_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_clip_asset ON public.programmes USING btree (clip_asset_id) WHERE (clip_asset_id IS NOT NULL);


--
-- Name: idx_prog_event_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_event_start ON public.programmes USING btree (event_id, starts_at);


--
-- Name: idx_prog_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_search ON public.programmes USING gin (to_tsvector('simple'::regconfig, title));


--
-- Name: idx_prog_series; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_series ON public.programmes USING btree (series_id, series_date) WHERE (series_id IS NOT NULL);


--
-- Name: idx_prog_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_prog_source ON public.programmes USING btree (channel_id, source_ref) WHERE (source_ref IS NOT NULL);


--
-- Name: idx_prog_source_event; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_prog_source_event ON public.programmes USING btree (event_id, source_ref) WHERE ((source_ref IS NOT NULL) AND (event_id IS NOT NULL));


--
-- Name: idx_prog_span_gist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prog_span_gist ON public.programmes USING gist (span);


--
-- Name: idx_ptarget_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ptarget_account ON public.publish_targets USING btree (account_id, platform);


--
-- Name: idx_ptarget_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ptarget_external ON public.publish_targets USING btree (account_id, platform, external_account, mode) WHERE (external_account IS NOT NULL);


--
-- Name: idx_pub_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_asset ON public.publications USING btree (vod_asset_id);


--
-- Name: idx_pub_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pub_platform ON public.publications USING btree (platform);


--
-- Name: idx_publications_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publications_asset ON public.publications USING btree (vod_asset_id);


--
-- Name: idx_publications_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publications_stale ON public.publications USING btree (stale) WHERE stale;


--
-- Name: idx_pubrule_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pubrule_scope ON public.publishing_rules USING btree (account_id, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: idx_purchases_viewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchases_viewer ON public.purchases USING btree (viewer_id, purchased_at DESC);


--
-- Name: idx_qc_events_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_events_asset ON public.qc_events USING btree (vod_asset_id, at DESC);


--
-- Name: idx_qc_events_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_events_check ON public.qc_events USING btree (vod_asset_id, check_name);


--
-- Name: idx_rec_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_channel ON public.recordings USING btree (channel_id, day_utc);


--
-- Name: idx_rec_container; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_container ON public.recordings USING btree (container_id);


--
-- Name: idx_rec_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_event ON public.recordings USING btree (event_id);


--
-- Name: idx_rec_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rec_expiry ON public.recordings USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_recordings_unfiled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recordings_unfiled ON public.recordings USING btree (start_epoch_ms) WHERE (container_id IS NULL);


--
-- Name: idx_refresh_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_user ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_relay_accruals_relay; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relay_accruals_relay ON public.relay_accruals USING btree (relay_id, from_at DESC);


--
-- Name: idx_relay_accruals_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relay_accruals_window ON public.relay_accruals USING btree (from_at, to_at);


--
-- Name: idx_relays_assignable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relays_assignable ON public.relays USING btree (state) WHERE (state = 'active'::text);


--
-- Name: idx_relays_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_relays_endpoint ON public.relays USING btree (source_host, source_port);


--
-- Name: idx_retention_rules_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retention_rules_account ON public.retention_rules USING btree (account_id) WHERE enabled;


--
-- Name: idx_retention_rules_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retention_rules_channel ON public.retention_rules USING btree (channel_id) WHERE enabled;


--
-- Name: idx_retention_stages_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_retention_stages_rule ON public.retention_stages USING btree (rule_id, after_days);


--
-- Name: idx_rollups_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rollups_account ON public.analytics_rollups USING btree (account_id, bucket_date);


--
-- Name: idx_run_stops_stream; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_stops_stream ON public.run_stops USING btree (stream_id, stopped_at DESC);


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
-- Name: idx_series_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_series_event ON public.programme_series USING btree (event_id);


--
-- Name: idx_series_topup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_series_topup ON public.programme_series USING btree (materialized_until) WHERE (rule IS NOT NULL);


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
-- Name: idx_sev_channel_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sev_channel_ts ON public.stream_events USING btree (channel_id, ts) WHERE (channel_id IS NOT NULL);


--
-- Name: idx_sev_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sev_event ON public.stream_events USING btree (event_id, id DESC);


--
-- Name: idx_sev_event_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sev_event_ts ON public.stream_events USING btree (event_id, ts) WHERE (event_id IS NOT NULL);


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
-- Name: idx_storyboards_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storyboards_account ON public.storyboards USING btree (account_id, unit_start);


--
-- Name: idx_storyboards_stream_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storyboards_stream_time ON public.storyboards USING btree (stream_id, unit_start);


--
-- Name: idx_tickets_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_account ON public.support_tickets USING btree (account_id, status);


--
-- Name: idx_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_status ON public.support_tickets USING btree (status);


--
-- Name: idx_track_metadata_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_track_metadata_key ON public.track_metadata USING btree (norm_key);


--
-- Name: idx_track_metadata_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_track_metadata_retry ON public.track_metadata USING btree (looked_up_at) WHERE (state = 'error'::text);


--
-- Name: idx_ugm_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ugm_group ON public.user_group_members USING btree (group_id);


--
-- Name: idx_upload_sessions_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_sessions_account ON public.upload_sessions USING btree (account_id, created_at DESC);


--
-- Name: idx_upload_sessions_expired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_sessions_expired ON public.upload_sessions USING btree (expires_at) WHERE (state = ANY (ARRAY['open'::public.upload_state, 'assembling'::public.upload_state]));


--
-- Name: idx_upload_sessions_vod; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_sessions_vod ON public.upload_sessions USING btree (vod_asset_id) WHERE (vod_asset_id IS NOT NULL);


--
-- Name: idx_usage_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_account ON public.usage_records USING btree (account_id, period_start);


--
-- Name: idx_usage_accruals_account_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_accruals_account_period ON public.usage_accruals USING btree (account_id, from_at);


--
-- Name: idx_usage_accruals_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_accruals_instance ON public.usage_accruals USING btree (instance_id, from_at);


--
-- Name: idx_usage_accruals_stream; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_accruals_stream ON public.usage_accruals USING btree (account_id, stream_id, from_at);


--
-- Name: idx_usage_accruals_stream_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_accruals_stream_run ON public.usage_accruals USING btree (stream_id, instance_ref, from_at);


--
-- Name: idx_usage_records_account_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_usage_records_account_period ON public.usage_records USING btree (account_id, period_kind, period_start) WHERE ((channel_id IS NULL) AND (event_id IS NULL));


--
-- Name: idx_user_devices_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_user ON public.user_devices USING btree (user_id);


--
-- Name: idx_vod_assets_account_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_account_source ON public.vod_assets USING btree (account_id, source_kind, created_at DESC);


--
-- Name: idx_vod_assets_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_created ON public.vod_assets USING btree (date_trunc('milliseconds'::text, (created_at AT TIME ZONE 'UTC'::text)) DESC, id);


--
-- Name: idx_vod_assets_duration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_duration ON public.vod_assets USING btree (duration_ms);


--
-- Name: idx_vod_assets_marker_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_marker_group ON public.vod_assets USING btree (account_id, marker_group) WHERE (marker_group IS NOT NULL);


--
-- Name: idx_vod_assets_multi_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_multi_day ON public.vod_assets USING btree (source_container_count) WHERE (source_container_count > 1);


--
-- Name: idx_vod_assets_poster_unpicked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_poster_unpicked ON public.vod_assets USING btree (created_at) WHERE (poster_source IS NULL);


--
-- Name: idx_vod_assets_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_queue ON public.vod_assets USING btree (created_at) WHERE (review_state = 'in_review'::public.review_state);


--
-- Name: idx_vod_assets_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_review ON public.vod_assets USING btree (review_state, created_at DESC);


--
-- Name: idx_vod_assets_schema_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_schema_created ON public.vod_assets USING btree (schema_id, created_at DESC);


--
-- Name: idx_vod_assets_top_height; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_top_height ON public.vod_assets USING btree (top_height) WHERE (top_height IS NOT NULL);


--
-- Name: idx_vod_assets_video_codec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_assets_video_codec ON public.vod_assets USING btree (video_codec) WHERE (video_codec IS NOT NULL);


--
-- Name: idx_vod_availability_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_availability_window ON public.vod_assets USING btree (availability_state, available_until) WHERE (availability_state = ANY (ARRAY['scheduled'::text, 'available'::text]));


--
-- Name: idx_vod_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_channel ON public.vod_assets USING btree (channel_id);


--
-- Name: idx_vod_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_event ON public.vod_assets USING btree (event_id);


--
-- Name: idx_vod_original_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_original_name ON public.vod_assets USING btree (account_id, lower(original_filename)) WHERE (original_filename IS NOT NULL);


--
-- Name: idx_vod_recording; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_recording ON public.vod_assets USING btree (recording_id);


--
-- Name: idx_vod_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vod_sha256 ON public.vod_assets USING btree (account_id, sha256) WHERE (sha256 IS NOT NULL);


--
-- Name: idx_vrt_viewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vrt_viewer ON public.viewer_refresh_tokens USING btree (viewer_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_watchfolder_items_account_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchfolder_items_account_open ON public.watchfolder_items USING btree (account_id, seen_at DESC) WHERE (status = 'quarantined'::text);


--
-- Name: idx_watchfolder_items_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchfolder_items_queue ON public.watchfolder_items USING btree (watchfolder_id, status, seen_at DESC);


--
-- Name: idx_watchfolder_rules_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchfolder_rules_folder ON public.watchfolder_rules USING btree (watchfolder_id, ordinal);


--
-- Name: idx_watchfolders_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_watchfolders_account ON public.watchfolders USING btree (account_id, created_at DESC);


--
-- Name: idx_wfe_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wfe_account ON public.workflow_events USING btree (account_id, id DESC);


--
-- Name: idx_wfe_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wfe_subject ON public.workflow_events USING btree (subject_type, subject_id, id);


--
-- Name: mfa_backup_codes_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mfa_backup_codes_principal ON public.mfa_backup_codes USING btree (principal_kind, principal_id) WHERE (used_at IS NULL);


--
-- Name: saas_signups_checkout; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX saas_signups_checkout ON public.saas_signups USING btree (checkout_session_id) WHERE (checkout_session_id IS NOT NULL);


--
-- Name: saas_signups_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saas_signups_email ON public.saas_signups USING btree (email);


--
-- Name: saas_signups_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saas_signups_status ON public.saas_signups USING btree (status, created_at DESC);


--
-- Name: saas_signups_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saas_signups_subscription ON public.saas_signups USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);


--
-- Name: security_codes_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_codes_expiry ON public.security_codes USING btree (expires_at);


--
-- Name: security_codes_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_codes_open ON public.security_codes USING btree (principal_kind, principal_id, purpose) WHERE (consumed_at IS NULL);


--
-- Name: uq_air_sessions_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_air_sessions_open ON public.air_sessions USING btree (stream_id) WHERE (to_at IS NULL);


--
-- Name: uq_analytics_rollups_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_analytics_rollups_key ON public.analytics_rollups USING btree (account_id, scope, scope_id, bucket_date) NULLS NOT DISTINCT;


--
-- Name: uq_container_channel_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_container_channel_day ON public.recording_containers USING btree (channel_id, broadcast_day) WHERE (channel_id IS NOT NULL);


--
-- Name: uq_container_event_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_container_event_day ON public.recording_containers USING btree (event_id, broadcast_day) WHERE (event_id IS NOT NULL);


--
-- Name: uq_encode_ladder_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_encode_ladder_default ON public.encode_ladder_groups USING btree (account_id) WHERE is_default;


--
-- Name: uq_epg_aliases_source_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_epg_aliases_source_channel ON public.epg_channel_aliases USING btree (source_id, channel_id) WHERE (channel_id IS NOT NULL);


--
-- Name: uq_gfx_one_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_gfx_one_draft ON public.gfx_template_versions USING btree (template_id) WHERE (status = 'draft'::text);


--
-- Name: uq_gfx_version_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_gfx_version_number ON public.gfx_template_versions USING btree (template_id, version) WHERE (version IS NOT NULL);


--
-- Name: uq_groups_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_groups_one_default ON public.groups USING btree (account_id) WHERE is_default;


--
-- Name: uq_jobs_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_jobs_dedupe ON public.jobs USING btree (dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND (state = ANY (ARRAY['queued'::public.job_state, 'running'::public.job_state])));


--
-- Name: uq_media_objects_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_media_objects_asset ON public.media_objects USING btree (vod_asset_id, logical_key) WHERE (vod_asset_id IS NOT NULL);


--
-- Name: uq_media_objects_channel_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_media_objects_channel_key ON public.media_objects USING btree (channel_id, logical_key) WHERE ((recording_id IS NULL) AND (vod_asset_id IS NULL) AND (channel_id IS NOT NULL));


--
-- Name: uq_media_objects_event_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_media_objects_event_key ON public.media_objects USING btree (event_id, logical_key) WHERE ((recording_id IS NULL) AND (vod_asset_id IS NULL) AND (event_id IS NOT NULL));


--
-- Name: uq_media_objects_recording; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_media_objects_recording ON public.media_objects USING btree (recording_id, logical_key) WHERE (recording_id IS NOT NULL);


--
-- Name: uq_rec_channel_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_rec_channel_day ON public.recordings USING btree (channel_id, day_utc) WHERE (kind = 'channel_day'::public.recording_kind);


--
-- Name: uq_user_groups_role_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_groups_role_key ON public.user_groups USING btree (account_id, role_key) WHERE (role_key IS NOT NULL);


--
-- Name: uq_viewers_hosted_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_viewers_hosted_email ON public.viewers USING btree (account_id, lower(email)) WHERE ((source = 'hosted'::text) AND (status <> 'deleted'::text));


--
-- Name: uq_watchfolder_items_object; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_watchfolder_items_object ON public.watchfolder_items USING btree (watchfolder_id, object_key, COALESCE(checksum, ''::text));


--
-- Name: user_access_links_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_access_links_expiry ON public.user_access_links USING btree (expires_at);


--
-- Name: user_access_links_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_access_links_open ON public.user_access_links USING btree (user_id, kind) WHERE ((consumed_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: vod_formats_render_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vod_formats_render_state_idx ON public.vod_formats USING btree (render_state) WHERE (render_state = ANY (ARRAY['queued'::text, 'rendering'::text]));


--
-- Name: accounts trg_cache_accounts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_accounts AFTER DELETE OR UPDATE OF status, geo_access ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('acct', 'id');


--
-- Name: api_keys trg_cache_api_keys; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_api_keys AFTER INSERT OR DELETE OR UPDATE OF enabled, scopes, kind, app_id, key_hash, account_id ON public.api_keys FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('keyhash', 'key_hash', 'key', 'id');


--
-- Name: apps trg_cache_apps; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_apps AFTER INSERT OR DELETE OR UPDATE ON public.apps FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('app', 'id');


--
-- Name: channels trg_cache_channels; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_channels AFTER INSERT OR DELETE OR UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('asset', 'id');


--
-- Name: entitlements trg_cache_entitlements; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_entitlements AFTER INSERT OR DELETE OR UPDATE ON public.entitlements FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('viewer', 'viewer_id');


--
-- Name: events trg_cache_events; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_events AFTER INSERT OR DELETE OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('asset', 'id');


--
-- Name: output_profiles trg_cache_output_profiles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_output_profiles AFTER DELETE OR UPDATE ON public.output_profiles FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('profile', 'id');


--
-- Name: player_configs trg_cache_player_configs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_player_configs AFTER INSERT OR DELETE OR UPDATE ON public.player_configs FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('playercfg', 'account_id');


--
-- Name: programmes trg_cache_programmes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_programmes AFTER INSERT OR DELETE OR UPDATE ON public.programmes FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('asset', 'channel_id', 'asset', 'event_id');


--
-- Name: publishing_rules trg_cache_publishing_rules; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_publishing_rules AFTER INSERT OR DELETE OR UPDATE ON public.publishing_rules FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('rules', 'account_id');


--
-- Name: stream_breaks trg_cache_stream_breaks; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_stream_breaks AFTER INSERT OR DELETE OR UPDATE ON public.stream_breaks FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('asset', 'channel_id', 'asset', 'event_id');


--
-- Name: user_group_members trg_cache_user_group_members; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_user_group_members AFTER INSERT OR DELETE OR UPDATE ON public.user_group_members FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('user', 'user_id');


--
-- Name: user_groups trg_cache_user_groups; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_user_groups AFTER INSERT OR DELETE OR UPDATE ON public.user_groups FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('ugroup', 'id');


--
-- Name: users trg_cache_users; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_users AFTER DELETE OR UPDATE OF role, status, user_group_id, platform_role, account_id ON public.users FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('user', 'id');


--
-- Name: vod_assets trg_cache_vod_assets; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_vod_assets AFTER INSERT OR DELETE OR UPDATE ON public.vod_assets FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('asset', 'id');


--
-- Name: vod_markers trg_cache_vod_markers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cache_vod_markers AFTER INSERT OR DELETE OR UPDATE ON public.vod_markers FOR EACH ROW EXECUTE FUNCTION public.volt_cache_notify('asset', 'vod_asset_id');


--
-- Name: gfx_files trg_gfx_files_frozen; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gfx_files_frozen BEFORE INSERT OR UPDATE ON public.gfx_files FOR EACH ROW EXECUTE FUNCTION public.gfx_frozen_version();


--
-- Name: gfx_files trg_gfx_files_frozen_del; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gfx_files_frozen_del BEFORE DELETE ON public.gfx_files FOR EACH ROW EXECUTE FUNCTION public.gfx_frozen_version();


--
-- Name: gfx_template_versions trg_gfx_version_frozen; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_gfx_version_frozen BEFORE UPDATE ON public.gfx_template_versions FOR EACH ROW EXECUTE FUNCTION public.gfx_frozen_version();


--
-- Name: media_files trg_media_files_search; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_media_files_search BEFORE INSERT OR UPDATE ON public.media_files FOR EACH ROW EXECUTE FUNCTION public.media_files_search_refresh();


--
-- Name: viewers trg_viewer_revoke; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_viewer_revoke AFTER UPDATE ON public.viewers FOR EACH ROW EXECUTE FUNCTION public.volt_viewer_revoke_notify();


--
-- Name: entitlements trg_viewer_revoke_ent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_viewer_revoke_ent AFTER DELETE OR UPDATE ON public.entitlements FOR EACH ROW EXECUTE FUNCTION public.volt_viewer_revoke_notify();


--
-- Name: vod_assets trg_vod_assets_encode_facts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vod_assets_encode_facts BEFORE INSERT OR UPDATE OF encode_result, channel_id, event_id ON public.vod_assets FOR EACH ROW EXECUTE FUNCTION public.vod_assets_encode_facts();


--
-- Name: accounts accounts_parent_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_parent_account_id_fkey FOREIGN KEY (parent_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: ad_beacons ad_beacons_break_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_beacons
    ADD CONSTRAINT ad_beacons_break_id_fkey FOREIGN KEY (break_id) REFERENCES public.stream_breaks(id) ON DELETE SET NULL;


--
-- Name: ad_beacons ad_beacons_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_beacons
    ADD CONSTRAINT ad_beacons_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: ad_creatives ad_creatives_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_creatives
    ADD CONSTRAINT ad_creatives_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: ad_creatives ad_creatives_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_creatives
    ADD CONSTRAINT ad_creatives_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE SET NULL;


--
-- Name: ad_decisions ad_decisions_ad_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_decisions
    ADD CONSTRAINT ad_decisions_ad_server_id_fkey FOREIGN KEY (ad_server_id) REFERENCES public.ad_servers(id) ON DELETE SET NULL;


--
-- Name: ad_decisions ad_decisions_break_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_decisions
    ADD CONSTRAINT ad_decisions_break_id_fkey FOREIGN KEY (break_id) REFERENCES public.stream_breaks(id) ON DELETE SET NULL;


--
-- Name: ad_decisions ad_decisions_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_decisions
    ADD CONSTRAINT ad_decisions_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: ad_servers ad_servers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_servers
    ADD CONSTRAINT ad_servers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: addon_run_events addon_run_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_run_events
    ADD CONSTRAINT addon_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.addon_runs(id) ON DELETE CASCADE;


--
-- Name: addon_runs addon_runs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_runs
    ADD CONSTRAINT addon_runs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: addon_runs addon_runs_addon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_runs
    ADD CONSTRAINT addon_runs_addon_id_fkey FOREIGN KEY (addon_id) REFERENCES public.addon_services(id) ON DELETE CASCADE;


--
-- Name: addon_runs addon_runs_trigger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_runs
    ADD CONSTRAINT addon_runs_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES public.addon_triggers(id) ON DELETE SET NULL;


--
-- Name: addon_services addon_services_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_services
    ADD CONSTRAINT addon_services_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: addon_triggers addon_triggers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_triggers
    ADD CONSTRAINT addon_triggers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: addon_triggers addon_triggers_addon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addon_triggers
    ADD CONSTRAINT addon_triggers_addon_id_fkey FOREIGN KEY (addon_id) REFERENCES public.addon_services(id) ON DELETE CASCADE;


--
-- Name: air_sessions air_sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.air_sessions
    ADD CONSTRAINT air_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: air_sessions air_sessions_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.air_sessions
    ADD CONSTRAINT air_sessions_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: air_sessions air_sessions_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.air_sessions
    ADD CONSTRAINT air_sessions_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


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
-- Name: asset_reviews asset_reviews_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_reviews
    ADD CONSTRAINT asset_reviews_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: asset_reviews asset_reviews_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_reviews
    ADD CONSTRAINT asset_reviews_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


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
-- Name: channel_ads channel_ads_ad_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ads
    ADD CONSTRAINT channel_ads_ad_server_id_fkey FOREIGN KEY (ad_server_id) REFERENCES public.ad_servers(id) ON DELETE SET NULL;


--
-- Name: channel_ads channel_ads_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_ads
    ADD CONSTRAINT channel_ads_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


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
-- Name: channels channels_relay_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_relay_id_fkey FOREIGN KEY (relay_id) REFERENCES public.relays(id) ON DELETE SET NULL;


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
-- Name: clip_segments clip_segments_container_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_segments
    ADD CONSTRAINT clip_segments_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.recording_containers(id) ON DELETE SET NULL;


--
-- Name: clip_segments clip_segments_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_segments
    ADD CONSTRAINT clip_segments_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;


--
-- Name: clip_segments clip_segments_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_segments
    ADD CONSTRAINT clip_segments_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


--
-- Name: cost_actuals cost_actuals_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_actuals
    ADD CONSTRAINT cost_actuals_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dayparts dayparts_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dayparts
    ADD CONSTRAINT dayparts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: drm_configs drm_configs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drm_configs
    ADD CONSTRAINT drm_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: encode_ladder_groups encode_ladder_groups_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_groups
    ADD CONSTRAINT encode_ladder_groups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: encode_ladder_groups encode_ladder_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_groups
    ADD CONSTRAINT encode_ladder_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: encode_ladder_groups encode_ladder_groups_tracks_output_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_groups
    ADD CONSTRAINT encode_ladder_groups_tracks_output_profile_id_fkey FOREIGN KEY (tracks_output_profile_id) REFERENCES public.output_profiles(id) ON DELETE SET NULL;


--
-- Name: encode_ladder_groups encode_ladder_groups_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_groups
    ADD CONSTRAINT encode_ladder_groups_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: encode_ladder_members encode_ladder_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_members
    ADD CONSTRAINT encode_ladder_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.encode_ladder_groups(id) ON DELETE CASCADE;


--
-- Name: encode_ladder_members encode_ladder_members_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_ladder_members
    ADD CONSTRAINT encode_ladder_members_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.encode_profiles(id) ON DELETE CASCADE;


--
-- Name: encode_profiles encode_profiles_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_profiles
    ADD CONSTRAINT encode_profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: encode_profiles encode_profiles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_profiles
    ADD CONSTRAINT encode_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: encode_profiles encode_profiles_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encode_profiles
    ADD CONSTRAINT encode_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: entitlements entitlements_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlements
    ADD CONSTRAINT entitlements_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: entitlements entitlements_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlements
    ADD CONSTRAINT entitlements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: entitlements entitlements_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlements
    ADD CONSTRAINT entitlements_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id) ON DELETE SET NULL;


--
-- Name: entitlements entitlements_viewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entitlements
    ADD CONSTRAINT entitlements_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES public.viewers(id) ON DELETE CASCADE;


--
-- Name: epg_batches epg_batches_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_batches
    ADD CONSTRAINT epg_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: epg_channel_aliases epg_channel_aliases_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_channel_aliases
    ADD CONSTRAINT epg_channel_aliases_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: epg_channel_aliases epg_channel_aliases_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_channel_aliases
    ADD CONSTRAINT epg_channel_aliases_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: epg_channel_aliases epg_channel_aliases_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_channel_aliases
    ADD CONSTRAINT epg_channel_aliases_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.epg_import_sources(id) ON DELETE CASCADE;


--
-- Name: epg_feeds epg_feeds_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_feeds
    ADD CONSTRAINT epg_feeds_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: epg_feeds epg_feeds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_feeds
    ADD CONSTRAINT epg_feeds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: epg_import_runs epg_import_runs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_import_runs
    ADD CONSTRAINT epg_import_runs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.epg_import_sources(id) ON DELETE CASCADE;


--
-- Name: epg_import_sources epg_import_sources_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epg_import_sources
    ADD CONSTRAINT epg_import_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


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
-- Name: fast_lineups fast_lineups_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_lineups
    ADD CONSTRAINT fast_lineups_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: fast_lineups fast_lineups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_lineups
    ADD CONSTRAINT fast_lineups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fast_lineups fast_lineups_previous_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_lineups
    ADD CONSTRAINT fast_lineups_previous_id_fkey FOREIGN KEY (previous_id) REFERENCES public.fast_lineups(id) ON DELETE SET NULL;


--
-- Name: fast_playouts fast_playouts_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_playouts
    ADD CONSTRAINT fast_playouts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


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
-- Name: gfx_assignments gfx_assignments_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_assignments
    ADD CONSTRAINT gfx_assignments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_assignments gfx_assignments_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_assignments
    ADD CONSTRAINT gfx_assignments_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: gfx_assignments gfx_assignments_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_assignments
    ADD CONSTRAINT gfx_assignments_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: gfx_assignments gfx_assignments_setup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_assignments
    ADD CONSTRAINT gfx_assignments_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES public.gfx_setups(id) ON DELETE CASCADE;


--
-- Name: gfx_data_sources gfx_data_sources_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_data_sources
    ADD CONSTRAINT gfx_data_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_files gfx_files_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_files
    ADD CONSTRAINT gfx_files_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.gfx_template_versions(id) ON DELETE CASCADE;


--
-- Name: gfx_impressions gfx_impressions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions
    ADD CONSTRAINT gfx_impressions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_impressions gfx_impressions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions
    ADD CONSTRAINT gfx_impressions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE SET NULL;


--
-- Name: gfx_impressions gfx_impressions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions
    ADD CONSTRAINT gfx_impressions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.gfx_assignments(id) ON DELETE SET NULL;


--
-- Name: gfx_impressions gfx_impressions_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions
    ADD CONSTRAINT gfx_impressions_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: gfx_impressions gfx_impressions_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_impressions
    ADD CONSTRAINT gfx_impressions_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: gfx_rundown_items gfx_rundown_items_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_rundown_items
    ADD CONSTRAINT gfx_rundown_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_rundown_items gfx_rundown_items_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_rundown_items
    ADD CONSTRAINT gfx_rundown_items_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: gfx_rundown_items gfx_rundown_items_setup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_rundown_items
    ADD CONSTRAINT gfx_rundown_items_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES public.gfx_setups(id) ON DELETE RESTRICT;


--
-- Name: gfx_setups gfx_setups_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_setups
    ADD CONSTRAINT gfx_setups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_setups gfx_setups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_setups
    ADD CONSTRAINT gfx_setups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gfx_setups gfx_setups_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_setups
    ADD CONSTRAINT gfx_setups_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.gfx_templates(id) ON DELETE RESTRICT;


--
-- Name: gfx_setups gfx_setups_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_setups
    ADD CONSTRAINT gfx_setups_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.gfx_template_versions(id) ON DELETE RESTRICT;


--
-- Name: gfx_snapshots gfx_snapshots_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_snapshots
    ADD CONSTRAINT gfx_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_snapshots gfx_snapshots_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_snapshots
    ADD CONSTRAINT gfx_snapshots_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: gfx_snapshots gfx_snapshots_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_snapshots
    ADD CONSTRAINT gfx_snapshots_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: gfx_state gfx_state_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state
    ADD CONSTRAINT gfx_state_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.gfx_assignments(id) ON DELETE CASCADE;


--
-- Name: gfx_state_log gfx_state_log_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state_log
    ADD CONSTRAINT gfx_state_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_state_log gfx_state_log_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state_log
    ADD CONSTRAINT gfx_state_log_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.gfx_assignments(id) ON DELETE CASCADE;


--
-- Name: gfx_state_log gfx_state_log_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_state_log
    ADD CONSTRAINT gfx_state_log_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: gfx_template_versions gfx_template_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_template_versions
    ADD CONSTRAINT gfx_template_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gfx_template_versions gfx_template_versions_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_template_versions
    ADD CONSTRAINT gfx_template_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gfx_template_versions gfx_template_versions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_template_versions
    ADD CONSTRAINT gfx_template_versions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.gfx_templates(id) ON DELETE CASCADE;


--
-- Name: gfx_templates gfx_templates_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_templates
    ADD CONSTRAINT gfx_templates_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: gfx_templates gfx_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_templates
    ADD CONSTRAINT gfx_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: gfx_templates gfx_templates_duplicated_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gfx_templates
    ADD CONSTRAINT gfx_templates_duplicated_from_fkey FOREIGN KEY (duplicated_from) REFERENCES public.gfx_templates(id) ON DELETE SET NULL;


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
-- Name: host_samples host_samples_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_samples
    ADD CONSTRAINT host_samples_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.compute_hosts(id) ON DELETE CASCADE;


--
-- Name: identity_providers identity_providers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_providers
    ADD CONSTRAINT identity_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: ingest_provider_accounts ingest_provider_accounts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_provider_accounts
    ADD CONSTRAINT ingest_provider_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: ingest_provider_accounts ingest_provider_accounts_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_provider_accounts
    ADD CONSTRAINT ingest_provider_accounts_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ingest_rules ingest_rules_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_rules
    ADD CONSTRAINT ingest_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: ingest_transfers ingest_transfers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_transfers
    ADD CONSTRAINT ingest_transfers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: ingest_transfers ingest_transfers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_transfers
    ADD CONSTRAINT ingest_transfers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ingest_transfers ingest_transfers_provider_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_transfers
    ADD CONSTRAINT ingest_transfers_provider_account_id_fkey FOREIGN KEY (provider_account_id) REFERENCES public.ingest_provider_accounts(id) ON DELETE SET NULL;


--
-- Name: ingest_webhooks ingest_webhooks_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_webhooks
    ADD CONSTRAINT ingest_webhooks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: instances instances_assigned_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_assigned_host_id_fkey FOREIGN KEY (assigned_host_id) REFERENCES public.compute_hosts(id) ON DELETE SET NULL;


--
-- Name: instances instances_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: instances instances_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: instances instances_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instances
    ADD CONSTRAINT instances_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.compute_hosts(id) ON DELETE SET NULL;


--
-- Name: job_attempts job_attempts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: jobs jobs_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: listener_sessions listener_sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listener_sessions
    ADD CONSTRAINT listener_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: listener_sessions listener_sessions_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listener_sessions
    ADD CONSTRAINT listener_sessions_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: media_events media_events_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_events
    ADD CONSTRAINT media_events_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.media_objects(id) ON DELETE CASCADE;


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
-- Name: media_locations media_locations_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_locations
    ADD CONSTRAINT media_locations_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.media_objects(id) ON DELETE CASCADE;


--
-- Name: media_objects media_objects_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: media_objects media_objects_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: media_objects media_objects_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;


--
-- Name: media_objects media_objects_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE SET NULL;


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
-- Name: payment_providers payment_providers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_providers
    ADD CONSTRAINT payment_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


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
-- Name: player_configs player_configs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_configs
    ADD CONSTRAINT player_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: player_configs player_configs_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_configs
    ADD CONSTRAINT player_configs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: player_events player_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_events
    ADD CONSTRAINT player_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: player_events player_events_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_events
    ADD CONSTRAINT player_events_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE SET NULL;


--
-- Name: player_events player_events_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.player_events
    ADD CONSTRAINT player_events_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: products products_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: programme_series programme_series_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programme_series
    ADD CONSTRAINT programme_series_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: programme_series programme_series_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programme_series
    ADD CONSTRAINT programme_series_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: programmes programmes_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programmes
    ADD CONSTRAINT programmes_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: programmes programmes_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programmes
    ADD CONSTRAINT programmes_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: programmes programmes_series_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programmes
    ADD CONSTRAINT programmes_series_id_fkey FOREIGN KEY (series_id) REFERENCES public.programme_series(id) ON DELETE SET NULL;


--
-- Name: publications publications_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


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
-- Name: publish_targets publish_targets_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publish_targets
    ADD CONSTRAINT publish_targets_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: publishing_rules publishing_rules_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publishing_rules
    ADD CONSTRAINT publishing_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: purchases purchases_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: purchases purchases_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: purchases purchases_viewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES public.viewers(id) ON DELETE CASCADE;


--
-- Name: qc_events qc_events_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_events
    ADD CONSTRAINT qc_events_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


--
-- Name: recording_containers recording_containers_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_containers
    ADD CONSTRAINT recording_containers_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: recording_containers recording_containers_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recording_containers
    ADD CONSTRAINT recording_containers_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: recordings recordings_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: recordings recordings_container_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.recording_containers(id) ON DELETE SET NULL;


--
-- Name: recordings recordings_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordings
    ADD CONSTRAINT recordings_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: reframe_settings reframe_settings_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reframe_settings
    ADD CONSTRAINT reframe_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: relay_accruals relay_accruals_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_accruals
    ADD CONSTRAINT relay_accruals_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.compute_hosts(id) ON DELETE SET NULL;


--
-- Name: relay_accruals relay_accruals_relay_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_accruals
    ADD CONSTRAINT relay_accruals_relay_id_fkey FOREIGN KEY (relay_id) REFERENCES public.relays(id) ON DELETE SET NULL;


--
-- Name: relays relays_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relays
    ADD CONSTRAINT relays_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.compute_hosts(id) ON DELETE SET NULL;


--
-- Name: retention_rules retention_rules_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_rules
    ADD CONSTRAINT retention_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: retention_rules retention_rules_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_rules
    ADD CONSTRAINT retention_rules_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: retention_rules retention_rules_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_rules
    ADD CONSTRAINT retention_rules_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: retention_stages retention_stages_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_stages
    ADD CONSTRAINT retention_stages_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.retention_rules(id) ON DELETE CASCADE;


--
-- Name: run_stops run_stops_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_stops
    ADD CONSTRAINT run_stops_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: saas_signups saas_signups_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_signups
    ADD CONSTRAINT saas_signups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: saas_signups saas_signups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_signups
    ADD CONSTRAINT saas_signups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


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
-- Name: social_oauth_states social_oauth_states_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_oauth_states
    ADD CONSTRAINT social_oauth_states_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: social_oauth_states social_oauth_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_oauth_states
    ADD CONSTRAINT social_oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: song_details song_details_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.song_details
    ADD CONSTRAINT song_details_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: storyboards storyboards_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storyboards
    ADD CONSTRAINT storyboards_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: stream_breaks stream_breaks_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_breaks
    ADD CONSTRAINT stream_breaks_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: stream_breaks stream_breaks_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_breaks
    ADD CONSTRAINT stream_breaks_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: stream_breaks stream_breaks_programme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_breaks
    ADD CONSTRAINT stream_breaks_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES public.programmes(id) ON DELETE CASCADE;


--
-- Name: stream_concurrency stream_concurrency_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_concurrency
    ADD CONSTRAINT stream_concurrency_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: stream_concurrency_parts stream_concurrency_parts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_concurrency_parts
    ADD CONSTRAINT stream_concurrency_parts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


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
-- Name: upload_sessions upload_sessions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_filler_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_filler_asset_id_fkey FOREIGN KEY (filler_asset_id) REFERENCES public.filler_assets(id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_ladder_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_ladder_group_id_fkey FOREIGN KEY (ladder_group_id) REFERENCES public.encode_ladder_groups(id) ON DELETE SET NULL;


--
-- Name: upload_sessions upload_sessions_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: upload_sessions upload_sessions_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.metadata_schemas(id) ON DELETE SET NULL;


--
-- Name: upload_sessions upload_sessions_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE SET NULL;


--
-- Name: usage_accruals usage_accruals_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals
    ADD CONSTRAINT usage_accruals_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: usage_accruals usage_accruals_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals
    ADD CONSTRAINT usage_accruals_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: usage_accruals usage_accruals_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals
    ADD CONSTRAINT usage_accruals_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;


--
-- Name: usage_accruals usage_accruals_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals
    ADD CONSTRAINT usage_accruals_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.compute_hosts(id) ON DELETE SET NULL;


--
-- Name: usage_accruals usage_accruals_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_accruals
    ADD CONSTRAINT usage_accruals_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.instances(id) ON DELETE SET NULL;


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
-- Name: user_access_links user_access_links_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_links
    ADD CONSTRAINT user_access_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: user_access_links user_access_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_links
    ADD CONSTRAINT user_access_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_access_links user_access_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_links
    ADD CONSTRAINT user_access_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_group_members user_group_members_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_group_members user_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON DELETE CASCADE;


--
-- Name: user_group_members user_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_groups user_groups_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: users users_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: users users_user_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_user_group_id_fkey FOREIGN KEY (user_group_id) REFERENCES public.user_groups(id) ON DELETE SET NULL;


--
-- Name: viewer_refresh_tokens viewer_refresh_tokens_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_refresh_tokens
    ADD CONSTRAINT viewer_refresh_tokens_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE SET NULL;


--
-- Name: viewer_refresh_tokens viewer_refresh_tokens_viewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_refresh_tokens
    ADD CONSTRAINT viewer_refresh_tokens_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES public.viewers(id) ON DELETE CASCADE;


--
-- Name: viewers viewers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewers
    ADD CONSTRAINT viewers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_encode_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_encode_job_id_fkey FOREIGN KEY (encode_job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: vod_assets vod_assets_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: vod_assets vod_assets_ladder_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_ladder_group_id_fkey FOREIGN KEY (ladder_group_id) REFERENCES public.encode_ladder_groups(id) ON DELETE SET NULL;


--
-- Name: vod_assets vod_assets_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;


--
-- Name: vod_assets vod_assets_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vod_assets vod_assets_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_assets
    ADD CONSTRAINT vod_assets_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.metadata_schemas(id) ON DELETE SET NULL;


--
-- Name: vod_formats vod_formats_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_formats
    ADD CONSTRAINT vod_formats_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


--
-- Name: vod_markers vod_markers_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_markers
    ADD CONSTRAINT vod_markers_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


--
-- Name: vod_tracks vod_tracks_vod_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vod_tracks
    ADD CONSTRAINT vod_tracks_vod_asset_id_fkey FOREIGN KEY (vod_asset_id) REFERENCES public.vod_assets(id) ON DELETE CASCADE;


--
-- Name: watchfolder_items watchfolder_items_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items
    ADD CONSTRAINT watchfolder_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: watchfolder_items watchfolder_items_matched_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items
    ADD CONSTRAINT watchfolder_items_matched_rule_id_fkey FOREIGN KEY (matched_rule_id) REFERENCES public.watchfolder_rules(id) ON DELETE SET NULL;


--
-- Name: watchfolder_items watchfolder_items_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items
    ADD CONSTRAINT watchfolder_items_media_file_id_fkey FOREIGN KEY (media_file_id) REFERENCES public.media_files(id) ON DELETE SET NULL;


--
-- Name: watchfolder_items watchfolder_items_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items
    ADD CONSTRAINT watchfolder_items_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: watchfolder_items watchfolder_items_watchfolder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_items
    ADD CONSTRAINT watchfolder_items_watchfolder_id_fkey FOREIGN KEY (watchfolder_id) REFERENCES public.watchfolders(id) ON DELETE CASCADE;


--
-- Name: watchfolder_rules watchfolder_rules_watchfolder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolder_rules
    ADD CONSTRAINT watchfolder_rules_watchfolder_id_fkey FOREIGN KEY (watchfolder_id) REFERENCES public.watchfolders(id) ON DELETE CASCADE;


--
-- Name: watchfolders watchfolders_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolders
    ADD CONSTRAINT watchfolders_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: watchfolders watchfolders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolders
    ADD CONSTRAINT watchfolders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: watchfolders watchfolders_ladder_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolders
    ADD CONSTRAINT watchfolders_ladder_group_id_fkey FOREIGN KEY (ladder_group_id) REFERENCES public.encode_ladder_groups(id) ON DELETE SET NULL;


--
-- Name: watchfolders watchfolders_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.watchfolders
    ADD CONSTRAINT watchfolders_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workflow_events workflow_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict QcqWltrhAK3gfbeIxAdJJqZ0whYALtiFqPNWWdUceyM0gz14PXHp9HFfPrz02M0

