/**
 * READ-THROUGH CACHE FOR THE VIEWER PATH.
 *
 * The rule this exists to enforce: the number of database queries must not
 * grow with the number of viewers. A million viewers of one channel ask the
 * same handful of questions (is this key valid, which app is it, who owns this
 * channel, what is on air, what do the rules say), so the answers are kept and
 * shared.
 *
 *   L1  this process's memory. Microseconds. Always on.
 *   L2  Valkey, shared by every process. ~0.3 ms. Only when REDIS_URL is set,
 *       and only for entries marked l2 (plain JSON: no Date objects).
 *
 * FRESHNESS. Every entry carries TAGS ('asset:<id>', 'app:<id>' ...). Database
 * triggers (migration 0046) announce changed rows on the volt_cache channel and
 * every process drops the tagged entries at once, so suspending an account or
 * changing a rule takes effect in milliseconds, not at TTL. The TTL is only the
 * backstop for a missed notification, and a lost listener connection drops the
 * whole cache when it comes back.
 *
 * STAMPEDES. When a hot entry expires, thousands of requests miss in the same
 * millisecond. Only the first runs the loader; the rest await its promise
 * (single-flight), so a miss costs one query per process, not one per viewer.
 *
 * RACES. A load that started before an invalidation and finishes after it
 * would store a stale answer. Each load notes the invalidation epoch when it
 * started and does not store its result if any of its tags moved since.
 */
import { scaleConfig } from './config';
import { redis } from './redis';
import { onNotify, onReconnect } from './notify';

interface Entry { v: unknown; exp: number; tags: string[] }

export interface CacheOpts<T> {
  /** Seconds, or a function of the loaded value (e.g. "until the programme ends"). */
  ttlSec: number | ((v: T) => number);
  /** Invalidation tags, or a function of the loaded value. */
  tags: string[] | ((v: T) => string[]);
  /** Also share through Valkey. Only for plain-JSON values. */
  l2?: boolean;
}

const store = new Map<string, Entry>();
const byTag = new Map<string, Set<string>>();
const inflight = new Map<string, Promise<unknown>>();

let epoch = 0;
let clearedAt = 0;
const tagMovedAt = new Map<string, number>();

const stats = { hits: 0, l2Hits: 0, misses: 0, coalesced: 0, invalidations: 0, flushes: 0, skippedStale: 0 };

const L2_PREFIX = 'vc:';
const L2_TAG = 'vt:';

function index(key: string, tags: string[]) {
  for (const t of tags) {
    let s = byTag.get(t);
    if (!s) { s = new Set(); byTag.set(t, s); }
    s.add(key);
  }
}

function drop(key: string) {
  const e = store.get(key);
  if (!e) return;
  store.delete(key);
  for (const t of e.tags) {
    const s = byTag.get(t);
    if (s) { s.delete(key); if (!s.size) byTag.delete(t); }
  }
}

function evictIfFull() {
  const max = scaleConfig.cache.maxEntries;
  if (store.size <= max) return;
  // Map iterates in insertion order: the oldest entries go first.
  let n = Math.ceil(max * 0.1);
  for (const k of store.keys()) {
    drop(k);
    if (--n <= 0) break;
  }
}

function put(key: string, v: unknown, ttlSec: number, tags: string[]) {
  if (ttlSec <= 0) return;
  drop(key);
  store.set(key, { v, exp: Date.now() + ttlSec * 1000, tags });
  index(key, tags);
  evictIfFull();
}

function stale(tags: string[], startedAt: number): boolean {
  if (clearedAt > startedAt) return true;
  for (const t of tags) if ((tagMovedAt.get(t) ?? 0) > startedAt) return true;
  return false;
}

async function l2Get(key: string): Promise<{ hit: boolean; v?: unknown }> {
  const r = redis();
  if (!r) return { hit: false };
  try {
    const raw = await r.get(L2_PREFIX + key);
    if (raw == null) return { hit: false };
    return { hit: true, v: JSON.parse(raw) };
  } catch {
    return { hit: false };
  }
}

