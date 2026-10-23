// ============================================================================
//  FRAMING PATHS: from the track store to time-coded crop keyframes, one path
//  per format (volt/REFRAME.md). PURE; no I/O, no clock.
//
//  A path is what the operator edits and what the render follows:
//    keys   [{ t, cx, cy, w, h, ease, mode, shot, cut }]
//           cx/cy is the CENTRE of the crop and w/h its size, all as fractions
//           of the source picture, so one path fits any rendition. `ease` says
//           how to move from this key to the next: glide (eased), linear, or
//           hold (stay, then jump at the next key). The last key of every shot
//           holds, so the framing never slides across a cut. `mode` crop or
//           fill (the whole picture over a blurred copy of itself).
//    shots  one plan per shot: who it follows, whether they fit, confidence.
//
//  THE RULES, in the order they apply to each shot:
//   1. who: the operator's choice for the shot, else the first of the account's
//      priorities found (faces, people, centre). Faces: the main face (on
//      screen longest, biggest); a second face of similar size that is on
//      screen most of the shot makes it a group shot.
//   2. fit: a group that cannot fit in the crop at some moment takes the
//      fallback: fill (whole picture) or follow the main face.
//   3. move: locked = one framing per shot; steady = one framing unless the
//      subject would leave it, then a smoothed pan; responsive = a lighter
//      smoothing. Pans are simplified to the few keyframes a person can edit.
// ============================================================================
import { FORMATS, type FormatKey, type ReframeSettings } from './formats';

export type Ease = 'glide' | 'linear' | 'hold';
export type Mode = 'crop' | 'fill';

export interface Key {
  t: number; cx: number; cy: number; w: number; h: number;
  ease: Ease; mode: Mode; shot: number; cut?: boolean;
}

export interface ShotPlan {
  index: number; start: number; end: number;
  /** subject id, 'group', 'centre' */
  follow: string;
  followLabel: string;
  mode: Mode;
  fits: boolean;
  confidence: number;
  reason: string;
  chosenBy: 'auto' | 'operator';
}

export interface FramingPath {
  version: 1;
  format: FormatKey;
  crop: { w: number; h: number };
  keys: Key[];
  shots: ShotPlan[];
  /** The lowest shot confidence: how sure Volt is about the whole clip. */
  confidence: number;
  /** Shots below 0.75 that a person should look at. */
  needsReview: number[];
}

export type Overrides = Record<string, { follow?: string }>;

// ---- the track store, as reframe_analyse.py writes it ----------------------
export interface TrackStore {
  source: { width: number; height: number; fps: number; durationSec: number };
  analysis: { sampleFps: number; engine?: Record<string, string> };
  shots: { index: number; start: number; end: number }[];
  subjects: { id: string; kind: 'face' | 'person'; label: string; onScreenSec: number; meanArea: number; shots: number[] }[];
  tracks: { id: string; subject: string; kind: 'face' | 'person'; shot: number; start: number; end: number;
    samples: [number, number, number, number, number, number][] }[];
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The crop as fractions of the source: full height for a narrower target. */
export function cropSize(format: FormatKey, srcW: number, srcH: number): { w: number; h: number } {
  const srcA = srcW / srcH;
  const a = FORMATS[format].aspect;
  return a <= srcA ? { w: r4(a / srcA), h: 1 } : { w: 1, h: r4(srcA / a) };
}

type Box = { x: number; y: number; w: number; h: number };

/** One subject's boxes inside one shot, by time. */
function boxesIn(store: TrackStore, subject: string, shot: number): Map<number, Box> {
  const m = new Map<number, Box>();
  for (const tr of store.tracks) {
    if (tr.subject !== subject || tr.shot !== shot) continue;
    for (const s of tr.samples) m.set(r3(s[0]), { x: s[1], y: s[2], w: s[3], h: s[4] });
  }
  return m;
}

/** The sample grid of a shot. */
function grid(start: number, end: number, fps: number): number[] {
  const out: number[] = [];
  const dt = 1 / fps;
  for (let t = Math.ceil(start * fps - 1e-6) / fps; t < end - 1e-6; t += dt) out.push(r3(t));
  if (!out.length) out.push(r3(start));
  return out;
}

/** A value per grid time, missing ones filled from their neighbours. */
function fill(times: number[], known: Map<number, number>): number[] {
  const vals: (number | null)[] = times.map((t) => known.has(t) ? known.get(t)! : null);
  const idx = vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  if (!idx.length) return times.map(() => 0.5);
  return vals.map((v, i) => {
    if (v != null) return v;
    const prev = [...idx].reverse().find((j) => j < i);
    const next = idx.find((j) => j > i);
    if (prev == null) return vals[next!]!;
    if (next == null) return vals[prev]!;
    const f = (i - prev) / (next - prev);
    return vals[prev]! + (vals[next]! - vals[prev]!) * f;
  });
}

function smooth(v: number[], win: number): number[] {
  if (win <= 1) return v.slice();
  const h = Math.floor(win / 2);
  return v.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(v.length - 1, i + h); j++) { s += v[j]; n++; }
    return s / n;
  });
}

