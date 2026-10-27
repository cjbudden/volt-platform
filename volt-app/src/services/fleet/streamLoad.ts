// ============================================================================
//  STREAM LOAD MODEL.
//
//  What a stream will cost to run (CPU, memory, GPU, network in and out),
//  worked out from its OUTPUT SETTINGS so that nobody using the product ever
//  has to. A customer picks a ladder, turns on a watermark or captions, and
//  presses Start. Which server it lands on, and how big a slice of it, is
//  decided here and in placementPlanner.ts.
//
//  WHY THE INPUT IS THE ENCODER JOB CONFIG. The job is the exact thing the
//  encoder is about to run (jobConfig.ts builds it from the channel, its group
//  profile, its inputs and the account). Estimating from anything else (the
//  profile alone, say) would drift from what actually runs the first time a
//  per-channel ladder override, a backup input or an account captions switch
//  changed the job without changing the profile. That exact drift already
//  happened once with the ladder (see the note in jobConfig.ts).
//
//  WHAT DRIVES EACH COST
//    transcode     decode the source once, then scale + encode every rung.
//                  x264 cost scales with output pixels per second; NVENC moves
//                  the encode onto the GPU and leaves the CPU a little glue.
//    package_only  no decode, no encode: relay each rendition, segment it,
//                  upload it. Cheap on CPU, heavy on network (in AND out).
//    watermark     an overlay per rung on transcode. On package-only it is not
//                  burned in at all (the encoder skips it), so it costs nothing
//                  and the estimate says so.
//    captions      Gladia rides inside the encoder (audio to a websocket);
//                  Whisper is a separate GPU task with its own estimate.
//    failover      every candidate source runs all the time (FAILOVER.md), so
//                  a backup DOUBLES the ingest relays and the network in.
//    DRM           AES on the way out. Small, counted anyway.
//
//  THE COEFFICIENTS ARE STARTING ESTIMATES, NOT MEASUREMENTS. They are set
//  conservatively (x264 veryfast, the preset ladder_args.py uses) and then
//  replaced by what the fleet actually observed for the same signature (see
//  calibrate()). Every estimate carries its basis so a person can see why a
//  stream was sized the way it was.
//
//  Pure: no DB, no clock, no IO.
// ============================================================================
import type { StreamLoad, Reservation } from './capacity';
import { projectStorage, type StorageProjection } from './storageProjection';

export interface SourceProbe {
  video?: { codec?: string; width?: number; height?: number; fps?: number | null; bitrate_kbps?: number | null };
  container?: { bitrate_kbps?: number | null };
  audio?: Array<{ bitrate_kbps?: number | null }>;
}

export interface LoadLine {
  what: string; cpuUnits: number; memoryMib: number; gpuShare: number; netInBps: number; netOutBps: number;
  /**
   * Which coefficient this line's CPU comes from (encode:x264, decode:hevc,
   * package...). loadFit.ts learns one multiplier per component from every
   * run, so a new ladder is sized from what its parts cost elsewhere.
   */
  component?: string;
}

export interface LoadEstimate {
  taskKind: 'transcode' | 'package_only' | 'radio' | 'captions';
  load: StreamLoad;
  reservation: Reservation;
  needsGpu: boolean;
  /** Stable key for "streams that cost the same", used to calibrate from history. */
  signature: string;
  /** estimate: the starting coefficients; fitted: corrected from all runs (loadFit.ts); observed: this signature's own history. */
  basis: 'estimate' | 'fitted' | 'observed';
  lines: LoadLine[];
  /** The lines before any fit, kept so learning always compares measurements with the unfitted model. */
  baseLines?: LoadLine[];
  /** Which learned fit was applied, when one was. */
  fit?: { family: string; runs: number };
  /** Task disk and S3 the stream will write, from its bitrates (storageProjection.ts). */
  storage: StorageProjection;
  /** Things a person should know about how their settings were applied. */
  notes: string[];
}

