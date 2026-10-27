// ============================================================================
//  CAPACITY: the shared vocabulary of load, servers and "does it fit".
//
//  Three files decide where streams run, and all three answer one question
//  ("can this server take that load without the streams already on it
//  noticing?"). The answer lives HERE, once, so placement at launch and
//  consolidation later can never disagree about what "fits" means. If they
//  did, consolidation would move a stream onto a server that placement would
//  have refused, or placement would fill a server that consolidation then
//  tries to empty, and the fleet would churn.
//
//  Units are absolute, never percentages: ECS CPU units (1024 = one vCPU),
//  MiB, bits per second, and GPU fractions. A percentage only means something
//  against a particular machine, and a stream moves between machines.
//
//  Pure: no DB, no clock, no IO.
// ============================================================================

/** What one stream costs to run, in the units a server is measured in. */
export interface StreamLoad {
  /** Steady-state CPU the work needs (1024 = one vCPU). */
  cpuUnits: number;
  memoryMib: number;
  /** Share of one GPU's encode/decode engine (0..1), 0 when no GPU is used. */
  gpuShare: number;
  /** Whole GPUs ECS must reserve for the task (0 or 1). */
  gpus: number;
  netInBps: number;
  netOutBps: number;
}

/** What ECS is asked to reserve for the task: the estimate plus headroom. */
export interface Reservation {
  cpuUnits: number;
  memoryMib: number;
  gpus: number;
}

/** What a server can hold. */
export interface Capacity {
  cpuUnits: number;
  memoryMib: number;
  /** Sustained (baseline) network, not the burst figure on the price page. */
  netBps: number;
  gpus: number;
  /** How many awsvpc tasks it can carry at all (ENIs - 1 without trunking). */
  taskSlots: number;
  /**
   * Task disk the encoders share (MiB), when known (FLEET_TASK_DISK_GIB).
   * Undefined means not checked: a guessed disk size would refuse or accept
   * streams for a reason nobody measured.
   */
  diskMib?: number;
}

export interface InstanceProfile {
  vcpus: number;
  memoryMib: number;
  netBaselineGbps: number;
  enis: number;
  gpus: number;
}

/**
 * Indicative instance facts for the types the encoder fleet uses. Baseline
 * network is the sustained figure ("up to 12.5 Gbps" instances sustain far
 * less), because a live encoder runs flat out for hours and burst credits run
 * out. A host's REGISTERED cpu and memory from ECS win over this table when
 * known; the table only fills what the provider did not report.
 */
export const INSTANCE_PROFILES: Record<string, InstanceProfile> = {
  'c5.large':     { vcpus: 2,  memoryMib: 4096,  netBaselineGbps: 0.75,   enis: 3, gpus: 0 },
  'c5.xlarge':    { vcpus: 4,  memoryMib: 8192,  netBaselineGbps: 1.25,   enis: 4, gpus: 0 },
  'c5.2xlarge':   { vcpus: 8,  memoryMib: 16384, netBaselineGbps: 2.5,    enis: 4, gpus: 0 },
  'c5n.xlarge':   { vcpus: 4,  memoryMib: 10752, netBaselineGbps: 5,      enis: 4, gpus: 0 },
  'c5n.2xlarge':  { vcpus: 8,  memoryMib: 21504, netBaselineGbps: 10,     enis: 4, gpus: 0 },
  'c6i.large':    { vcpus: 2,  memoryMib: 4096,  netBaselineGbps: 0.781,  enis: 3, gpus: 0 },
  'c6i.xlarge':   { vcpus: 4,  memoryMib: 8192,  netBaselineGbps: 1.5625, enis: 4, gpus: 0 },
  'c6i.2xlarge':  { vcpus: 8,  memoryMib: 16384, netBaselineGbps: 3.125,  enis: 4, gpus: 0 },
  'c6i.4xlarge':  { vcpus: 16, memoryMib: 32768, netBaselineGbps: 6.25,   enis: 8, gpus: 0 },
  'c7i.large':    { vcpus: 2,  memoryMib: 4096,  netBaselineGbps: 0.781,  enis: 3, gpus: 0 },
  'c7i.xlarge':   { vcpus: 4,  memoryMib: 8192,  netBaselineGbps: 1.5625, enis: 4, gpus: 0 },
  'c7i.2xlarge':  { vcpus: 8,  memoryMib: 16384, netBaselineGbps: 3.125,  enis: 4, gpus: 0 },
  'c7i.4xlarge':  { vcpus: 16, memoryMib: 32768, netBaselineGbps: 6.25,   enis: 8, gpus: 0 },
  'g4dn.xlarge':  { vcpus: 4,  memoryMib: 16384, netBaselineGbps: 5,      enis: 3, gpus: 1 },
  'g4dn.2xlarge': { vcpus: 8,  memoryMib: 32768, netBaselineGbps: 10,     enis: 3, gpus: 1 },
  'g5.xlarge':    { vcpus: 4,  memoryMib: 16384, netBaselineGbps: 2.5,    enis: 4, gpus: 1 },
};

