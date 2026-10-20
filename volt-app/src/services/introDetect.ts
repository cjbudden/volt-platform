// ============================================================================
//  INTRO AND CREDITS DETECTION, by comparing episodes of the same series.
//
//  WHY ACROSS EPISODES. There is no reliable way to find an intro inside one
//  programme on its own: black frames, silence and music changes all fire on
//  ordinary scenes. What an intro IS, though, is the same audio (the theme and
//  titles) in every episode, at whatever point each episode puts it. So two
//  episodes are fingerprinted (Chromaprint, through ffmpeg's own `chromaprint`
//  muxer: no extra tool) and the longest stretch they share is the intro. The
//  same comparison over the last minutes finds the end credits.
//
//  A fingerprint is one 32-bit value per ~0.124 s of audio. Matching audio
//  gives values that differ in only a few bits even after a re-encode, a level
//  change or a different sample rate, so:
//    1. candidate alignments (shifts) come from values the two share exactly,
//       which even a lossy copy has enough of;
//    2. along each shift, an item matches when its values differ in at most
//       MAX_BITS bits;
//    3. the answer is the longest run of matches (short gaps bridged), which
//       must last between the minimum and maximum a real intro lasts.
//  With several episodes each one is compared with up to four others, and the
//  interval most of them agree on wins; agreement is the confidence.
//
//  Pure apart from fingerprint(), which runs ffmpeg. Checked by
//  test/intro-detect.check.ts against real audio.
// ============================================================================
import { spawn } from 'node:child_process';

/** Seconds of audio per fingerprint value (Chromaprint's default: 4096/3 samples at 11025 Hz). */
export const ITEM_SEC = 4096 / 3 / 11025;
const MAX_BITS = 10;          // of 32: matching audio differs in a few; unrelated audio in ~16
const MAX_GAP_SEC = 3.5;      // a few unmatched items inside a run (a sting, a dropout) are bridged
/**
 * A value describes audio slightly AFTER its index time (Chromaprint's frames
 * and filters reach forward), so a match read straight off the indices comes
 * out early. Measured on real encodes: 0.6-0.9 s early at both ends, same for
 * every position and episode. Corrected here, once.
 */
const ALIGN_SEC = 0.7;

export interface MatchRange { aStart: number; aEnd: number; bStart: number; bEnd: number; score: number }
export interface Interval { start: number; end: number }

export interface DetectOptions {
  /** Shortest and longest run that counts. Intros: 10-150 s. Credits: 15-420 s. */
  minSec?: number;
  maxSec?: number;
}