function l2Put(key: string, v: unknown, ttlSec: number, tags: string[]) {
  const r = redis();
  if (!r || ttlSec <= 0) return;
  const ms = Math.ceil(ttlSec * 1000);
  try {
    const m = r.multi();
    m.set(L2_PREFIX + key, JSON.stringify(v), 'PX', ms);
    for (const t of tags) { m.sadd(L2_TAG + t, key); m.pexpire(L2_TAG + t, ms * 2); }
    m.exec().catch(() => {});
  } catch { /* cache write is best effort */ }
}

async function l2DropTag(tag: string) {
  const r = redis();
  if (!r) return;
  try {
    const keys: string[] = await r.smembers(L2_TAG + tag);
    const m = r.multi();
    for (const k of keys) m.del(L2_PREFIX + k);
    m.del(L2_TAG + tag);
    await m.exec();
  } catch { /* the TTL is the backstop */ }
}

/**
 * Return the cached value for `key`, loading it once if absent.
 * With VIEWER_CACHE=false it simply calls the loader (the pre-cache behaviour).
 */
export async function cached<T>(key: string, opts: CacheOpts<T>, load: () => Promise<T>): Promise<T> {
  if (!scaleConfig.cache.enabled) return load();
  const now = Date.now();
  const e = store.get(key);
  if (e && e.exp > now) { stats.hits++; return e.v as T; }
  if (e) drop(key);

  const running = inflight.get(key);
  if (running) { stats.coalesced++; return running as Promise<T>; }

  const startedAt = ++epoch;
  const p = (async () => {
    if (opts.l2) {
      const got = await l2Get(key);
      if (got.hit) {
        stats.l2Hits++;
        const v = got.v as T;
        const tags = typeof opts.tags === 'function' ? opts.tags(v) : opts.tags;
        const ttl = typeof opts.ttlSec === 'function' ? opts.ttlSec(v) : opts.ttlSec;
        if (!stale(tags, startedAt)) put(key, v, ttl, tags);
        return v;
      }
    }
    stats.misses++;
    const v = await load();
    const tags = typeof opts.tags === 'function' ? opts.tags(v) : opts.tags;
    const ttl = typeof opts.ttlSec === 'function' ? opts.ttlSec(v) : opts.ttlSec;
    if (stale(tags, startedAt)) { stats.skippedStale++; return v; }
    put(key, v, ttl, tags);
    if (opts.l2) l2Put(key, v, ttl, tags);
    return v;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** Drop everything carrying `tag`, here and in Valkey. */
export function invalidateTag(tag: string): void {
  stats.invalidations++;
  tagMovedAt.set(tag, ++epoch);
  if (tagMovedAt.size > 200_000) { tagMovedAt.clear(); clearedAt = ++epoch; }
  const keys = byTag.get(tag);
  if (keys) for (const k of [...keys]) drop(k);
  void l2DropTag(tag);
}

/** Drop the whole L1 cache (used after the listener reconnects). */
export function invalidateAll(): void {
  stats.flushes++;
  clearedAt = ++epoch;
  store.clear();
  byTag.clear();
}

export function cacheStats() {
  return { entries: store.size, tags: byTag.size, inflight: inflight.size, ...stats };
}

let wired = false;
/** Subscribe to change notifications. Called once at boot by startScale(). */
export function wireCacheInvalidation(): void {
  if (wired) return;
  wired = true;
  onNotify('volt_cache', (payload) => {
    if (!payload) return;
    if (payload === '*') return invalidateAll();
    for (const tag of payload.split(',')) if (tag) invalidateTag(tag);
  });
  onReconnect(() => invalidateAll());
}

/** Test hook. */
export function _resetCacheForTests(): void {
  store.clear(); byTag.clear(); inflight.clear(); tagMovedAt.clear();
  epoch = 0; clearedAt = 0;
  for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;
}
