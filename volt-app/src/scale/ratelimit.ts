/**
 * FIXED-WINDOW RATE LIMITS for credential endpoints (logins, password resets,
 * token refresh). Counted in Valkey when configured, so the limit holds
 * across every API process; per process otherwise. A Valkey failure fails
 * OPEN to the per-process counter rather than locking everyone out.
 *
 * The WAF rate rules at CloudFront are the first line (per IP, coarse); this
 * is the second (per account+email, so a botnet spread over many IPs still
 * cannot guess one person's password quickly).
 */
import { redis } from './redis';
import { ApiError } from '../util/http';

const local = new Map<string, { n: number; until: number }>();

async function hit(key: string, windowSec: number): Promise<number> {
  const r = redis();
  if (r) {
    try {
      const k = `rl:${key}`;
      // SET NX starts the window once; INCR counts within it.
      const out = await r.multi().set(k, '0', 'EX', windowSec, 'NX').incr(k).exec();
      return Number(out?.[1]?.[1] ?? 0);
    } catch { /* fall through to the local counter */ }
  }
  const now = Date.now();
  let e = local.get(key);
  if (!e || e.until < now) { e = { n: 0, until: now + windowSec * 1000 }; local.set(key, e); }
  e.n++;
  if (local.size > 100_000) for (const [k, v] of local) if (v.until < now) local.delete(k);
  return e.n;
}

/** Throw 429 once `key` has been hit more than `max` times in `windowSec`. */
export async function limit(key: string, max: number, windowSec: number, message = 'Too many attempts, try again shortly'): Promise<void> {
  const n = await hit(key, windowSec);
  if (n > max) throw Object.assign(new ApiError(429, message), { code: 'rate_limited' });
}

/** How many times `key` was hit in its current window, without counting this look. */
export async function peek(key: string): Promise<number> {
  const r = redis();
  if (r) {
    try { return Number((await r.get(`rl:${key}`)) ?? 0); } catch { /* fall through */ }
  }
  const e = local.get(key);
  return e && e.until >= Date.now() ? e.n : 0;
}