export function instanceProfile(type: string | null | undefined): InstanceProfile | null {
  return (type && INSTANCE_PROFILES[type]) || null;
}

export function isGpuType(type: string | null | undefined): boolean {
  return (instanceProfile(type)?.gpus ?? 0) > 0 || /^(g\d|p\d)/.test(type ?? '');
}

/**
 * A server's capacity from what ECS registered (cpu, memory) and the instance
 * table (network, ENIs, GPUs). Null when the instance type is unknown AND the
 * provider reported nothing, because a guessed capacity is worse than none:
 * it would let placement fill a server it knows nothing about.
 */
export function capacityOf(
  instanceType: string | null,
  registered: { vcpus?: number | null; memoryMib?: number | null },
  opts: { taskSlotsOverride?: number | null; diskGib?: number | null } = {},
): Capacity | null {
  const p = instanceProfile(instanceType);
  const vcpus = registered.vcpus ?? p?.vcpus ?? null;
  const mem = registered.memoryMib ?? (p ? Math.floor(p.memoryMib * 0.94) : null); // ECS agent + OS
  if (vcpus == null || mem == null || !p) return null;
  return {
    cpuUnits: Math.round(vcpus * 1024),
    memoryMib: mem,
    netBps: p.netBaselineGbps * 1e9,
    gpus: p.gpus,
    taskSlots: opts.taskSlotsOverride ?? Math.max(1, p.enis - 1),
    ...(opts.diskGib ? { diskMib: Math.round(opts.diskGib * 1024) } : {}),
  };
}

export interface FitPolicy {
  /** Observed (or estimated) CPU and network after the change must stay at or under this share. */
  ceiling: number;
  /** Incoming load is multiplied by this before it is added. */
  safetyFactor: number;
  /** Several tasks share one GPU's NVENC engine (no whole-GPU ECS reservation). */
  gpuSharing: boolean;
  /**
   * Sizing a NEW, empty server for one stream: the 80% sizing ceiling with no
   * safety factor, because there are no neighbours to protect and the
   * reservation already carries 30% headroom. Without this a full 1080p ladder
   * would be refused by every server size it actually runs well on.
   */
  soloCeiling: number;
}

export const DEFAULT_FIT: FitPolicy = { ceiling: 0.65, safetyFactor: 1.25, gpuSharing: false, soloCeiling: 0.8 };

/** The fit policy for an empty server sized for one stream. */
export function soloFit(p: FitPolicy): FitPolicy {
  return { ...p, ceiling: Math.max(p.ceiling, p.soloCeiling), safetyFactor: 1 };
}

/** What a server is carrying right now, in absolute units. */
export interface Occupancy {
  reserved: Reservation;
  tasks: number;
  /** CPU and network IN USE (observed p95, or the sum of estimates when not yet observed). */
  cpuUnits: number;
  netBps: number;
  gpuShare: number;
  /** Task disk the streams on it will hold over the planning horizon (MiB). */
  diskMib?: number;
}

/**
 * Share of the task disk placement lets streams fill. The rest is the OS,
 * the ECS agent, container images and logs, which also live on that volume.
 */
export const DISK_USABLE = 0.85;

export interface FitResult { ok: boolean; reason: string | null; cpuAfter: number; netAfter: number }

