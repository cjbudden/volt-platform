// ============================================================================
//  PROJECTION AGAINST ACTUAL, per class of work.
//
//  Every stream is sized before it runs (CPU, network, storage). This report
//  sets those projections against what the servers then measured, per class
//  (transcode, package-only, radio, captions), so the error is visible and
//  anyone can see whether learning (loadFit.ts) is closing it.
//
//  What "actual" means for each figure, and why it can be trusted:
//    CPU       p95 of the host while it carried that task alone. With other
//              tasks on the host there is no per-task reading to compare with,
//              so those runs are not counted (the same rule calibrate() uses).
//    network   p95 of the host's in + out over the same samples.
//    storage   the host's average outbound rate over the run. On an encoder
//              host the S3 uploader is the only thing that sends (viewers are
//              served by CloudFront from S3), so bytes out are bytes stored;
//              a Gladia captions upstream adds about 256 kbps and is noted.
//
//  Pure: no DB, no clock, no IO. loadLearning.ts reads the rows.
// ============================================================================

export interface ProjectionRow {
  taskKind: string;
  basis: string | null;
  projectedCpuUnits: number | null;
  actualCpuUnitsP95: number | null;
  projectedNetBps: number | null;
  actualNetBpsP95: number | null;
  projectedStoreBytesPerHour: number | null;
  actualOutBpsMean: number | null;
}

export interface ErrorSummary {
  /** Runs with both a projection and a measurement. */
  runs: number;
  /** Median actual / projected (1 = right, above 1 = under-projected). */
  medianRatio: number | null;
  /** Median |actual - projected| / actual. */
  medianAbsError: number | null;
  /** Share of runs where actual exceeded projected by more than 10 %. */
  underProjected: number | null;
}

export interface ClassReport {
  taskKind: string;
  runs: number;
  basis: Record<string, number>;
  cpu: ErrorSummary;
  network: ErrorSummary;
  storage: ErrorSummary;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r3 = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);

export function errorSummary(pairs: Array<[number | null, number | null]>): ErrorSummary {
  const ok = pairs.filter(([p, a]) => p != null && a != null && p > 0 && a > 0) as Array<[number, number]>;
  if (!ok.length) return { runs: 0, medianRatio: null, medianAbsError: null, underProjected: null };
  return {
    runs: ok.length,
    medianRatio: r3(median(ok.map(([p, a]) => a / p))),
    medianAbsError: r3(median(ok.map(([p, a]) => Math.abs(a - p) / a))),
    underProjected: r3(ok.filter(([p, a]) => a > p * 1.1).length / ok.length),
  };
}

export function summarizeProjection(rows: ProjectionRow[]): ClassReport[] {
  const kinds = [...new Set(rows.map((r) => r.taskKind))].sort();
  return kinds.map((k) => {
    const mine = rows.filter((r) => r.taskKind === k);
    const basis: Record<string, number> = {};
    for (const r of mine) basis[r.basis ?? 'unknown'] = (basis[r.basis ?? 'unknown'] ?? 0) + 1;
    return {
      taskKind: k, runs: mine.length, basis,
      cpu: errorSummary(mine.map((r) => [r.projectedCpuUnits, r.actualCpuUnitsP95])),
      network: errorSummary(mine.map((r) => [r.projectedNetBps, r.actualNetBpsP95])),
      storage: errorSummary(mine.map((r) => [r.projectedStoreBytesPerHour, r.actualOutBpsMean != null ? (r.actualOutBpsMean / 8) * 3600 : null])),
    };
  });
}
