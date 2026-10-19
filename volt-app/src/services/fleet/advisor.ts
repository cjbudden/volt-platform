// ============================================================================
//  CONSOLIDATION ADVISOR: runs the planner on the fleet pass and keeps the
//  result where the Fleet page and the platform API can read it.
//
//  ADVISE ONLY. It moves nothing: the make-before-break handoff that would
//  carry a running stream to another server without the viewer noticing is
//  not built yet (CONSOLIDATION.md). Until it is, the value of this pass is
//  the evidence: how often consolidation would fire on the real fleet, which
//  streams block it and why, and how many servers it would save.
// ============================================================================
import { query } from '../../db';
import { planConsolidation, type ConsolidationPlan } from './consolidation';
import { loadFleetSnapshot } from './snapshot';
import { fleetSettings } from './placementConfig';

export async function adviseConsolidation(): Promise<ConsolidationPlan | null> {
  const s = fleetSettings();
  if (s.consolidate === 'off') return null;
  const hosts = await loadFleetSnapshot(s);
  const plan = planConsolidation(hosts, s.consolidationPolicy);
  await query(
    `INSERT INTO fleet_plans (kind, plan, servers_saved, hosts_considered)
     VALUES ('consolidation', $1::jsonb, $2, $3)`,
    [JSON.stringify(plan), plan.serversSaved, hosts.length]
  );
  if (plan.serversSaved) console.log(`[fleet] consolidation would free ${plan.serversSaved} server(s): ${plan.moves.length} move(s) (advise only)`);
  return plan;
}

export async function latestConsolidation(): Promise<any | null> {
  const r = await query(`SELECT at, plan, servers_saved, hosts_considered FROM fleet_plans WHERE kind='consolidation' ORDER BY at DESC LIMIT 1`);
  return r[0] ?? null;
}

/** How often the plan would have freed servers, over a period: the case for building the handoff. */
export async function consolidationHistory(days = 7): Promise<{ passes: number; passesWithSaving: number; maxServersSaved: number }> {
  const r = await query<{ passes: number; with_saving: number; max_saved: number | null }>(
    `SELECT COUNT(*)::int AS passes, COUNT(*) FILTER (WHERE servers_saved > 0)::int AS with_saving, MAX(servers_saved) AS max_saved
       FROM fleet_plans WHERE kind='consolidation' AND at > now() - make_interval(days => $1)`,
    [days]
  );
  return { passes: r[0]?.passes ?? 0, passesWithSaving: r[0]?.with_saving ?? 0, maxServersSaved: r[0]?.max_saved ?? 0 };
}

export async function pruneFleetPlans(keepDays = 14): Promise<number> {
  const r = await query(`DELETE FROM fleet_plans WHERE at < now() - make_interval(days => $1) RETURNING id`, [keepDays]);
  return r.length;
}