/** Coefficients, in one place so calibration and review touch one table. */
export const K = {
  x264PerMpxs: 40,        // CPU units per output megapixel/second, libx264 veryfast
  decodePerMpxs: 6,       // H.264 software decode per source Mpx/s (HEVC x2)
  scalePerMpxs: 2,        // swscale per output Mpx/s
  overlayPerMpxs: 2,      // watermark overlay per output Mpx/s
  nvencCpuPerRung: 80,    // CPU glue per NVENC rung
  nvencDecodeCpu: 60,     // CPU glue for CUDA decode
  gpuMpxsCapacity: 1000,  // NVENC Mpx/s one T4-class GPU sustains (indicative)
  aacPerTrack: 30,
  packagerBase: 150,      // Shaka + playout writer + uploader
  ioPerMbps: 20,          // CPU units per Mbps moved through the box
  relayPerInput: 20,
  drmPerMbps: 10,
  gladia: 120,
  // Whisper on CPU in the encoder: a window of N seconds must transcribe in
  // well under N seconds. Measured 20 Oct 2026 (faster-whisper 1.0.3 int8,
  // arm64 VM, warm model): tiny 0.19 and base 0.30 CPU-seconds per second of
  // audio. Reserved at about four times that for slower cores and bursts.
  // NLLB-600M on CPU is an estimate (not measured here): about one core.
  whisperCpu: { tiny: 768, base: 1280 } as Record<'tiny' | 'base', number>,
  memWhisperCpu: { tiny: 512, base: 768 } as Record<'tiny' | 'base', number>,
  nllbCpu: 1024,
  memNllbCpu: 2560,
  memBase: 384,
  memPerTranscodeRung1080: 150,
  memPerTranscodeRungMin: 48,
  memDecoder1080: 100,
  memPerRelay: 48,
  memGladia: 64,
  // Burned-in graphics renderer (headless Chromium, one page per stream), from
  // the 20 Oct spike: idle about 1 % of a core, a cut a second 6 %, a third of
  // a core during a 1 s transition, about 200 MB PSS for its own Chromium. The
  // composite itself is a box blended once before the split: +2 to +4 % encode.
  gfxRendererCpu: 100,
  memGfxRenderer: 320,
  muxOverhead: 1.05,      // CMAF/TS container bytes over the elementary bitrate
  audioKbps: 128,         // ladder_args.py: aac 128k per track
  gladiaUpKbps: 256,      // 16 kHz 16-bit mono PCM to the STT service
  headroom: 1.3,          // reservation = estimate x this
  minCpu: 256,
  minMem: 512,
};

const DEFAULT_SOURCE_KBPS: Array<[number, number]> = [[2160, 20000], [1440, 12000], [1080, 8000], [720, 5000], [0, 3000]];
const defaultSourceKbps = (h: number) => DEFAULT_SOURCE_KBPS.find(([min]) => h >= min)![1];

const mpxs = (w: number, h: number, fps: number) => (w * h * fps) / 1e6;
const widthFor = (h: number) => Math.round((h * 16) / 9 / 2) * 2;
const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step;
const kbpsToBps = (k: number) => k * 1000;

function line(what: string, l: Partial<LoadLine>, component?: string): LoadLine {
  return { what, cpuUnits: 0, memoryMib: 0, gpuShare: 0, netInBps: 0, netOutBps: 0, ...l, ...(component ? { component } : {}) };
}

function total(lines: LoadLine[], gpus: number): StreamLoad {
  const s = lines.reduce((a, l) => ({
    cpuUnits: a.cpuUnits + l.cpuUnits, memoryMib: a.memoryMib + l.memoryMib, gpuShare: a.gpuShare + l.gpuShare,
    netInBps: a.netInBps + l.netInBps, netOutBps: a.netOutBps + l.netOutBps,
  }), { cpuUnits: 0, memoryMib: 0, gpuShare: 0, netInBps: 0, netOutBps: 0 });
  return {
    cpuUnits: Math.round(s.cpuUnits), memoryMib: Math.round(s.memoryMib),
    gpuShare: Math.round(s.gpuShare * 1000) / 1000, gpus,
    netInBps: Math.round(s.netInBps), netOutBps: Math.round(s.netOutBps),
  };
}

/** Estimate + headroom, rounded to what ECS accepts cleanly. */
export function reserve(load: StreamLoad, headroom = K.headroom): Reservation {
  return {
    cpuUnits: Math.max(K.minCpu, ceilTo(load.cpuUnits * headroom, 128)),
    memoryMib: Math.max(K.minMem, ceilTo(load.memoryMib * headroom, 64)),
    gpus: load.gpus,
  };
}

/**
 * Estimate the load of an ENCODER job (transcode or package_only).
 * `probe` is the primary source's stored probe (stream_inputs.probe), when known.
 */
