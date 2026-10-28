// ============================================================================
//  THE REPLICA DRILL (build queue 2.11 acceptance: "a replica lost and
//  rebuilt with no report gap"). For a real two-replica cluster, such as the
//  one deploy/terraform/clickhouse.tf builds; the stand-in used by the checks
//  (scripts/chdb-http.py) cannot replicate.
//
//    CLICKHOUSE_URL=http://volt:<pw>@10.0.8.20:8123,http://volt:<pw>@10.0.9.21:8123 \
//    CLICKHOUSE_DATABASE=volt_qoe CLICKHOUSE_CLUSTER=volt QOE_STORE=clickhouse \
//    DATABASE_URL=postgres://... npx tsx scripts/clickhouse-drill.ts \
//      --lose  "<command that stops replica 2 and deletes its data>" \
//      --start "<command that starts replica 2 again, empty>" [--account <id>] [--minutes 10]
//
//  On AWS the commands are SSM Run Command on the second replica, for example
//    --lose  "aws ssm send-command --instance-ids i-... --document-name AWS-RunShellScript --parameters commands='systemctl stop clickhouse-server; rm -rf /var/lib/clickhouse/store/*/*/'"
//    --start "aws ssm send-command --instance-ids i-... --document-name AWS-RunShellScript --parameters commands='sudo -u clickhouse touch /var/lib/clickhouse/flags/force_restore_data; systemctl start clickhouse-server'"
//  The data goes, the table definitions stay; force_restore_data makes the
//  server fetch every part it should have from replica 1 through Keeper. A
//  server lost outright is replaced by applying Terraform again (same
//  address and replica name) after SYSTEM DROP REPLICA 'replica-2' on
//  replica 1; the app makes its tables ON CLUSTER and they refill the same way.
//
//  What it checks, printing PASS or FAIL for each:
//    1. before: both replicas hold the same rows (per table);
//    2. while replica 2 is gone and while it refills: the reports answer
//       every 2 s through CLICKHOUSE_URL with the same totals or more (no
//       gap, nothing going backwards), and the collector's writes go in;
//    3. after: replica 2 caught up (no replication queue, no delay) and holds
//       exactly what replica 1 holds, including the rows written meanwhile.
// ============================================================================
import { execSync } from 'node:child_process';

const arg = (name: string, d = '') => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, x?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (x !== undefined ? ' ' + JSON.stringify(x) : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const urls = (process.env.CLICKHOUSE_URL ?? '').split(',').filter(Boolean);
  if (urls.length < 2 || !arg('--lose') || !arg('--start')) { console.error('needs CLICKHOUSE_URL with both replicas, --lose and --start'); process.exit(2); }
  process.env.QOE_STORE = 'clickhouse';
  const ch = await import('../src/services/qoe/clickhouse');
  const sw = await import('../src/services/qoe/storeSwitch');
  const reports = await import('../src/services/qoe/reports');
  const store = await import('../src/services/qoe/store');
  const db = sw.qoeChDatabase();
  const minutes = Number(arg('--minutes', '10'));
  const acct = arg('--account') || (await ch.chSelect<any>(`SELECT account_id FROM qoe_views GROUP BY account_id ORDER BY count() DESC LIMIT 1`, db))[0]?.account_id;
  const tables = ['qoe_views', 'qoe_minutes', 'qoe_collector_minutes', 'qoe_gate', 'qoe_app_sessions', 'qoe_journeys', 'qoe_cdn_minutes', 'qoe_cdn_sessions'];
  const on = async (u: string, sql: string) => { process.env.CLICKHOUSE_URL = u; ch.resetClickhouse(); try { return await ch.chSelect<any>(sql, db); } finally { process.env.CLICKHOUSE_URL = urls.join(','); ch.resetClickhouse(); } };
  const counts = async (u: string) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await on(u, `SELECT count() AS n FROM ${t} ${['qoe_views', 'qoe_app_sessions', 'qoe_journeys'].includes(t) ? 'FINAL' : ''}`))[0].n)])));
  const q = reports.parseQuery({ days: 400 });

  const before1 = await counts(urls[0]), before2 = await counts(urls[1]);
  ok(JSON.stringify(before1) === JSON.stringify(before2), 'before: both replicas hold the same rows', { replica1: before1, replica2: before2 });
  const base = await reports.playbackSuccess(acct, q);
  console.log(`account ${acct}: ${base.attempts} views over 400 days`);

  console.log(`losing replica 2: ${arg('--lose')}`);
  execSync(arg('--lose'), { stdio: 'inherit' });
  let polls = 0, failures = 0, backwards = 0, written = 0, last = base.attempts;
  const until = Date.now() + minutes * 60_000;
  let restarted = false;
  while (Date.now() < until) {
    try {
      const r = await reports.playbackSuccess(acct, q);
      polls++; if (r.attempts < last) backwards++; last = r.attempts;
    } catch { failures++; }
    try {
      const id = `drill-${Date.now()}`;
      const now = Date.now();
      await store.writeViews([{ account_id: acct, view_id: id, day: new Date(now).toISOString().slice(0, 10), def_version: 3, sid: id, attempt: 1, app_id: null, started_at: now - 1000, ended_at: now,
        ended_by: 'q', outcome: 'exited', unknown_keys: {} } as any]);
      written++;
    } catch { failures++; }
    if (!restarted && Date.now() > until - (minutes * 60_000) / 2) { console.log(`starting replica 2 again: ${arg('--start')}`); execSync(arg('--start'), { stdio: 'inherit' }); restarted = true; }
    await sleep(2000);
  }
  ok(failures === 0 && polls > 0, `the reports answered all ${polls} polls and ${written} writes went in while replica 2 was gone and refilling`, { failures });
  ok(backwards === 0, 'no total ever went backwards (no gap)');

  // Wait for replica 2 to catch up.
  let caught = false;
  for (let i = 0; i < 180 && !caught; i++) {
    try {
      const [r] = await on(urls[1], `SELECT max(absolute_delay) AS d, sum(queue_size) AS qs FROM system.replicas WHERE database = ${ch.lit(db)}`);
      caught = Number(r.d) === 0 && Number(r.qs) === 0;
    } catch { /* still starting */ }
    if (!caught) await sleep(5000);
  }
  ok(caught, 'replica 2 caught up: no replication queue, no delay');
  const after1 = await counts(urls[0]), after2 = await counts(urls[1]);
  ok(JSON.stringify(after1) === JSON.stringify(after2) && after1.qoe_views >= before1.qoe_views + written, 'after: replica 2 holds exactly what replica 1 holds, the drill\'s writes included', { replica1: after1, replica2: after2 });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
