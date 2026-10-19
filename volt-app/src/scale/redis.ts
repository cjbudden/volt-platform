/**
 * OPTIONAL VALKEY / REDIS CLIENT.
 *
 * Returns null when REDIS_URL is unset, and every caller treats null as "work
 * per process". Nothing in Volt may REQUIRE Valkey: a box without it must keep
 * working, only less shared.
 *
 * Loaded with require() rather than import so a checkout that has not run
 * `npm install` since ioredis was added still compiles and runs without it.
 *
 * Failure policy: a Valkey that is down is a cache miss, never an error the
 * viewer sees. Commands time out fast (commandTimeout) and callers catch.
 */
import { createRequire } from 'node:module';
import { scaleConfig } from './config';

const requireCjs = createRequire(__filename);

type RedisLike = any;

let client: RedisLike | null | undefined;
let healthy = false;

export function redis(): RedisLike | null {
  if (client !== undefined) return client;
  if (!scaleConfig.redisUrl) return (client = null);
  let Redis: any;
  try {
    Redis = requireCjs('ioredis');
  } catch {
    console.error('[scale] REDIS_URL is set but ioredis is not installed (npm install). Running without Valkey.');
    return (client = null);
  }
  const c = new Redis(scaleConfig.redisUrl, {
    // Fail fast: a slow cache is worse than no cache on the viewer path.
    commandTimeout: 250,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
    // Many tiny commands per second (one ZADD per beacon): batch them per tick.
    enableAutoPipelining: true,
  });
  c.on('ready', () => { healthy = true; console.log('[scale] valkey connected'); });
  c.on('end', () => { healthy = false; });
  c.on('error', (e: Error) => {
    if (healthy) console.error('[scale] valkey error', e.message);
    healthy = false;
  });
  client = c;
  return client;
}

/** True when Valkey is configured AND currently connected. */
export function redisHealthy(): boolean {
  return !!redis() && healthy;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    try { await client.quit(); } catch { /* already gone */ }
  }
  client = null;
}
