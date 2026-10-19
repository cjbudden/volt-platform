// ============================================================================
//  PLACEMENT: which server a new stream starts on.
//
//  The cheapest fleet is the one with the fewest servers running, so a new
//  stream goes onto a server that is ALREADY RUNNING and has room, and the
//  fullest such server wins (best fit). A new server is only started when no
//  running one can take the stream without the streams already on it
//  noticing. That one rule, applied at every start, prevents most of the
//  fragmentation consolidation would otherwise have to clean up later.
//
//  Which servers are eligible at all is decided by the stream and the plan,
//  never by the person starting it:
//
//    GPU            a stream encoding on NVENC (or the Whisper add-on) needs a
//                   GPU server; everything else must NOT take one, because a
//                   GPU server is several times the price of a CPU server.
//    ISOLATION      a dedicated-tier account only ever lands in its own pool;
//                   a shared-tier account never lands in someone's dedicated
//                   pool.
//    SPOT           24/7 channels run on on-demand capacity by default. A Spot
//                   reclaim gives two minutes' notice and today a restart is a
//                   visible interruption, so Spot is reserved for work that
//                   tolerates it: events (on-demand fallback), radio,
//                   thumbnails. Configurable per deployment.
//
//  Pure: no DB, no clock, no IO.
// ============================================================================
import { fits, soloFit, DEFAULT_FIT, instanceProfile, capacityOf, type FitPolicy, type Reservation, type StreamLoad } from './capacity';
import { occupancyOf, type HostSnapshot, type Lifecycle } from './fleetModel';

export type StreamClass = 'channel' | 'event' | 'radio' | 'captions' | 'thumbnailer';

export interface PlacementRequest {
  streamId: string;
  streamClass: StreamClass;
  accountId: string | null;
  /** 'shared' (default) or 'dedicated', from the account's plan tier. */
  isolation: 'shared' | 'dedicated';
  load: StreamLoad;
  reservation: Reservation;
  needsGpu: boolean;
}

/**
 * A pool of servers ECS can scale: one capacity provider and the instance
 * types its Auto Scaling group may launch. A new server can be ANY of those
 * types, so a stream only goes to a pool whose SMALLEST type holds it.
 */
export interface PoolSpec {
  provider: string;
  lifecycle: Lifecycle;
  gpu: boolean;
  /** 'shared' or 'dedicated:<accountId>'. */
  pool: string;
  /** Smallest first. */
  types: string[];
}

export interface PlacementPolicy {
  fit: FitPolicy;
  spotForChannels: boolean;
  pools: PoolSpec[];
}

const SMALL = ['c7i.xlarge', 'c6i.xlarge', 'c5.xlarge'];
const LARGE = ['c7i.2xlarge', 'c6i.2xlarge', 'c5.2xlarge'];

/**
 * Two sizes per lifecycle. Small servers carry package-only work, radio and
 * light transcodes cheaply; a full 1080p x264 ladder needs more than a 4-vCPU
 * server can give within the ceiling, so it goes to the large pool. Order is
 * preference: small before large, so nothing gets a bigger server than it needs.
 */
export const DEFAULT_POOLS: PoolSpec[] = [
  { provider: 'volt-ondemand', lifecycle: 'on_demand', gpu: false, pool: 'shared', types: SMALL },
  { provider: 'volt-ondemand-large', lifecycle: 'on_demand', gpu: false, pool: 'shared', types: LARGE },
  { provider: 'volt-spot', lifecycle: 'spot', gpu: false, pool: 'shared', types: SMALL },
  { provider: 'volt-spot-large', lifecycle: 'spot', gpu: false, pool: 'shared', types: LARGE },
];

export const DEFAULT_PLACEMENT: PlacementPolicy = { fit: DEFAULT_FIT, spotForChannels: false, pools: DEFAULT_POOLS };

export type PlacementDecision =
  | {
      action: 'existing_host';
      hostId: string;
      ec2InstanceId: string;
      capacityProvider: string | null;
      lifecycle: Lifecycle;
      cpuAfterPct: number;
      netAfterPct: number;
      reason: string;
      considered: Array<{ hostId: string; reason: string }>;
    }
  | {
      action: 'new_host';
      capacityProvider: string;
      lifecycle: Lifecycle;
      /** The smallest instance type in the pool that holds this stream within the ceiling. */
      instanceType: string | null;
      reason: string;
      considered: Array<{ hostId: string; reason: string }>;
    }
  | { action: 'unplaceable'; reason: string; considered: Array<{ hostId: string; reason: string }> };

/** Lifecycles this stream may run on, in order of preference (cheapest acceptable first). */
export function lifecyclesFor(c: StreamClass, p: PlacementPolicy): Lifecycle[] {
  if (c === 'channel') return p.spotForChannels ? ['spot', 'on_demand'] : ['on_demand'];
  if (c === 'captions') return ['on_demand'];
  return ['spot', 'on_demand'];
}