/** Fewest points that keep the curve within `tol` (vertical distance). */
function simplify(ts: number[], vs: number[], tol: number): number[] {
  const keep = new Set<number>([0, ts.length - 1]);
  const rec = (a: number, b: number) => {
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const f = (ts[i] - ts[a]) / ((ts[b] - ts[a]) || 1);
      const d = Math.abs(vs[i] - (vs[a] + (vs[b] - vs[a]) * f));
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol && wi > 0) { keep.add(wi); rec(a, wi); rec(wi, b); }
  };
  if (ts.length > 2) rec(0, ts.length - 1);
  return [...keep].sort((x, y) => x - y);
}

interface Candidate { id: string; kind: 'face' | 'person'; label: string; boxes: Map<number, Box>; coverage: number; area: number }

function candidates(store: TrackStore, shot: { index: number; start: number; end: number }, times: number[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of store.subjects) {
    const boxes = boxesIn(store, s.id, shot.index);
    if (!boxes.size) continue;
    let area = 0;
    for (const b of boxes.values()) area += b.w * b.h;
    out.push({ id: s.id, kind: s.kind, label: s.label, boxes, coverage: Math.min(1, boxes.size / times.length), area: area / boxes.size });
  }
  return out.sort((a, b) => (b.coverage * (0.02 + b.area)) - (a.coverage * (0.02 + a.area)));
}

/** Left and right edges (and top, bottom) of a set of subjects at each time. */
function span(members: Candidate[], times: number[]) {
  const L: Map<number, number> = new Map(), R = new Map<number, number>(), T = new Map<number, number>(), B = new Map<number, number>();
  for (const t of times) {
    let l = Infinity, r = -Infinity, tp = Infinity, bt = -Infinity;
    for (const m of members) {
      const b = m.boxes.get(t);
      if (!b) continue;
      l = Math.min(l, b.x); r = Math.max(r, b.x + b.w); tp = Math.min(tp, b.y); bt = Math.max(bt, b.y + b.h);
    }
    if (l < Infinity) { L.set(t, l); R.set(t, r); T.set(t, tp); B.set(t, bt); }
  }
  return { L, R, T, B };
}

export interface PlanInput {
  store: TrackStore;
  format: FormatKey;
  settings: Pick<ReframeSettings, 'priority' | 'movement' | 'fallback' | 'safeArea'>;
  overrides?: Overrides;
}