export function estimateEncoderLoad(job: Record<string, any>, probe?: SourceProbe | null): LoadEstimate {
  const lines: LoadLine[] = [];
  const notes: string[] = [];
  const workflow: 'transcode' | 'package_only' = job.workflow === 'package_only' ? 'package_only' : 'transcode';
  const fps = Number(job.fps) || Number(probe?.video?.fps) || 25;
  const inputs: any[] = Array.isArray(job.inputs) ? job.inputs : [];
  const primaries = inputs.filter((i) => i.role !== 'backup');
  const backups = inputs.filter((i) => i.role === 'backup');
  const audioTracks = Math.max(1, probe?.audio?.length ?? 1);
  let outKbps = 0;
  let gpus = 0;
  let needsGpu = false;

  if (workflow === 'transcode') {
    const ladder: Array<{ height: number; bitrate_kbps: number }> = Array.isArray(job.ladder) ? job.ladder : [];
    const srcH = Number(probe?.video?.height) || Math.max(1080, ...ladder.map((r) => r.height || 0));
    const srcW = Number(probe?.video?.width) || widthFor(srcH);
    const srcFps = Number(probe?.video?.fps) || fps;
    const srcKbps = Number(probe?.video?.bitrate_kbps) || Number(probe?.container?.bitrate_kbps) || defaultSourceKbps(srcH);
    const hevc = /hevc|h265/i.test(probe?.video?.codec ?? '');
    const srcMpxs = mpxs(srcW, srcH, srcFps);
    needsGpu = job.gpu === true;
    if (needsGpu) gpus = 1;

    const sources = 1 + (backups.length ? 1 : 0);
    lines.push(line(`source in (${srcH}p, ${Math.round(srcKbps / 100) / 10} Mbps${sources > 1 ? ', primary + backup' : ''})`, {
      netInBps: kbpsToBps(srcKbps) * sources,
      cpuUnits: K.ioPerMbps * (srcKbps / 1000) * sources,
      memoryMib: K.memPerRelay * (sources - 1),
    }, 'ingest'));
    lines.push(line(`decode ${hevc ? 'HEVC' : 'H.264'} ${srcH}p${needsGpu ? ' on GPU' : ''}`, needsGpu
      ? { cpuUnits: K.nvencDecodeCpu, gpuShare: srcMpxs / (K.gpuMpxsCapacity * 2), memoryMib: K.memDecoder1080 * (srcMpxs / 62.2) }
      : { cpuUnits: K.decodePerMpxs * srcMpxs * (hevc ? 2 : 1), memoryMib: 64 + K.memDecoder1080 * (srcMpxs / 62.2) },
      needsGpu ? 'decode:gpu' : hevc ? 'decode:hevc' : 'decode:h264'));

    const wm = !!job.watermark;
    for (const r of ladder) {
      const h = Math.min(r.height || srcH, srcH);
      const m = mpxs(widthFor(h), h, fps);
      const cpu = needsGpu
        ? K.nvencCpuPerRung + (wm ? K.overlayPerMpxs * m : 0)
        : K.x264PerMpxs * m + K.scalePerMpxs * m + (wm ? K.overlayPerMpxs * m : 0);
      lines.push(line(`encode ${h}p @ ${r.bitrate_kbps} kbps${needsGpu ? ' (NVENC)' : ' (x264)'}${wm ? ' + watermark' : ''}`, {
        cpuUnits: cpu,
        gpuShare: needsGpu ? m / K.gpuMpxsCapacity : 0,
        memoryMib: Math.max(K.memPerTranscodeRungMin, K.memPerTranscodeRung1080 * (m / 62.2)),
      }, needsGpu ? 'encode:nvenc' : 'encode:x264'));
      outKbps += r.bitrate_kbps || 0;
    }
    if (!ladder.length) notes.push('The output ladder is empty, so only the source path is counted.');
    lines.push(line(`audio: ${audioTracks} AAC track${audioTracks > 1 ? 's' : ''}`, { cpuUnits: K.aacPerTrack * audioTracks }, 'audio'));
  } else {
    const kbpsOf = (i: any) => Number(i.bitrate_kbps) || 3000;
    const inKbps = primaries.reduce((s, i) => s + kbpsOf(i), 0);
    const bkKbps = backups.reduce((s, i) => s + kbpsOf(i), 0);
    const missing = inputs.filter((i) => !Number(i.bitrate_kbps)).length;
    if (missing) notes.push(`${missing} input rendition${missing > 1 ? 's have' : ' has'} no bitrate set, so 3 Mbps each was assumed.`);
    lines.push(line(`relay ${primaries.length} rendition${primaries.length === 1 ? '' : 's'} in`, {
      netInBps: kbpsToBps(inKbps), cpuUnits: K.relayPerInput * primaries.length + K.ioPerMbps * (inKbps / 1000),
      memoryMib: K.memPerRelay * primaries.length,
    }, 'ingest'));
    if (backups.length) {
      lines.push(line(`relay ${backups.length} backup rendition${backups.length === 1 ? '' : 's'} in (always running)`, {
        netInBps: kbpsToBps(bkKbps), cpuUnits: K.relayPerInput * backups.length + K.ioPerMbps * (bkKbps / 1000),
        memoryMib: K.memPerRelay * backups.length,
      }, 'ingest'));
    }
    outKbps = inKbps;
    if (job.watermark) notes.push('Package-only channels pass the source through untouched, so the watermark is not burned in. Use a transcode profile to burn it in.');
  }

  const outTotalKbps = (outKbps + K.audioKbps * audioTracks) * K.muxOverhead;
  lines.push(line('package + upload to origin', {
    cpuUnits: K.packagerBase + K.ioPerMbps * (outTotalKbps / 1000),
    memoryMib: K.memBase,
    netOutBps: kbpsToBps(outTotalKbps),
  }, 'package'));
  if (job.graphics_burn && workflow === 'transcode') {
    lines.push(line('graphics burned into the picture (renderer + one composite)', { cpuUnits: K.gfxRendererCpu, memoryMib: K.memGfxRenderer }, 'graphics'));
  }
  if (job.drm) lines.push(line('DRM encryption', { cpuUnits: K.drmPerMbps * (outTotalKbps / 1000), memoryMib: 16 }, 'drm'));
  if (job.captions?.enabled && job.captions.engine === 'gladia') {
    lines.push(line('live captions (Gladia, in the cloud)', { cpuUnits: K.gladia, memoryMib: K.memGladia, netOutBps: kbpsToBps(K.gladiaUpKbps) }, 'captions:gladia'));
  }
  if (job.captions?.enabled && job.captions.engine === 'whisper' && job.captions.in_encoder) {
    // faster-whisper int8 on CPU (captionsPlan.ts CPU_WHISPER_SIZES), plus NLLB
    // on CPU when a target is neither English nor the source language.
    const size = job.captions.model_size === 'base' ? 'base' : 'tiny';
    const src = job.captions.source_lang && job.captions.source_lang !== 'auto' ? job.captions.source_lang : 'en';
    const mt = (job.captions.targets ?? []).some((t: string) => t !== 'en' && t !== src);
    lines.push(line(`live captions (Whisper ${size} on CPU${mt ? ' + translation' : ''})`, {
      cpuUnits: K.whisperCpu[size] + (mt ? K.nllbCpu : 0),
      memoryMib: K.memWhisperCpu[size] + (mt ? K.memNllbCpu : 0),
    }, 'captions:whisper-cpu'));
  }

  const load = total(lines, gpus);
  return {
    taskKind: workflow, load, reservation: reserve(load), needsGpu,
    signature: encoderSignature(job), basis: 'estimate', lines, notes,
    // The packaged output is what lands on the task disk and in S3; the
    // Gladia upstream is not stored, so it is left out on purpose.
    storage: projectStorage(outTotalKbps, job.recording?.retention_sec ?? null),
  };
}

