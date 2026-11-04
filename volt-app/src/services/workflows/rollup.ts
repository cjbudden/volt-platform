// ============================================================================
//  THE WORKFLOW REPORT'S ROLLUPS (build queue W1, WORKFLOWS.md "The report").
//
//  Per stage of the base workflow (map.ts): runs, success and error rate,
//  retries, p50 and p95 time, top error codes, and add-on runs. The console
//  never scans jobs for this: jobs grows with every encode, clip and image,
//  and a report over thirty days of it would compete with the workers for
//  the control plane's database. Instead, once a minute, the leader reads
//  only what FINISHED in the last few minutes (indexes in migration 0126) and
//  writes it into two tables in the analytics database (qoe/analyticsDb.ts,
//  which already keeps reporting off the control plane's pool):
//
//    wf_minutes  one row per account, minute, source and kind; kept 14 days
//    wf_days     the same per UTC day, rebuilt from the minutes of each day
//                the pass touched; kept as long as the database is
//
//  Sources and kinds:
//    job    a finished job of one type (stage from JOB_STAGES, '' if none)
//    event  a hook that marks a stage's work done (EVENT_RUN_HOOKS), for the
//           stages that have no jobs of their own (Record, Review, Encode)
//    addon  an add-on run that finished, kind = the add-on, hook = its hook
//
//  Each pass RECOMPUTES whole minutes (from a little before the cursor to a
//  minute ago) and replaces them, so running it twice, or two tasks racing,
//  gives the same rows: there is no counter to double. Percentiles come from
//  DDSketches (qoe/sketch.ts), which merge exactly from minutes into days.
//
//  The tables can be dropped and rebuilt from the control plane's rows at any
//  time: clear wf_rollup_to in qoe_meta and the next passes backfill
//  BACKFILL_DAYS. They stay in the analytics Postgres even when the QoE tables
//  have moved to ClickHouse (their names are not in analyticsDb's CH_TABLES):
//  a few thousand rows a day per account do not need it.
// ============================================================================
import { query } from '../../db';
import { analyticsPool } from '../qoe/analyticsDb';
import { add, merge, quantile, type Sketch } from '../qoe/sketch';
import { codeFromMessage, normaliseCode } from '../jobs/errorCode';
import { OWNED, ACCOUNT } from '../jobs/owner';
import { HOOKS, JOB_STAGES, LANES, REPORT_SKIPS_JOBS, STAGES } from './map';

const LOCK = 72010003; // 72010001 schema, 72010002 nightly replay (qoe)
const MINUTE = 60_000;
const DAY = 86_400_000;
/** Work that finished in the last minute may still be committing: leave it for the next pass. */
const LAG_MS = 60_000;
/** Each pass also redoes the few minutes before its cursor, for rows that committed late. */
const REWIND_MS = 5 * MINUTE;
/** The longest window one pass computes (a backfill takes several passes). */
const CHUNK_MS = DAY;
const MINUTES_KEPT_DAYS = 14;
export const BACKFILL_DAYS = 30;

/**
 * Hooks that mean "this stage finished a piece of work". stream.started is
 * left out: a stream's run is counted once, when it stops, and a stop for a
 * fault is that stage's failure. recording.completed carries its duration.
 */
export const EVENT_RUN_HOOKS = new Set(['stream.stopped', 'recording.completed', 'review.decided', 'publication.published', 'upload.received']);

