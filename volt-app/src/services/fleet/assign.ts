// ============================================================================
//  ASSIGN: size a stream and choose its server, between "build the job" and
//  "launch it".
//
//    1. ESTIMATE  the load from the job the encoder will run (streamLoad.ts),
//                 replaced by measured history for the same settings when the
//                 fleet has enough of it.
//    2. PLACE     onto the fullest running server that can take it, or a new
//                 server from the smallest pool that holds it
//                 (placementPlanner.ts).
//    3. HINT      the launcher: reservation (task-level cpu/memory override),
//                 capacity provider, and the host to pin to.
//
//  NEVER BLOCKS A START. Placement is a cost optimisation. If any part of it
//  fails (the database is slow, a host has no capacity facts, no pool fits),
//  the stream launches exactly the way it did before this existed: task
//  definition size, the default capacity strategy, ECS's own choice of host.
//  A channel that does not go on air is far more expensive than one that runs
//  on a slightly emptier server.
// ============================================================================
import { query } from '../../db';
import type { LaunchHints } from '../orchestrator/launcher';
import { calibrate, type LoadEstimate } from './streamLoad';
import { applyFit, fitFor } from './loadFit';
import { currentLoadFits, familyForPlacement } from './loadLearning';
import { scratchMibAt } from './storageProjection';
import { choosePlacement, type PlacementDecision, type StreamClass } from './placementPlanner';
import { loadFleetSnapshot, signatureHistory } from './snapshot';
import { fleetSettings } from './placementConfig';

export interface Assignment {
  estimate: LoadEstimate;
  decision: PlacementDecision | { action: 'not_planned'; reason: string };
  hints: LaunchHints | undefined;
}

export async function assignStream(args: {
  streamId: string;
  streamClass: StreamClass;
  accountId: string | null;
  estimate: LoadEstimate;
  /** Hours the stream is expected to run, when known (an event's window); the disk horizon otherwise. */
  horizonHours?: number;
}): Promise<Assignment> {
  const s = fleetSettings();
  let estimate = args.estimate;
  // LEARN FIRST, THEN CALIBRATE. The fit corrects the cost of each component
  // from every run (so a new ladder starts from what its parts really cost);
  // a signature with enough history of its own then replaces that with its
  // own measurement, which is more exact still.
  if (s.learn) {
    try {
      estimate = applyFit(estimate, fitFor(await currentLoadFits(), familyForPlacement(s.placementPolicy, estimate.needsGpu)));
    } catch (e) {
      console.warn('[fleet] learned fit unavailable; using the starting coefficients', e);
    }
  }
  try {
    estimate = calibrate(estimate, await signatureHistory(estimate.signature));
  } catch (e) {
    console.warn('[fleet] history lookup failed; using the estimate', e);
  }
  if (!s.placement) {
    return { estimate, decision: { action: 'not_planned', reason: 'placement is off for this launcher' }, hints: undefined };
  }

  try {
    let isolation: 'shared' | 'dedicated' = 'shared';
    if (args.accountId) {
      const a = await query<{ plan_tier: string }>(`SELECT plan_tier FROM accounts WHERE id=$1`, [args.accountId]);
      if (a[0] && s.dedicatedTiers.includes(a[0].plan_tier)) isolation = 'dedicated';
    }
    const hosts = await loadFleetSnapshot(s);
    const decision = choosePlacement({
      streamId: args.streamId, streamClass: args.streamClass, accountId: args.accountId, isolation,
      load: estimate.load, reservation: estimate.reservation, needsGpu: estimate.needsGpu,
      diskMib: scratchMibAt(estimate.storage?.scratchMibPerHour ?? 0, 0, args.horizonHours ?? s.diskHorizonHours),
    }, hosts, s.placementPolicy);

    const sized = { cpuUnits: estimate.reservation.cpuUnits, memoryMib: estimate.reservation.memoryMib, gpus: estimate.reservation.gpus };
    if (decision.action === 'existing_host') {
      const host = hosts.find((h) => h.id === decision.hostId)!;
      return { estimate, decision, hints: { ...sized, capacityProvider: decision.capacityProvider ?? undefined, ec2InstanceId: host.externalId, hostId: host.id } };
    }
    if (decision.action === 'new_host') {
      return { estimate, decision, hints: { ...sized, capacityProvider: decision.capacityProvider } };
    }
    // Unplaceable: launch as before, and say why so the fleet view shows it.
    console.warn(`[fleet] ${args.streamId}: ${decision.reason}; launching with default sizing`);
    return { estimate, decision, hints: undefined };
  } catch (e) {
    console.error('[fleet] placement failed; launching with default sizing', e);
    return { estimate, decision: { action: 'not_planned', reason: 'placement error, default sizing used' }, hints: undefined };
  }
}

/** Write what was decided onto the instance row, so the next placement sees it immediately. */
export async function recordAssignment(taskArn: string, a: Assignment): Promise<void> {
  const l = a.estimate.load;
  await query(
    `UPDATE instances SET
       est_cpu_units = $2, est_memory_mib = $3, est_gpu_share = $4,
       est_net_in_bps = $5, est_net_out_bps = $6, load_signature = $7, load_basis = $8,
       cpu_units = COALESCE(cpu_units, $9), memory_mib = COALESCE(memory_mib, $10), reserved_gpus = $11,
       assigned_host_id = $12, capacity_provider = COALESCE(capacity_provider, $13),
       placement_decision = $14::jsonb
     WHERE task_arn = $1`,
    [taskArn, l.cpuUnits, l.memoryMib, l.gpuShare, l.netInBps, l.netOutBps, a.estimate.signature, a.estimate.basis,
     a.hints?.cpuUnits ?? null, a.hints?.memoryMib ?? null, a.estimate.reservation.gpus,
     a.hints?.hostId ?? null, a.hints?.capacityProvider ?? null,
     // baseLines (the unfitted model) is what learning compares measurements
     // with; storage drives the disk check for the next placements.
     JSON.stringify({ ...a.decision, lines: a.estimate.lines, baseLines: a.estimate.baseLines ?? a.estimate.lines,
       notes: a.estimate.notes, reservation: a.estimate.reservation, storage: a.estimate.storage, fit: a.estimate.fit ?? null })]
  );
}
