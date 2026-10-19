/**
 * Fleet placement and consolidation, for the SaaS admin (requirePlatform).
 *
 *   GET /api/platform/fleet-plan             latest consolidation advice + 7-day summary
 *   GET /api/platform/fleet-plan/hosts       every server: capacity, measured and estimated load, streams
 *   GET /api/platform/fleet-plan/stream/:id  why a stream is sized and placed the way it is
 *
 * Read-only. Nothing here moves a stream (CONSOLIDATION.md: advise mode).
 */
import { Router } from 'express';
import { query } from '../db';
import { requirePlatform } from '../auth/platform';
import { asyncHandler } from '../util/http';
import { latestConsolidation, consolidationHistory } from '../services/fleet/advisor';
import { loadFleetSnapshot } from '../services/fleet/snapshot';
import { occupancyOf, telemetryTrusted } from '../services/fleet/fleetModel';
import { fleetSettings } from '../services/fleet/placementConfig';

export const fleetPlanRouter = Router();

fleetPlanRouter.get('/', ...requirePlatform('read_only'), asyncHandler(async (_req, res) => {
  const s = fleetSettings();
  res.json({
    mode: s.consolidate,
    placement: s.placement,
    latest: await latestConsolidation(),
    last7Days: await consolidationHistory(7),
    policy: { consolidation: s.consolidationPolicy, pools: s.placementPolicy.pools, spotForChannels: s.placementPolicy.spotForChannels },
  });
}));

fleetPlanRouter.get('/hosts', ...requirePlatform('read_only'), asyncHandler(async (_req, res) => {
  const hosts = await loadFleetSnapshot();
  const pct = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 1000) / 10 : null);
  res.json(hosts.map((h) => {
    const est = occupancyOf(h, 'conservative')!;
    return {
      id: h.id, ec2InstanceId: h.externalId, instanceType: h.instanceType, pool: h.pool, lifecycle: h.lifecycle,
      capacityProvider: h.capacityProvider, availabilityZone: h.availabilityZone, gpu: h.gpu,
      capacity: h.capacity,
      measured: h.observed ? {
        cpuPct: pct(h.observed.cpuUnitsP95, h.capacity.cpuUnits), netPct: pct(h.observed.netBpsP95, h.capacity.netBps),
        windowMinutes: Math.round(h.observed.windowMinutes), coverage: Math.round(h.observed.coverage * 100) / 100,
        trusted: telemetryTrusted(h),
      } : null,
      planned: {
        cpuPct: pct(est.cpuUnits, h.capacity.cpuUnits), netPct: pct(est.netBps, h.capacity.netBps),
        reservedCpuPct: pct(est.reserved.cpuUnits, h.capacity.cpuUnits), reservedMemPct: pct(est.reserved.memoryMib, h.capacity.memoryMib),
        tasks: est.tasks, slots: h.capacity.taskSlots,
      },
      streams: h.tasks.map((t) => ({ streamId: t.streamId, kind: t.kind, ingest: t.ingest, healthy: t.healthy, load: t.load, reservation: t.reservation, pending: t.pending })),
    };
  }));
}));

fleetPlanRouter.get('/stream/:id', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT id, task_arn, task_kind, role, launched_at, cpu_units, memory_mib, reserved_gpus,
            est_cpu_units, est_memory_mib, est_gpu_share, est_net_in_bps, est_net_out_bps,
            load_basis, load_signature, host_id, assigned_host_id, capacity_provider, instance_type, placement_decision
       FROM instances WHERE (channel_id = $1 OR event_id = $1) AND terminated_at IS NULL
      ORDER BY launched_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));