/**
 * THE FIT TEST. Both halves must hold:
 *
 *   RESERVATION  what ECS will enforce. Fails as a RunTask error if ignored.
 *   USAGE        what the streams already on the server will FEEL. A server
 *                can have reservation room and still be busy (reservations
 *                set too small), and it is the viewers on that server who
 *                would pay for a placement that ignored it.
 *
 * Network counts in AND out: a packager pulls a whole ladder in and pushes it
 * all back out to S3, so on package-only work the NIC, not the CPU, is what
 * runs out first.
 */
export function fits(cap: Capacity, occ: Occupancy, add: { reservation: Reservation; load: StreamLoad; diskMib?: number }, p: FitPolicy = DEFAULT_FIT): FitResult {
  const cpuAfter = (occ.cpuUnits + add.load.cpuUnits * p.safetyFactor) / cap.cpuUnits;
  const netAdd = (add.load.netInBps + add.load.netOutBps) * p.safetyFactor;
  const netAfter = (occ.netBps + netAdd) / cap.netBps;
  const no = (reason: string): FitResult => ({ ok: false, reason, cpuAfter, netAfter });

  if (occ.tasks + 1 > cap.taskSlots) return no('no task slot (network interfaces) left');
  if (occ.reserved.cpuUnits + add.reservation.cpuUnits > cap.cpuUnits) return no('CPU reservation would not fit');
  if (occ.reserved.memoryMib + add.reservation.memoryMib > cap.memoryMib) return no('memory reservation would not fit');
  if (add.load.gpuShare > 0 || add.reservation.gpus > 0) {
    if (cap.gpus < 1) return no('needs a GPU');
    if (!p.gpuSharing && occ.reserved.gpus + add.reservation.gpus > cap.gpus) return no('GPU already taken');
    if (p.gpuSharing && occ.gpuShare + add.load.gpuShare * p.safetyFactor > p.ceiling * cap.gpus) return no('GPU encoder would be too busy');
  }
  // DISK. The encoder keeps its whole run on the task disk while the sidecar
  // mirrors it to S3 (storageProjection.ts), so what matters is what every
  // stream on the server will have written by the end of the planning
  // horizon. No safety factor: the bitrates fix the bytes.
  if (cap.diskMib != null && (add.diskMib ?? 0) > 0 && (occ.diskMib ?? 0) + (add.diskMib ?? 0) > cap.diskMib * DISK_USABLE) {
    return no(`task disk would run short (${Math.round(((occ.diskMib ?? 0) + (add.diskMib ?? 0)) / 1024)} of ${Math.round(cap.diskMib / 1024)} GiB)`);
  }
  if (cpuAfter > p.ceiling) return no(`CPU would reach ${Math.round(cpuAfter * 100)}%`);
  if (netAfter > p.ceiling) return no(`network would reach ${Math.round(netAfter * 100)}%`);
  return { ok: true, reason: null, cpuAfter, netAfter };
}

/** Add a placed load to an occupancy (for planning several placements in a row). */
export function occupy(occ: Occupancy, add: { reservation: Reservation; load: StreamLoad; diskMib?: number }): Occupancy {
  return {
    tasks: occ.tasks + 1,
    reserved: {
      cpuUnits: occ.reserved.cpuUnits + add.reservation.cpuUnits,
      memoryMib: occ.reserved.memoryMib + add.reservation.memoryMib,
      gpus: occ.reserved.gpus + add.reservation.gpus,
    },
    cpuUnits: occ.cpuUnits + add.load.cpuUnits,
    netBps: occ.netBps + add.load.netInBps + add.load.netOutBps,
    gpuShare: occ.gpuShare + add.load.gpuShare,
    diskMib: (occ.diskMib ?? 0) + (add.diskMib ?? 0),
  };
}

export const ZERO_LOAD: StreamLoad = { cpuUnits: 0, memoryMib: 0, gpuShare: 0, gpus: 0, netInBps: 0, netOutBps: 0 };

export function sumLoads(loads: StreamLoad[]): StreamLoad {
  return loads.reduce((a, l) => ({
    cpuUnits: a.cpuUnits + l.cpuUnits, memoryMib: a.memoryMib + l.memoryMib,
    gpuShare: a.gpuShare + l.gpuShare, gpus: a.gpus + l.gpus,
    netInBps: a.netInBps + l.netInBps, netOutBps: a.netOutBps + l.netOutBps,
  }), { ...ZERO_LOAD });
}
