/**
 * CLOUDWATCH METRICS FOR AUTOSCALING.
 *
 * The worker service scales on how much work is waiting, which only the
 * database knows. The scheduler leader publishes it every METRICS_PERIOD_SEC:
 *
 *   Volt/JobsQueued        jobs ready to run now        (worker scale-out)
 *   Volt/JobsRunning       jobs claimed                 (dashboard)
 *   Volt/OldestQueuedSec   age of the oldest ready job  (alarm)
 *
 * Off unless CLOUDWATCH_METRICS=true; in staging the same numbers are on
 * /health/ready. Uses @aws-sdk/client-cloudwatch, already a dependency.
 */
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { one } from '../db';
import { scaleConfig } from './config';

let timer: NodeJS.Timeout | null = null;

export async function queueDepth(): Promise<{ queued: number; running: number; oldestQueuedSec: number }> {
  const r = await one<any>(
    `SELECT count(*) FILTER (WHERE state = 'queued' AND run_after <= now())::int AS queued,
            count(*) FILTER (WHERE state = 'running')::int AS running,
            COALESCE(EXTRACT(EPOCH FROM now() - min(run_after) FILTER (WHERE state = 'queued' AND run_after <= now())), 0)::int AS oldest
       FROM jobs WHERE state IN ('queued', 'running')`
  );
  return { queued: r?.queued ?? 0, running: r?.running ?? 0, oldestQueuedSec: r?.oldest ?? 0 };
}

export function startMetrics(): () => void {
  const m = scaleConfig.metrics;
  if (!m.cloudwatch || timer) return () => {};
  const cw = new CloudWatchClient({});
  const dims = [{ Name: 'Service', Value: m.service }];
  const push = async () => {
    try {
      const q = await queueDepth();
      await cw.send(new PutMetricDataCommand({
        Namespace: m.namespace,
        MetricData: [
          { MetricName: 'JobsQueued', Value: q.queued, Unit: 'Count', Dimensions: dims },
          { MetricName: 'JobsRunning', Value: q.running, Unit: 'Count', Dimensions: dims },
          { MetricName: 'OldestQueuedSec', Value: q.oldestQueuedSec, Unit: 'Seconds', Dimensions: dims },
        ],
      }));
    } catch (e) {
      console.error('[metrics] publish failed', (e as Error).message);
    }
  };
  void push();
  timer = setInterval(() => { void push(); }, m.periodSec * 1000);
  timer.unref();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
