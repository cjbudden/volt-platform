// ============================================================================
//  WHICH FRAME REPRESENTS A VIDEO BEST.
//
//  No model, no faces: plain image measures that separate "a good still" from
//  the frames people complain about, and that run in milliseconds per frame
//  on a 160×90 sample:
//
//    exposure       black, white and fade frames are rejected outright
//    contrast       a flat slate or a single-colour card is rejected
//    sharpness      variance of the Laplacian: motion blur and soft focus lose
//    colourfulness  Hasler and Süsstrunk's measure: a grey studio wall loses
//                   to the presenter in a red jacket
//    detail         histogram entropy: busy, informative frames win
//    test patterns  colour bars: every column the same top to bottom
//    position       the first and last few percent are idents, slates and
//                   credits, so they are discounted, not banned
//
//  Each candidate gets a 0..100 score and the notes that explain it, so the
//  console can say why a frame won ("sharpest well-exposed of 12") and why
//  others did not ("too dark", "colour bars").
//  PURE apart from decoding the image with sharp.
// ============================================================================
import sharp from 'sharp';

export interface FrameStats {
  mean: number;          // luma 0..1
  stdev: number;         // luma 0..1
  sharpness: number;     // Laplacian variance on 0..255 luma
  colourfulness: number; // Hasler-Süsstrunk on 0..1 RGB
  entropy: number;       // bits, 64-bin luma histogram (max 6)
  columnUniformity: number; // 0..1, 1 = every column is one colour top to bottom
}
export interface FrameScore { score: number; notes: string[]; rejected?: string }

const W = 160, H = 90;

export async function frameStats(img: Buffer): Promise<FrameStats> {
  const { data } = await sharp(img).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = W * H;
  const luma = new Float32Array(n);
  let sum = 0, rgSum = 0, ybSum = 0;
  const rgs = new Float32Array(n), ybs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = y; sum += y;
    const rg = (r - g) / 255, yb = (0.5 * (r + g) - b) / 255;
    rgs[i] = rg; ybs[i] = yb; rgSum += rg; ybSum += yb;
  }
  const mean = sum / n;
  let v = 0, rgV = 0, ybV = 0;
  const hist = new Array(64).fill(0);
  for (let i = 0; i < n; i++) {
    v += (luma[i] - mean) ** 2;
    rgV += (rgs[i] - rgSum / n) ** 2; ybV += (ybs[i] - ybSum / n) ** 2;
    hist[Math.min(63, Math.floor(luma[i] / 4))]++;
  }
  const stdev = Math.sqrt(v / n);
  let lap = 0, lapSum = 0; const laps: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const l = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - W] - luma[i + W];
    laps.push(l); lapSum += l;
  }
  const lm = lapSum / laps.length; for (const l of laps) lap += (l - lm) ** 2;
  let ent = 0; for (const c of hist) if (c) { const p = c / n; ent -= p * Math.log2(p); }
  // Colour bars and plain cards: how much of the picture's variation is
  // within columns rather than across them. Measured on the top two thirds,
  // where SMPTE bars are columns (the bottom third is the castellations).
  let within = 0; const top = Math.floor(H * 2 / 3);
  for (let x = 0; x < W; x++) {
    let cs = 0; for (let y = 0; y < top; y++) cs += luma[y * W + x];
    const cm = cs / top; for (let y = 0; y < top; y++) within += (luma[y * W + x] - cm) ** 2;
  }
  const withinSd = Math.sqrt(within / (W * top));
  const sdRg = Math.sqrt(rgV / n), sdYb = Math.sqrt(ybV / n);
  const colourfulness = Math.sqrt(sdRg ** 2 + sdYb ** 2) + 0.3 * Math.sqrt((rgSum / n) ** 2 + (ybSum / n) ** 2);
  return {
    mean: mean / 255, stdev: stdev / 255, sharpness: lap / laps.length, colourfulness, entropy: ent,
    columnUniformity: stdev > 1 ? Math.max(0, 1 - withinSd / stdev) : 1,
  };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Score one frame. `at` is its position in the asset, 0..1, when known. */
export function scoreFrame(s: FrameStats, at?: number | null): FrameScore {
  const notes: string[] = [];
  if (s.mean < 0.06) return { score: 0, notes: ['black'], rejected: 'black' };
  if (s.mean > 0.96) return { score: 0, notes: ['white'], rejected: 'white' };
  if (s.stdev < 0.035) return { score: 0, notes: ['a flat card'], rejected: 'flat' };
  if (s.columnUniformity > 0.93 && s.colourfulness > 0.25) return { score: 0, notes: ['colour bars'], rejected: 'bars' };
  // Log scale between a soft frame (~20) and a crisp one (~1500) on the 160×90 sample.
  const sharp = clamp((Math.log(Math.max(1, s.sharpness)) - Math.log(20)) / (Math.log(1500) - Math.log(20)));
  const contrast = clamp(s.stdev / 0.25);
  const colour = clamp(s.colourfulness / 0.45);
  const detail = clamp(s.entropy / 5.6);
  let score = 100 * (0.45 * sharp + 0.2 * contrast + 0.15 * colour + 0.2 * detail);
  if (s.mean < 0.18) { score *= 0.7; notes.push('dark'); }
  else if (s.mean > 0.85) { score *= 0.75; notes.push('very bright'); }
  if (sharp < 0.35) notes.push('soft'); else if (sharp > 0.8) notes.push('sharp');
  if (colour > 0.7) notes.push('colourful');
  if (at != null) {
    if (at < 0.03 || at > 0.97) { score *= 0.6; notes.push(at < 0.5 ? 'at the very start' : 'at the very end'); }
    else if (at < 0.08 || at > 0.92) score *= 0.85;
  }
  return { score: Math.round(score), notes };
}

export interface Candidate { key: string; atMs?: number | null; origin: 'ingest' | 'live'; score?: number; notes?: string[]; rejected?: string }

/** The winner and a sentence about it. Candidates come back scored, best first. */
export function pickFrame(cands: Candidate[]): { best: Candidate | null; reason: string; ranked: Candidate[] } {
  const ranked = [...cands].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const ok = ranked.filter((c) => !c.rejected && (c.score ?? 0) > 0);
  if (!ok.length) return { best: null, reason: cands.length ? `None of the ${cands.length} frames was usable (${summarise(cands)}).` : 'No frames to choose from.', ranked };
  const best = ok[0];
  const rej = cands.filter((c) => c.rejected);
  const at = best.atMs != null ? ` at ${clock(best.atMs)}` : '';
  const why = best.notes?.length ? ` (${best.notes.join(', ')})` : '';
  return { best, reason: `Best of ${cands.length} frames${at}${why}${rej.length ? `; skipped ${summarise(rej)}` : ''}.`, ranked };
}

function summarise(cs: Candidate[]): string {
  const m = new Map<string, number>();
  for (const c of cs) if (c.rejected) m.set(c.rejected, (m.get(c.rejected) ?? 0) + 1);
  return [...m].map(([k, n]) => `${n} ${k}`).join(', ') || 'no reason';
}
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}
