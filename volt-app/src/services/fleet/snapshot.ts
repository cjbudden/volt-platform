// ============================================================================
//  Build the planners' view of the fleet from the database.
//
//  Every number here is either an OBSERVATION (host_samples, placement) or a
//  stored ESTIMATE (the load model's figures written onto the instance row at
//  launch). Nothing is invented: a host without a known instance type and
//  without registered resources has no capacity and is left out, because a
//  guessed capacity would let placement fill a machine it knows nothing about.
// ============================================================================
import { query } from '../../db';
import { config } from '../../config';
import { capacityOf, isGpuType, type StreamLoad } from './capacity';
import type { HostSnapshot, TaskSnapshot, Lifecycle } from './fleetModel';
import type { ObservedHistory } from './streamLoad';
import { fleetSettings, type FleetSettings } from './placementConfig';
import { scratchMibAt } from './storageProjection';

interface HostRow {
  id: string; external_id: string; instance_type: string | null; availability_zone: string | null;
  lifecycle: Lifecycle | null; vcpus: string | number | null; memory_mib: number | null;
  cpu_p95: string | number | null; net_p95: string | number | null; samples: number; first_sample: Date | null;
}

interface TaskRow {
  id: string; host: string; stream_id: string; account_id: string | null; plan_tier: string | null;
  task_kind: TaskSnapshot['kind'] | null; capacity_provider: string | null;
  cpu_units: number | null; memory_mib: number | null; reserved_gpus: number | null;
  est_cpu_units: number | null; est_memory_mib: number | null; est_gpu_share: string | number | null;
  est_net_in_bps: string | number | null; est_net_out_bps: string | number | null; is_gpu: boolean | null;
  pending: boolean; armed: boolean; status: string | null; fallback_in_use: boolean | null;
  drm: boolean | null; protocol: string | null; ingest_url: string | null;
  ends_in_min: string | number | null; since_move_min: string | number | null;
  scratch_mib_per_hour: string | number | null; hours_running: string | number | null;
  vram_mib: string | number | null;
}

const n = (v: unknown) => (v == null ? null : Number(v));

/**
 * Pull vs push, from the primary source. A push source (RTMP, an SRT listener
 * or a stream key with no URL) is pointed AT the running task, so it cannot
 * move without the sender re-pointing. A pull source (HLS, DASH, NDI, 2110,
 * Icecast, SRT in caller mode) is fetched by whichever task is running.
 */
export function ingestModeOf(protocol: string | null, url: string | null): 'push' | 'pull' {
  const p = (protocol ?? '').toLowerCase();
  if (!url) return 'push';
  if (p === 'rtmp' || p === 'rtmps') return 'push';
  if (p === 'srt') return /0\.0\.0\.0|mode=listener/i.test(url) ? 'push' : 'pull';
  return 'pull';
}