/** The Whisper add-on runs as its own GPU task (captionsPlan.ts sizes its VRAM). */
export function estimateWhisperLoad(plan: { estVramGb: number; needsMt: boolean; modelSize: string | null }): LoadEstimate {
  const lines = [
    line(`Whisper ${plan.modelSize ?? 'small'}${plan.needsMt ? ' + translation' : ''} (GPU)`, {
      cpuUnits: 768, memoryMib: 2048 + plan.estVramGb * 256, gpuShare: 0.5, netInBps: kbpsToBps(160), netOutBps: kbpsToBps(16),
    }, 'captions:whisper-gpu'),
  ];
  const load = total(lines, 1);
  return {
    taskKind: 'captions', load, reservation: reserve(load), needsGpu: true,
    signature: `captions|whisper|${plan.modelSize ?? 'small'}|${plan.needsMt ? 'mt' : 'nomt'}`,
    // Subtitle segments only: a few kbps, written next to the video output.
    basis: 'estimate', lines, notes: [], storage: projectStorage(16),
  };
}

/** Radio: one audio source, a few audio-only outputs. Tiny next to video. */
export function estimateRadioLoad(job: Record<string, any>): LoadEstimate {
  const kbps = Number(job.bitrate_kbps) || 128;
  const outs = job.outputs ?? {};
  const n = ['hls', 'dash', 'mp3'].filter((k) => outs[k]).length || 1;
  const lines = [
    line('audio source in', { netInBps: kbpsToBps(Math.max(kbps, 256)), cpuUnits: 40 }, 'radio'),
    line(`${n} audio output${n > 1 ? 's' : ''} at ${kbps} kbps`, {
      cpuUnits: 60 * n, memoryMib: 192 + 32 * n, netOutBps: kbpsToBps(kbps * n * K.muxOverhead),
    }, 'radio'),
  ];
  const load = total(lines, 0);
  return {
    taskKind: 'radio', load, reservation: reserve(load), needsGpu: false,
    signature: `radio|${kbps}|${n}`, basis: 'estimate', lines, notes: [],
    // Each segmented output (HLS, DASH) is written and uploaded; the MP3 mount is a live relay, not stored.
    storage: projectStorage(kbps * K.muxOverhead * ['hls', 'dash'].filter((k) => outs[k]).length, job.recording?.retention_sec ?? null),
  };
}

