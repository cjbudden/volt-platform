// ============================================================================
//  PER-STREAM OPERATING REPORT.  docs/REQ_stream_reporting.md section 6.
//
//  Pins the six acceptance criteria against a real database, plus the rules
//  that make the numbers defensible:
//
//    AC1  three runs are three rows, and the total is their sum
//    AC2  deleting the channel does not delete the report (runs, air, stops)
//    AC3  hours run and hours on air differ; a run never on air reports 0 air
//    AC4  exact peak inside the raw window, NOT RETAINED (null, never 0) outside
//         it, with the day's rollup peak offered instead
//    AC5  a rename does not rewrite the name on historical rows
//    AC6  a fault stop and an operator stop are distinguishable without a log
//
//  Plus: a hand-over between viewers is not a peak, events derive air from
//  their public window, station MP3 listeners are reported separately, the
//  period clips runs, cost is hidden from non-platform readers, and the HTTP
//  routes (JSON + CSV) answer with the same numbers.
//
//  Usage: DATABASE_URL=... npx tsx test/stream-report.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';
import {
  resolveStream, streamReport, streamReportCsv, overlapSeconds, mergeIntervals, coveredSeconds, mttr, chainSlices,
} from '../src/services/streamReport';
import { recordRunStop } from '../src/services/orchestrator/service';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const A  = '00000000-0000-0000-0000-0000000e0a01';
const P  = '00000000-0000-0000-0000-0000000e0a02';
const G  = '00000000-0000-0000-0000-0000000e0a03';
const C1 = '00000000-0000-0000-0000-0000000e0c01';   // tv channel
const R1 = '00000000-0000-0000-0000-0000000e0c02';   // station
const E1 = '00000000-0000-0000-0000-0000000e0e01';   // event
const U1 = '00000000-0000-0000-0000-0000000e0b01';   // ordinary admin
const U2 = '00000000-0000-0000-0000-0000000e0b02';   // platform admin
const I = (n: number) => `00000000-0000-0000-0000-0000000e1${String(n).padStart(3, '0')}`;

const H = 3600_000, MIN = 60_000, DAY = 86_400_000;
const NOW = Date.now();
const at = (ms: number) => new Date(ms).toISOString();

/** A finished run: an instance row plus its meter slices (one per UTC day, as the meter writes them). */
async function run(n: number, stream: string, kind: 'channel' | 'event', from: number, to: number | null, name: string) {
  await query(
    `INSERT INTO instances(id, ${kind}_id, role, state, launched_at, terminated_at, task_kind, instance_type, lifecycle)
     VALUES ($1,$2,'primary',$3,$4,$5,'transcode','c5.large','on_demand')`,
    [I(n), stream, to == null ? 'running' : 'terminated', at(from), to == null ? null : at(to)]);
  const end = to ?? NOW;
  let cur = from;
  while (cur < end) {
    const boundary = Math.ceil((cur + 1) / DAY) * DAY;
    const t = Math.min(boundary, end);
    const secs = Math.round((t - cur) / 1000);
    await query(
      `INSERT INTO usage_accruals(account_id, instance_id, instance_ref, ${kind}_id, stream_id, stream_name, task_kind,
         instance_type, lifecycle, from_at, to_at, seconds, usd_per_hour, est_usd, indicative)
       VALUES ($1,$2,$2,$3,$3,$4,'transcode','c5.large','on_demand',$5,$6,$7,0.1,$8,false)`,
      [A, I(n), stream, name, at(cur), at(t), secs, (secs / 3600) * 0.1]);
    cur = t;
  }
}
async function viewer(key: string, asset: 'channel' | 'event', id: string, from: number, to: number, ip = key) {
  await query(
    `INSERT INTO play_sessions(account_id, session_key, asset_kind, asset_id, started_at, last_seen_at, ended_at, seconds_watched, ip_hash, blocked)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,false)`,
    [A, key, asset, id, at(from), at(to), Math.round((to - from) / 1000), ip]);
}

