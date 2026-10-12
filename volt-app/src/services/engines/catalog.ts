// ============================================================================
//  ENGINE CATALOGUE — the built-in engine and the capability SKETCHES for the
//  vendors we expect to add.
//
//  Only `builtin` is installed. The vendor entries are planning data: they let
//  the console show what each option would give a customer, and they are the
//  checklist an adapter author confirms against the vendor's current API docs
//  before flipping availability to 'installed'. Every vendor value below is a
//  sketch from general product knowledge (Oct 2026), not a verified contract;
//  the `todo` list on each entry names what to confirm first.
//
//  Reading a value: true = the engine does it; 'volt' = the vendor does not
//  (or we choose not to use theirs) and Volt does it downstream because our
//  packager still sees the segments; 'vendor' = the vendor does it with its
//  own implementation, so Volt's version (and its guarantees) does not apply;
//  false = unavailable on this engine.
// ============================================================================
import type { EngineDescriptor } from './types';

export const BUILTIN: EngineDescriptor = {
  id: 'builtin',
  name: 'Volt built-in',
  vendor: 'Volt (FFmpeg + Shaka Packager)',
  availability: 'installed',
  defaultMode: 'full',
  summary: 'Our own container: SRT/RTMP ingest, x264 or NVENC ladder, Shaka CMAF packaging, every Volt feature.',
  costNote: 'Our compute. Best margin.',
  caps: {
    modes: ['full'],
    transcodeLadder: true, packageOnly: true,
    maxRenditions: 8, videoCodecs: ['h264'], audioCodecs: ['aac'],
    maxHeight: 2160, gpu: true,
    inputProtocols: ['srt', 'rtmp', 'hls', 'udp'],
    returnPaths: [],
    inputFailover: true, slateOnInputLoss: true, burnInOverlay: true,
    captions: true, scte35Passthrough: true, drm: true,
    recording: true, clipping: true, geoSlate: true, thumbnails: true,
    pushesEvents: true,
  },
};

export const MEDIALIVE: EngineDescriptor = {
  id: 'medialive',
  name: 'AWS Elemental MediaLive',
  vendor: 'Amazon Web Services',
  availability: 'planned',
  defaultMode: 'encode_only',
  summary: 'Managed broadcast-grade encoder with AWS SLAs and dual pipelines. Best fit for customers already on AWS media services.',
  costNote: 'Per-channel-hour pass-through, priced by input and output class. Bill as cost plus management fee.',
  caps: {
    modes: ['encode_only', 'full'],
    transcodeLadder: true, packageOnly: false,
    maxRenditions: null, videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'],
    maxHeight: 2160, gpu: false,
    inputProtocols: ['srt', 'rtmp', 'rtp', 'hls', 'mediaconnect'],
    returnPaths: ['rtmp_push', 'srt_push', 'cmaf_s3'],
    inputFailover: 'vendor', slateOnInputLoss: 'volt', burnInOverlay: 'vendor',
    captions: 'volt', scte35Passthrough: true, drm: 'volt',
    recording: 'volt', clipping: 'volt', geoSlate: 'volt', thumbnails: 'volt',
    pushesEvents: true,
  },
  todo: [
    'Confirm SRT output (caller) availability per region, else RTMP push per rendition.',
    'Map EventBridge "MediaLive Channel Alert" and "State Change" events to canonical events.',
    'Decide single vs standard (dual pipeline) channel class per tier; dual pipeline means two return feeds into source_selector.',
    'Input security groups / SRT passphrase handling via Secrets Manager refs, never values in the job.',
    'Image overlay: map Volt watermark config to static image activate schedule action.',
  ],
};

export const BITMOVIN: EngineDescriptor = {
  id: 'bitmovin',
  name: 'Bitmovin Live Encoding',
  vendor: 'Bitmovin',
  availability: 'planned',
  defaultMode: 'encode_only',
  summary: 'Cloud live encoder with strong codec options (per-title style ladders, HEVC/AV1). Writes segments to object storage.',
  costNote: 'Per-minute encoding pass-through by resolution/codec. Bill as cost plus management fee.',
  caps: {
    modes: ['encode_only', 'full'],
    transcodeLadder: true, packageOnly: false,
    maxRenditions: null, videoCodecs: ['h264', 'hevc', 'av1'], audioCodecs: ['aac', 'ac3', 'eac3'],
    maxHeight: 2160, gpu: false,
    inputProtocols: ['srt', 'rtmp', 'zixi'],
    returnPaths: ['cmaf_s3', 'rtmp_push'],
    inputFailover: 'vendor', slateOnInputLoss: 'volt', burnInOverlay: 'vendor',
    captions: 'volt', scte35Passthrough: 'vendor', drm: 'volt',
    recording: 'volt', clipping: 'volt', geoSlate: 'volt', thumbnails: 'volt',
    pushesEvents: false,
  },
  todo: [
    'Confirm the live return path: fMP4/CMAF to our S3 bucket (preferred, packager reads from S3) vs RTMP/SRT push per rendition.',
    'If cmaf_s3: segment duration and timescale MUST match the channel so failover filler and geo slate splice cleanly.',
    'Live status: webhooks cover encoding lifecycle; live input health likely needs polling the live encoding status endpoint.',
    'Watermark filter mapping from Volt overlay config.',
  ],
};

export const WOWZA: EngineDescriptor = {
  id: 'wowza',
  name: 'Wowza Streaming Engine / Wowza Video',
  vendor: 'Wowza Media Systems',
  availability: 'planned',
  defaultMode: 'encode_only',
  summary: 'For customers with existing Wowza estates: their transcoder, our packaging and delivery. Self-hosted engine or Wowza cloud.',
  costNote: 'Customer-held licence (self-hosted) or Wowza cloud per-hour. Usually the customer pays Wowza directly.',
  caps: {
    modes: ['encode_only'],
    transcodeLadder: true, packageOnly: false,
    maxRenditions: null, videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'],
    maxHeight: 2160, gpu: true,
    inputProtocols: ['srt', 'rtmp', 'rtsp', 'webrtc'],
    returnPaths: ['srt_push', 'rtmp_push'],
    inputFailover: 'volt', slateOnInputLoss: 'volt', burnInOverlay: 'vendor',
    captions: 'volt', scte35Passthrough: 'vendor', drm: 'volt',
    recording: 'volt', clipping: 'volt', geoSlate: 'volt', thumbnails: 'volt',
    pushesEvents: false,
  },
  todo: [
    'Two flavours behind one id or two ids: Streaming Engine REST API (self-hosted, per server) vs Wowza Video REST API (cloud).',
    'Return path via Stream Targets (push publishing) per rendition to our SRT listeners.',
    'No native webhooks on Streaming Engine: poll incoming/outgoing stream stats; Wowza Video may offer webhooks.',
  ],
};

export const CATALOG: EngineDescriptor[] = [BUILTIN, MEDIALIVE, BITMOVIN, WOWZA];