const HOOK_STAGE: Record<string, string> = Object.fromEntries(HOOKS.map((h) => [h.id, h.stage]));
/** Stages whose numbers come from jobs; every other stage reports its hook events. */
const JOB_FED = new Set(Object.values(JOB_STAGES));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wf_minutes (
  account_id  UUID NOT NULL,
  minute      TIMESTAMPTZ NOT NULL,
  source      TEXT NOT NULL,              -- job | event | addon
  kind        TEXT NOT NULL,              -- job type, hook id, or add-on id
  hook        TEXT NOT NULL DEFAULT '',   -- add-on runs: the hook that started it ('manual' by hand)
  stage       TEXT NOT NULL DEFAULT '',   -- the stage in map.ts; '' for a job type no stage claims
  runs        INT NOT NULL DEFAULT 0,
  succeeded   INT NOT NULL DEFAULT 0,
  failed      INT NOT NULL DEFAULT 0,     -- failed, and add-on runs that timed out
  cancelled   INT NOT NULL DEFAULT 0,
  retries     INT NOT NULL DEFAULT 0,     -- attempts past the first; add-on runs started by Retry
  run_sketch  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- time the work took, ms
  wait_sketch JSONB NOT NULL DEFAULT '{}'::jsonb,  -- time it waited before starting, ms
  codes       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {error code: failures}
  PRIMARY KEY (account_id, minute, source, kind, hook)
);
CREATE INDEX IF NOT EXISTS wf_minutes_minute ON wf_minutes (minute);
CREATE TABLE IF NOT EXISTS wf_days (
  account_id  UUID NOT NULL,
  day         DATE NOT NULL,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  hook        TEXT NOT NULL DEFAULT '',
  stage       TEXT NOT NULL DEFAULT '',
  runs        INT NOT NULL DEFAULT 0,
  succeeded   INT NOT NULL DEFAULT 0,
  failed      INT NOT NULL DEFAULT 0,
  cancelled   INT NOT NULL DEFAULT 0,
  retries     INT NOT NULL DEFAULT 0,
  run_sketch  JSONB NOT NULL DEFAULT '{}'::jsonb,
  wait_sketch JSONB NOT NULL DEFAULT '{}'::jsonb,
  codes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, day, source, kind, hook)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'wf_jsonb_sum') THEN
    CREATE AGGREGATE wf_jsonb_sum(jsonb) (SFUNC = qoe_jsonb_add, STYPE = jsonb, INITCOND = '{}');
  END IF;
