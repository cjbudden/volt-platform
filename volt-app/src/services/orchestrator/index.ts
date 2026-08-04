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
