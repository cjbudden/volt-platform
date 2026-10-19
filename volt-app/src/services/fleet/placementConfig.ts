// ============================================================================
//  Placement and consolidation settings, from the environment.
//
//  Kept out of config.ts on purpose: everything here has a safe default, and
//  a deployment that sets none of it gets packing at launch, right-sized
//  reservations and consolidation in ADVISE mode (planned and shown, never
//  acted on). Nothing here can move a running stream.
// ============================================================================
import { config } from '../../config';
import { DEFAULT_FIT, type FitPolicy } from './capacity';
import { DEFAULT_POLICY, type ConsolidationPolicy } from './consolidation';
import type { PlacementPolicy, PoolSpec } from './placementPlanner';

const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v: string | undefined, d: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);
function json<T>(v: string | undefined, d: T): T {
  if (!v) return d;
  try { return JSON.parse(v) as T; } catch { console.warn('[fleet] ignoring unparseable JSON setting'); return d; }
}

export interface FleetSettings {
  /** Choose a server per stream at launch (ECS only; other launchers just size). */
  placement: boolean;
  /** off | advise. 'act' is refused until the make-before-break handoff exists. */
  consolidate: 'off' | 'advise';
  placementPolicy: PlacementPolicy;
  consolidationPolicy: ConsolidationPolicy;
  /** Account plan tiers that run on a dedicated pool. */
  dedicatedTiers: string[];
  /** Task slots per host when ENI trunking is on (null = ENIs - 1). */
  taskSlotsOverride: number | null;
  windowMinutes: number;
}

function pools(): PoolSpec[] {
  const o = config.orchestrator;
  const small = list(process.env.FLEET_SMALL_TYPES, ['c7i.xlarge', 'c6i.xlarge', 'c5.xlarge']);
  const large = list(process.env.FLEET_LARGE_TYPES, ['c7i.2xlarge', 'c6i.2xlarge', 'c5.2xlarge']);
  const out: PoolSpec[] = [
    { provider: o.onDemandProvider, lifecycle: 'on_demand', gpu: false, pool: 'shared', types: small },
  ];
  // The large pools exist only once Terraform has created them. Until then a
  // ladder too big for a small server is launched the way it was before
  // (task definition size, ECS's own choice of host) and the decision says so.
  if (process.env.ECS_ONDEMAND_LARGE_PROVIDER) out.push({ provider: process.env.ECS_ONDEMAND_LARGE_PROVIDER, lifecycle: 'on_demand', gpu: false, pool: 'shared', types: large });
  out.push({ provider: o.spotProvider, lifecycle: 'spot', gpu: false, pool: 'shared', types: small });
  if (process.env.ECS_SPOT_LARGE_PROVIDER) out.push({ provider: process.env.ECS_SPOT_LARGE_PROVIDER, lifecycle: 'spot', gpu: false, pool: 'shared', types: large });
  if (process.env.ECS_GPU_PROVIDER) out.push({ provider: process.env.ECS_GPU_PROVIDER, lifecycle: 'on_demand', gpu: true, pool: 'shared', types: list(process.env.FLEET_GPU_TYPES, ['g4dn.xlarge']) });
  // Dedicated pools: {"<accountId>": {"provider": "...", "types": [...]}}
  const ded = json<Record<string, { provider: string; types?: string[]; gpu?: boolean }>>(process.env.FLEET_DEDICATED_POOLS, {});
  for (const [acct, d] of Object.entries(ded)) {
    out.push({ provider: d.provider, lifecycle: 'on_demand', gpu: !!d.gpu, pool: `dedicated:${acct}`, types: d.types ?? large });
  }
  return json<PoolSpec[]>(process.env.FLEET_POOLS, out);
}

export function fleetSettings(): FleetSettings {
  const fit: FitPolicy = {
    ...DEFAULT_FIT,
    ceiling: num(process.env.FLEET_CEILING, DEFAULT_FIT.ceiling),
    safetyFactor: num(process.env.FLEET_SAFETY_FACTOR, DEFAULT_FIT.safetyFactor),
    gpuSharing: bool(process.env.FLEET_GPU_SHARING, false),
    soloCeiling: num(process.env.FLEET_SOLO_CEILING, DEFAULT_FIT.soloCeiling),
  };
  const mode = (process.env.FLEET_CONSOLIDATE ?? 'advise').toLowerCase();
  if (mode === 'act') console.warn('[fleet] FLEET_CONSOLIDATE=act is not available until the handoff is built; running in advise mode');
  const slots = process.env.FLEET_TASK_SLOTS ? num(process.env.FLEET_TASK_SLOTS, 0) || null : null;
  return {
    placement: bool(process.env.FLEET_PLACEMENT, config.orchestrator.launcher === 'ecs'),
    consolidate: mode === 'off' ? 'off' : 'advise',
    placementPolicy: { fit, spotForChannels: bool(process.env.FLEET_SPOT_FOR_CHANNELS, false), pools: pools() },
    consolidationPolicy: {
      ...DEFAULT_POLICY,
      fit,
      underusedCpu: num(process.env.FLEET_UNDERUSED_CPU, DEFAULT_POLICY.underusedCpu),
      underusedNet: num(process.env.FLEET_UNDERUSED_NET, DEFAULT_POLICY.underusedNet),
      minUnderusedHosts: Math.max(2, num(process.env.FLEET_MIN_UNDERUSED_HOSTS, DEFAULT_POLICY.minUnderusedHosts)),
    },
    dedicatedTiers: list(process.env.FLEET_DEDICATED_TIERS, ['dedicated']),
    taskSlotsOverride: slots,
    windowMinutes: num(process.env.FLEET_WINDOW_MINUTES, 60),
  };
}
