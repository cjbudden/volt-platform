// ============================================================================
//  WHICH STORE HOLDS THE DERIVED QOE DATA, AND THE SWITCH TO CLICKHOUSE
//  (build queue 2.11, QOE_REPORTING.md sections 9 and 9a).
//
//    QOE_STORE                 postgres (default), clickhouse, or auto
//    QOE_CLICKHOUSE_ABOVE_VH   auto: viewer hours in the last 30 days that
//                              move the reports to ClickHouse (default
//                              1000000, the size QOE_REPORTING.md section 9
//                              gives for the switch)
//    QOE_BACKFILL_DAYS         auto: how far back the move rebuilds (default
//                              400, the longest window a report takes)
//
//  postgres and clickhouse are fixed. auto starts on the Postgres analytics
//  database and moves once, by itself, when the audience passes the size:
//
//    postgres ── audience over the size, CLICKHOUSE_URL set ──► moving
//    moving:   from the switch minute every write goes to BOTH stores; the
//              reports still read Postgres. The history is rebuilt in
//              ClickHouse from the raw archive (the replay, day by day, so
//              ClickHouse holds exactly what a replay would give, not a copy
//              of rows that might predate a definitions change), and the two
//              server logs that are not rebuildable (the play gate's
//              decisions, the collector's refusals) are copied up to the
//              switch minute. The switch day itself is replayed once it is
//              over, which covers the minutes before the switch.
//    moving ── all of that done ──► clickhouse: reads and writes ClickHouse only.
//
//  No gap and no double count: everything after the switch minute was
//  written to ClickHouse as it happened; everything before it comes from
//  the replay or the copy, and the switch day's replay replaces that whole
//  day. The Postgres tables are left as they were (nothing is deleted).
//  It never moves back by itself; QOE_STORE=postgres does that.
//
//  The state is a row in the Postgres analytics database's qoe_meta (key
//  store), so every API process agrees; each reads it at most every 15 s.
// ============================================================================
import { aquery, analyticsPool, analyticsUrl } from './analyticsDb';
import { chDatabase, chExec, chInsert, clickhouseConfigured, lit } from './clickhouse';

export type StoreKind = 'postgres' | 'clickhouse';
export interface StoreState { phase: 'postgres' | 'moving' | 'clickhouse'; switchAt?: number; backfilledTo?: string | null; copied?: boolean; doneAt?: number; viewerHours?: number }

const mode = (): 'postgres' | 'clickhouse' | 'auto' => {
  const m = (process.env.QOE_STORE ?? 'postgres').toLowerCase();
  return m === 'clickhouse' || m === 'auto' ? m : 'postgres';
};
export const switchAboveVh = () => Math.max(0, Number(process.env.QOE_CLICKHOUSE_ABOVE_VH ?? 1_000_000));
const backfillDays = () => Math.max(1, Math.min(800, Number(process.env.QOE_BACKFILL_DAYS ?? 400)));

let cached: { at: number; s: StoreState } | null = null;

/** The move's state (auto), or the fixed store. */
export async function storeState(force = false): Promise<StoreState> {
  const m = mode();
  if (m === 'postgres') return { phase: 'postgres' };
  if (m === 'clickhouse') return { phase: 'clickhouse' };
  if (!force && cached && Date.now() - cached.at < 15_000) return cached.s;
  let s: StoreState = { phase: 'postgres' };
  try {
    const [r] = await aquery<any>(`SELECT v FROM qoe_meta WHERE k = 'store'`);
    if (r?.v) s = JSON.parse(r.v);
  } catch { /* unreadable: stay where reads are safe */ }
  cached = { at: Date.now(), s };
  return s;
}

