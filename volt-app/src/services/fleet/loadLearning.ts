// ============================================================================
//  LOAD LEARNING: read what ran, fit the load model, report its error.
//
//  The database half of loadFit.ts and projectionReport.ts. Runs are read
//  from instances (the estimate written at launch, in placement_decision)
//  joined to host_samples taken while the host carried that one task alone,
//  the only per-task reading available without per-container metrics.
//
//  The fit is cached for ten minutes: it changes as runs accumulate over
//  hours and days, and a start should not wait on a 30-day scan.
// ============================================================================
import { query } from '../../db';
import { config } from '../../config';
import { fitLoadModel, type LoadFits, type RunObservation } from './loadFit';
import { summarizeProjection, type ClassReport, type ProjectionRow } from './projectionReport';
import { family } from './fleetModel';
import type { PlacementPolicy } from './placementPlanner';
import type { LoadLine } from './streamLoad';

const CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; fits: LoadFits } | null = null;

/** Every finished or running task of the last `days` days with solo-host readings. */
export async function observedRuns(days = 30): Promise<RunObservation[]> {
  const rows = await query<{ instance_type: string | null; lines: LoadLine[] | null; cpu: string | null; net: string | null; samples: number }>(
    `SELECT h.instance_type,
            COALESCE(i.placement_decision->'baseLines', i.placement_decision->'lines') AS lines,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY hs.cpu_pct / 100.0 * h.vcpus * 1024) AS cpu,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(hs.net_in_bps,0) + COALESCE(hs.net_out_bps,0)) AS net,
            COUNT(hs.id)::int AS samples
       FROM instances i
       JOIN compute_hosts h ON h.id = i.host_id
       JOIN host_samples hs ON hs.host_id = h.id
                           AND hs.at BETWEEN i.launched_at + interval '5 minutes' AND COALESCE(i.terminated_at, now())
                           AND hs.tasks_on_host = 1 AND hs.cpu_pct IS NOT NULL
      WHERE i.launched_at > now() - make_interval(days => $1)
        AND jsonb_typeof(COALESCE(i.placement_decision->'baseLines', i.placement_decision->'lines')) = 'array'
        AND h.vcpus IS NOT NULL
      GROUP BY i.id, h.instance_type, i.placement_decision`,
    [days]
  );
  const tickH = config.orchestrator.fleetTickSeconds / 3600;
  return rows
    .filter((r) => r.cpu != null && Array.isArray(r.lines))
    .map((r) => ({
      family: family(r.instance_type),
      lines: r.lines!,
      cpuUnitsP95: Number(r.cpu),
      netBpsP95: r.net != null ? Number(r.net) : null,
      hours: r.samples * tickH,
    }));
}

/** The learned fit, refreshed every ten minutes. */
export async function currentLoadFits(force = false): Promise<LoadFits> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.fits;
  const fits = fitLoadModel(await observedRuns());
  cached = { at: Date.now(), fits };
  return fits;
}

/** Forget the cached fit (tests, and after a bulk import of history). */
export function resetLoadFitCache(): void { cached = null; }

/**
 * The family a new stream is sized for: the first type of the first shared
 * pool with the right hardware, which is where placement prefers to put it
 * (and where a new server comes from). A stream that lands on another family
 * is measured there, and that family's fit catches up.
 */
export function familyForPlacement(p: PlacementPolicy, gpu: boolean): string | null {
  const spec = p.pools.find((s) => s.pool === 'shared' && s.gpu === gpu && s.types.length);
  return spec ? family(spec.types[0]) : null;
}

/** Projection against actual, per class of work, over the last `days` days. */
export async function projectionReport(days = 30): Promise<{ days: number; classes: ClassReport[] }> {
  const rows = await query<{
    task_kind: string | null; basis: string | null; est_cpu: number | null; est_net: string | null; est_store: string | null;
    cpu: string | null; net: string | null; out_mean: string | null;
  }>(
    `SELECT i.task_kind, i.load_basis AS basis, i.est_cpu_units AS est_cpu,
            (COALESCE(i.est_net_in_bps,0) + COALESCE(i.est_net_out_bps,0)) AS est_net,
            (i.placement_decision->'storage'->>'s3BytesPerHour') AS est_store,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY hs.cpu_pct / 100.0 * h.vcpus * 1024) AS cpu,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(hs.net_in_bps,0) + COALESCE(hs.net_out_bps,0)) AS net,
            AVG(hs.net_out_bps) AS out_mean
       FROM instances i
       JOIN compute_hosts h ON h.id = i.host_id
       JOIN host_samples hs ON hs.host_id = h.id
                           AND hs.at BETWEEN i.launched_at + interval '5 minutes' AND COALESCE(i.terminated_at, now())
                           AND hs.tasks_on_host = 1 AND hs.cpu_pct IS NOT NULL
      WHERE i.launched_at > now() - make_interval(days => $1) AND h.vcpus IS NOT NULL
      GROUP BY i.id`,
    [days]
  );
  const n = (v: unknown) => (v == null ? null : Number(v));
  const data: ProjectionRow[] = rows.map((r) => ({
    taskKind: r.task_kind ?? 'unknown', basis: r.basis,
    projectedCpuUnits: n(r.est_cpu), actualCpuUnitsP95: n(r.cpu),
    projectedNetBps: n(r.est_net) || null, actualNetBpsP95: n(r.net),
    projectedStoreBytesPerHour: n(r.est_store), actualOutBpsMean: n(r.out_mean),
  }));
  return { days, classes: summarizeProjection(data) };
}
