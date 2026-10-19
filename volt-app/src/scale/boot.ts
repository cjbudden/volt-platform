/**
 * STARTING AND STOPPING THE SCALE MACHINERY.
 *
 * Called from src/index.ts once the schema is in place. Every piece is safe on
 * one box with nothing but Postgres: Valkey and the cloud services are only
 * used when configured.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { one } from '../db';
import { scaleConfig } from './config';
import { startListener, stopListener } from './notify';
import { wireCacheInvalidation } from './cache';
import { redis, closeRedis } from './redis';
import { startKeyUsage, stopKeyUsage } from './keyUsage';
import { allBatchers } from './batches';
import { wireStatusFanout } from '../services/statusHub';
import { wireViewerRevocation } from '../auth/viewerTokens';
import { startAnalyticsPipeline, stopAnalyticsPipeline } from '../services/analytics';

/** Roles that own the schema: they migrate on boot. Others wait for it. */
export function runsSchemaWork(): boolean {
  const v = process.env.RUN_MIGRATIONS;
  if (v !== undefined && v !== '') return /^(1|true|yes|on)$/i.test(v);
  return ['all', 'api', 'api-admin', 'scheduler'].includes(scaleConfig.role);
}

/**
 * Serialise boot schema work across processes. migrate() has its own lock;
 * ensureSchema's ALTERs did not, and two processes booting together could
 * queue their exclusive locks behind each other's.
 */
export async function withBootLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: scaleConfig.listenUrl, application_name: 'volt-boot' });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1, $2)', [0x0109, 1]);
    return await fn();
  } finally {
    await c.query('SELECT pg_advisory_unlock($1, $2)', [0x0109, 1]).catch(() => {});
    await c.end().catch(() => {});
  }
}

/** Wait until the newest migration on disk is recorded as applied. */
export async function waitForSchema(): Promise<void> {
  let latest: string | null = null;
  try {
    latest = readdirSync(join(process.cwd(), 'migrations')).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort().pop() ?? null;
  } catch { /* no migrations dir: nothing to wait for */ }
  if (!latest) return;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await one<any>('SELECT 1 AS ok FROM schema_migrations WHERE id = $1', [latest]);
      if (r?.ok) return;
    } catch { /* table not there yet */ }
    if (attempt % 15 === 0) console.log(`[boot] waiting for migration ${latest} (applied by the admin or scheduler role)`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function startScale(): Promise<void> {
  wireCacheInvalidation();
  wireStatusFanout();
  wireViewerRevocation();
  await startListener();
  redis();               // connect early so the first viewer is not the one waiting
  startKeyUsage();
  for (const b of allBatchers) b.start();
  startAnalyticsPipeline();
  console.log(`[scale] role=${scaleConfig.role} valkey=${scaleConfig.redisUrl ? 'on' : 'off'} ` +
    `cache=${scaleConfig.cache.enabled ? 'on' : 'off'} sessions=${scaleConfig.analytics.sessions} ` +
    `edgeGeo=${scaleConfig.edge.trustGeoHeader ? 'trusted' : 'client'}`);
}

export async function stopScale(): Promise<void> {
  await stopKeyUsage().catch(() => {});
  for (const b of allBatchers) await b.stop().catch(() => {});
  await stopAnalyticsPipeline().catch(() => {});
  await stopListener().catch(() => {});
  await closeRedis().catch(() => {});
}
