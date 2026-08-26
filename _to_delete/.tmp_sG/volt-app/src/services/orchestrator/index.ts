import { config } from '../../config';
import { Orchestrator } from './service';

export { Orchestrator } from './service';
export * from './launcher';

/** Shared orchestrator instance used by routes and the scheduler. */
export const orchestrator = new Orchestrator();

/**
 * Start the background scheduler: provision/stop scheduled events, roll channel
 * recordings at the day boundary, and sweep expired recordings. Returns a stop
 * fn. In production the event-scheduling half can be moved to EventBridge; the
 * retention sweep can move to a scheduled Lambda. The logic in service.ts is
 * unchanged either way.
 */
export function startScheduler(): () => void {
  const o = config.orchestrator;
  // FIRST, before any tick: the stored 'live' flags are a cache of a running
  // process, and a crash leaves them stale. Reconcile them against what is
  // actually running so nothing downstream reports a status that is not true.
  orchestrator.reconcileStreamStatus()
    .then((n) => { if (n) console.log(`[orchestrator] boot reconcile corrected ${n} stream status row(s)`); })
    .catch((e) => console.error('[orchestrator] boot reconcile failed', e));
  const tick = setInterval(
    () => orchestrator.tick().catch((e) => console.error('[orchestrator] tick error', e)),
    o.tickSeconds * 1000
  );
  const sweep = setInterval(
    () => orchestrator.sweepRetention().catch((e) => console.error('[orchestrator] sweep error', e)),
    o.retentionSweepSeconds * 1000
  );
  tick.unref?.();
  sweep.unref?.();
  console.log(`[orchestrator] scheduler up (tick ${o.tickSeconds}s, retention sweep ${o.retentionSweepSeconds}s, launcher=${o.launcher})`);
  return () => {
    clearInterval(tick);
    clearInterval(sweep);
  };
}
