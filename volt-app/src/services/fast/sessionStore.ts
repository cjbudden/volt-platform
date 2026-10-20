// ============================================================================
//  STITCHER SESSION STATE, SHARED ACROSS API TASKS.
//
//  A viewer's playlist refreshes land on whichever API task the load balancer
//  picks. The stitcher's numbering (stitch.ts SessionState per track) and the
//  viewer's ad decisions must be the same on every task, or the media sequence
//  jumps between refreshes. So they live in Valkey when it is configured
//  (REDIS_URL, scale/redis.ts), and in this process otherwise (one task, a
//  laptop). Keys, all expiring 10 minutes after the last use:
//
//    fast:c:<session>              the viewer's context (ip, user agent, country)
//    fast:t:<session>:<track>      stitch state for one playlist (v720, audio...)
//    fast:p:<session>:<break>      the decided pod for one break ("null" = none)
//    fast:l:<session>:<break>      decision in progress (30 s), so two tasks do not both ask the ad server
//
//  Valkey failing is a miss, never an error: the viewer then gets the channel's
//  own breaks (house spots), which is the stitcher's fail-open rule anyway.
// ============================================================================
import { redis } from '../../scale/redis';

const TTL_SEC = 600;
const mem = new Map<string, { v: string; exp: number }>();
setInterval(() => { const now = Date.now(); for (const [k, e] of mem) if (e.exp < now) mem.delete(k); }, 60_000).unref?.();

async function get(key: string): Promise<string | null> {
  const r = redis();
  if (r) { try { return await r.get(key); } catch { return null; } }
  const e = mem.get(key);
  return e && e.exp > Date.now() ? e.v : null;
}
async function set(key: string, v: string, ttl = TTL_SEC): Promise<void> {
  const r = redis();
  if (r) { try { await r.set(key, v, 'EX', ttl); } catch { /* a miss next time */ } return; }
  mem.set(key, { v, exp: Date.now() + ttl * 1000 });
}
/** Set only if absent (a lock). True when this caller got it. */
async function setNx(key: string, ttl: number): Promise<boolean> {
  const r = redis();
  if (r) { try { return (await r.set(key, '1', 'EX', ttl, 'NX')) === 'OK'; } catch { return false; } }
  const e = mem.get(key);
  if (e && e.exp > Date.now()) return false;
  mem.set(key, { v: '1', exp: Date.now() + ttl * 1000 });
  return true;
}

export const sessionStore = {
  async context(sid: string, init: () => Record<string, unknown>): Promise<Record<string, unknown>> {
    const k = `fast:c:${sid}`;
    const v = await get(k);
    if (v) { await set(k, v); return JSON.parse(v); }
    const c = { ...init(), started: Date.now() };
    await set(k, JSON.stringify(c));
    return c;
  },
  async track<T>(sid: string, track: string): Promise<T | null> {
    const v = await get(`fast:t:${sid}:${track}`);
    return v ? JSON.parse(v) as T : null;
  },
  async saveTrack(sid: string, track: string, state: unknown): Promise<void> {
    await set(`fast:t:${sid}:${track}`, JSON.stringify(state));
  },
  /** The decided pod: undefined = not decided yet, null = decided, nothing to stitch. */
  async pod<T>(sid: string, breakId: string): Promise<T | null | undefined> {
    const v = await get(`fast:p:${sid}:${breakId}`);
    return v == null ? undefined : v === 'null' ? null : JSON.parse(v) as T;
  },
  async savePod(sid: string, breakId: string, plan: unknown): Promise<void> {
    await set(`fast:p:${sid}:${breakId}`, plan == null ? 'null' : JSON.stringify(plan));
  },
  /** Claim the decision for a break (30 s), so only one task asks the ad server. */
  claim(sid: string, breakId: string): Promise<boolean> {
    return setNx(`fast:l:${sid}:${breakId}`, 30);
  },
};
