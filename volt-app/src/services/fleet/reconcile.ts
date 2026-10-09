// ============================================================================
//  THE FLEET RECONCILER.
//
//  Runs on the orchestrator tick and does one thing: ask the launcher where
//  each live task actually is, and write down the answer.
//
//  WHY THIS IS A TICK AND NOT A LAUNCH-TIME WRITE. At the moment RunTask
//  returns, an ECS task is normally PROVISIONING: it has an arn and no
//  container instance. Recording placement there would have captured null for
//  the majority of tasks and never revisited it, which is the failure mode
//  that produced the empty ec2_instance_id column this feature replaces.
//  Placement is therefore treated as something that becomes knowable, not
//  something known.
//
//  WHY IT IS SEPARATE FROM THE STATUS RECONCILER. That one decides whether a
//  stream is alive and can tear things down. This one only observes and can
//  change nothing about what is running. Keeping them apart means a bug in
//  placement capture, or a throttled DescribeContainerInstances, can never
//  take a channel off air; the worst it can do is leave the fleet view thin.
//  That asymmetry is deliberate and worth the extra pass.
// ============================================================================
import { query } from '../../db';
import type { TaskLauncher } from '../orchestrator/launcher';
import { upsertHost, attachInstanceToHost, retireStaleHosts } from './hosts';

export interface FleetReconcileResult {
  considered: number;
  placed: number;
  /** Tasks whose launcher could not say where they are. Not an error. */
  unplaceable: number;
  hosts: number;
  retired: number;
}

/**
 * Observe placement for every task the database believes is running.
 *
 * Failure is per task. One launcher call that throws must not abandon the
 * other thirty-nine, because the common cause of a throw here is API
 * throttling, which is exactly the moment a large fleet most needs the rest of
 * its rows updated.
 */
export async function reconcileFleet(launcher: TaskLauncher): Promise<FleetReconcileResult> {
  const out: FleetReconcileResult = { considered: 0, placed: 0, unplaceable: 0, hosts: 0, retired: 0 };

  // A launcher with no describePlacement is not broken; it is a backend that
  // does not expose placement. Say nothing, write nothing.
  if (typeof launcher.describePlacement !== 'function') return out;

  const live = await query<{ id: string; task_arn: string }>(
    `SELECT id, task_arn FROM instances
      WHERE terminated_at IS NULL AND task_arn IS NOT NULL
      ORDER BY launched_at NULLS FIRST`
  );
  out.considered = live.length;

  const seen = new Set<string>();
  for (const inst of live) {
    let placement = null;
    try {
      placement = await launcher.describePlacement(inst.task_arn);
    } catch (e) {
      console.warn('[fleet] placement lookup failed for', inst.task_arn, e);
    }
    if (!placement) { out.unplaceable++; continue; }
    try {
      const hostId = await upsertHost(placement);
      await attachInstanceToHost(inst.id, hostId, placement);
      seen.add(hostId);
      out.placed++;
    } catch (e) {
      console.error('[fleet] could not record placement for', inst.task_arn, e);
    }
  }
  out.hosts = seen.size;
  out.retired = await retireStaleHosts();
  return out;
}