(async () => {
  // ---- pure helpers -----------------------------------------------------
  console.log('== interval arithmetic ==');
  check('overlap of disjoint intervals is zero', overlapSeconds({ from: 0, to: 1000 }, { from: 2000, to: 3000 }), 0);
  check('overlap is clipped', overlapSeconds({ from: 0, to: 10_000 }, { from: 4000, to: 20_000 }), 6);
  check('overlapping windows merge, so air time cannot exceed wall clock',
    mergeIntervals([{ from: 0, to: 5000 }, { from: 3000, to: 8000 }, { from: 9000, to: 9500 }]).length, 2);
  check('covered seconds counts a double window once',
    coveredSeconds({ from: 0, to: 10_000 }, [{ from: 0, to: 6000 }, { from: 2000, to: 6000 }]), 6);
  const m = mttr([{ start: 0, end: 1000, stop: 'fault' }, { start: 61_000, end: 90_000, stop: 'operator' }, { start: 100_000, end: 110_000, stop: 'fault' }]);
  check('MTTR is the time from a fault to the next run', m.seconds, 60);
  check('a fault with no later run is counted as unrecovered, not averaged in', m.unrecovered, 1);
  check('back-to-back meter slices chain into one run',
    chainSlices([{ from_at: at(0), to_at: at(H) }, { from_at: at(H), to_at: at(2 * H) }, { from_at: at(3 * H), to_at: at(4 * H) }]).length, 2);

  // ---- fixture ----------------------------------------------------------
  await query(`DELETE FROM run_stops WHERE account_id = $1`, [A]);
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name,analytics_raw_retention_days) VALUES ($1,'ReportCo',30)`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
               VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','transcode')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ($1,$2,'g',$3,20,10)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind,on_air) VALUES
                 ($1,$3,'Harbourside News','ended','tv',false), ($2,$3,'Harbour FM','ended','radio',false)`, [C1, R1, G]);

  // Harbourside News, three runs inside the last 30 days:
  //   run 1  10 days ago, 2 h, never on air, ends in a FAULT
  //   run 2  starts 10 min after run 1 ended, 3 h, on air for the middle hour, OPERATOR stop
  //   run 3  2 days ago, 1 h, on air throughout, SCHEDULE stop
  // and one old run, 100 days ago, outside the raw window.
  const r1 = NOW - 10 * DAY, r2 = r1 + 2 * H + 10 * MIN, r3 = NOW - 2 * DAY, r0 = NOW - 100 * DAY;
  await run(1, C1, 'channel', r1, r1 + 2 * H, 'Harbourside News');
  await run(2, C1, 'channel', r2, r2 + 3 * H, 'Harbourside News');
  await run(3, C1, 'channel', r3, r3 + H, 'Harbourside News');
  await run(9, C1, 'channel', r0, r0 + H, 'Harbourside News (old name)');
  await recordRunStop('channel', C1, I(1), 'fault', 'encoder exited rc=183');
  await recordRunStop('channel', C1, I(2), 'operator', 'console: chris');
  await recordRunStop('channel', C1, I(3), 'schedule', 'window closed');
  await query(`INSERT INTO air_sessions(account_id,stream_kind,stream_id,stream_name,channel_id,from_at,to_at,seconds,close_reason) VALUES
                 ($1,'channel',$2,'Harbourside News',$2,$3,$4,3600,'operator'),
                 ($1,'channel',$2,'Harbourside News',$2,$5,$6,3600,'schedule')`,
    [A, C1, at(r2 + H), at(r2 + 2 * H), at(r3), at(r3 + H)]);

  // Viewers on run 2: a peak of 3, and a hand-over (one leaves the instant another arrives) that must NOT read as 4.
  await viewer('v1', 'channel', C1, r2 + 10 * MIN, r2 + 2 * H);
  await viewer('v2', 'channel', C1, r2 + 20 * MIN, r2 + 50 * MIN);
  await viewer('v3', 'channel', C1, r2 + 30 * MIN, r2 + 40 * MIN);
  await viewer('v4', 'channel', C1, r2 + 50 * MIN, r2 + 70 * MIN);   // arrives exactly as v2 leaves
  // The old run's day is out of the raw window and sealed, so its raw rows are gone; the rollup survives.
  const oldDay = at(r0).slice(0, 10);
  await query(`INSERT INTO analytics_rollups(account_id,scope,scope_id,bucket_date,total_views,unique_views,peak_concurrent,watch_seconds,sealed)
               VALUES ($1,'account',NULL,$2,40,30,12,9000,true), ($1,'channel',$3,$2,40,30,12,9000,true)`, [A, oldDay, C1]);

  const s = (await resolveStream(A, C1))!;
  const from = new Date(NOW - 30 * DAY), to = new Date(NOW);
  const rep = await streamReport(A, s, from, to);

  console.log('\n== AC1: three runs, three rows, the total is the sum ==');
  check('three runs in the last 30 days', rep.runs.length, 3);
  check('newest first', rep.runs[0].instance_id, I(3));
  check('run 1 is two hours', rep.runs[2].duration_seconds, 7200);
  check('total run seconds equals the sum of the rows',
    rep.totals.run_seconds, rep.runs.reduce((n, r) => n + r.seconds_in_period, 0));
  check('which is six hours', rep.totals.run_seconds, 6 * 3600);

  console.log('\n== AC3: hours run and hours on air are different numbers ==');
  check('two hours on air in the period', rep.totals.on_air_seconds, 2 * 3600);
  check('a run that never went on air reports zero air time', rep.runs[2].on_air_seconds, 0);
  check('the middle run was on air for one hour of three', rep.runs[1].on_air_seconds, 3600);
  check('availability for a 24x7 channel is air over the period',
    rep.totals.availability_window, 'period');
  {
    // The channel first ran ten days ago: the twenty days before it existed are
    // not an outage and must not be counted as one.
    const want = Math.round((2 * 3600) / ((NOW - r1) / 1000) * 10000) / 100;
    const got = rep.totals.availability_pct ?? -1;
    Math.abs(got - want) < 0.05 ? ok('availability is not counted against days before the stream existed')
      : bad('availability is not counted against days before the stream existed', `expected ~${want} got ${got}`);
  }

  console.log('\n== AC6: a fault and an operator stop are told apart without a log ==');
  check('run 1 ended in a fault', rep.runs[2].stop, 'fault');
  check('which is not a planned stop', rep.runs[2].planned_stop, false);
  check('and says why', rep.runs[2].stop_detail, 'encoder exited rc=183');
  check('run 2 was stopped by an operator', rep.runs[1].stop, 'operator');
  check('which is planned', rep.runs[1].planned_stop, true);
  check('the schedule is planned too', rep.runs[0].planned_stop, true);
  check('stop counts: two planned', rep.totals.stops.planned, 2);
  check('stop counts: one unplanned', rep.totals.stops.unplanned, 1);
  check('mean time to recovery is the ten minutes to the next run', rep.totals.mttr_seconds, 600);

  console.log('\n== AC4: exact peak inside the raw window, not retained outside it ==');
  check('run 2 has an exact peak', rep.runs[1].audience.peak_basis, 'exact');
  check('of three, not four: a hand-over is not a peak', rep.runs[1].audience.peak_concurrent, 3);
  check('and the peak has a time', rep.runs[1].audience.peak_at, at(r2 + 30 * MIN));
  check('four views on run 2', rep.runs[1].audience.views, 4);
  check('a run with nobody watching says so, rather than claiming a measured zero',
    rep.runs[2].audience.peak_basis, 'no_viewers_recorded');
  const old = await streamReport(A, s, new Date(r0 - DAY), new Date(r0 + DAY));
  check('the old run is listed', old.runs.length, 1);
  check('its peak is NOT zero', old.runs[0].audience.peak_concurrent, null);
  check('it is marked not retained', old.runs[0].audience.peak_basis, 'not_retained');
  check('and the day\'s rollup peak is offered instead', old.runs[0].audience.day_peak_concurrent, 12);
  check('the period peak falls back to the daily rollups and says so', old.totals.peak_basis, 'daily');
  check('the report explains it', old.notes.some((n) => /not retained/.test(n)), true);
  const csvOld = streamReportCsv(old, false);
  check('the CSV writes "not retained", never 0', /,not retained,/.test(csvOld), true);

  console.log('\n== AC5: a rename does not rewrite history ==');
  await query(`UPDATE channels SET name = 'Harbourside 24' WHERE id = $1`, [C1]);
  const renamed = await streamReport(A, (await resolveStream(A, C1))!, new Date(r0 - DAY), new Date(r0 + DAY));
  check('the report header carries the current name', renamed.stream.name, 'Harbourside 24');
  check('but the historical run keeps the name it ran under', renamed.runs[0].name_at_run, 'Harbourside News (old name)');
  check('and so does its CSV row', streamReportCsv(renamed, false).includes('run,Harbourside News (old name),'), true);

  console.log('\n== AC2: deleting the channel does not delete the report ==');
  await query(`DELETE FROM channels WHERE id = $1`, [C1]);
  check('the instances really are gone', (await one<any>(`SELECT count(*)::int n FROM instances WHERE id = ANY($1::uuid[])`, [[I(1), I(2), I(3)]]))!.n, 0);
  const gone = await resolveStream(A, C1);
  check('the stream still resolves from the ledgers', !!gone, true);
  check('marked deleted', gone?.exists, false);
  const after = await streamReport(A, gone!, from, to);
  check('still three runs (not collapsed into one)', after.runs.length, 3);
  check('still six hours run', after.totals.run_seconds, 6 * 3600);
  check('still two hours on air', after.totals.on_air_seconds, 2 * 3600);
  check('still knows run 1 was a fault', after.runs.find((r) => r.started_at === at(r1))?.stop, 'fault');
  check('and the exact peak still stands', after.runs.find((r) => r.started_at === at(r2))?.audience.peak_concurrent, 3);

  // ---- events -------------------------------------------------------------
  console.log('\n== events: on-air is the run inside the public window ==');
  const e0 = NOW - 5 * DAY;
  await query(`INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end,public_start,public_end)
               VALUES ($1,$2,'Cup Final',$3,$4,$5,$6,$7)`,
    [E1, G, 'ended', at(e0), at(e0 + 3 * H), at(e0 + 30 * MIN), at(e0 + 2 * H + 30 * MIN)]);
  await run(20, E1, 'event', e0, e0 + 3 * H, 'Cup Final');   // runs the whole 3 h booking
  const ev = await streamReport(A, (await resolveStream(A, E1))!, from, to);
  check('the event ran three hours', ev.totals.run_seconds, 3 * 3600);
  check('but was public for two', ev.totals.on_air_seconds, 2 * 3600);
  check('and the basis says it was derived from the public window', ev.air_basis, 'public_window');
  check('availability against the public window is 100%', ev.totals.availability_pct, 100);
  check('the stop reason of a run that never reached stopStream is unknown, not guessed', ev.runs[0].stop, 'unknown');

  // ---- stations -------------------------------------------------------------
  console.log('\n== stations: MP3 listeners are reported separately ==');
  const s0 = NOW - 3 * DAY;
  await run(30, R1, 'channel', s0, s0 + 4 * H, 'Harbour FM');
  await query(`INSERT INTO listener_sessions(channel_id,account_id,started_at,ended_at,seconds,bytes) VALUES
                 ($1,$2,$3,$4,3600,57600000), ($1,$2,$5,$6,1800,28800000)`,
    [R1, A, at(s0 + H), at(s0 + 2 * H), at(s0 + 90 * MIN), at(s0 + 120 * MIN)]);
  const st = await streamReport(A, (await resolveStream(A, R1))!, from, to);
  check('a station is reported as radio', st.stream.kind, 'radio');
  check('with its MP3 listener sessions', st.runs[0].listeners?.sessions, 2);
  check('and their peak', st.runs[0].listeners?.peak_concurrent, 2);
  check('the station CSV has the MP3 columns', streamReportCsv(st, false).split('\r\n')[0].includes('mp3_listeners'), true);

  // ---- period clipping --------------------------------------------------------
  console.log('\n== a run across the edge of the period counts only the part inside ==');
  const clip = await streamReport(A, (await resolveStream(A, R1))!, new Date(s0 + H), new Date(s0 + 2 * H));
  check('one hour of a four-hour run', clip.totals.run_seconds, 3600);
  check('while the row still says how long the whole run was', clip.runs[0].duration_seconds, 4 * 3600);

  // ---- HTTP: auth, cost visibility, CSV ------------------------------------------
  console.log('\n== HTTP routes ==');
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,platform_role,status) VALUES
                 ($1,$3,'ops@report.test','x','admin',NULL,'active'), ($2,$3,'saas@report.test','x','admin','saas_admin','active')`, [U1, U2, A]);
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const app: any = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const get = (path: string, user: string) => fetch(base + path, { headers: { authorization: `Bearer ${signAccess({ sub: user, account_id: A, role: 'admin' })}` } });
  const q = `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

  const j = await get(`/api/reports/stream/${E1}${q}`, U1);
  check('the stream report answers 200', j.status, 200);
  const jb: any = await j.json();
  check('with the same air time as the service', jb.totals.on_air_seconds, 2 * 3600);
  check('and no cost for an account admin', 'cost_basis_usd' in jb.totals, false);
  check('with a link to its CSV', typeof jb.links?.csv, 'string');
  const jp: any = await (await get(`/api/reports/stream/${E1}${q}`, U2)).json();
  check('a platform admin sees the cost basis', typeof jp.totals.cost_basis_usd, 'number');

  const c = await get(`/api/reports/stream/${E1}.csv${q}`, U1);
  check('the CSV answers 200', c.status, 200);
  check('as text/csv', (c.headers.get('content-type') ?? '').startsWith('text/csv'), true);
  check('as a download', /attachment; filename="operating-report-Cup-Final-/.test(c.headers.get('content-disposition') ?? ''), true);
  const ct = await c.text();
  check('one header, one run, one total', ct.trim().split('\r\n').length, 3);

  const sum: any = await (await get(`/api/reports/streams${q}`, U1)).json();
  check('the account summary lists every stream that ran, the deleted one included', sum.items.length, 3);
  check('sorted by hours run, most first', sum.items[0].name, 'Harbourside News');
  check('and still says it was deleted', sum.items[0].deleted, true);
  const radioOnly: any = await (await get(`/api/reports/streams${q}&kind=radio`, U1)).json();
  check('filter by kind', radioOnly.items.length, 1);
  const badSort = await get(`/api/reports/streams${q}&sort=nope`, U1);
  check('an unknown sort is a 400 that lists the columns', badSort.status, 400);
  const sc = await get(`/api/reports/streams.csv${q}`, U1);
  check('the summary CSV is four lines', (await sc.text()).trim().split('\r\n').length, 4);
  check('another account cannot read this one\'s stream',
    (await fetch(base + `/api/reports/stream/${E1}${q}`, { headers: { authorization: `Bearer ${signAccess({ sub: U1, account_id: '00000000-0000-0000-0000-00000000dead', role: 'admin' })}` } })).status === 200, false);
  const badRange = await get(`/api/reports/streams?from=2026-10-10&to=2026-10-01`, U1);
  check('a backwards period is a 400', badRange.status, 400);
  srv.close();

  await query(`DELETE FROM run_stops WHERE account_id = $1`, [A]);
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