END $$;
`;

let schemaReady: Promise<void> | null = null;
async function pool() {
  const p = await analyticsPool();
  if (!schemaReady) {
    schemaReady = (async () => {
      const c = await p.connect();
      try { await c.query(`SELECT pg_advisory_lock(72010001)`); await c.query(SCHEMA); }
      finally { await c.query(`SELECT pg_advisory_unlock(72010001)`).catch(() => {}); c.release(); }
    })().catch((e) => { schemaReady = null; throw e; });
  }
  await schemaReady;
  return p;
}

interface Bucket {
  account_id: string; minute: number; source: string; kind: string; hook: string; stage: string;
  runs: number; succeeded: number; failed: number; cancelled: number; retries: number;
  run: Sketch; wait: Sketch; codes: Record<string, number>;
}

const floorMin = (t: number) => Math.floor(t / MINUTE) * MINUTE;
const ms = (a: any, b: any) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);

/** Pure: fold finished rows into minute buckets. Exported for the suite. */
export function bucketRows(jobs: any[], events: any[], runs: any[]): Bucket[] {
  const m = new Map<string, Bucket>();
  const get = (acct: string, at: any, source: string, kind: string, hook: string, stage: string) => {
    const minute = floorMin(new Date(at).getTime());
    const k = `${acct}|${minute}|${source}|${kind}|${hook}`;
    let b = m.get(k);
    if (!b) { b = { account_id: acct, minute, source, kind, hook, stage, runs: 0, succeeded: 0, failed: 0, cancelled: 0, retries: 0, run: {}, wait: {}, codes: {} }; m.set(k, b); }
    return b;
  };
  for (const j of jobs) {
    if (REPORT_SKIPS_JOBS.has(j.type)) continue;
    const b = get(j.account_id, j.finished_at, 'job', j.type, '', JOB_STAGES[j.type] ?? '');
    b.runs++;
    if (j.state === 'succeeded') b.succeeded++;
    else if (j.state === 'cancelled') b.cancelled++;
    else if (j.state === 'failed') {
      b.failed++;
      const code = normaliseCode(j.error_code) ?? codeFromMessage(j.last_error);
      b.codes[code] = (b.codes[code] ?? 0) + 1;
    }
    b.retries += Math.max(0, Number(j.attempts ?? 0) - 1);
    const run = ms(j.started_at ?? j.created_at, j.finished_at);
    if (run != null) add(b.run, Math.max(0, run));
    const wait = ms(j.created_at, j.started_at);
    if (wait != null) add(b.wait, Math.max(0, wait));
  }
  for (const e of events) {
    if (!EVENT_RUN_HOOKS.has(e.hook)) continue;
    const b = get(e.account_id, e.created_at, 'event', e.hook, '', HOOK_STAGE[e.hook] ?? '');
    b.runs++;
    if (e.hook === 'stream.stopped' && e.data?.intent === 'fault') {
      b.failed++; b.codes.stream_fault = (b.codes.stream_fault ?? 0) + 1;
    } else b.succeeded++;
    const d = Number(e.data?.durationMs);
    if (Number.isFinite(d) && d >= 0) add(b.run, d);
  }
  for (const r of runs) {
    const hook = r.hook ?? 'manual';
    const b = get(r.account_id, r.finished_at, 'addon', r.addon_id, hook, hook === 'manual' ? 'manual' : (HOOK_STAGE[hook] ?? ''));
    b.runs++;
    if (r.state === 'succeeded') b.succeeded++;
    else if (r.state === 'cancelled') b.cancelled++;
    else {
      b.failed++;
      const code = r.state === 'timed_out' ? 'timed_out' : codeFromMessage(r.error);
      b.codes[code] = (b.codes[code] ?? 0) + 1;
    }
    if (String(r.created_by ?? '').startsWith('retry:')) b.retries++;
    const run = ms(r.created_at, r.finished_at);
    if (run != null) add(b.run, Math.max(0, run));
    const wait = ms(r.created_at, r.dispatched_at);
    if (wait != null) add(b.wait, Math.max(0, wait));
  }
  return [...m.values()];
}

/** Recompute every minute in [from, to) and the days they fall in. */
export async function rollupWindow(from: number, to: number): Promise<{ rows: number; days: string[] }> {
  from = floorMin(from); to = floorMin(to);
  if (to <= from) return { rows: 0, days: [] };
  const f = new Date(from), t = new Date(to);
  const jobs = await query<any>(
    `SELECT j.type, j.state, j.attempts, j.error_code, j.last_error, j.created_at, j.started_at, j.finished_at, ${ACCOUNT} AS account_id
     ${OWNED}
      WHERE j.finished_at >= $1 AND j.finished_at < $2 AND j.state IN ('succeeded','failed','cancelled')
        AND ${ACCOUNT} IS NOT NULL`, [f, t]);
  const events = await query<any>(
    `SELECT account_id, hook, data, created_at FROM workflow_events
      WHERE created_at >= $1 AND created_at < $2 AND hook = ANY($3)`, [f, t, [...EVENT_RUN_HOOKS]]);
  const runs = await query<any>(
    `SELECT account_id, addon_id, hook, state, error, created_by, created_at, dispatched_at, finished_at FROM addon_runs
      WHERE finished_at >= $1 AND finished_at < $2 AND state IN ('succeeded','failed','cancelled','timed_out')`, [f, t]);
  const buckets = bucketRows(jobs, events, runs);

  const p = await pool();
  const c = await p.connect();
  const days: string[] = [];
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) days.push(new Date(d).toISOString().slice(0, 10));
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM wf_minutes WHERE minute >= $1 AND minute < $2`, [f, t]);
    if (buckets.length) {
      const col = (k: (b: Bucket) => any) => buckets.map(k);
      await c.query(
        `INSERT INTO wf_minutes (account_id, minute, source, kind, hook, stage, runs, succeeded, failed, cancelled, retries, run_sketch, wait_sketch, codes)
         SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::jsonb[], $13::jsonb[], $14::jsonb[])`,
        [col((b) => b.account_id), col((b) => new Date(b.minute)), col((b) => b.source), col((b) => b.kind), col((b) => b.hook), col((b) => b.stage),
         col((b) => b.runs), col((b) => b.succeeded), col((b) => b.failed), col((b) => b.cancelled), col((b) => b.retries),
         col((b) => JSON.stringify(b.run)), col((b) => JSON.stringify(b.wait)), col((b) => JSON.stringify(b.codes))]);
    }
    // A day is rebuilt whole from its minutes, so it is always their exact sum.
    await c.query(`DELETE FROM wf_days WHERE day = ANY($1::date[])`, [days]);
    await c.query(
      `INSERT INTO wf_days (account_id, day, source, kind, hook, stage, runs, succeeded, failed, cancelled, retries, run_sketch, wait_sketch, codes)
       SELECT account_id, (minute AT TIME ZONE 'UTC')::date, source, kind, hook, max(stage),
              sum(runs), sum(succeeded), sum(failed), sum(cancelled), sum(retries),
              wf_jsonb_sum(run_sketch), wf_jsonb_sum(wait_sketch), wf_jsonb_sum(codes)
         FROM wf_minutes WHERE (minute AT TIME ZONE 'UTC')::date = ANY($1::date[])
        GROUP BY 1, 2, 3, 4, 5`, [days]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
  return { rows: buckets.length, days };
}

