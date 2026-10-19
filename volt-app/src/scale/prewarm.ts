/**
 * PRE-WARM THE VIEWER API FROM THE SCHEDULE.
 *
 * A new Fargate task takes one to two minutes to start. A million viewers who
 * press play at kick-off arrive in about ninety seconds. Reactive autoscaling
 * therefore always arrives late for the one moment that matters, so the
 * scheduler raises the floor BEFORE the event, from the EPG, and lowers it
 * again once the start rush is over.
 *
 * Input: events.expected_viewers and programmes.expected_viewers (migration
 * 0046), set by the operator for anything big.
 *
 *   tasks = ceil(viewers x PREWARM_ORIGIN_FRACTION / PREWARM_RAMP_SEC / PREWARM_STARTS_PER_TASK)
 *
 * clamped to [PREWARM_BASE_MIN, PREWARM_MAX_TASKS]. PREWARM_STARTS_PER_TASK
 * comes from a load test (deploy/loadtest); PREWARM_ORIGIN_FRACTION is the
 * share of starts that miss the edge cache (1 without CloudFront, ~0.05 with).
 *
 * PREWARM_MODE=log (default, any deployment) reports what it would do.
 * PREWARM_MODE=aws raises the minimum capacity of the ECS services named in
 * PREWARM_ECS_RESOURCE_IDS through Application Auto Scaling. Target tracking
 * keeps working above that floor.
 *
 * Runs only in the scheduler leader.
 */
import { createRequire } from 'node:module';
import { query } from '../db';
import { scaleConfig } from './config';

export interface PrewarmStatus {
  at: string | null;
  viewers: number;
  desiredMin: number;
  applied: number | null;
  drivers: { kind: string; id: string; name: string; startsAt: string; viewers: number }[];
  error: string | null;
}

const status: PrewarmStatus = { at: null, viewers: 0, desiredMin: scaleConfig.prewarm.baseMin, applied: null, drivers: [], error: null };
let timer: NodeJS.Timeout | null = null;

export function prewarmStatus(): PrewarmStatus {
  return status;
}

export function tasksFor(viewers: number): number {
  const p = scaleConfig.prewarm;
  const startsPerSec = (viewers * p.originFraction) / Math.max(1, p.rampSeconds);
  const n = Math.ceil(startsPerSec / Math.max(1, p.startsPerTask));
  return Math.max(p.baseMin, Math.min(p.maxTasks, n));
}

async function upcoming() {
  const p = scaleConfig.prewarm;
  return query<{ kind: string; id: string; name: string; starts_at: Date; viewers: number }>(
    `SELECT 'event' AS kind, id::text, name, scheduled_start AS starts_at, expected_viewers AS viewers
       FROM events
      WHERE expected_viewers > 0
        AND scheduled_start < now() + make_interval(mins => $1)
        AND scheduled_start > now() - make_interval(mins => $2)
     UNION ALL
     SELECT 'programme', id::text, title, starts_at, expected_viewers
       FROM programmes
      WHERE expected_viewers > 0
        AND starts_at < now() + make_interval(mins => $1)
        AND starts_at > now() - make_interval(mins => $2)`,
    [p.leadMinutes, p.holdMinutes]
  );
}

async function apply(min: number): Promise<void> {
  const p = scaleConfig.prewarm;
  if (p.mode !== 'aws') return;
  if (!p.ecsResourceIds.length) throw new Error('PREWARM_MODE=aws but PREWARM_ECS_RESOURCE_IDS is empty');
  const sdk = createRequire(__filename)('@aws-sdk/client-application-auto-scaling');
  const c = new sdk.ApplicationAutoScalingClient({});
  for (const ResourceId of p.ecsResourceIds) {
    await c.send(new sdk.RegisterScalableTargetCommand({
      ServiceNamespace: 'ecs',
      ScalableDimension: 'ecs:service:DesiredCount',
      ResourceId,
      MinCapacity: min,
    }));
  }
}

export async function prewarmTick(): Promise<void> {
  try {
    const rows = await upcoming();
    const viewers = rows.reduce((n, r) => n + Number(r.viewers || 0), 0);
    const desired = tasksFor(viewers);
    status.at = new Date().toISOString();
    status.viewers = viewers;
    status.desiredMin = desired;
    status.drivers = rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, startsAt: new Date(r.starts_at).toISOString(), viewers: Number(r.viewers) }));
    // Re-asserted every tick while raised, so a deploy that resets the
    // service's minimum mid-event (terraform apply) is corrected within a tick.
    const reassert = scaleConfig.prewarm.mode === 'aws' && desired > scaleConfig.prewarm.baseMin;
    if (status.applied !== desired || reassert) {
      const verb = scaleConfig.prewarm.mode === 'aws' ? 'setting' : 'would set (PREWARM_MODE=log)';
      if (status.applied !== desired) console.log(`[prewarm] ${verb} api-public minimum to ${desired} task(s) for ${viewers} expected viewer(s)` +
        (rows.length ? ` (${rows.map((r) => r.name).join(', ')})` : ''));
      await apply(desired);
      status.applied = desired;
    }
    status.error = null;
  } catch (e: any) {
    status.error = e?.message ?? String(e);
    console.error('[prewarm] tick failed', status.error);
  }
}

export function startPrewarm(): () => void {
  if (!scaleConfig.prewarm.enabled || timer) return () => {};
  void prewarmTick();
  timer = setInterval(() => { void prewarmTick(); }, scaleConfig.prewarm.tickSec * 1000);
  timer.unref();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
