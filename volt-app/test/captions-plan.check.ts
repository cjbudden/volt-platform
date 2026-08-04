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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
