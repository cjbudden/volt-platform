/**
 * Captions provisioning plan — decides whether a stream needs the heavy Whisper
 * add-on task, a thin Gladia sidecar, or nothing, and sizes the GPU. Pure.
 * Run: npx tsx test/captions-plan.check.ts
 */
import { resolveCaptionsPlan, sizeWhisper } from '../src/services/captionsPlan';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

// account off -> nothing, no weight
ok(resolveCaptionsPlan({ accountProvider: 'none', captionsEnabled: true, targets: ['ms'] }).mode === 'none',
   'account=none -> mode none (no task, no weight)');
// profile not enabled -> nothing even if account has a provider
ok(resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: false, targets: ['ms'] }).enabled === false,
   'profile captions disabled -> off');

// gladia -> thin sidecar, no separate task, no GPU
const g = resolveCaptionsPlan({ accountProvider: 'gladia', captionsEnabled: true, targets: ['ms', 'zh'] });
ok(g.mode === 'gladia' && !g.runsSeparateTask && !g.needsGpu && g.image === null,
   'gladia -> sidecar: no separate task, no GPU, no image weight');

// whisper, English-only target -> separate GPU task but NO MT model
const w1 = resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: true, sourceLang: 'ms', targets: ['en'] });
ok(w1.mode === 'whisper' && w1.runsSeparateTask && w1.needsGpu && w1.needsMt === false,
   'whisper en-only target -> separate GPU task, no MT (Whisper translates to English)');

// whisper with ms/zh/ta targets -> needs MT (NLLB), bigger VRAM
const w2 = resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: true, sourceLang: 'en', targets: ['en', 'ms', 'zh', 'ta'], modelSize: 'small' });
ok(w2.needsMt === true && w2.image === 'volt-captions', 'whisper + ms/zh/ta -> needsMt true, image volt-captions');
ok(w2.estVramGb > w1.estVramGb, 'MT stage adds VRAM footprint');
ok(w2.instanceType === 'g4dn.xlarge', 'small+MT fits a single T4 (g4dn.xlarge)');

// sizing: large-v3 + MT still fits a T4; sizing is monotonic
ok(sizeWhisper('large-v3', true).vramGb > sizeWhisper('tiny', false).vramGb, 'large-v3+MT > tiny');
ok(sizeWhisper('large-v3', true).instanceType === 'g4dn.xlarge', 'large-v3+MT still on g4dn (T4 16GB)');

// whisper tiny/base on CPU inside the encoder (20 Oct 2026), only when the image has the stack
const cpu = resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: true, sourceLang: 'en', targets: ['en', 'ms'], modelSize: 'base', cpuInEncoder: true });
ok(cpu.mode === 'whisper' && cpu.inEncoder && !cpu.runsSeparateTask && !cpu.needsGpu && cpu.image === null && cpu.estVramGb === 0,
   'whisper base + CPU stack in the encoder -> in the encoder, no GPU task');
ok(cpu.needsMt === true, '...and still says it needs NLLB for ms');
const noStack = resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: true, targets: ['en'], modelSize: 'tiny' });
ok(noStack.runsSeparateTask && !noStack.inEncoder, 'whisper tiny without the CPU stack -> the GPU add-on, as before');
const tooBig = resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: true, targets: ['en'], modelSize: 'small', cpuInEncoder: true });
ok(tooBig.runsSeparateTask && tooBig.needsGpu, 'whisper small is too heavy for CPU -> the GPU add-on even with the stack');
ok(resolveCaptionsPlan({ accountProvider: 'gladia', captionsEnabled: true, targets: ['en'] }).inEncoder, 'gladia runs in the encoder');

// the job config says where the words are produced, so the encoder never
// runs a second transcription beside the GPU add-on
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildEncoderJobConfig } = require('../src/services/jobConfig');
const { estimateEncoderLoad } = require('../src/services/fleet/streamLoad');
const { config } = require('../src/config');
const jbase: any = {
  kind: 'channel', owner: { id: 'ch1' }, account: { captions_provider: 'whisper' },
  inputs: [{ role: 'primary', rendition_label: null, rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://x', stream_key: null }],
  profile: { rungs: [{ height: 720, bitrate_kbps: 2500 }], packaging: 'both', workflow_type: 'transcode', codec_backend: 'x264', segment_dur: 4, dvr_window_sec: 60,
    captions_enabled: true, caption_source_lang: 'en', caption_targets: ['en', 'ms'], caption_offset_sec: 0, caption_model_size: 'base' },
};
(config.orchestrator as any).captionsCpuInEncoder = false;
const jGpu = buildEncoderJobConfig(jbase);
ok(jGpu.captions?.in_encoder === false && jGpu.captions?.model_size === 'base', 'GPU add-on plan: job says in_encoder false (the encoder only advertises tracks)');
ok(!estimateEncoderLoad(jGpu).lines.some((l: any) => /Whisper/.test(l.label ?? l.what ?? JSON.stringify(l))), '...and the encoder estimate carries no Whisper CPU');
(config.orchestrator as any).captionsCpuInEncoder = true;
const jCpu = buildEncoderJobConfig(jbase);
ok(jCpu.captions?.in_encoder === true, 'CPU plan: job says in_encoder true');
const est = estimateEncoderLoad(jCpu);
const wl = est.lines.find((l: any) => /Whisper base on CPU \+ translation/.test(JSON.stringify(l)));
ok(!!wl, '...and the encoder estimate reserves Whisper base + NLLB on CPU');
const jg = buildEncoderJobConfig({ ...jbase, account: { captions_provider: 'gladia' } });
ok(jg.captions?.in_encoder === true && jg.captions?.model_size === undefined, 'gladia job: in the encoder, no model size');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