/** Plan and keyframe one shot. */
function planShot(inp: PlanInput, shot: { index: number; start: number; end: number }, crop: { w: number; h: number }): { plan: ShotPlan; keys: Key[] } {
  const { store, settings, format } = inp;
  const fps = store.analysis.sampleFps || 5;
  const times = grid(shot.start, shot.end, fps);
  const cands = candidates(store, shot, times);
  const ov = inp.overrides?.[String(shot.index)]?.follow;
  const base = { index: shot.index, start: shot.start, end: shot.end };
  const lockX = crop.w >= 1, lockY = crop.h >= 1;
  const statik = (mode: Mode, cx: number, cy: number) => [{ t: r3(shot.start), cx: r4(cx), cy: r4(cy), w: crop.w, h: crop.h, ease: 'hold' as Ease, mode, shot: shot.index, cut: true }];
  const centre = (reason: string, confidence: number, chosenBy: 'auto' | 'operator') => ({
    plan: { ...base, follow: 'centre', followLabel: 'Centre', mode: 'crop' as Mode, fits: true, confidence, reason, chosenBy },
    keys: statik('crop', 0.5, 0.5),
  });
  const fillShot = (follow: string, followLabel: string, reason: string, chosenBy: 'auto' | 'operator') => ({
    plan: { ...base, follow, followLabel, mode: 'fill' as Mode, fits: false, confidence: chosenBy === 'operator' ? 1 : 0.55, reason, chosenBy },
    keys: statik('fill', 0.5, 0.5),
  });

  // ---- 1. who
  let members: Candidate[] = [];
  let chosenBy: 'auto' | 'operator' = 'auto';
  let followId = 'centre', followLabel = 'Centre', why = '';
  if (ov) {
    chosenBy = 'operator';
    if (ov === 'centre') return centre('Fixed on the centre by an operator.', 1, 'operator');
    if (ov === 'fill') return fillShot('fill', 'Whole picture', 'Whole picture chosen by an operator.', 'operator');
    if (ov === 'group') {
      members = cands.filter((c) => c.kind === 'face' && c.coverage >= 0.3);
      if (members.length < 2) members = cands.slice(0, 2);
      followId = 'group'; followLabel = members.map((m) => m.label).join(' and ') || 'Group';
    } else {
      const c = cands.find((x) => x.id === ov);
      if (!c) return centre('The chosen subject is not in this shot, so it is framed on the centre.', 0.6, 'operator');
      members = [c]; followId = c.id; followLabel = c.label;
    }
  } else {
    for (const p of settings.priority) {
      if (p === 'centre') break;
      const kind = p === 'faces' ? 'face' : 'person';
      const of = cands.filter((c) => c.kind === kind && c.coverage >= 0.25);
      if (!of.length) continue;
      const main = of[0];
      const companions = of.slice(1).filter((c) => c.area >= main.area * 0.5 && c.coverage >= 0.5 && main.coverage >= 0.5);
      members = [main, ...companions];
      followId = members.length > 1 ? 'group' : main.id;
      followLabel = members.map((m) => m.label).join(' and ');
      break;
    }
    if (!members.length) {
      return centre(cands.length ? 'Nobody is on screen long enough to follow, so it is framed on the centre.' : 'No face or person in this shot, so it is framed on the centre.', 0.75, 'auto');
    }
  }

  // ---- 2. fit
  const margin = 0.03;
  let sp = span(members, times);
  const widest = Math.max(...[...sp.L.keys()].map((t) => sp.R.get(t)! - sp.L.get(t)!));
  const fitsGroup = lockX || widest + margin <= crop.w;
  let fits = true;
  if (members.length > 1 && !fitsGroup) {
    if (settings.fallback === 'fill' || chosenBy === 'operator') {
      return fillShot(followId, followLabel, `${followLabel} are too far apart for ${FORMATS[format].ratio}, so the whole picture is shown over a blurred fill.`, chosenBy);
    }
    members = [members[0]]; followId = members[0].id; followLabel = members[0].label; fits = false;
    why = `Too far apart for ${FORMATS[format].ratio}: follows ${followLabel}.`;
    sp = span(members, times);
  }

  // ---- 3. move
  const kx = new Map<number, number>(), ky = new Map<number, number>();
  for (const t of sp.L.keys()) {
    kx.set(t, (sp.L.get(t)! + sp.R.get(t)!) / 2);
    ky.set(t, (sp.T.get(t)! + sp.B.get(t)!) / 2);
  }
  const offset = settings.safeArea && format === '9x16' ? 0.06 * crop.w : 0;
  let xs = fill(times, kx).map((v) => v + offset);
  // a face sits in the upper third of the frame, not its middle
  let ys = fill(times, ky).map((v) => v + 0.15 * crop.h);
  const loX = crop.w / 2, hiX = 1 - crop.w / 2, loY = crop.h / 2, hiY = 1 - crop.h / 2;
  const subjW = Math.max(...[...sp.L.keys()].map((t) => sp.R.get(t)! - sp.L.get(t)!), 0);
  const rangeX = Math.max(...xs) - Math.min(...xs);
  const rangeY = Math.max(...ys) - Math.min(...ys);
  const holds = (rangeX + subjW <= crop.w * 0.85 || lockX) && (rangeY <= crop.h * 0.3 || lockY);
  const coverage = Math.min(...members.map((m) => m.coverage));
  const confidence = r3(chosenBy === 'operator' ? 1 : !fits ? 0.65 : members.length > 1 ? 0.9 : 0.6 + 0.35 * Math.min(1, coverage / 0.8));
  const plan: ShotPlan = { ...base, follow: followId, followLabel, mode: 'crop', fits, confidence,
    reason: why || (members.length > 1 ? `${followLabel} fit together.` : `Follows ${followLabel}.`), chosenBy };

  const midX = clamp((Math.max(...xs) + Math.min(...xs)) / 2, loX, hiX);
  const midY = clamp((Math.max(...ys) + Math.min(...ys)) / 2, loY, hiY);
  if (settings.movement === 'locked' || holds) {
    return { plan, keys: statik('crop', lockX ? 0.5 : midX, lockY ? 0.5 : midY) };
  }
  const responsive = settings.movement === 'responsive';
  const win = Math.max(1, Math.round((responsive ? 0.6 : 1.6) * fps));
  xs = smooth(xs, win).map((v) => clamp(v, loX, hiX));
  ys = smooth(ys, win).map((v) => clamp(v, loY, hiY));
  const tol = responsive ? 0.006 : 0.012;
  const ix = new Set([...simplify(times, xs, tol), ...(lockY ? [] : simplify(times, ys, tol))]);
  const ease: Ease = responsive ? 'linear' : 'glide';
  const keys: Key[] = [...ix].sort((a, b) => a - b).map((i, n) => ({
    t: n === 0 ? r3(shot.start) : times[i], cx: r4(lockX ? 0.5 : xs[i]), cy: r4(lockY ? 0.5 : ys[i]),
    w: crop.w, h: crop.h, ease, mode: 'crop' as Mode, shot: shot.index, ...(n === 0 ? { cut: true } : {}),
  }));
  keys[keys.length - 1].ease = 'hold';
  return { plan, keys };
}

