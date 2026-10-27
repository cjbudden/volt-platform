// ============================================================================
//  LOAD FIT: the load model's coefficients, learned from every stream that ran.
//
//  streamLoad.ts sizes a stream from fixed starting coefficients (CPU per
//  output megapixel per second for x264, decode cost per codec, packaging and
//  I/O per Mbps, and so on). calibrate() can replace that estimate with real
//  history, but only for a signature that has already run several times, so
//  every NEW ladder was sized from the constants however wrong they had
//  proved on everything else. This file learns from ALL runs instead: each
//  run's estimate is a sum of components, and a multiplier per component is
//  fitted so the sum matches what the server measured. A new ladder then gets
//  the corrected cost of its parts on its first start.
//
//  HOW, in plain terms. For every run we know the estimated CPU of each
//  component (its lines, tagged with `component`) and the p95 CPU the server
//  measured while it carried only that task. We look for multipliers m (one
//  per component) so that sum(component estimate x m) is as close as possible
//  to the measurement over all runs: a least-squares fit, pulled towards 1
//  (the starting coefficients) with the weight of a few runs, so a component
//  that hardly appears in the history stays where it was.
//
//  ONE ODD RUN CANNOT MOVE IT FAR. Three guards:
//    * runs whose measurement is far off the first fit (a run that idled on
//      slate, a noisy neighbour reading) are set aside before the final fit,
//      judged by the median absolute deviation of the ratio measured/fitted;
//    * each multiplier is clamped to a floor and a bound (0.5x to 2x by
//      default), so the model never trusts history to halve or more than
//      double a cost;
//    * a run's weight is its measured hours, capped, so a long run counts more
//      than a short one but no single run dominates.
//
//  PER INSTANCE FAMILY. The same encode costs a different share of a c5 and a
//  c7i core, so the fit is made per family (c7i, c6i, c5, g4dn...) when the
//  family has enough runs, and from all families together otherwise.
//
//  Network is one multiplier on the estimated in + out (container overhead,
//  retransmits, the uploader's own requests), fitted and guarded the same way.
//
//  Pure: no DB, no clock, no IO. loadLearning.ts reads the runs.
// ============================================================================
import type { LoadEstimate, LoadLine } from './streamLoad';
import { reserve } from './streamLoad';
import type { StreamLoad } from './capacity';

export interface RunObservation {
  /** Instance family the run's host belonged to (c7i, g4dn...). */
  family: string;
  /** The estimate's lines as written at launch (instances.placement_decision.lines). */
  lines: LoadLine[];
  /** Measured p95 CPU units while the host carried this task alone. */
  cpuUnitsP95: number;
  /** Measured p95 network in + out (bps), when known. */
  netBpsP95: number | null;
  /** Hours of measurement behind the figures. */
  hours: number;
}

export interface LoadFitPolicy {
  /** Lowest multiplier a component may get. */
  floor: number;
  /** Highest multiplier a component may get. */
  bound: number;
  /** How many runs' worth of weight the starting coefficients carry. */
  priorRuns: number;
  /** A family needs this many runs for its own fit; otherwise all families are used together. */
  minRuns: number;
  /** A run whose measured/fitted ratio is more than this many MADs from the median is set aside. */
  outlierMads: number;
  /** A run counts at most this many hours. */
  maxHoursWeight: number;
}

export const DEFAULT_LOAD_FIT: LoadFitPolicy = { floor: 0.5, bound: 2, priorRuns: 3, minRuns: 5, outlierMads: 4, maxHoursWeight: 24 };

export interface ComponentFit {
  /** Multiplier on the starting coefficient (1 = the constant was right). */
  multiplier: number;
  /** Runs in which this component carried CPU. */
  runs: number;
  /** True when the clamp, not the data, set the value. */
  clamped: boolean;
}

export interface LoadFit {
  family: string;
  runs: number;
  /** Runs set aside as outliers. */
  setAside: number;
  cpu: Record<string, ComponentFit>;
  net: ComponentFit;
  /** Median |measured - projected| / measured over the runs used, before and after the fit. */
  cpuErrorBefore: number;
  cpuErrorAfter: number;
}