const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** The alignments worth trying: b index = a index - shift. Most-supported first. */
export function candidateShifts(a: Uint32Array, b: Uint32Array, max = 12): number[] {
  const where = new Map<number, number[]>();
  for (let j = 0; j < b.length; j++) {
    const l = where.get(b[j]);
    if (l) { if (l.length < 16) l.push(j); } else where.set(b[j], [j]);
  }
  const votes = new Map<number, number>();
  for (let i = 0; i < a.length; i++) {
    const l = where.get(a[i]);
    if (!l) continue;
    for (const j of l) { const s = i - j; votes.set(s, (votes.get(s) ?? 0) + 1); }
  }
  // Neighbouring shifts are the same alignment give or take an item: pool them.
  const pooled = new Map<number, number>();
  for (const [s, v] of votes) {
    let sum = v;
    for (const d of [-2, -1, 1, 2]) sum += (votes.get(s + d) ?? 0) * 0.5;
    pooled.set(s, sum);
  }
  const picked: number[] = [];
  for (const [s] of [...pooled].sort((x, y) => y[1] - x[1])) {
    if (picked.some((p) => Math.abs(p - s) <= 3)) continue;
    picked.push(s);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * The longest matching run of a and b at one shift, or null.
 *
 * DENSITY, NOT ADJACENCY. Unrelated audio still throws up the odd close value
 * (more so for tonal beds and silence), and bridging gaps between those chained
 * a real 40 s intro into a 110 s "match". So an item counts only where the
 * matches around it are dense: at least DENSITY of a ~2 s window. Runs of dense
 * items are bridged across short gaps, then trimmed to their first and last
 * real match.
 */
const WINDOW = 16;            // ~2 s
const DENSITY = 0.6;
export function runAt(a: Uint32Array, b: Uint32Array, shift: number, opt: DetectOptions = {}): MatchRange | null {
  const minItems = Math.round((opt.minSec ?? 10) / ITEM_SEC);
  const maxItems = Math.round((opt.maxSec ?? 150) / ITEM_SEC);
  const gap = Math.round(MAX_GAP_SEC / ITEM_SEC);
  const lo = Math.max(0, shift), hi = Math.min(a.length, b.length + shift);
  if (hi - lo < minItems) return null;
  const n = hi - lo;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = popcount(a[lo + i] ^ b[lo + i - shift]) <= MAX_BITS ? 1 : 0;
  // centred moving density
  const pre = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + m[i];
  const half = WINDOW >> 1;
  const dense = (i: number) => {
    const s0 = Math.max(0, i - half), e0 = Math.min(n, i + half);
    return (pre[e0] - pre[s0]) / (e0 - s0) >= DENSITY;
  };
  let best: { s: number; e: number } | null = null;
  let s = -1, last = -1;
  const close = () => {
    if (s < 0) return;
    // trim to the real matches at the edges
    let s1 = s, e1 = last;
    while (s1 < e1 && !m[s1]) s1++;
    while (e1 > s1 && !m[e1]) e1--;
    if (e1 + 1 - s1 >= minItems && (!best || e1 + 1 - s1 > best.e - best.s)) best = { s: s1, e: e1 + 1 };
  };
  for (let i = 0; i < n; i++) {
    if (dense(i)) {
      if (s < 0 || i - last > gap) { close(); s = i; }
      last = i;
    }
  }
  close();
  if (!best) return null;
  const r = best as { s: number; e: number };
  if (r.e - r.s > maxItems) return null;   // longer than any intro: the same programme twice, not an intro
  const hits = pre[r.e] - pre[r.s];
  return {
    aStart: (lo + r.s) * ITEM_SEC + ALIGN_SEC, aEnd: (lo + r.e) * ITEM_SEC + ALIGN_SEC,
    bStart: (lo + r.s - shift) * ITEM_SEC + ALIGN_SEC, bEnd: (lo + r.e - shift) * ITEM_SEC + ALIGN_SEC,
    score: hits / (r.e - r.s),
  };
}

/** The best shared stretch of two fingerprints, or null when they share none. */
export function compare(a: Uint32Array, b: Uint32Array, opt: DetectOptions = {}): MatchRange | null {
  let best: MatchRange | null = null;
  for (const sh of candidateShifts(a, b)) {
    const r = runAt(a, b, sh, opt);
    if (r && (!best || (r.aEnd - r.aStart) * r.score > (best.aEnd - best.aStart) * best.score)) best = r;
  }
  return best;
}

export interface EpisodeResult { id: string; interval: Interval | null; confidence: number; comparedWith: number; agreed: number }

/**
 * Each episode against up to `peers` others. An episode's answer is the interval
 * the most comparisons agree on (within `toleranceSec` at both ends); its
 * confidence is the share of comparisons that agree. One other episode is
 * enough to find an intro; more make a wrong one unlikely.
 */
export function detectAcross(eps: Array<{ id: string; fp: Uint32Array; offsetSec?: number }>, opt: DetectOptions & { peers?: number; toleranceSec?: number } = {}): EpisodeResult[] {
  const peers = opt.peers ?? 4, tol = opt.toleranceSec ?? 2;
  const found = new Map<string, Interval[]>();
  const tries = new Map<string, number>();
  const add = (id: string, iv: Interval) => { const l = found.get(id) ?? []; l.push(iv); found.set(id, l); };
  for (let i = 0; i < eps.length; i++) {
    for (let k = 1; k <= Math.min(peers, eps.length - 1); k++) {
      const j = (i + k) % eps.length;
      if (j < i && eps.length - 1 <= peers) continue;      // each pair once when everyone meets everyone
      const A = eps[i], B = eps[j];
      tries.set(A.id, (tries.get(A.id) ?? 0) + 1); tries.set(B.id, (tries.get(B.id) ?? 0) + 1);
      const r = compare(A.fp, B.fp, opt);
      if (!r) continue;
      add(A.id, { start: r.aStart + (A.offsetSec ?? 0), end: r.aEnd + (A.offsetSec ?? 0) });
      add(B.id, { start: r.bStart + (B.offsetSec ?? 0), end: r.bEnd + (B.offsetSec ?? 0) });
    }
  }
  return eps.map((e) => {
    const l = found.get(e.id) ?? [];
    const n = tries.get(e.id) ?? 0;
    let best: Interval | null = null, agreed = 0;
    for (const c of l) {
      const near = l.filter((o) => Math.abs(o.start - c.start) <= tol && Math.abs(o.end - c.end) <= tol);
      if (near.length > agreed) {
        agreed = near.length;
        // the median of the agreeing ones, so one sloppy edge does not set the answer
        const st = near.map((o) => o.start).sort((x, y) => x - y), en = near.map((o) => o.end).sort((x, y) => x - y);
        best = { start: st[Math.floor(st.length / 2)], end: en[Math.floor(en.length / 2)] };
      }
    }
    return { id: e.id, interval: best, confidence: n ? agreed / n : 0, comparedWith: n, agreed };
  });
}

/** Little-endian uint32 values from ffmpeg's raw fingerprint output. */
export function decodeRaw(buf: Buffer): Uint32Array {
  const n = Math.floor(buf.length / 4), out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

/**
 * Fingerprint part of a file or URL with ffmpeg's chromaprint muxer.
 * `fromSec` and `durSec` pick the window: the opening minutes for an intro, the
 * closing minutes for credits. Audio only, so a 10-minute window takes seconds.
 */
export function fingerprint(input: string, fromSec = 0, durSec = 600, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<Uint32Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (fromSec > 0) args.push('-ss', String(fromSec));
    args.push('-i', input, '-t', String(durSec), '-vn', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', '-');
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`fingerprint failed (${code}): ${err.trim().split('\n').pop() ?? ''}`));
      resolve(decodeRaw(Buffer.concat(out)));
    });
  });
}
