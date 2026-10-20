/**
 * Captions provisioning plan.
 *
 * The control plane must NOT carry the caption model weight (faster-whisper +
 * NLLB, ~1.2GB+ and a GPU) on every encoder. This resolver decides, per stream,
 * whether captions run at all and HOW they are hosted, so the base encoder image
 * stays lean and the heavy Whisper runtime is pulled in only when a channel/event
 * is actually created with transcription enabled and target languages selected.
 *
 * Three outcomes:
 *   • none    — captions off (account provider 'none', or profile not enabled).
 *               Nothing launched, no weight, no GPU.
 *   • gladia  — a THIN sidecar inside the encoder task (just a websocket client;
 *               no model, no GPU). Gladia does STT+MT in the cloud, so the account
 *               needs no Whisper setup at all. Rides the encoder task's sizing.
 *   • whisper — a SEPARATE add-on task (its own image `volt-captions`, its own GPU
 *               sizing, its own lifecycle) launched alongside the encoder ONLY for
 *               this stream. The orchestrator tracks it as an `instances` row
 *               (role='captions') so it counts in projected-instances and cost.
 *
 *   • whisper on CPU, in the encoder (20 Oct 2026) — tiny and base are small
 *               enough to run beside the packager on CPU (faster-whisper int8,
 *               NLLB on CPU when a non-English target needs it), so no GPU task
 *               is launched. Needs an encoder image built with CAPTIONS_CPU=true
 *               (and CAPTIONS_MT=true for NLLB), announced to the control plane
 *               by CAPTIONS_CPU_IN_ENCODER=true. Off by default: an image without
 *               the stack would fail every window.
 *
 * Pure and unit-tested (test/captions-plan.check.ts).
 */

export type CaptionsMode = 'none' | 'gladia' | 'whisper';

export interface CaptionsPlanInput {
  /** account master toggle: none|whisper|gladia */
  accountProvider?: 'none' | 'whisper' | 'gladia' | null;
  captionsEnabled?: boolean;
  sourceLang?: string;          // 'auto' or an ISO code
  targets?: string[];           // e.g. ['en','ms','zh','ta']
  modelSize?: string;           // whisper size: tiny|base|small|medium|large-v3
  /** The encoder image carries the CPU caption stack (CAPTIONS_CPU_IN_ENCODER). */
  cpuInEncoder?: boolean;
}

/** Whisper sizes that keep up with live on CPU beside the packager. */
export const CPU_WHISPER_SIZES = ['tiny', 'base'] as const;

export interface CaptionsPlan {
  mode: CaptionsMode;
  enabled: boolean;
  /** true only for whisper: a dedicated task the orchestrator launches + tears down. */
  runsSeparateTask: boolean;
  /** Transcribed inside the encoder task (gladia always, whisper tiny/base on CPU). */
  inEncoder: boolean;
  needsGpu: boolean;
  /** any non-English target => a downstream NLLB MT model is needed on top of Whisper. */
  needsMt: boolean;
  sourceLang: string;
  targets: string[];
  modelSize: string | null;
  /** container image the add-on task runs (whisper only). */
  image: string | null;
  /** rough VRAM footprint to size the GPU; 0 when no GPU. */
  estVramGb: number;
  /** a sensible default AWS GPU instance family for this footprint (whisper only). */
  instanceType: string | null;
}

/**
 * VRAM + instance sizing for the Whisper add-on. faster-whisper (CTranslate2,
 * int8) is far lighter than reference Whisper; NLLB-200 distilled adds ~2GB only
 * when a non-English target is requested. Numbers are deliberately conservative
 * (headroom for the audio buffer + batching).
 */
export function sizeWhisper(modelSize: string, needsMt: boolean): { vramGb: number; instanceType: string } {
  const whisperVram: Record<string, number> = {
    tiny: 1, base: 1.5, small: 2.5, medium: 5, 'large-v3': 6, large: 6,
  };
  const wv = whisperVram[modelSize] ?? 2.5;      // default to 'small'
  const mt = needsMt ? 2 : 0;                     // NLLB-200 distilled-600M, int8/fp16
  const vramGb = wv + mt;
  // T4 (g4dn, 16GB) covers everything up to large-v3+MT; only reach for A10G (g5)
  // if you later move to a bigger MT model or heavy batching.
  const instanceType = vramGb <= 14 ? 'g4dn.xlarge' : 'g5.xlarge';
  return { vramGb, instanceType };
}

export function resolveCaptionsPlan(inp: CaptionsPlanInput): CaptionsPlan {
  const provider = inp.accountProvider ?? 'none';
  const off: CaptionsPlan = {
    mode: 'none', enabled: false, runsSeparateTask: false, inEncoder: false, needsGpu: false,
    needsMt: false, sourceLang: inp.sourceLang ?? 'auto', targets: [], modelSize: null,
    image: null, estVramGb: 0, instanceType: null,
  };
  if (provider === 'none' || !inp.captionsEnabled) return off;

  const sourceLang = inp.sourceLang ?? 'auto';
  const targets = inp.targets ?? [];
  // a non-English target needs the NLLB MT stage; 'en' targets use Whisper's own
  // translate task and need no extra model.
  const srcForMt = sourceLang && sourceLang !== 'auto' ? sourceLang : 'en';
  const needsMt = targets.some((t) => t !== 'en' && t !== srcForMt);

  if (provider === 'gladia') {
    // thin sidecar, no model, no GPU, no separate task
    return {
      mode: 'gladia', enabled: true, runsSeparateTask: false, inEncoder: true, needsGpu: false,
      needsMt, sourceLang, targets, modelSize: null, image: null, estVramGb: 0, instanceType: null,
    };
  }

  const modelSize = inp.modelSize ?? 'small';
  // whisper tiny/base on CPU inside the encoder, when its image has the stack
  if (inp.cpuInEncoder && (CPU_WHISPER_SIZES as readonly string[]).includes(modelSize)) {
    return {
      mode: 'whisper', enabled: true, runsSeparateTask: false, inEncoder: true, needsGpu: false,
      needsMt, sourceLang, targets, modelSize, image: null, estVramGb: 0, instanceType: null,
    };
  }

  // whisper: dedicated add-on task, own image + GPU sizing
  const { vramGb, instanceType } = sizeWhisper(modelSize, needsMt);
  return {
    mode: 'whisper', enabled: true, runsSeparateTask: true, inEncoder: false, needsGpu: true,
    needsMt, sourceLang, targets, modelSize, image: 'volt-captions',
    estVramGb: vramGb, instanceType,
  };
}

/**
 * The job config handed to the separate `volt-captions` task. The encoder exposes
 * an audio tap (an audio-only rendition on the S3 origin, or an SRT/RTP audio
 * relay) that this task consumes; it writes WebVTT renditions back to the same
 * origin prefix the packager uses, so players pick them up as subtitle tracks.
 */
export function buildCaptionsJobConfig(streamId: string, plan: CaptionsPlan, audioSource: string, offsetSec: number, s3Prefix: string): Record<string, any> {
  return {
    stream_id: streamId,
    engine: plan.mode,                 // 'whisper'
    audio_source: audioSource,
    source_lang: plan.sourceLang,
    targets: plan.targets,
    offset_sec: offsetSec,
    model_size: plan.modelSize,
    needs_mt: plan.needsMt,
    out_prefix: s3Prefix,              // WebVTT renditions land here
  };
}
