// ============================================================================
//  THE FLEET AS THE PLANNERS SEE IT.
//
//  One snapshot shape feeds both decisions: where a NEW stream goes
//  (placementPlanner.ts) and whether RUNNING streams can be combined onto
//  fewer servers (consolidation.ts). snapshot.ts builds it from the database.
//
//  Two readings of "how busy is this server", and the difference matters:
//
//    trusted       what the server was MEASURED doing (p95 over a full window
//                  with no gaps). Consolidation only ever moves streams on
//                  this, because moving a live stream on a guess is how
//                  viewers get hurt.
//    conservative  the larger of the measurement and the sum of the estimates
//                  of everything on it. Placement uses this so a server that
//                  booted five minutes ago (no full window yet) can still be
//                  filled, which is the whole point of packing: otherwise every
//                  new stream in a busy hour would get its own fresh server.
//
//  Pure: no DB, no clock, no IO.
// ============================================================================
import type { Capacity, Occupancy, Reservation, StreamLoad } from './capacity';

export type Lifecycle = 'spot' | 'on_demand';

export interface TaskSnapshot {
  instanceId: string;
  streamId: string;
  accountId: string | null;
  kind: 'transcode' | 'package_only' | 'radio' | 'captions' | 'thumbnailer';
  reservation: Reservation;
  /** The model's load for this task (estimate, or calibrated from history). */
  load: StreamLoad;
  /** Measured p95 for THIS task, when the provider reports per-task stats. */
  observedCpuUnitsP95: number | null;
  observedNetBpsP95: number | null;
  ingest: 'push' | 'pull';
  /** Auto connect armed AND server/input/encoder/output all healthy right now. */
  healthy: boolean;
  /** On backup or spliced filler: the source is already in trouble. */
  onFallback: boolean;
  drm: boolean;
  dedicated: boolean;
  /** Minutes until an event's window closes; null for 24/7 channels. */
  endsInMinutes: number | null;
  /** Minutes since this stream last moved host; null if never. */
  minutesSinceMove: number | null;
  /** Placed by a launch in the last few minutes and not yet seen by telemetry. */
  pending: boolean;
  /**
   * Task disk this stream will hold by the end of the planning horizon (MiB):
   * what it has written so far plus what it will write, from its storage
   * projection. Undefined for tasks launched before storage was projected.
   */
  diskMibAtHorizon?: number;
}

export interface HostSnapshot {
  id: string;
  /** EC2 instance id (i-...), the handle ECS placement constraints use. */
  externalId: string;
  /** 'shared' or 'dedicated:<accountId>'. */
  pool: string;
  lifecycle: Lifecycle;
  capacityProvider: string | null;
  instanceType: string | null;
  availabilityZone: string | null;
  gpu: boolean;
  capacity: Capacity;
  /** Host p95 over the window in absolute units; null when not measured. */
  observed: { cpuUnitsP95: number; netBpsP95: number; windowMinutes: number; coverage: number } | null;
  /** Scale-in protected for another reason (e.g. the on-demand base host). */
  pinned: boolean;
  tasks: TaskSnapshot[];
}

export interface TrustPolicy { minWindowMinutes: number; minSampleCoverage: number }
export const DEFAULT_TRUST: TrustPolicy = { minWindowMinutes: 30, minSampleCoverage: 0.9 };

/** A full window of readings with no meaningful gaps. A gap is never idleness. */
export function telemetryTrusted(h: HostSnapshot, p: TrustPolicy = DEFAULT_TRUST): boolean {
  return !!h.observed && h.observed.windowMinutes >= p.minWindowMinutes && h.observed.coverage >= p.minSampleCoverage
    && !h.tasks.some((t) => t.pending);
}

/** A task's best-known load: its own measurement when there is one, never below the model. */
export function taskLoad(t: TaskSnapshot): StreamLoad {
  const cpu = Math.max(t.load.cpuUnits, t.observedCpuUnitsP95 ?? 0);
  const estNet = t.load.netInBps + t.load.netOutBps;
  const net = Math.max(estNet, t.observedNetBpsP95 ?? 0);
  const k = estNet > 0 ? net / estNet : 1;
  return { ...t.load, cpuUnits: cpu, netInBps: Math.round(t.load.netInBps * k), netOutBps: Math.round(t.load.netOutBps * k) };
}

function reservedOf(h: HostSnapshot): Reservation {
  return h.tasks.reduce((a, t) => ({
    cpuUnits: a.cpuUnits + t.reservation.cpuUnits,
    memoryMib: a.memoryMib + t.reservation.memoryMib,
    gpus: a.gpus + t.reservation.gpus,
  }), { cpuUnits: 0, memoryMib: 0, gpus: 0 });
}

/** What the server is carrying, read the way the caller needs (see header). */
export function occupancyOf(h: HostSnapshot, mode: 'trusted' | 'conservative', excludeInstanceIds: Set<string> = new Set()): Occupancy | null {
  const tasks = h.tasks.filter((t) => !excludeInstanceIds.has(t.instanceId));
  const est = tasks.reduce((a, t) => {
    const l = taskLoad(t);
    return { cpu: a.cpu + l.cpuUnits, net: a.net + l.netInBps + l.netOutBps, gpu: a.gpu + l.gpuShare, disk: a.disk + (t.diskMibAtHorizon ?? 0) };
  }, { cpu: 0, net: 0, gpu: 0, disk: 0 });
  const reserved = reservedOf({ ...h, tasks });
  if (mode === 'trusted') {
    if (!telemetryTrusted(h)) return null;
    // Removing a task from a measured host removes its measured share too.
    const removed = h.tasks.filter((t) => excludeInstanceIds.has(t.instanceId)).map(taskLoad);
    const rmCpu = removed.reduce((s, l) => s + l.cpuUnits, 0);
    const rmNet = removed.reduce((s, l) => s + l.netInBps + l.netOutBps, 0);
    return {
      reserved, tasks: tasks.length, gpuShare: est.gpu, diskMib: est.disk,
      cpuUnits: Math.max(0, h.observed!.cpuUnitsP95 - rmCpu),
      netBps: Math.max(0, h.observed!.netBpsP95 - rmNet),
    };
  }
  return {
    reserved, tasks: tasks.length, gpuShare: est.gpu, diskMib: est.disk,
    cpuUnits: Math.max(est.cpu, h.observed?.cpuUnitsP95 ?? 0),
    netBps: Math.max(est.net, h.observed?.netBpsP95 ?? 0),
  };
}

/** Instance family (c7i.xlarge -> c7i). */
export function family(instanceType: string | null): string {
  return (instanceType ?? 'unknown').split('.')[0];
}
