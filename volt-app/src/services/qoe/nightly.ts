// ============================================================================
//  THE NIGHTLY REPLAY: YESTERDAY REBUILT FROM THE RAW REPORTS (build queue
//  2.11b, QOE_REPORTING.md section 9a).
//
//  The live rows are as good as one task can make them as reports arrive.
//  Some are still provisional: a session whose owner changed (a collector
//  task started or stopped, sidRoute.ts), a forward that could not be
//  delivered, a view dropped under backpressure, a report that arrived after
//  its view was written. Once a night yesterday is replayed from the raw
//  archive (replay.ts, the same code the collector runs), so from then on
//  every row of that day is exactly what a replay gives.
//
//  Exactly once, however many tasks: the first task past the hour takes an
//  advisory lock in the analytics database, checks the marker in qoe_meta,
//  replays, and moves the marker. Every task that takes reports runs the
//  check; the others find the marker moved and do nothing.
//
//    QOE_NIGHTLY_REPLAY     on (default) or off
//    QOE_NIGHTLY_REPLAY_AT  UTC time of day after which yesterday is replayed
//                           (default 02:30: late reports and sessions over
//                           midnight are in by then)
// ============================================================================
import { analyticsPool } from './analyticsDb';
import { replayRange } from './replay';

const LOCK = 72010002; // 72010001 is the schema lock (analyticsDb.ts)
const CHECK_MS = 10 * 60_000;
export const nightlyStats = { runs: 0, lastDay: null as string | null, lastViews: 0, lastError: null as string | null };
let timer: ReturnType<typeof setInterval> | null = null;

function atMinutes(): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(process.env.QOE_NIGHTLY_REPLAY_AT ?? '02:30');
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : 150;
}

/**
 * Replay yesterday if it is due and no task has done it yet. Returns the day
 * replayed, or null. Tests call it with their own clock.
 */
export async function nightlyReplay(now = Date.now(), replay: typeof replayRange = replayRange): Promise<string | null> {
  const d = new Date(now);
  if (d.getUTCHours() * 60 + d.getUTCMinutes() < atMinutes()) return null;
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const p = await analyticsPool();
  const c = await p.connect();
  let locked = false;
  try {
    locked = !!(await c.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK])).rows[0]?.ok;
    if (!locked) return null; // another task is replaying now
    const done = (await c.query(`SELECT v FROM qoe_meta WHERE k = 'nightly_replay'`)).rows[0]?.v as string | undefined;
    if (done && done >= yesterday) return null;
    const r = await replay(yesterday, yesterday);
    await c.query(`INSERT INTO qoe_meta(k, v) VALUES ('nightly_replay', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [yesterday]);
    nightlyStats.runs++; nightlyStats.lastDay = yesterday; nightlyStats.lastViews = r.reduce((n, x) => n + x.views, 0); nightlyStats.lastError = null;
    console.log(`[qoe] nightly replay of ${yesterday}: ${r.length} account(s), ${nightlyStats.lastViews} views`);
    return yesterday;
  } finally {
    if (locked) await c.query(`SELECT pg_advisory_unlock($1)`, [LOCK]).catch(() => {});
    c.release();
  }
}

/** Check every ten minutes in a task that takes reports (collector.ts starts it). */
export function startNightlyReplay(): void {
  if (timer || (process.env.QOE_NIGHTLY_REPLAY ?? 'on') === 'off') return;
  timer = setInterval(() => {
    nightlyReplay().catch((e) => { nightlyStats.lastError = (e as Error).message; console.error('[qoe] nightly replay failed, tried again in ten minutes', (e as Error).message); });
  }, CHECK_MS);
  timer.unref?.();
}

export function stopNightlyReplay(): void { if (timer) clearInterval(timer); timer = null; }
