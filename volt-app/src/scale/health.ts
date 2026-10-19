/**
 * HEALTH: LIVE vs READY, and the public-only guard.
 *
 *   GET /health/live    the process is up. Container health check. Never
 *                       touches the database: a database outage must not make
 *                       ECS kill and replace every task (that turns a database
 *                       blip into a full restart storm).
 *   GET /health/ready   this process should receive traffic: boot finished
 *                       (migrations applied) and the database answers within
 *                       1 s. The load balancer's target health check. A task
 *                       that has lost its database leaves the rotation instead
 *                       of answering 500s, and returns when it recovers.
 *
 * /health (the original) is unchanged.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { scaleConfig } from './config';
import { cacheStats } from './cache';
import { redisHealthy } from './redis';
import { listenerConnected } from './notify';
import { pendingKeyUse } from './keyUsage';
import { allBatchers } from './batches';
import { prewarmStatus } from './prewarm';

let booted = false;
let leaderCheck: () => boolean = () => false;

export function markBooted(): void { booted = true; }
export function setLeaderCheck(fn: () => boolean): void { leaderCheck = fn; }

async function dbAnswers(): Promise<boolean> {
  const c = await Promise.race([
    pool.query('SELECT 1').then(() => true).catch(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ]);
  return c;
}

export function mountHealth(app: Express): void {
  app.get('/health/live', (_req, res) => res.json({ ok: true, role: scaleConfig.role }));
  app.get('/health/ready', async (_req, res) => {
    const db = await dbAnswers();
    const ok = booted && db;
    // Lazy import: analytics pulls in more than a health check should need at load.
    const { analyticsStats } = await import('../services/analytics');
    res.status(ok ? 200 : 503).json({
      ok, role: scaleConfig.role, booted, db,
      leader: leaderCheck(),
      valkey: scaleConfig.redisUrl ? redisHealthy() : 'not configured',
      listener: listenerConnected(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      cache: cacheStats(),
      keyUsagePending: pendingKeyUse(),
      batches: Object.fromEntries(allBatchers.map((b) => [b.name, { pending: b.pending(), written: b.written, dropped: b.dropped }])),
      analytics: analyticsStats(),
      prewarm: leaderCheck() ? prewarmStatus() : undefined,
    });
  });
}

/**
 * ROLE=api-public serves only the viewer surface. The edge (CloudFront or the
 * staging nginx) already routes admin paths elsewhere; this makes a routing
 * mistake a 404 instead of an admin API exposed on the scaled-out tier.
 */
/** '/x/' matches everything under /x/; '/x' matches /x and everything under /x/. */
export function pathMatches(path: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(prefix + '/');
}

export function publicOnlyGuard() {
  const prefixes = scaleConfig.publicPrefixes;
  return (req: Request, res: Response, next: NextFunction) => {
    if (prefixes.some((x) => pathMatches(req.path, x))) return next();
    res.status(404).json({ error: 'Not found on the public tier' });
  };
}