export const rollupStats = { passes: 0, lastTo: null as string | null, lastRows: 0, lastError: null as string | null };

/**
 * One pass: from the cursor (less REWIND) up to a minute ago, at most CHUNK_MS,
 * then move the cursor. A first pass, or one after the cursor was cleared,
 * starts BACKFILL_DAYS back. Returns false when another task holds the lock.
 */
export async function rollupPass(now = Date.now()): Promise<boolean> {
  const p = await pool();
  const c = await p.connect();
  let locked = false;
  try {
    locked = !!(await c.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK])).rows[0]?.ok;
    if (!locked) return false;
    const end = floorMin(now - LAG_MS);
    const cur = (await c.query(`SELECT v FROM qoe_meta WHERE k = 'wf_rollup_to'`)).rows[0]?.v as string | undefined;
    const start = cur ? new Date(cur).getTime() - REWIND_MS : floorMin(now - BACKFILL_DAYS * DAY);
    const to = Math.min(end, start + CHUNK_MS);
    const r = await rollupWindow(start, to);
    await c.query(`INSERT INTO qoe_meta(k, v) VALUES ('wf_rollup_to', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [new Date(to).toISOString()]);
    await c.query(`DELETE FROM wf_minutes WHERE minute < $1`, [new Date(floorMin(now - MINUTES_KEPT_DAYS * DAY))]);
    rollupStats.passes++; rollupStats.lastTo = new Date(to).toISOString(); rollupStats.lastRows = r.rows; rollupStats.lastError = null;
    return true;
  } finally {
    if (locked) await c.query(`SELECT pg_advisory_unlock($1)`, [LOCK]).catch(() => {});
    c.release();
  }
}

/** Keep passing until caught up (a backfill), then once a minute. Leader only (index.ts). */
export function startWorkflowRollup(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    let caughtUp = true;
    try {
      await rollupPass();
      caughtUp = !rollupStats.lastTo || Date.now() - new Date(rollupStats.lastTo).getTime() < LAG_MS + 2 * MINUTE;
    } catch (e) {
      rollupStats.lastError = (e as Error).message;
      console.error('[workflows] report rollup failed, tried again in a minute', (e as Error).message);
    }
    if (!stopped) { timer = setTimeout(tick, caughtUp ? MINUTE : 1000); timer.unref?.(); }
  };
  timer = setTimeout(tick, 5000); timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

// ---------------------------------------------------------------- the report

export type Range = '24h' | '7d' | '30d';
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 100 : null);
const topCodes = (codes: Record<string, number>, n = 5) =>
  Object.entries(codes).map(([code, count]) => ({ code, count: Number(count) })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, n);

interface Agg { runs: number; succeeded: number; failed: number; cancelled: number; retries: number; run: Sketch; wait: Sketch; codes: Record<string, number> }
const empty = (): Agg => ({ runs: 0, succeeded: 0, failed: 0, cancelled: 0, retries: 0, run: {}, wait: {}, codes: {} });
function fold(a: Agg, r: any): Agg {
  a.runs += Number(r.runs); a.succeeded += Number(r.succeeded); a.failed += Number(r.failed); a.cancelled += Number(r.cancelled); a.retries += Number(r.retries);
  merge(a.run, r.run_sketch ?? {}); merge(a.wait, r.wait_sketch ?? {});
  for (const [k, v] of Object.entries(r.codes ?? {})) a.codes[k] = (a.codes[k] ?? 0) + Number(v);
  return a;
}
function figures(a: Agg) {
  const p = (s: Sketch, q: number) => { const v = quantile(s, q); return v == null ? null : Math.round(v); };
  return {
    runs: a.runs, succeeded: a.succeeded, failed: a.failed, cancelled: a.cancelled, retries: a.retries,
    successRate: pct(a.succeeded, a.runs), errorRate: pct(a.failed, a.runs),
    p50Ms: p(a.run, 0.5), p95Ms: p(a.run, 0.95), waitP50Ms: p(a.wait, 0.5), waitP95Ms: p(a.wait, 0.95),
    topCodes: topCodes(a.codes),
  };
}

/** The report for one account. Reads only the rollups, never jobs. */
export async function workflowReport(accountId: string, range: Range, now = Date.now()) {
  const p = await pool();
  const perMinute = range === '24h';
  const since = perMinute ? new Date(floorMin(now) - DAY) : new Date(Math.floor(now / DAY) * DAY - ((range === '7d' ? 7 : 30) - 1) * DAY);
  const rows = (await p.query(
    perMinute
      ? `SELECT source, kind, hook, stage, date_trunc('hour', minute) AS t, runs, succeeded, failed, cancelled, retries, run_sketch, wait_sketch, codes
           FROM wf_minutes WHERE account_id = $1 AND minute >= $2`
      : `SELECT source, kind, hook, stage, day::timestamptz AS t, runs, succeeded, failed, cancelled, retries, run_sketch, wait_sketch, codes
           FROM wf_days WHERE account_id = $1 AND day >= $2::date`,
    [accountId, since])).rows;

  const stageOf = (r: any) => (r.source === 'job' ? r.stage : r.source === 'event' && !JOB_FED.has(r.stage) ? r.stage : null);
  const byStage = new Map<string, Agg>();
  const other = new Map<string, Agg>();
  const addons = new Map<string, Agg & { addonId: string; hook: string }>();
  const series = new Map<string, { t: string; lane: string; runs: number; failed: number }>();
  const laneOf: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.id, s.lane]));
  for (const r of rows) {
    if (r.source === 'addon') {
      const k = `${r.kind}|${r.hook}`;
      const a = addons.get(k) ?? Object.assign(empty(), { addonId: r.kind, hook: r.hook });
      addons.set(k, fold(a, r) as any);
      continue;
    }
    if (r.source === 'job' && !r.stage) { other.set(r.kind, fold(other.get(r.kind) ?? empty(), r)); continue; }
    const st = stageOf(r);
    if (!st) continue;
    byStage.set(st, fold(byStage.get(st) ?? empty(), r));
    const lane = laneOf[st];
    if (!lane) continue;
    const t = new Date(r.t).toISOString();
    const sk = `${t}|${lane}`;
    const s = series.get(sk) ?? { t, lane, runs: 0, failed: 0 };
    s.runs += Number(r.runs); s.failed += Number(r.failed);
    series.set(sk, s);
  }

  const names = addons.size
    ? Object.fromEntries((await query<any>(`SELECT id, name, category FROM addon_services WHERE account_id = $1 AND id = ANY($2::uuid[])`,
        [accountId, [...new Set([...addons.values()].map((a) => a.addonId))]])).map((a) => [a.id, a]))
    : {};
  const total = empty();
  for (const a of byStage.values()) fold(total, { ...a, run_sketch: {}, wait_sketch: {} });

  return {
    range, bucket: perMinute ? 'hour' : 'day', since: since.toISOString(), until: new Date(now).toISOString(),
    lanes: LANES,
    totals: { runs: total.runs, failed: total.failed, retries: total.retries, errorRate: pct(total.failed, total.runs) },
    stages: STAGES.map(({ impl: _impl, ...s }) => ({
      ...s, fedBy: JOB_FED.has(s.id) ? 'jobs' : (HOOKS.some((h) => h.stage === s.id && EVENT_RUN_HOOKS.has(h.id)) ? 'events' : 'none'),
      ...figures(byStage.get(s.id) ?? empty()),
    })),
    otherJobs: [...other.entries()].map(([type, a]) => ({ type, ...figures(a) })).sort((a, b) => b.runs - a.runs),
    addons: [...addons.values()].map((a) => ({
      addonId: a.addonId, name: names[a.addonId]?.name ?? null, category: names[a.addonId]?.category ?? null, hook: a.hook, ...figures(a),
    })).sort((a, b) => b.runs - a.runs),
    series: [...series.values()].map((s) => ({ ...s, errorRate: pct(s.failed, s.runs) })).sort((a, b) => a.t.localeCompare(b.t) || a.lane.localeCompare(b.lane)),
    // How fresh the numbers are: the end of the last minute rolled up (any task's pass).
    rollup: { through: ((await p.query(`SELECT v FROM qoe_meta WHERE k = 'wf_rollup_to'`)).rows[0]?.v as string | undefined) ?? null },
  };
}