/** The whole path for one format. */
export function planPath(inp: PlanInput): FramingPath {
  const { store, format } = inp;
  const crop = cropSize(format, store.source.width, store.source.height);
  const shots = store.shots.length ? store.shots : [{ index: 0, start: 0, end: store.source.durationSec || 0 }];
  const plans: ShotPlan[] = [];
  const keys: Key[] = [];
  for (const s of shots) {
    const { plan, keys: k } = planShot(inp, s, crop);
    plans.push(plan); keys.push(...k);
  }
  return finish(format, crop, keys, plans);
}

function finish(format: FormatKey, crop: { w: number; h: number }, keys: Key[], shots: ShotPlan[]): FramingPath {
  keys.sort((a, b) => a.t - b.t);
  const confidence = shots.length ? Math.min(...shots.map((s) => s.confidence)) : 1;
  return { version: 1, format, crop, keys, shots, confidence: r3(confidence), needsReview: shots.filter((s) => s.confidence < 0.75).map((s) => s.index) };
}

/** Re-plan only some shots, keeping every other shot's keys (a person's edits) as they are. */
export function replanShots(prev: FramingPath, inp: PlanInput, shotIdx: number[]): FramingPath {
  const fresh = planPath(inp);
  const set = new Set(shotIdx);
  const keys = [...prev.keys.filter((k) => !set.has(k.shot)), ...fresh.keys.filter((k) => set.has(k.shot))];
  const shots = fresh.shots.map((s) => (set.has(s.index) ? s : prev.shots.find((p) => p.index === s.index) ?? s));
  return finish(prev.format, prev.crop, keys, shots);
}