export async function loadFleetSnapshot(s: FleetSettings = fleetSettings()): Promise<HostSnapshot[]> {
  const win = s.windowMinutes;
  const hosts = await query<HostRow>(
    `SELECT h.id, h.external_id, h.instance_type, h.availability_zone, h.lifecycle, h.vcpus, h.memory_mib,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY hs.cpu_pct) AS cpu_p95,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(hs.net_in_bps,0) + COALESCE(hs.net_out_bps,0)) AS net_p95,
            COUNT(hs.id)::int AS samples, MIN(hs.at) AS first_sample
       FROM compute_hosts h
       LEFT JOIN host_samples hs ON hs.host_id = h.id AND hs.at > now() - make_interval(mins => $1)
                                AND hs.cpu_pct IS NOT NULL
      WHERE h.state = 'up' AND h.kind = 'ec2' AND h.role = 'compute'
      GROUP BY h.id`,
    [win]
  );
  if (!hosts.length) return [];

  const tasks = await query<TaskRow>(
    `SELECT i.id, COALESCE(i.host_id, i.assigned_host_id) AS host,
            COALESCE(i.channel_id, i.event_id) AS stream_id, g.account_id, a.plan_tier,
            i.task_kind, i.capacity_provider, i.cpu_units, i.memory_mib, i.reserved_gpus,
            i.est_cpu_units, i.est_memory_mib, i.est_gpu_share, i.est_net_in_bps, i.est_net_out_bps, i.is_gpu,
            (i.host_id IS NULL) AS pending,
            (COALESCE(c.resume_armed_at, e.resume_armed_at) IS NOT NULL) AS armed,
            COALESCE(c.status::text, e.status::text) AS status,
            ss.fallback_in_use,
            COALESCE(op.drm_enabled, false) AS drm,
            si.protocol, si.ingest_url,
            CASE WHEN e.server_stop IS NOT NULL THEN EXTRACT(EPOCH FROM (e.server_stop - now())) / 60 END AS ends_in_min,
            CASE WHEN i.moved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (now() - i.moved_at)) / 60 END AS since_move_min,
            (i.placement_decision->'storage'->>'scratchMibPerHour')::float AS scratch_mib_per_hour,
            (i.placement_decision->>'vramMib')::float AS vram_mib,
            EXTRACT(EPOCH FROM (now() - i.launched_at)) / 3600 AS hours_running
       FROM instances i
       LEFT JOIN channels c ON c.id = i.channel_id
       LEFT JOIN events e ON e.id = i.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
       LEFT JOIN accounts a ON a.id = g.account_id
       LEFT JOIN output_profiles op ON op.id = g.output_profile_id
       LEFT JOIN stream_status ss ON ss.channel_id = i.channel_id OR ss.event_id = i.event_id
       LEFT JOIN LATERAL (
         SELECT protocol, ingest_url FROM stream_inputs x
          WHERE (x.channel_id = i.channel_id OR x.event_id = i.event_id) AND x.role = 'primary'
          ORDER BY x.rendition_bitrate_kbps DESC NULLS LAST LIMIT 1
       ) si ON true
      WHERE i.terminated_at IS NULL AND COALESCE(i.host_id, i.assigned_host_id) IS NOT NULL`
  );

  // Pool and provider of each host, from what its tasks were launched into.
  const providerOf = new Map<string, string>();
  for (const t of tasks) if (t.capacity_provider && !providerOf.has(t.host)) providerOf.set(t.host, t.capacity_provider);
  const specByProvider = new Map(s.placementPolicy.pools.map((p) => [p.provider, p]));
  const tickMin = Math.max(1, config.orchestrator.fleetTickSeconds / 60);

  const out: HostSnapshot[] = [];
  for (const h of hosts) {
    const cap = capacityOf(h.instance_type, { vcpus: n(h.vcpus), memoryMib: h.memory_mib }, { taskSlotsOverride: s.taskSlotsOverride, diskGib: s.placementPolicy.taskDiskGib });
    if (!cap) continue;
    const provider = providerOf.get(h.id) ?? null;
    const spec = provider ? specByProvider.get(provider) : undefined;
    const windowMinutes = h.first_sample ? Math.min(win, (Date.now() - new Date(h.first_sample).getTime()) / 60000) : 0;
    const observed = h.samples > 0 && h.cpu_p95 != null
      ? {
          cpuUnitsP95: (Number(h.cpu_p95) / 100) * cap.cpuUnits,
          netBpsP95: Number(h.net_p95 ?? 0),
          windowMinutes,
          coverage: Math.min(1, h.samples / Math.max(1, windowMinutes / tickMin)),
        }
      : null;
    const mine = tasks.filter((t) => t.host === h.id);
    out.push({
      id: h.id, externalId: h.external_id, pool: spec?.pool ?? 'shared',
      lifecycle: (h.lifecycle ?? spec?.lifecycle ?? 'on_demand') as Lifecycle,
      capacityProvider: provider, instanceType: h.instance_type, availabilityZone: h.availability_zone,
      gpu: isGpuType(h.instance_type), capacity: cap, observed, pinned: false,
      tasks: mine.map((t) => toTask(t, s)),
    });
  }
  return out;
}

