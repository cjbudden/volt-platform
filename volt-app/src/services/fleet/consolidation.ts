// ============================================================================
//  FLEET CONSOLIDATION PLANNER.
//
//  Decides whether streams on several under-used servers can be combined onto
//  fewer servers, and if so exactly which stream goes where. It PLANS ONLY:
//  nothing here launches, stops or terminates anything. The executor (the
//  make-before-break handoff in CONSOLIDATION.md) consumes the plan.
//
//  The rules (Christian, 13 Oct 2026): consolidate only when MULTIPLE servers
//  are below a usage level, only streams whose needs and usage are similar,
//  never in a way that affects the performance of streams already running,
//  and never with downtime or a change in quality or experience for viewers.
//
//    MULTIPLE      at least `minUnderusedHosts` under-used hosts in the SAME
//                  class. One quiet server alone is never touched.
//    SIMILAR       hosts are grouped into a class (pool, lifecycle, instance
//                  family, GPU or not, AZ); streams only move inside it.
//    NO IMPACT     the target must pass capacity.fits() on its MEASURED load
//                  (never an estimate when moving live streams): reservation,
//                  task slots, and CPU and network after the move under the
//                  ceiling. This is the same test placement uses at launch.
//    NO DOWNTIME   only streams the handoff can carry invisibly are movable
//                  (pull ingest, healthy, not on filler, no DRM in v1, not
//                  dedicated). Anything else waits for a natural boundary.
//    ALL OR NONE   a host is only drained if EVERY task on it can be placed.
//
//  Pure: no DB, no clock, no IO. The caller builds the snapshot (snapshot.ts).
// ============================================================================
import { fits, occupy, DEFAULT_FIT, type FitPolicy, type Occupancy } from './capacity';
import { occupancyOf, telemetryTrusted, taskLoad, family, DEFAULT_TRUST, type HostSnapshot, type TaskSnapshot, type TrustPolicy } from './fleetModel';

export interface ConsolidationPolicy {
  /** A host is under-used when its p95 CPU AND p95 network are both below these shares. */
  underusedCpu: number;
  underusedNet: number;
  /** How many under-used hosts in one class before anything moves. "Multiple" = 2+. */
  minUnderusedHosts: number;
  trust: TrustPolicy;
  fit: FitPolicy;
  eventEndingSoonMinutes: number;
  moveCooldownMinutes: number;
  maxHostsPerPass: number;
}

export const DEFAULT_POLICY: ConsolidationPolicy = {
  underusedCpu: 0.30,
  underusedNet: 0.30,
  minUnderusedHosts: 2,
  trust: DEFAULT_TRUST,
  fit: DEFAULT_FIT,
  eventEndingSoonMinutes: 45,
  moveCooldownMinutes: 360,
  maxHostsPerPass: 1,
};

export interface Move { instanceId: string; streamId: string; from: string; to: string }
export interface HostVerdict { hostId: string; reason: string }

export interface ConsolidationPlan {
  /** Hosts that will be empty once the moves are done (ECS then scales them in). */
  drain: string[];
  moves: Move[];
  skipped: HostVerdict[];
  classes: Array<{ key: string; hosts: number; underused: number; triggered: boolean }>;
  /** Servers that would stop running, per pass, if the plan were carried out. */
  serversSaved: number;
}

/** The similarity key. Two hosts only ever exchange streams inside one class. */
export function classKey(h: HostSnapshot): string {
  return [h.pool, h.lifecycle, family(h.instanceType), h.gpu ? 'gpu' : 'cpu', h.availabilityZone ?? '?'].join('|');
}

export function isUnderused(h: HostSnapshot, p: ConsolidationPolicy = DEFAULT_POLICY): boolean {
  if (!telemetryTrusted(h, p.trust) || h.tasks.length === 0) return false;
  return h.observed!.cpuUnitsP95 / h.capacity.cpuUnits < p.underusedCpu
    && h.observed!.netBpsP95 / h.capacity.netBps < p.underusedNet;
}