async function saveState(s: StoreState): Promise<void> {
  await aquery(`INSERT INTO qoe_meta(k, v) VALUES ('store', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [JSON.stringify(s)]);
  cached = { at: Date.now(), s };
}

/** Where the reports read. */
export async function readStore(): Promise<StoreKind> {
  return (await storeState()).phase === 'clickhouse' ? 'clickhouse' : 'postgres';
}

/**
 * Where a write goes. While moving, ClickHouse gets the rows from the switch
 * minute on (`since`); for the derived tables that is every row (the switch
 * day is replayed anyway), for the two server logs only rows at or after it.
 */
export async function writeTargets(): Promise<Array<{ kind: StoreKind; since?: number }>> {
  const s = await storeState();
  if (s.phase === 'moving') return [{ kind: 'postgres' }, { kind: 'clickhouse', since: s.switchAt }];
  return [{ kind: s.phase === 'clickhouse' ? 'clickhouse' : 'postgres' }];
}

/** The ClickHouse database for this install (named after the Postgres analytics database unless set). */
export function qoeChDatabase(): string {
  let fallback = 'volt_qoe';
  try { fallback = decodeURIComponent(new URL(analyticsUrl()).pathname.replace(/^\//, '')) || fallback; } catch { /* the default */ }
  return chDatabase(fallback);
}

/** For tests. */
export function resetStoreState(): void { cached = null; }

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface SwitchDeps {
  /** Rebuild one day of every account from the raw archive into ClickHouse (replay.ts replayRange with target clickhouse). */
  replayInto: (day: string) => Promise<number>;
}

/**
 * One step of the move, run hourly by the API (and by tests with their own
 * clock). Under an advisory lock, so two processes never do the same step.
 * Returns what it did.
 */
export async function checkStoreSwitch(deps: SwitchDeps, now = Date.now()): Promise<string> {
  if (mode() !== 'auto') return 'fixed store';
  if (!clickhouseConfigured()) return 'CLICKHOUSE_URL not set';
  const pool = await analyticsPool();
  const c = await pool.connect();
  try {
    const [{ locked }] = (await c.query(`SELECT pg_try_advisory_lock(72010011) AS locked`)).rows;
    if (!locked) return 'another process is moving';
    try { return await step(deps, now); }
    finally { await c.query(`SELECT pg_advisory_unlock(72010011)`).catch(() => {}); }
  } finally { c.release(); }
}

async function step(deps: SwitchDeps, now: number): Promise<string> {
  const s = await storeState(true);
  if (s.phase === 'clickhouse') return 'on clickhouse';
  if (s.phase === 'postgres') {
    // Viewer hours: playing time of the views that ended in the last 30 days, every account.
    const [r] = await aquery<any>(`SELECT COALESCE(sum(playing_ms), 0) AS ms FROM qoe_views WHERE ended_at >= $1`, [new Date(now - 30 * DAY).toISOString()]);
    const vh = Number(r?.ms ?? 0) / 3_600_000;
    if (vh < switchAboveVh()) return `staying on postgres (${Math.round(vh)} viewer hours in 30 days, switch at ${switchAboveVh()})`;
    // The next whole minute: the collector's minute rows never straddle it.
    const switchAt = Math.ceil((now + 1) / 60_000) * 60_000;
    await saveState({ phase: 'moving', switchAt, backfilledTo: null, copied: false, viewerHours: Math.round(vh) });
    return `moving to clickhouse from ${new Date(switchAt).toISOString()} (${Math.round(vh)} viewer hours in 30 days)`;
  }
  // moving
  const switchAt = s.switchAt!;
  if (now < switchAt) return 'waiting for the switch minute';
  const switchDay = dayOf(switchAt);
  const done: string[] = [];
  // 1. The server logs, up to the switch minute (after it they are written to both).
  if (!s.copied) {
    const db = qoeChDatabase();
    const cut = new Date(switchAt).toISOString();
    await chExec(`DELETE FROM qoe_gate WHERE at < ${lit(cut)}`, db);
    await chExec(`DELETE FROM qoe_collector_minutes WHERE minute < ${lit(cut)}`, db);
    let n = 0;
    for (let from = 0; ; ) {
      const rows = await aquery<any>(`SELECT account_id, app_id, sid, at, method, status, mode, reason, layer, rule_id, asset_id, asset_kind, country, ms, id
        FROM qoe_gate WHERE at < $1 AND id > $2 ORDER BY id LIMIT 20000`, [cut, from]);
      if (!rows.length) break;
      await chInsert('qoe_gate', rows.map(({ id: _id, ...g }) => ({ ...g, at: new Date(g.at).toISOString() })), db);
      from = Number(rows[rows.length - 1].id); n += rows.length;
    }
    const counts = await aquery<any>(`SELECT account_id, minute, accepted, rejected, reasons FROM qoe_collector_minutes WHERE minute < $1`, [cut]);
    await chInsert('qoe_collector_minutes', counts.map((x) => ({ ...x, minute: new Date(x.minute).toISOString() })), db, { additive: true });
    s.copied = true; await saveState(s);
    done.push(`copied ${n} gate decisions and ${counts.length} collector minutes`);
  }
  // 2. The history, a day at a time from the oldest, so a restart resumes where it stopped.
  const first = dayOf(switchAt - backfillDays() * DAY);
  let day = s.backfilledTo ? dayOf(Date.parse(s.backfilledTo + 'T00:00:00Z') + DAY) : first;
  let views = 0, days = 0;
  const budget = Date.now() + 20 * 60_000; // one step does at most 20 minutes of it; the next hour carries on
  while (day < switchDay && Date.now() < budget) {
    views += await deps.replayInto(day);
    s.backfilledTo = day; days++;
    await saveState(s);
    day = dayOf(Date.parse(day + 'T00:00:00Z') + DAY);
  }
  if (days) done.push(`replayed ${days} days (${views} views) into clickhouse`);
  if (day < switchDay) return done.join('; ') + '; history not finished';
  // 3. The switch day, once it is over and its views have closed (a view closes after at most an hour of silence).
  const dayEnd = Date.parse(switchDay + 'T00:00:00Z') + DAY;
  if (now < dayEnd + 2 * 3_600_000) return [...done, `history done; the switch day is replayed after ${new Date(dayEnd + 2 * 3_600_000).toISOString()}`].join('; ');
  await deps.replayInto(switchDay);
  await saveState({ ...s, phase: 'clickhouse', backfilledTo: switchDay, doneAt: now });
  return [...done, 'switch day replayed; reports now read clickhouse'].join('; ');
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Started by the API when QOE_STORE=auto: one step an hour (and one a minute after start). */
export function startStoreSwitch(deps: SwitchDeps): void {
  if (mode() !== 'auto' || timer) return;
  const run = () => { checkStoreSwitch(deps).then((m) => { if (!/^staying|^on clickhouse|^fixed/.test(m)) console.log('[qoe] store:', m); }).catch((e) => console.error('[qoe] store switch', e.message)); };
  setTimeout(run, 60_000).unref?.();
  timer = setInterval(run, 3_600_000);
  timer.unref?.();
}

export const moveStats = { postgresWriteFailures: 0, lastPostgresError: null as string | null };

/**
 * Run a write against the store(s) it belongs in. `target` forces one
 * (a replay into ClickHouse during the move). While moving, ClickHouse is
 * written first and a failure there is thrown (the caller keeps the rows and
 * tries again, nothing having been written); Postgres, which the reports
 * leave within a day, is written after it and a failure there is only
 * counted, so a retry can never add the same minutes into ClickHouse twice.
 */
export async function forEachTarget(write: { clickhouse: (since?: number) => Promise<void>; postgres: () => Promise<void> }, target?: StoreKind): Promise<void> {
  if (target) return target === 'clickhouse' ? write.clickhouse() : write.postgres();
  const ts = await writeTargets();
  if (ts.length === 1) return ts[0].kind === 'clickhouse' ? write.clickhouse() : write.postgres();
  const ch = ts.find((t) => t.kind === 'clickhouse')!;
  await write.clickhouse(ch.since);
  try { await write.postgres(); }
  catch (e) { moveStats.postgresWriteFailures++; moveStats.lastPostgresError = (e as Error).message; }
}
