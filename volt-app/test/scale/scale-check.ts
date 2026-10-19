/**
 * SCALE CHECK: proves the viewer path behaves as SCALING.md says.
 *
 *   DATABASE_URL=postgres://… [REDIS_URL=redis://…] npx tsx test/scale/scale-check.ts
 *
 * Starts the control plane itself (three processes: ROLE=api on :18080,
 * ROLE=api-public on :18081, and two ROLE=scheduler on :18082/:18083), seeds
 * one account / channel / app / key, then checks:
 *
 *   1. a warm anonymous start makes (almost) no database transactions
 *   2. GET /api/availability is marked cacheable at the edge
 *   3. an EPG blackout and a disabled key take effect in well under a second
 *   4. key usage is metered in batches, not per request
 *   5. analytics beacons are buffered: sessions, rollups and concurrency land,
 *      and a replayed `end` is not counted twice
 *   6. the api-public tier refuses admin paths
 *   7. exactly one scheduler leads
 *
 * Uses a throwaway account; leaves its rows behind (prefixed scale-check).
 * Exits non-zero on the first failed check.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgres://volt:volt@localhost:5432/volt';
const ROOT = join(__dirname, '..', '..');
const procs: ChildProcess[] = [];
let failures = 0;

function ok(cond: boolean, what: string, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

function start(role: string, port: number, extra: Record<string, string> = {}) {
  const p = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env, DATABASE_URL: DB, PORT: String(port), ROLE: role, NODE_ENV: 'development',
      KEY_USAGE_FLUSH_SEC: '1', ANALYTICS_FLUSH_SEC: '1', ANALYTICS_CONCURRENCY_SEC: '1',
      ORCH_LAUNCHER: 'mock', PREWARM_ENABLED: 'false', LEADER_RETRY_SEC: '1', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: tsx runs node as a child, and killing only tsx would
    // leave the server (and its leader lock) running.
    detached: true,
  });
  const tag = `[${role}:${port}]`;
  p.stdout!.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(`${tag} ${d}`); });
  p.stderr!.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(`${tag} ${d}`); });
  procs.push(p);
  return p;
}

async function waitReady(port: number, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(`http://localhost:${port}/health/ready`); if (r.ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`port ${port} never became ready`);
}

function killGroup(p: ChildProcess, sig: NodeJS.Signals) {
  try { process.kill(-p.pid!, sig); } catch { /* already gone */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function xacts(c: Client): Promise<number> {
  // Fresh snapshot each call: pg_stat views are cached per transaction.
  await c.query('SELECT pg_stat_clear_snapshot()');
  const r = await c.query(`SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()`);
  return Number(r.rows[0].n);
}

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  // The api role migrates; wait for it before seeding.
  start('api', 18080);
  await waitReady(18080);

  // ---- seed --------------------------------------------------------------
  const acct = (await db.query(`INSERT INTO accounts(name) VALUES ('scale-check ' || now()) RETURNING id`)).rows[0].id;
  const group = (await db.query(`INSERT INTO groups(account_id, name) VALUES ($1, 'scale-check') RETURNING id`, [acct])).rows[0].id;
  const ch = (await db.query(
    `INSERT INTO channels(group_id, name, status, on_air) VALUES ($1, 'scale-check', 'live', true) RETURNING id`, [group])).rows[0].id;
  await db.query(`INSERT INTO stream_status(channel_id, output_available, updated_at) VALUES ($1, true, now())`, [ch]);
  const app = (await db.query(`INSERT INTO apps(account_id, name, type) VALUES ($1, 'scale-check', 'web') RETURNING id`, [acct])).rows[0].id;
  const raw = `pk_test_${randomBytes(24).toString('base64url')}`;
  const keyId = (await db.query(
    `INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}') RETURNING id`,
    [acct, app, raw.slice(0, 14), createHash('sha256').update(raw).digest('hex')])).rows[0].id;

  const base = 'http://localhost:18080';
  const getAvail = (geo = 'AU', port = 18080) => fetch(`http://localhost:${port}/api/availability?appKey=${encodeURIComponent(raw)}&assetId=${ch}&geo=${geo}`);

  // ---- 1 + 2: warm path, cache headers ---------------------------------------
  let r = await getAvail();
  const first = await r.json();
  ok(r.status === 200 && first.available === true, 'GET availability plays', `status ${r.status}`);
  ok(/s-maxage=\d+/.test(r.headers.get('cache-control') ?? ''), 'GET availability is edge-cacheable', r.headers.get('cache-control') ?? '');
  ok(!!first.delivery?.hls, 'availability returns the manifest URL', JSON.stringify(first.delivery));
  for (let i = 0; i < 20; i++) await getAvail();   // warm every cache entry
  await sleep(1500);                                 // let the key-usage flush settle
  const before = await xacts(db);
  const N = 500;
  await Promise.all(Array.from({ length: N }, () => getAvail().then((x) => x.arrayBuffer())));
  const after = await xacts(db);
  // Our own two xacts() calls, a key-usage flush or two, the 1 s analytics
  // and concurrency timers: a handful. The old path was ~6-20 per request.
  const used = after - before;
  ok(used < 25, `${N} warm anonymous starts cost ${used} database transactions`, `old path: ~${N * 6}-${N * 20}`);

  const pr = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: raw, assetId: ch, geo: 'AU' }) });
  ok(pr.status === 200 && (pr.headers.get('cache-control') ?? '').includes('no-store'), 'POST availability plays and is not cached');

  // ---- 3: invalidation ------------------------------------------------------------
  await db.query(
    `INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries)
     VALUES ($1, 'scale-check blackout', now() - interval '1 minute', now() + interval '1 hour', 'block', '{AU}')`, [ch]);
  await sleep(300);
  r = await getAvail();
  ok(r.status === 451, 'EPG blackout applies within 300 ms (cache invalidated by trigger)', `status ${r.status}`);
  r = await getAvail('NZ');
  ok(r.status === 200, 'other countries still play');

  await db.query(`UPDATE api_keys SET enabled = false WHERE id = $1`, [keyId]);
  await sleep(300);
  r = await getAvail('NZ');
  ok(r.status === 401, 'disabled key refused within 300 ms', `status ${r.status}`);
  await db.query(`UPDATE api_keys SET enabled = true WHERE id = $1`, [keyId]);
  await sleep(300);

  // ---- 4: key usage batched ---------------------------------------------------------
  const rc0 = Number((await db.query(`SELECT request_count FROM api_keys WHERE id=$1`, [keyId])).rows[0].request_count);
  await Promise.all(Array.from({ length: 100 }, () => getAvail('NZ').then((x) => x.arrayBuffer())));
  await sleep(2500);
  const rc1 = Number((await db.query(`SELECT request_count FROM api_keys WHERE id=$1`, [keyId])).rows[0].request_count);
  ok(rc1 - rc0 >= 100, 'key usage counted (batched)', `+${rc1 - rc0}`);

  // ---- 5: analytics -------------------------------------------------------------------
  const tok = (await (await getAvail('NZ')).json()).playbackToken as string;
  const beacon = (sessionId: string, event: string, seconds = 0) => fetch(`${base}/api/analytics/beacon`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome' },
    body: JSON.stringify({ playbackToken: tok, sessionId, event, seconds }),
  });
  const sessions = Array.from({ length: 100 }, () => `sc-${randomUUID()}`);
  await Promise.all(sessions.map((s) => beacon(s, 'start')));
  await Promise.all(sessions.map((s) => beacon(s, 'heartbeat', 30)));
  await Promise.all(sessions.slice(0, 40).map((s) => beacon(s, 'end', 5)));
  await sleep(3000);
  const ps = (await db.query(
    `SELECT count(*)::int AS n, count(ended_at)::int AS ended, sum(seconds_watched)::int AS secs
       FROM play_sessions WHERE account_id=$1`, [acct])).rows[0];
  ok(ps.n === 100 && ps.ended === 40, 'sessions written in batches', JSON.stringify(ps));
  ok(ps.secs === 100 * 30 + 40 * 5, 'watch seconds add up', String(ps.secs));
  const roll = async () => (await db.query(
    `SELECT total_views::int AS v, watch_seconds::int AS s FROM analytics_rollups WHERE account_id=$1 AND scope='channel' AND scope_id=$2`,
    [acct, ch])).rows[0];
  const r1 = await roll();
  ok(r1?.v === 40 && r1?.s === 40 * 35, 'ended sessions rolled up', JSON.stringify(r1));
  await Promise.all(sessions.slice(0, 40).map((s) => beacon(s, 'end', 5)));   // replay
  await sleep(2500);
  const r2 = await roll();
  ok(r2?.v === 40, 'replayed end not counted twice', JSON.stringify(r2));
  const conc = (await db.query(`SELECT concurrent FROM stream_concurrency WHERE asset_kind='channel' AND asset_id=$1`, [ch])).rows[0];
  ok(conc?.concurrent === 60, 'concurrency = open sessions', JSON.stringify(conc));

  // ---- 6: public tier -----------------------------------------------------------------
  start('api-public', 18081);
  await waitReady(18081);
  r = await fetch('http://localhost:18081/api/channels');
  ok(r.status === 404, 'api-public refuses admin paths', `status ${r.status}`);
  r = await getAvail('NZ', 18081);
  ok(r.status === 200, 'api-public serves the play gate', `status ${r.status}`);

  // ---- 7: one leader -------------------------------------------------------------------
  start('scheduler', 18082);
  start('scheduler', 18083);
  await waitReady(18082); await waitReady(18083);
  await sleep(4000);
  const leaders = [];
  for (const p of [18080, 18081, 18082, 18083]) {
    const h = await (await fetch(`http://localhost:${p}/health/ready`)).json();
    if (h.leader) leaders.push(p);
  }
  ok(leaders.length === 1 && leaders[0] !== 18080 && leaders[0] !== 18081, 'exactly one scheduler leads', JSON.stringify(leaders));
  // Kill the leader: the other takes over.
  const leaderProc = procs[leaders[0] === 18082 ? 2 : 3];
  killGroup(leaderProc, 'SIGKILL');
  await sleep(4000);
  const other = leaders[0] === 18082 ? 18083 : 18082;
  const h2 = await (await fetch(`http://localhost:${other}/health/ready`)).json();
  ok(h2.leader === true, 'standby takes over when the leader dies');

  await db.end();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    for (const p of procs) killGroup(p, 'SIGTERM');
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    setTimeout(() => process.exit(failures ? 1 : 0), 1500);
  });