export function poolFor(req: PlacementRequest): string {
  return req.isolation === 'dedicated' && req.accountId ? `dedicated:${req.accountId}` : 'shared';
}

const EMPTY = { reserved: { cpuUnits: 0, memoryMib: 0, gpus: 0 }, tasks: 0, cpuUnits: 0, netBps: 0, gpuShare: 0 };

/** Does EVERY type this pool can launch hold the stream within the ceiling? */
function poolHolds(spec: PoolSpec, add: { reservation: Reservation; load: StreamLoad }, fit: FitPolicy): boolean {
  return spec.types.length > 0 && spec.types.every((t) => {
    const cap = capacityOf(t, {});
    return !!cap && fits(cap, EMPTY, add, soloFit(fit)).ok;
  });
}

export function choosePlacement(req: PlacementRequest, hosts: HostSnapshot[], p: PlacementPolicy = DEFAULT_PLACEMENT): PlacementDecision {
  const considered: Array<{ hostId: string; reason: string }> = [];
  const pool = poolFor(req);
  const lifecycles = lifecyclesFor(req.streamClass, p);
  const add = { reservation: req.reservation, load: req.load };

  const candidates: Array<{ h: HostSnapshot; cpu: number; net: number; rank: number }> = [];
  for (const h of hosts) {
    if (h.pool !== pool) { considered.push({ hostId: h.id, reason: `different pool (${h.pool})` }); continue; }
    if (req.needsGpu !== h.gpu) { considered.push({ hostId: h.id, reason: req.needsGpu ? 'not a GPU server' : 'GPU server (kept for GPU work)' }); continue; }
    const rank = lifecycles.indexOf(h.lifecycle);
    if (rank < 0) { considered.push({ hostId: h.id, reason: `${h.lifecycle} not used for this kind of stream` }); continue; }
    const occ = occupancyOf(h, 'conservative')!;
    const f = fits(h.capacity, occ, add, p.fit);
    if (!f.ok) { considered.push({ hostId: h.id, reason: f.reason! }); continue; }
    candidates.push({ h, cpu: f.cpuAfter, net: f.netAfter, rank });
  }

  // Preferred lifecycle first, then the FULLEST server after placement (best
  // fit: the binding resource, CPU or network, closest to the ceiling).
  candidates.sort((a, b) => (a.rank - b.rank) || (Math.max(b.cpu, b.net) - Math.max(a.cpu, a.net)) || a.h.id.localeCompare(b.h.id));
  const best = candidates[0];
  if (best) {
    return {
      action: 'existing_host', hostId: best.h.id, ec2InstanceId: best.h.externalId,
      capacityProvider: best.h.capacityProvider, lifecycle: best.h.lifecycle,
      cpuAfterPct: Math.round(best.cpu * 100), netAfterPct: Math.round(best.net * 100),
      reason: `fits on a running server (CPU ${Math.round(best.cpu * 100)}%, network ${Math.round(best.net * 100)}% after)`,
      considered,
    };
  }

  // Nothing running can take it: a new server, in the cheapest pool that
  // matches this stream's pool, hardware and lifecycle and is big enough.
  for (const lc of lifecycles) {
    const specs = p.pools.filter((s) => s.pool === pool && s.gpu === req.needsGpu && s.lifecycle === lc);
    const spec = specs.find((s) => poolHolds(s, add, p.fit));
    if (spec) {
      return {
        action: 'new_host', capacityProvider: spec.provider, lifecycle: lc, instanceType: spec.types[0],
        reason: hosts.length ? 'no running server has room without affecting its streams' : 'no server running yet',
        considered,
      };
    }
  }
  const anyPool = p.pools.some((s) => s.pool === pool && s.gpu === req.needsGpu && lifecycles.includes(s.lifecycle));
  return {
    action: 'unplaceable', considered,
    reason: !anyPool
      ? (req.isolation === 'dedicated'
        ? 'this account is on a dedicated plan but no dedicated server pool is configured for it'
        : req.needsGpu ? 'this stream needs a GPU and no GPU server pool is configured' : 'no capacity pool is configured')
      : `this stream is larger than the biggest configured server can run within the ${Math.round(p.fit.soloCeiling * 100)}% sizing ceiling`,
  };
}

/** Smallest instance in a family that holds a load within the ceiling (sizing advice for people). */
export function smallestFitting(types: string[], load: StreamLoad, reservation: Reservation, fit: FitPolicy = DEFAULT_FIT): string | null {
  return types.find((t) => {
    const cap = capacityOf(t, {});
    return !!cap && !!instanceProfile(t) && fits(cap, EMPTY, { load, reservation }, soloFit(fit)).ok;
  }) ?? null;
}