export interface LoadFits {
  all: LoadFit | null;
  byFamily: Record<string, LoadFit>;
  policy: LoadFitPolicy;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Which component a line's CPU belongs to. Lines written since 27 Oct carry
 * `component`; older stored lines are recognised from their wording so the
 * history before this change is not thrown away.
 */
export function componentOf(l: LoadLine): string {
  if (l.component) return l.component;
  const w = l.what ?? '';
  if (/^encode .*NVENC/.test(w)) return 'encode:nvenc';
  if (/^encode /.test(w)) return 'encode:x264';
  if (/^decode .* on GPU/.test(w)) return 'decode:gpu';
  if (/^decode HEVC/.test(w)) return 'decode:hevc';
  if (/^decode /.test(w)) return 'decode:h264';
  if (/^source in|^relay /.test(w)) return 'ingest';
  if (/^audio/.test(w)) return 'audio';
  if (/^package/.test(w)) return 'package';
  if (/^DRM/.test(w)) return 'drm';
  if (/^graphics/.test(w)) return 'graphics';
  if (/Gladia/.test(w)) return 'captions:gladia';
  if (/Whisper .* on CPU/.test(w)) return 'captions:whisper-cpu';
  if (/Whisper/.test(w)) return 'captions:whisper-gpu';
  if (/audio output|audio source/.test(w)) return 'radio';
  return 'other';
}

function cpuByComponent(lines: LoadLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    if (!(l.cpuUnits > 0)) continue;
    const c = componentOf(l);
    out[c] = (out[c] ?? 0) + l.cpuUnits;
  }
  return out;
}

const netOf = (lines: LoadLine[]) => lines.reduce((s, l) => s + (l.netInBps || 0) + (l.netOutBps || 0), 0);

// ---------------------------------------------------------------------------
// Small linear algebra (a handful of components, so Gaussian elimination)
// ---------------------------------------------------------------------------

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const clamp = (v: number, p: LoadFitPolicy) => Math.min(p.bound, Math.max(p.floor, v));

/**
 * The smallest spread (on the log ratio) outlier detection assumes. Real host
 * readings vary by several percent from minute to minute; without a floor, a
 * history that happens to agree closely would set aside runs for being 3 %
 * off.
 */
const MIN_SPREAD = 0.05;

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

interface Row { x: Record<string, number>; y: number; w: number; netEst: number; netObs: number | null }

function rowsOf(obs: RunObservation[], p: LoadFitPolicy): Row[] {
  return obs
    .filter((o) => o.cpuUnitsP95 > 0 && Array.isArray(o.lines) && o.lines.length > 0)
    .map((o) => ({
      x: cpuByComponent(o.lines), y: o.cpuUnitsP95,
      w: Math.max(0.25, Math.min(p.maxHoursWeight, o.hours || 0)),
      netEst: netOf(o.lines), netObs: o.netBpsP95,
    }))
    .filter((r) => Object.keys(r.x).length > 0);
}

/** Ridge least squares pulled towards m = 1, weighted by run hours. */
function fitCpu(rows: Row[], comps: string[], p: LoadFitPolicy): Record<string, number> {
  const n = comps.length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  const totalW = rows.reduce((s, r) => s + r.w, 0) || 1;
  for (const r of rows) {
    const xs = comps.map((c) => r.x[c] ?? 0);
    for (let i = 0; i < n; i++) {
      b[i] += r.w * xs[i] * r.y;
      for (let j = 0; j < n; j++) A[i][j] += r.w * xs[i] * xs[j];
    }
  }
  // The prior: as if `priorRuns` average runs had confirmed each starting
  // coefficient exactly. Scaled by the component's own size so a small
  // component (audio) and a large one (encode) are held equally firmly.
  for (let i = 0; i < n; i++) {
    const meanSq = rows.reduce((s, r) => s + r.w * (r.x[comps[i]] ?? 0) ** 2, 0) / totalW;
    const lam = p.priorRuns * Math.max(meanSq, 1);
    A[i][i] += lam;
    b[i] += lam;
  }
  const m = solve(A, b) ?? new Array(n).fill(1);
  return Object.fromEntries(comps.map((c, i) => [c, m[i]]));
}

const predict = (r: Row, m: Record<string, number>) => Object.entries(r.x).reduce((s, [c, v]) => s + v * (m[c] ?? 1), 0);

function fitNet(rows: Row[], p: LoadFitPolicy): { k: number; runs: number } {
  const usable = rows.filter((r) => r.netObs != null && r.netObs > 0 && r.netEst > 0);
  if (!usable.length) return { k: 1, runs: 0 };
  const ratios = usable.map((r) => r.netObs! / r.netEst);
  const med = median(ratios);
  const mad = Math.max(0.02, median(ratios.map((x) => Math.abs(x - med))) * 1.4826);
  const kept = usable.filter((_, i) => Math.abs(ratios[i] - med) <= p.outlierMads * mad);
  const meanEst = kept.reduce((s, r) => s + r.w * r.netEst, 0) / (kept.reduce((s, r) => s + r.w, 0) || 1);
  const lam = p.priorRuns * meanEst;
  const k = (kept.reduce((s, r) => s + r.w * r.netObs!, 0) + lam) / (kept.reduce((s, r) => s + r.w * r.netEst, 0) + lam);
  return { k, runs: kept.length };
}

