// ============================================================================
//  DDSKETCH: PERCENTILES THAT MERGE (QOE_REPORTING.md section 3).
//
//  A minute aggregate cannot keep every startup time it saw, and percentiles
//  of percentiles are wrong. A DDSketch keeps a count per logarithmic bin, so
//  any quantile comes back within ALPHA relative error (1 %), and two sketches
//  merge by adding their bins: ten collector flushes, or a whole day of
//  minutes, give the same answer as one sketch over everything.
//
//  Stored as a flat JSON object of counts: { "<bin>": n, ..., "z": zeros },
//  so Postgres merges them with qoe_jsonb_add and ClickHouse with sumMap.
//  Values are milliseconds (or any non-negative number).
// ============================================================================

export const ALPHA = 0.01;
const GAMMA = (1 + ALPHA) / (1 - ALPHA);
const LOG_GAMMA = Math.log(GAMMA);
/** Below this a value counts as zero (1 µs, for ms values). */
const MIN_VALUE = 1e-3;

export type Sketch = Record<string, number>;

export function binOf(v: number): string {
  if (!(v > MIN_VALUE)) return 'z';
  return String(Math.ceil(Math.log(v) / LOG_GAMMA));
}

/** The representative value of a bin: within ALPHA of every value in it. */
function valueOf(bin: string): number {
  if (bin === 'z') return 0;
  const i = Number(bin);
  return (2 * Math.pow(GAMMA, i)) / (GAMMA + 1);
}

export function add(s: Sketch, v: number, n = 1): Sketch {
  if (!Number.isFinite(v) || v < 0) return s;
  const b = binOf(v);
  s[b] = (s[b] ?? 0) + n;
  return s;
}

export function merge(a: Sketch, b: Sketch): Sketch {
  for (const [k, n] of Object.entries(b)) a[k] = (a[k] ?? 0) + Number(n);
  return a;
}

export function count(s: Sketch): number {
  let n = 0;
  for (const v of Object.values(s)) n += Number(v);
  return n;
}

/**
 * The q quantile (0..1), by the nearest-rank rule the reports use everywhere
 * (the value at rank ceil(q x n)), or null for an empty sketch.
 */
export function quantile(s: Sketch, q: number): number | null {
  const n = count(s);
  if (!n) return null;
  const rank = Math.max(1, Math.ceil(q * n));
  const bins = Object.keys(s).filter((k) => Number(s[k]) > 0)
    .sort((x, y) => (x === 'z' ? -Infinity : Number(x)) - (y === 'z' ? -Infinity : Number(y)));
  let seen = 0;
  for (const b of bins) { seen += Number(s[b]); if (seen >= rank) return valueOf(b); }
  return valueOf(bins[bins.length - 1]);
}
