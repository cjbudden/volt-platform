// ============================================================================
//  WHICH FRAME REPRESENTS A VIDEO BEST.
//
//  Plain image measures that separate "a good still" from the frames people
//  complain about, run in milliseconds per frame on a 160×90 sample, and, when
//  the server has OpenCV, FACES (8 Nov 2026, Christian: too many hands and dark
//  frames were chosen while clear faces and scenes were never offered):
//
//    faces          a clear, lit, good-sized face beats any face-less frame
//                   (YuNet via volt-encoder/bin/frame_faces.py); a face in
//                   deep shadow counts for less; when a video has faces, its
//                   frames without one are marked down
//    exposure       black, white and fade frames are rejected outright, but a
//                   LOW-KEY frame (dark overall, with lit highlights such as a
//                   face in a pool of light) is only marked down, not called black;
//                   a well-exposed frame scores higher than a dim one
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
  /** Luma at the 98th percentile, 0..1: the frame's highlights. Low-key frames have them; black frames do not. */
  p98?: number;
  /** Faces found in the frame (frameFaces), when a detector ran. */
  faces?: FrameFaces | null;
}
/** What the face detector saw in one frame. Areas are fractions of the frame. */
export interface FrameFaces { count: number; largest: number; score: number; luma: number }
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
  let acc = 0, p98 = 0; for (let b = 0; b < 64; b++) { acc += hist[b]; if (acc >= 0.98 * n) { p98 = (b * 4 + 2) / 255; break; } }
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
    p98,
  };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Score one frame. `at` is its position in the asset, 0..1, when known. */
export function scoreFrame(s: FrameStats, at?: number | null): FrameScore {
  const notes: string[] = [];
  // BLACK means no picture, not a dark one: a low-key frame keeps its highlights.
  const highlights = s.p98 ?? s.mean;
  if (s.mean < 0.06 && highlights < 0.3 && !(s.faces?.count)) return { score: 0, notes: ['black'], rejected: 'black' };
  if (s.mean > 0.96) return { score: 0, notes: ['white'], rejected: 'white' };
  if (s.stdev < 0.035 && !(s.faces?.count)) return { score: 0, notes: ['a flat card'], rejected: 'flat' };
  if (s.columnUniformity > 0.93 && s.colourfulness > 0.25) return { score: 0, notes: ['colour bars'], rejected: 'bars' };
  // Log scale between a soft frame (~20) and a crisp one (~1500) on the 160×90 sample.
  const sharp = clamp((Math.log(Math.max(1, s.sharpness)) - Math.log(20)) / (Math.log(1500) - Math.log(20)));
  const contrast = clamp(s.stdev / 0.25);
  const colour = clamp(s.colourfulness / 0.45);
  const detail = clamp(s.entropy / 5.6);
  // How well exposed: best around a mid-grey average, falling off towards dark and bright.
  const exposure = clamp(1 - Math.abs(s.mean - 0.42) / 0.36);
  // Sharpness no longer dominates: a crisp close-up of hands used to beat a clear face.
  let score = 100 * (0.3 * sharp + 0.15 * contrast + 0.15 * colour + 0.15 * detail + 0.25 * exposure);
  if (s.mean < 0.06) { score *= 0.55; notes.push('low light'); }
  else if (s.mean < 0.18) { score *= 0.75; notes.push('dark'); }
  else if (s.mean > 0.85) { score *= 0.75; notes.push('very bright'); }
  if (sharp < 0.35) notes.push('soft'); else if (sharp > 0.8) notes.push('sharp');
  if (colour > 0.7) notes.push('colourful');
  const f = s.faces;
  if (f && f.count > 0) {
    // A face from about 0.4% of the frame (a wide shot) to 6% (a close-up), surely detected.
    const size = clamp((Math.log(Math.max(1e-4, f.largest)) - Math.log(0.004)) / (Math.log(0.06) - Math.log(0.004)));
    const lit = clamp((f.luma - 0.08) / 0.27);
    const bonus = 45 * (0.35 + 0.65 * size) * clamp(f.score) * (0.3 + 0.7 * lit);
    score += bonus;
    notes.push(f.count > 1 ? `${f.count} faces` : 'a face');
    if (lit < 0.4) notes.push('face in shadow');
  }
  if (at != null) {
    if (at < 0.03 || at > 0.97) { score *= 0.6; notes.push(at < 0.5 ? 'at the very start' : 'at the very end'); }
    else if (at < 0.08 || at > 0.92) score *= 0.85;
  }
  return { score: Math.round(Math.min(100, score)), notes };
}

/**
 * When the video has faces, a frame without one is a weaker picture of it (a
 * hand, a guitar neck, an empty room). Applied across a set of scored
 * candidates once the detector has run on all of them.
 */
export function preferFaces<T extends { score?: number; notes?: string[]; rejected?: string; faces?: FrameFaces | null }>(cands: T[]): T[] {
  const withFaces = cands.filter((c) => !c.rejected && (c.faces?.count ?? 0) > 0).length;
  if (withFaces < 1) return cands;
  return cands.map((c) => (c.rejected || (c.faces?.count ?? 0) > 0 || c.faces === undefined) ? c
    : { ...c, score: Math.round((c.score ?? 0) * 0.75), notes: [...(c.notes ?? []), 'no face'] });
}

/**
 * Keep `n` of the best, spread over the video: a frame within `gapMs` of a
 * better one already kept is a near-copy of it (the same shot) and is passed
 * over while others are left. Only when too few frames are usable do rejected
 * ones fill the set, at the end, so the console can say why they were skipped.
 */
export function keepBestSpread<T extends { atMs?: number | null; score?: number; rejected?: string }>(cands: T[], n: number, gapMs: number): T[] {
  const ranked = [...cands].filter((c) => !c.rejected).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const kept: T[] = [];
  for (const c of ranked) {
    if (kept.length >= n) break;
    if (c.atMs != null && kept.some((k) => k.atMs != null && Math.abs((k.atMs as number) - (c.atMs as number)) < gapMs)) continue;
    kept.push(c);
  }
  for (const c of ranked) { if (kept.length >= n) break; if (!kept.includes(c)) kept.push(c); }
  const rejected = cands.filter((c) => c.rejected).slice(0, Math.max(0, n - kept.length));
  return [...kept, ...rejected];
}

export interface Candidate { key: string; atMs?: number | null; origin: 'ingest' | 'live'; score?: number; notes?: string[]; rejected?: string; faces?: FrameFaces | null }

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
