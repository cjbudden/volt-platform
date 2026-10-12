// ============================================================================
//  ENCODE ENGINES — the contract an encoding vendor plugs into.
//
//  Volt's own pipeline (FFmpeg + Shaka in our container) is one engine among
//  possible many. An engine is WHAT encodes; a TaskLauncher is WHERE our own
//  container runs (mock, local, docker, ECS). The two are deliberately
//  separate: the built-in engine uses a launcher, an external engine (AWS
//  Elemental MediaLive, Bitmovin, Wowza…) calls the vendor's API instead.
//
//  Two integration modes, and the difference matters more than anything else
//  in this file:
//
//    encode_only  the vendor encodes the ladder and pushes each rendition back
//                 to Volt, where OUR packager (package_only workflow) cuts the
//                 CMAF. Every feature that reads our segments keeps working:
//                 captions on the one tfdt clock, failover splice, recordings,
//                 DVR index, clipping, geo slate, DRM, thumbnails, QC.
//    full         the vendor encodes, packages and originates. Volt is control
//                 plane and catalogue only, and features that need our
//                 segments are unavailable unless the vendor writes CMAF into
//                 our bucket. Capabilities must say so, honestly.
//
//  Full guide: volt/ENGINES.md.
// ============================================================================
import type { Liveness } from '../orchestrator/launcher';

export type EngineMode = 'encode_only' | 'full';

/** Whether a vendor adapter actually exists in this build. */
export type EngineAvailability = 'installed' | 'planned';

/**
 * WHAT AN ENGINE CAN DO, declared up front.
 *
 * The point is that nothing is lost silently. A profile that asks for
 * something the chosen engine cannot honour is refused when it is saved
 * (validate), and the console greys the option out, instead of the channel
 * starting and quietly not doing it.
 *
 * `volt` in a value means "the vendor does not, but Volt does it downstream
 * because our packager still sees the segments" (only meaningful in
 * encode_only mode). `false` means nobody does it on this engine.
 */
export type Cap = boolean | 'volt' | 'vendor';

export interface EngineCaps {
  modes: EngineMode[];
  /** Encode from a single mezzanine to an ABR ladder. */
  transcodeLadder: boolean;
  /** Accept a ready-made ladder and only package it. */
  packageOnly: boolean;
  maxRenditions: number | null;
  videoCodecs: string[];             // 'h264' | 'hevc' | 'av1'
  audioCodecs: string[];             // 'aac' | 'ac3' | 'eac3' | 'opus'
  maxHeight: number | null;
  gpu: boolean;
  inputProtocols: string[];          // what the VENDOR can ingest: 'srt' | 'rtmp' | 'rtp' | 'zixi' | 'hls'
  /** How the vendor returns renditions to Volt in encode_only mode. */
  returnPaths: Array<'srt_push' | 'rtmp_push' | 'hls_pull' | 'cmaf_s3'>;
  inputFailover: Cap;
  slateOnInputLoss: Cap;
  burnInOverlay: Cap;
  captions: Cap;
  scte35Passthrough: Cap;
  drm: Cap;
  recording: Cap;
  clipping: Cap;
  geoSlate: Cap;
  thumbnails: Cap;
  /** Vendor reports status by pushing webhooks (true) or Volt must poll (false). */
  pushesEvents: boolean;
}

/** One entry the console and GET /api/engines can show. */
export interface EngineDescriptor {
  id: string;
  name: string;
  vendor: string;
  availability: EngineAvailability;
  defaultMode: EngineMode;
  summary: string;
  caps: EngineCaps;
  /** Pricing model note shown to the person choosing it (pass-through cost). */
  costNote?: string;
  /** Integration notes the adapter author must confirm against vendor docs. */
  todo?: string[];
}

/** The neutral job spec every engine translates FROM. It is the encoder job
 *  config built by services/jobConfig.ts, unchanged. */
export type JobSpec = Record<string, any>;

export interface ValidationIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

/** What a vendor gave back when we created its job. Persisted in engine_bindings. */
export interface EngineHandle {
  /** The vendor's own id for the channel / encoding / stream target. */
  externalRef: string;
  /** Anything the adapter needs later (region, pipeline ids, output URLs). */
  meta?: Record<string, unknown>;
}

/**
 * A Volt status event in the canonical vocabulary the encoder already speaks
 * (volt-encoder/bin/events.py). Adapters map vendor signals INTO these, so the
 * event log, the five health gates and the console need no change per vendor.
 */
export const CANONICAL_EVENTS = [
  'channel.start', 'channel.stop',
  'source.up', 'source.down', 'input.error',
  'failover.switch', 'filler.engaged', 'filler.cleared',
  'packager.up', 'packager.down',
  'output.degraded', 'output.stalled',
  'engine.provisioned', 'engine.state', 'engine.alert', 'engine.error',
] as const;
export type CanonicalEventType = typeof CANONICAL_EVENTS[number];

export interface NormalisedEvent {
  kind: 'channel' | 'event';
  id: string;
  type: CanonicalEventType;
  detail?: Record<string, unknown>;
  ts_ms?: number;
}

export interface EncodeEngine {
  descriptor: EngineDescriptor;
  /** Refuse a job this engine cannot honour, before anything is provisioned. */
  validate(job: JobSpec, mode: EngineMode): ValidationIssue[];
  /**
   * In encode_only mode: rewrite the neutral job into the package_only job our
   * own packager runs, with one listener input per rendition the vendor will
   * push to. Not called in full mode.
   */
  packagerJob?(job: JobSpec): JobSpec;
  /** Create (or reuse) the vendor-side resource. Idempotent per stream. */
  provision(streamId: string, job: JobSpec, mode: EngineMode): Promise<EngineHandle>;
  start(h: EngineHandle): Promise<void>;
  /** Stop, and release billable vendor resources. Must tolerate "already gone". */
  stop(h: EngineHandle, reason: string): Promise<void>;
  /** Same three-valued rule as the launcher: only a definite `dead` reconciles. */
  isRunning(h: EngineHandle): Promise<Liveness>;
  /** Verify a webhook is genuinely from the vendor (signature, shared secret). */
  verifyWebhook?(headers: Record<string, string | string[] | undefined>, rawBody: string): boolean;
  /** Vendor payload (webhook body or poll result) -> canonical Volt events. */
  normalize(raw: unknown, binding: { streamKind: 'channel' | 'event'; streamId: string; handle: EngineHandle }): NormalisedEvent[];
  /** Optional: vendor usage for metering pass-through. */
  usage?(h: EngineHandle, fromMs: number, toMs: number): Promise<{ minutes: number; costUsd?: number } | null>;
}