const relErr = (pred: number, y: number) => Math.abs(pred - y) / Math.max(1, y);

/** Fit one set of runs (one family, or all). Null when there are too few runs. */
export function fitRuns(family: string, obs: RunObservation[], p: LoadFitPolicy = DEFAULT_LOAD_FIT): LoadFit | null {
  const rows = rowsOf(obs, p);
  if (rows.length < p.minRuns) return null;
  const comps = [...new Set(rows.flatMap((r) => Object.keys(r.x)))].sort();

  // Fit, set aside the runs that disagree with the fit, and fit again, until
  // the set stops changing. Repeating matters: a single wild run pulls the
  // first fit towards itself, which can make good runs look odd; once it is
  // out, those runs agree again and come back in. Judged on the log of
  // measured/fitted, so "twice as high" and "half as high" weigh the same.
  let used = rows;
  let raw = fitCpu(rows, comps, p);
  for (let pass = 0; pass < 6; pass++) {
    const lr = rows.map((r) => Math.log(Math.max(1, r.y) / Math.max(1, predict(r, raw))));
    const med = median(lr);
    const mad = Math.max(MIN_SPREAD, median(lr.map((x) => Math.abs(x - med))) * 1.4826);
    const kept = rows.filter((_, i) => Math.abs(lr[i] - med) <= p.outlierMads * mad);
    const next = kept.length >= p.minRuns ? kept : rows;
    if (next.length === used.length && next.every((r, i) => r === used[i])) break;
    used = next;
    raw = fitCpu(used, comps, p);
  }

  const cpu: Record<string, ComponentFit> = {};
  for (const c of comps) {
    const v = raw[c];
    const m = clamp(v, p);
    cpu[c] = { multiplier: Math.round(m * 1000) / 1000, runs: used.filter((r) => (r.x[c] ?? 0) > 0).length, clamped: m !== v };
  }
  const mult = Object.fromEntries(comps.map((c) => [c, cpu[c].multiplier]));
  const net = fitNet(used, p);
  const netM = clamp(net.k, p);
  return {
    family, runs: used.length, setAside: rows.length - used.length, cpu,
    net: { multiplier: Math.round(netM * 1000) / 1000, runs: net.runs, clamped: netM !== net.k },
    cpuErrorBefore: Math.round(median(used.map((r) => relErr(predict(r, {}), r.y))) * 1000) / 1000,
    cpuErrorAfter: Math.round(median(used.map((r) => relErr(predict(r, mult), r.y))) * 1000) / 1000,
  };
}

/** Fit every family with enough runs, plus all of them together. */
export function fitLoadModel(obs: RunObservation[], p: LoadFitPolicy = DEFAULT_LOAD_FIT): LoadFits {
  const byFamily: Record<string, LoadFit> = {};
  const families = [...new Set(obs.map((o) => o.family))];
  for (const f of families) {
    const fit = fitRuns(f, obs.filter((o) => o.family === f), p);
    if (fit) byFamily[f] = fit;
  }
  return { all: fitRuns('*', obs, p), byFamily, policy: p };
}

/** The fit to use for a family: its own, else the all-family fit, else none. */
export function fitFor(fits: LoadFits | null, family: string | null): LoadFit | null {
  if (!fits) return null;
  return (family && fits.byFamily[family]) || fits.all;
}

/**
 * The estimate with the learned multipliers applied to each line. Memory is
 * left as estimated (memory is reserved, not shared, and calibrate() corrects
 * it per signature). Basis becomes 'fitted' so a person can see why.
 */
export function applyFit(est: LoadEstimate, fit: LoadFit | null): LoadEstimate {
  if (!fit) return est;
  const lines = est.lines.map((l) => {
    const c = componentOf(l);
    const m = fit.cpu[c]?.multiplier ?? 1;
    return {
      ...l,
      cpuUnits: l.cpuUnits * m,
      netInBps: l.netInBps * fit.net.multiplier,
      netOutBps: l.netOutBps * fit.net.multiplier,
    };
  });
  const sum = (k: 'cpuUnits' | 'netInBps' | 'netOutBps') => Math.round(lines.reduce((s, l) => s + l[k], 0));
  const load: StreamLoad = { ...est.load, cpuUnits: sum('cpuUnits'), netInBps: sum('netInBps'), netOutBps: sum('netOutBps') };
  return { ...est, lines, baseLines: est.baseLines ?? est.lines, load, reservation: reserve(load), basis: 'fitted', fit: { family: fit.family, runs: fit.runs } };
}