/** Where the crop is at time t, as the render and the console preview see it. */
export function sampleAt(keys: Key[], t: number): { cx: number; cy: number; w: number; h: number; mode: Mode } {
  if (!keys.length) return { cx: 0.5, cy: 0.5, w: 1, h: 1, mode: 'crop' };
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const k0 = keys[i];
  if (t < k0.t || i + 1 >= keys.length || k0.ease === 'hold') return { cx: k0.cx, cy: k0.cy, w: k0.w, h: k0.h, mode: k0.mode };
  const k1 = keys[i + 1];
  let p = (t - k0.t) / ((k1.t - k0.t) || 1);
  if (k0.ease === 'glide') p = p * p * (3 - 2 * p);
  return { cx: k0.cx + (k1.cx - k0.cx) * p, cy: k0.cy + (k1.cy - k0.cy) * p, w: k0.w, h: k0.h, mode: k0.mode };
}

/**
 * Keys an operator sent, made safe: sorted, inside the clip, the crop kept on
 * the picture, the size fixed by the format (a person moves the framing, the
 * format decides its shape), and the shot each key falls in recomputed.
 */
export function cleanKeys(raw: unknown, path: FramingPath, shots: { index: number; start: number; end: number }[], duration: number): Key[] {
  if (!Array.isArray(raw)) throw Object.assign(new Error('keys must be a list'), { status: 400 });
  if (raw.length > 5000) throw Object.assign(new Error('too many keyframes (5000 at most)'), { status: 400 });
  const { w, h } = path.crop;
  const shotOf = (t: number) => (shots.find((s) => t >= s.start - 1e-6 && t < s.end - 1e-6) ?? shots[shots.length - 1] ?? { index: 0 }).index;
  const keys: Key[] = raw.map((k: any, n: number) => {
    const t = Number(k?.t), cx = Number(k?.cx), cy = Number(k?.cy ?? 0.5);
    if (!Number.isFinite(t) || !Number.isFinite(cx) || !Number.isFinite(cy)) throw Object.assign(new Error(`keyframe ${n + 1}: t and cx must be numbers`), { status: 400 });
    const ease: Ease = ['glide', 'linear', 'hold'].includes(k?.ease) ? k.ease : 'glide';
    const mode: Mode = k?.mode === 'fill' ? 'fill' : 'crop';
    const tt = r3(clamp(t, 0, Math.max(0, duration)));
    const shot = shotOf(tt);
    const s = shots.find((x) => x.index === shot);
    return { t: tt, cx: r4(clamp(cx, w / 2, 1 - w / 2)), cy: r4(clamp(cy, h / 2, 1 - h / 2)), w, h, ease, mode, shot,
      ...(s && Math.abs(s.start - tt) < 1e-3 ? { cut: true } : {}) };
  }).sort((a, b) => a.t - b.t);
  // one key per instant: the later one in the list wins
  const out: Key[] = [];
  for (const k of keys) { if (out.length && Math.abs(out[out.length - 1].t - k.t) < 1e-3) out[out.length - 1] = k; else out.push(k); }
  // never slide across a cut: the last key before each shot change holds
  for (let i = 0; i + 1 < out.length; i++) if (out[i + 1].shot !== out[i].shot) out[i].ease = 'hold';
  return out;
}

export function withKeys(path: FramingPath, keys: Key[]): FramingPath {
  return finish(path.format, path.crop, keys, path.shots);
}