function toTask(t: TaskRow, s: FleetSettings): TaskSnapshot {
  // A task launched before the load model existed has no estimate; its
  // reservation is the best stand-in for what it costs.
  const load: StreamLoad = {
    cpuUnits: t.est_cpu_units ?? t.cpu_units ?? 2048,
    memoryMib: t.est_memory_mib ?? t.memory_mib ?? 4096,
    gpuShare: n(t.est_gpu_share) ?? (t.is_gpu ? 1 : 0),
    gpus: t.reserved_gpus ?? (t.is_gpu ? 1 : 0),
    netInBps: n(t.est_net_in_bps) ?? 0,
    netOutBps: n(t.est_net_out_bps) ?? 0,
    // GPU memory a captions task holds (recorded at launch); what keeps
    // tasks sharing a GPU from overfilling it.
    ...(n(t.vram_mib) ? { vramMib: n(t.vram_mib)! } : {}),
  };
  return {
    instanceId: t.id, streamId: t.stream_id, accountId: t.account_id,
    kind: (t.task_kind ?? 'transcode') as TaskSnapshot['kind'],
    reservation: { cpuUnits: t.cpu_units ?? load.cpuUnits, memoryMib: t.memory_mib ?? load.memoryMib, gpus: load.gpus },
    load, observedCpuUnitsP95: null, observedNetBpsP95: null,
    ingest: ingestModeOf(t.protocol, t.ingest_url),
    healthy: t.armed && t.status === 'live',
    onFallback: !!t.fallback_in_use,
    drm: !!t.drm,
    dedicated: !!t.plan_tier && s.dedicatedTiers.includes(t.plan_tier),
    endsInMinutes: n(t.ends_in_min),
    minutesSinceMove: n(t.since_move_min),
    pending: t.pending,
    ...(t.scratch_mib_per_hour != null ? {
      diskMibAtHorizon: scratchMibAt(Number(t.scratch_mib_per_hour), n(t.hours_running) ?? 0,
        horizonHours(s.diskHorizonHours, n(t.ends_in_min))),
    } : {}),
  };
}

/** Hours of writing still to come: the horizon, or less when an event's window closes sooner. */
export function horizonHours(horizon: number, endsInMinutes: number | null): number {
  return endsInMinutes != null ? Math.max(0, Math.min(horizon, endsInMinutes / 60)) : horizon;
}

/**
 * What streams with this signature ACTUALLY used, read from hosts that were
 * carrying that one task alone (so the host reading is the task reading).
 * That is the only per-task measurement available without per-container
 * metrics, and it is exact when it exists.
 */
export async function signatureHistory(signature: string): Promise<ObservedHistory | null> {
  const r = await query<{ cpu: string | null; mem: string | null; net: string | null; runs: number; samples: number }>(
    `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY hs.cpu_pct / 100.0 * h.vcpus * 1024) AS cpu,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY hs.mem_pct / 100.0 * h.memory_mib) AS mem,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(hs.net_in_bps,0) + COALESCE(hs.net_out_bps,0)) AS net,
            COUNT(DISTINCT i.id)::int AS runs, COUNT(hs.id)::int AS samples
       FROM instances i
       JOIN compute_hosts h ON h.id = i.host_id
       JOIN host_samples hs ON hs.host_id = h.id
                           AND hs.at BETWEEN i.launched_at + interval '5 minutes' AND COALESCE(i.terminated_at, now())
                           AND hs.tasks_on_host = 1 AND hs.cpu_pct IS NOT NULL
      WHERE i.load_signature = $1 AND i.launched_at > now() - interval '30 days'`,
    [signature]
  );
  const row = r[0];
  if (!row || row.cpu == null) return null;
  return {
    cpuUnitsP95: Number(row.cpu), memoryMibP95: row.mem != null ? Number(row.mem) : null,
    netBpsP95: row.net != null ? Number(row.net) : null,
    runs: row.runs, hours: (row.samples * config.orchestrator.fleetTickSeconds) / 3600,
  };
}