/** Why this task cannot be handed over invisibly right now, or null if it can. */
export function immovableReason(t: TaskSnapshot, p: ConsolidationPolicy = DEFAULT_POLICY): string | null {
  if (t.dedicated) return 'dedicated isolation tier';
  if (t.ingest === 'push') return 'push ingest: source is pointed at this task, no stable ingest address yet';
  if (t.drm) return 'DRM: key continuity across the handoff not proven (v1)';
  if (!t.healthy) return 'not fully healthy: never move a stream that is not proven';
  if (t.onFallback) return 'on backup or filler: source already in trouble';
  if (t.endsInMinutes != null && t.endsInMinutes <= p.eventEndingSoonMinutes) return 'event ends soon: it frees the host by itself';
  if (t.minutesSinceMove != null && t.minutesSinceMove < p.moveCooldownMinutes) return 'moved recently (cooldown)';
  if (t.kind === 'thumbnailer') return 'short-lived job: let it finish';
  return null;
}

export function planConsolidation(hosts: HostSnapshot[], p: ConsolidationPolicy = DEFAULT_POLICY): ConsolidationPlan {
  const plan: ConsolidationPlan = { drain: [], moves: [], skipped: [], classes: [], serversSaved: 0 };
  const byClass = new Map<string, HostSnapshot[]>();
  for (const h of hosts) {
    const k = classKey(h);
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(h);
  }

  for (const [key, members] of [...byClass.entries()].sort()) {
    const under = members.filter((h) => isUnderused(h, p));
    const triggered = under.length >= p.minUnderusedHosts;
    plan.classes.push({ key, hosts: members.length, underused: under.length, triggered });
    if (!triggered) {
      for (const h of under) plan.skipped.push({ hostId: h.id, reason: `only ${under.length} under-used server in its class; need ${p.minUnderusedHosts}` });
      continue;
    }

    // Targets: any host in the class with trusted telemetry.
    const occ = new Map<string, Occupancy>();
    const byId = new Map(members.map((h) => [h.id, h]));
    for (const h of members) { const o = occupancyOf(h, 'trusted'); if (o) occ.set(h.id, o); }
    const received = new Set<string>();
    const drained = new Set<string>();

    const sources = [...under].sort((a, b) =>
      (a.tasks.length - b.tasks.length) || (a.observed!.cpuUnitsP95 / a.capacity.cpuUnits - b.observed!.cpuUnitsP95 / b.capacity.cpuUnits) || a.id.localeCompare(b.id));

    for (const src of sources) {
      if (plan.drain.length >= p.maxHostsPerPass) { plan.skipped.push({ hostId: src.id, reason: 'pass limit reached; next pass' }); continue; }
      if (src.pinned) { plan.skipped.push({ hostId: src.id, reason: 'pinned (scale-in protected for another reason)' }); continue; }
      const blocked = src.tasks.map((t) => [t, immovableReason(t, p)] as const).find(([, r]) => r);
      if (blocked) { plan.skipped.push({ hostId: src.id, reason: `${blocked[0].streamId}: ${blocked[1]}` }); continue; }
      if (received.has(src.id)) { plan.skipped.push({ hostId: src.id, reason: 'is receiving streams this pass' }); continue; }

      // Trial on copies, so a host that cannot be fully drained leaves nothing behind.
      const trial = new Map<string, Occupancy>();
      for (const [id, o] of occ) if (id !== src.id && !drained.has(id)) trial.set(id, o);
      const moves: Move[] = [];
      let ok = true;
      const biggestFirst = [...src.tasks].sort((a, b) => taskLoad(b).cpuUnits - taskLoad(a).cpuUnits);
      for (const t of biggestFirst) {
        const add = { reservation: t.reservation, load: taskLoad(t) };
        const options = [...trial.entries()]
          .map(([id, o]) => ({ id, o, f: fits(byId.get(id)!.capacity, o, add, p.fit) }))
          .filter((x) => x.f.ok)
          .sort((a, b) => (Math.max(b.f.cpuAfter, b.f.netAfter) - Math.max(a.f.cpuAfter, a.f.netAfter)) || a.id.localeCompare(b.id));
        const target = options[0];
        if (!target) { ok = false; break; }
        trial.set(target.id, occupy(target.o, add));
        moves.push({ instanceId: t.instanceId, streamId: t.streamId, from: src.id, to: target.id });
      }
      if (!ok) { plan.skipped.push({ hostId: src.id, reason: 'not every stream fits elsewhere without crossing the ceiling' }); continue; }

      for (const [id, o] of trial) occ.set(id, o);
      for (const m of moves) received.add(m.to);
      drained.add(src.id);
      plan.drain.push(src.id);
      plan.moves.push(...moves);
    }
  }
  plan.serversSaved = plan.drain.length;
  return plan;
}
