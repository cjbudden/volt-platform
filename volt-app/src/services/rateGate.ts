// ============================================================================
//  A RATE LIMIT SHARED BY EVERY PROCESS (migration 0073, rate_gates).
//
//  External services limit by IP (MusicBrainz: about one call a second), and
//  Volt runs several processes behind one address. Each call reserves the
//  next free slot in one row, atomically (the row lock serialises them), then
//  waits until its slot. The day's count is kept beside it for the console.
//  Without a database (unit tests) it falls back to a per-process gate.
// ============================================================================
import { one } from '../db';

const local = new Map<string, number>();

/** Wait for this process's turn at `name`, at most one call every `gapMs` across the platform. */
export async function takeTurn(name: string, gapMs: number): Promise<void> {
  let waitMs: number;
  try {
    const r = await one<{ wait_ms: string }>(
      `INSERT INTO rate_gates(name, next_at, calls, day, day_calls) VALUES ($1, clock_timestamp() + make_interval(secs => $2 / 1000.0), 1, current_date, 1)
       ON CONFLICT (name) DO UPDATE SET
         next_at = GREATEST(rate_gates.next_at, clock_timestamp()) + make_interval(secs => $2 / 1000.0),
         calls = rate_gates.calls + 1,
         day_calls = CASE WHEN rate_gates.day = current_date THEN rate_gates.day_calls + 1 ELSE 1 END,
         day = current_date
       RETURNING GREATEST(0, extract(epoch FROM (next_at - make_interval(secs => $2 / 1000.0) - clock_timestamp())) * 1000)::bigint AS wait_ms`,
      [name, gapMs]);
    waitMs = Number(r?.wait_ms ?? 0);
  } catch {
    const now = Date.now(); const next = Math.max(local.get(name) ?? 0, now);
    local.set(name, next + gapMs); waitMs = next - now;
  }
  if (waitMs > 0) await new Promise((res) => setTimeout(res, waitMs));
}

/** Calls made today through a gate, for the console. */
export async function gateUsage(name: string): Promise<{ today: number; total: number } | null> {
  try {
    const r = await one<any>(`SELECT CASE WHEN day = current_date THEN day_calls ELSE 0 END AS today, calls AS total FROM rate_gates WHERE name = $1`, [name]);
    return r ? { today: Number(r.today), total: Number(r.total) } : { today: 0, total: 0 };
  } catch { return null; }
}