/**
 * Streams with the same signature cost the same to run. Built from the job,
 * not from names or ids, so two channels with identical settings share a
 * history and a channel whose ladder changes starts a new one.
 */
export function encoderSignature(job: Record<string, any>): string {
  const ladder = (job.ladder ?? []).map((r: any) => `${r.height}:${r.bitrate_kbps}`).join(',');
  const inputs = (job.inputs ?? []).map((i: any) => `${i.role === 'backup' ? 'b' : 'p'}${i.bitrate_kbps ?? ''}`).join(',');
  return [
    job.workflow === 'package_only' ? 'pkg' : 'tx', job.gpu ? 'gpu' : 'cpu', `fps${job.fps ?? ''}`,
    ladder || inputs, job.watermark ? 'wm' : '', job.captions?.enabled ? `cc-${job.captions.engine}` : '', job.drm ? 'drm' : '',
    // Appended only when on, so every existing signature (and its history) is unchanged.
    ...(job.graphics_burn ? ['gfx'] : []),
  ].join('|');
}

export interface ObservedHistory {
  /** p95 CPU units this signature actually used, across finished and running runs. */
  cpuUnitsP95: number;
  memoryMibP95: number | null;
  netBpsP95: number | null;
  runs: number;
  hours: number;
}

/**
 * Replace the estimate with what the fleet actually saw, once there is enough
 * of it (3 runs and 2 hours by default). Never trusts history to shrink a
 * stream below half its estimate, because a run that idled on slate for an
 * hour would otherwise teach the model that a full ladder costs nothing.
 */
export function calibrate(est: LoadEstimate, hist: ObservedHistory | null, opts = { minRuns: 3, minHours: 2 }): LoadEstimate {
  if (!hist || hist.runs < opts.minRuns || hist.hours < opts.minHours) return est;
  const cpu = Math.max(Math.round(hist.cpuUnitsP95), Math.round(est.load.cpuUnits * 0.5));
  const mem = hist.memoryMibP95 != null ? Math.max(Math.round(hist.memoryMibP95), Math.round(est.load.memoryMib * 0.5)) : est.load.memoryMib;
  let { netInBps, netOutBps } = est.load;
  if (hist.netBpsP95 != null) {
    const estNet = netInBps + netOutBps || 1;
    const k = Math.max(hist.netBpsP95 / estNet, 0.5);
    netInBps = Math.round(netInBps * k); netOutBps = Math.round(netOutBps * k);
  }
  const load: StreamLoad = { ...est.load, cpuUnits: cpu, memoryMib: mem, netInBps, netOutBps };
  return { ...est, load, reservation: reserve(load), basis: 'observed' };
}

/**
 * The one sentence a customer sees. No CPU units, no instance types: whether
 * it is sized, roughly what drives the size, and anything about their
 * settings that did not apply the way they might expect.
 */
export function describeForPeople(est: LoadEstimate): string {
  const what = est.taskKind === 'package_only'
    ? 'Your renditions are passed through and packaged, which is light on processing.'
    : est.taskKind === 'radio'
      ? 'Audio only, which needs very little server capacity.'
      : est.needsGpu
        ? 'Your ladder is encoded on a GPU server.'
        : 'Your ladder is encoded on a shared server sized for it.';
  return [what, 'Server capacity is assigned and managed automatically.', ...est.notes].join(' ');
}
