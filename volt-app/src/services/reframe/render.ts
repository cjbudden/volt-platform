// ============================================================================
//  REFRAME RENDER: one ffmpeg pass per format, following the framing path.
//
//  The crop position is an EXPRESSION OF TIME that ffmpeg evaluates for every
//  frame: one term per keyframe span, the same hold, linear and smoothstep
//  (glide) easing the console preview uses (framing.ts sampleAt), so what the
//  operator approved is what is encoded. Shots on the blurred fill are drawn
//  from a second branch of the same graph and switched in by time, so a clip
//  that mixes both is still one decode and one encode.
//
//  buildRenderArgs is PURE (tested); runRender spawns ffmpeg and reports
//  progress from `-progress pipe:1`.
// ============================================================================
import { spawn } from 'node:child_process';
import { FORMATS, type FormatKey } from './formats';
import type { Key } from './framing';

const n4 = (v: number) => (Math.round(v * 10000) / 10000).toString();
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * A piecewise function of t built from keys. `px` turns a key into the value
 * (pixels) at that key. Before the first key the first value holds; after the
 * last, the last.
 */
export function pieceExpr(keys: Key[], px: (k: Key) => number): string {
  if (!keys.length) return '0';
  const v = keys.map(px);
  if (v.every((x) => x === v[0])) return String(v[0]);
  const terms: string[] = [`lt(t,${n4(keys[0].t)})*${v[0]}`];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], t0 = n4(k.t);
    if (i === keys.length - 1) { terms.push(`gte(t,${t0})*${v[i]}`); break; }
    const t1 = n4(keys[i + 1].t);
    const d = Math.max(1e-3, keys[i + 1].t - k.t);
    let body: string;
    if (k.ease === 'hold' || v[i + 1] === v[i]) body = String(v[i]);
    else {
      const p = `((t-${t0})/${n4(d)})`;
      const shaped = k.ease === 'glide' ? `(${p}*${p}*(3-2*${p}))` : p;
      body = `(${v[i]}+${v[i + 1] - v[i]}*${shaped})`;
    }
    terms.push(`gte(t,${t0})*lt(t,${t1})*${body}`);
  }
  return terms.join('+');
}

/** `between` spans (seconds) where the path shows the whole picture on the blurred fill. */
export function fillSpans(keys: Key[], duration: number): [number, number][] {
  const out: [number, number][] = [];
  keys.forEach((k, i) => {
    if (k.mode !== 'fill') return;
    const end = i + 1 < keys.length ? keys[i + 1].t : Math.max(duration, k.t + 0.001);
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - k.t) < 1e-6) last[1] = end; else out.push([k.t, end]);
  });
  return out;
}

export interface RenderSpec {
  input: string;
  output: string;
  format: FormatKey;
  keys: Key[];
  srcW: number;
  srcH: number;
  duration: number;
  /** x264 preset: veryfast by default (social files, not mezzanine). */
  preset?: string;
  ffmpegBin?: string;
}

export function buildRenderArgs(s: RenderSpec): { bin: string; args: string[]; graph: string; crop: { w: number; h: number }; out: { w: number; h: number } } {
  const F = FORMATS[s.format];
  const OW = F.width, OH = F.height;
  const k0 = s.keys[0];
  const cw = Math.min(s.srcW, even((k0?.w ?? 1) * s.srcW));
  const ch = Math.min(s.srcH, even((k0?.h ?? 1) * s.srcH));
  const xOf = (k: Key) => Math.round(Math.max(0, Math.min(s.srcW - cw, k.cx * s.srcW - cw / 2)));
  const yOf = (k: Key) => Math.round(Math.max(0, Math.min(s.srcH - ch, k.cy * s.srcH - ch / 2)));
  const cropKeys = s.keys.length ? s.keys : [{ t: 0, cx: 0.5, cy: 0.5, w: 1, h: 1, ease: 'hold', mode: 'crop', shot: 0 } as Key];
  const crop = `crop=w=${cw}:h=${ch}:x='${pieceExpr(cropKeys, xOf)}':y='${pieceExpr(cropKeys, yOf)}',scale=${OW}:${OH}:flags=bicubic,setsar=1`;
  const spans = fillSpans(cropKeys, s.duration);
  let graph: string;
  if (!spans.length) {
    graph = `[0:v]${crop},format=yuv420p[v]`;
  } else if (spans.length === 1 && spans[0][0] <= 1e-3 && spans[0][1] >= s.duration - 1e-3) {
    graph = `[0:v]split=2[s1][s2];` +
      `[s1]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},boxblur=luma_radius=40:luma_power=2,eq=brightness=-0.06[bg];` +
      `[s2]scale=${OW}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`;
  } else {
    const enable = spans.map(([a, b]) => `between(t,${n4(a)},${n4(b - 0.0005)})`).join('+');
    graph = `[0:v]split=3[s0][s1][s2];[s0]${crop}[c];` +
      `[s1]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},boxblur=luma_radius=40:luma_power=2,eq=brightness=-0.06[bg];` +
      `[s2]scale=${OW}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[f];` +
      `[c][f]overlay=0:0:enable='${enable}',format=yuv420p[v]`;
  }
  const args = ['-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-i', s.input,
    '-filter_complex', graph, '-map', '[v]', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', s.preset ?? 'veryfast', '-crf', '21', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', s.output];
  return { bin: s.ffmpegBin ?? 'ffmpeg', args, graph, crop: { w: cw, h: ch }, out: { w: OW, h: OH } };
}

/** Run it. Resolves with ffmpeg's last error lines when it fails. */
export function runRender(cmd: { bin: string; args: string[] }, duration: number, onProgress: (pct: number) => void,
  isCancelled: () => boolean = () => false): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd.bin, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', last = -1;
    const timer = setInterval(() => { if (isCancelled()) p.kill('SIGTERM'); }, 1000);
    p.stdout.on('data', (b) => {
      const m = String(b).match(/out_time_(?:ms|us)=(\d+)/g);
      if (!m || !duration) return;
      const us = Number(m[m.length - 1].split('=')[1]);
      const pct = Math.max(0, Math.min(99, Math.floor((us / 1e6 / duration) * 100)));
      if (pct > last) { last = pct; onProgress(pct); }
    });
    p.stderr.on('data', (b) => { err = (err + String(b)).slice(-4000); });
    p.on('error', (e) => { clearInterval(timer); resolve({ ok: false, error: `ffmpeg could not start: ${e.message}` }); });
    p.on('close', (code) => {
      clearInterval(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `ffmpeg exited ${code}` });
    });
  });
}
