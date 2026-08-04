import { config } from '../config';

/**
 * Build the JSON job config the Volt encoder container reads (matches
 * volt-encoder/job.example.json). This is the seam between the control-plane DB
 * model and the encoder contract — pure and unit-tested.
 *
 * Inputs are the already-loaded rows: the channel/event, its group's output
 * profile, its stream_inputs, and (optionally) the DRM config. The builder
 * decides workflow, ladder, inputs (primary + backup roles), S3 target, DRM,
 * redundancy, captions, and the status-report webhook.
 */
export interface StreamInputRow {
  role: 'primary' | 'backup';
  rendition_label: string | null;
  rendition_bitrate_kbps: number | null;
  protocol: string;
  ingest_url: string | null;
  stream_key: string | null;
}
export interface ProfileRow {
  rungs: Array<{ height: number; bitrate_kbps: number; fps?: number }>;
  packaging: 'hls' | 'dash' | 'both';
  workflow_type: 'transcode' | 'package_only';
  codec_backend: 'x264' | 'nvenc';
  segment_dur: number | string;
  dvr_window_sec: number;
  captions_enabled?: boolean;
  caption_engine?: string;
  caption_source_lang?: string;
  caption_targets?: string[];
  caption_offset_sec?: number;
  drm_enabled?: boolean;
}
export interface DrmRow {
  scheme: string;
  systems: string[];
  tenant_id: string;
  key_service_url: string;
  management_key_ref: string;
}
export interface OwnerRow {
  id: string;
  input_failover_enabled?: boolean;
  auto_failback?: boolean;
  input_loss_behavior?: string;
  filler_ref?: string | null; // resolved slate URL or vod loop URL
  filler_vod_url?: string | null;
}

export interface AccountRow {
  /** master captions switch decided per overall account: none disables it entirely. */
  captions_provider?: 'none' | 'whisper' | 'gladia';
}

export interface JobConfigCtx {
  kind: 'channel' | 'event';
  owner: OwnerRow;
  profile: ProfileRow;
  inputs: StreamInputRow[];
  drm?: DrmRow | null;
  account?: AccountRow | null;
}

function inputUrl(i: StreamInputRow): string {
  // prefer an explicit ingest_url; otherwise it's an endpoint we issue and the
  // stream key selects the stream (the encoder listens / connects per protocol).
  return i.ingest_url ?? `srt://0.0.0.0:9000?streamid=${i.stream_key ?? ''}`;
}

export function buildEncoderJobConfig(ctx: JobConfigCtx): Record<string, any> {
  const { owner, profile, inputs, drm } = ctx;
  const seg = Number(profile.segment_dur) || 4;
  const fps = profile.rungs[0]?.fps ?? 25;

  const cfg: Record<string, any> = {
    channel_id: owner.id,
    workflow: profile.workflow_type,
    segment_seconds: seg,
    fps,
    dvr_seconds: profile.dvr_window_sec,
    packaging: profile.packaging,
    s3: {
      bucket: config.aws.s3Bucket,
      prefix: `${ctx.kind}/${owner.id}`,
    },
    status_report: {
      url: `${config.internalApiBaseUrl}/api/streams/${owner.id}/report`,
      token: config.ingestToken,
    },
  };

  if (profile.workflow_type === 'transcode') {
    // one mezzanine input; we build the ladder from the profile rungs
    cfg.inputs = inputs
      .filter((i) => i.role === 'primary')
      .map((i) => ({
        rendition_label: i.rendition_label ?? 'mezzanine',
        role: i.role,
        protocol: i.protocol,
        url: inputUrl(i),
        has_audio: true,
      }));
    // backups (a 2nd mezzanine) if failover is on
    if (owner.input_failover_enabled) {
      cfg.inputs.push(
        ...inputs
          .filter((i) => i.role === 'backup')
          .map((i) => ({
            rendition_label: i.rendition_label ?? 'mezzanine',
            role: 'backup',
            protocol: i.protocol,
            url: inputUrl(i),
          }))
      );
    }
    cfg.gpu = profile.codec_backend === 'nvenc';
    cfg.ladder = profile.rungs.map((r) => ({ height: r.height, bitrate_kbps: r.bitrate_kbps }));
  } else {
    // package_only: the client sends the full ladder — one input per rendition
    cfg.inputs = inputs
      .filter((i) => owner.input_failover_enabled || i.role === 'primary')
      .map((i, idx) => ({
        rendition_label: i.rendition_label ?? `r${idx}`,
        role: i.role,
        protocol: i.protocol,
        url: inputUrl(i),
        bitrate_kbps: i.rendition_bitrate_kbps ?? undefined,
        ...(idx === 0 ? { has_audio: true } : {}),
      }));
  }

  if (drm && profile.drm_enabled) {
    cfg.drm = {
      mode: drm.scheme, // cbcs
      speke_url: drm.key_service_url,
      content_id: owner.id,
      // the encoder resolves the actual management key from Secrets Manager via
      // the task role; we pass the reference, never the secret itself.
      auth_ref: drm.management_key_ref,
      tenant_id: drm.tenant_id,
      systems: drm.systems,
    };
  }

  if (owner.input_failover_enabled) {
    cfg.redundancy = {
      input_failover: true,
      auto_failback: owner.auto_failback ?? true,
      input_loss_behavior: owner.input_loss_behavior ?? 'slate',
      filler: {
        slate_ref: owner.filler_ref ?? null,
        vod_loop_url: owner.filler_vod_url ?? null,
      },
    };
  }

  // live captions / transcription / translation (encoder sidecar).
  // The account's captions_provider is the MASTER switch: 'none' (or unset)
  // disables captions for every profile regardless of captions_enabled. When the
  // account has a provider, the profile opts in via captions_enabled and its engine
  // falls back to the account default. A profile can't pick an engine the account
  // hasn't licensed — it's pinned to the account provider.
  const acctProvider = ctx.account?.captions_provider ?? 'none';
  if (profile.captions_enabled && acctProvider !== 'none') {
    cfg.captions = {
      enabled: true,
      engine: acctProvider, // account decides the engine; profile can't exceed it
      source_lang: profile.caption_source_lang ?? 'auto',
      targets: profile.caption_targets ?? [],
      offset_sec: profile.caption_offset_sec ?? 0,
    };
  }

  return cfg;
}

/** Job config for the CPU thumbnailer task, run on recording completion. */
export function buildThumbnailerJobConfig(rec: {
  id: string;
  kind: 'recording' | 'vod';
  source_master: string; // s3 URL of the hi-res source manifest
  duration_sec: number;
}): Record<string, any> {
  return {
    target: rec.kind,
    id: rec.id,
    source: rec.source_master,
    duration_sec: rec.duration_sec,
    out_s3: `s3://${config.aws.s3Bucket}/thumbs/${rec.id}`,
    grid: { cols: 5, rows: 5 },
    interval_sec: 10,
    thumb_width: 320,
    aspect: [16, 9],
    poster_at_sec: Math.min(30, Math.max(1, Math.floor(rec.duration_sec / 2))),
    report: {
      url: `${config.internalApiBaseUrl}/api/media/thumbnails`,
      token: config.ingestToken,
    },
  };
}
