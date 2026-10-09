// ============================================================================
//  HOURS ON AIR, WHICH THE SYSTEM COULD NOT PREVIOUSLY ANSWER AT ALL.
//
//  `channels.on_air` is a boolean: it says what is true now and nothing about
//  how it got there. A channel going on air ran a bare UPDATE and left no trace
//  whatsoever; radio wrote an event into a log with no retention rule that an
//  operator can now clear with a button. So the figure a client with an SLA
//  actually asks for had no defensible source.
//
//  This suite pins the ledger and, more importantly, the RULE THAT KEEPS IT
//  TRUE: one function owns the column and the history together, because four
//  call sites used to write that column and they already disagreed about
//  whether to record anything. The last case reads the source and fails if a
//  fifth one appears -- a convention nobody CAN break beats one everybody
//  agrees with.
//
//  THE FOUR WAYS A LEDGER LIKE THIS GOES WRONG, each with a case below:
//
//    DOUBLE OPEN. Two open windows on one stream overlap, and overlapping
//    windows make the total exceed wall-clock time while every row still looks
//    correct. The partial unique index forbids it and setOnAir is idempotent so
//    nothing ever has to catch that violation.
//
//    NEVER CLOSED. A control plane killed mid-broadcast leaves a window open,
//    and an open window GROWS: every later read includes the time since the
//    process died. closeOrphanAirSessions is the counterpart to the orphan
//    recording sweep and runs in the same place.
//
//    COUNTED WHOLE. A broadcast spanning the edge of the report period must
//    contribute only the part inside it, or a monthly total comes to exceed the
//    month.
//
//    LOST WITH THE STREAM. Deleting a channel must not delete the record that
//    it was on air for 300 hours, and renaming one must not retroactively
//    rewrite whose airtime it was. Hence a snapshotted, FK-free identity, the
//    same choice usage_accruals made in migration 0016.
//
//  Usage: DATABASE_URL=... npx tsx test/air-sessions.check.ts
// ============================================================================
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';
import { setOnAir, closeOrphanAirSessions, airTotals, airSessions } from '../src/services/airSessions';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const near = (m: string, got: number, want: number, tol = 2) =>
  Math.abs(got - want) <= tol ? ok(m) : bad(m, `expected ~${want} (±${tol}) got ${got}`);

const A  = '00000000-0000-0000-0000-00000a12a001';
const P  = '00000000-0000-0000-0000-00000a12a002';
const G  = '00000000-0000-0000-0000-00000a12a003';
const C1 = '00000000-0000-0000-0000-00000a12a010';
const C2 = '00000000-0000-0000-0000-00000a12a011';
const IN = '00000000-0000-0000-0000-00000a12a020';

const onAirNow = async (id: string) =>
  (await one<any>(`SELECT on_air FROM channels WHERE id=$1`, [id]))?.on_air;
const openRows = async (id: string) =>
  (await one<any>(`SELECT count(*)::int n FROM air_sessions WHERE stream_id=$1 AND to_at IS NULL`, [id]))!.n;

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'AirCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','package_only')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent)
               VALUES ($1,$2,'g',$3,20,10)`, [G, A, P]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,on_air) VALUES
       ($1,$3,'Harbourside News','live','tv',false),
       ($2,$3,'DEF CON Radio','live','radio',false)`, [C1, C2, G]);

  // ---- the basic window ---------------------------------------------------
  console.log('== going on air opens a window, coming off closes it ==');
  const up = await setOnAir('channel', C1, true, { actor: 'chris' });
  check('the call reports a change', up.changed, true);
  check('the column moved', await onAirNow(C1), true);
  check('and exactly one window is open', await openRows(C1), 1);

  const down = await setOnAir('channel', C1, false, { actor: 'chris', reason: 'operator' });
  check('coming off air changes it back', down.changed, true);
  check('the column moved back', await onAirNow(C1), false);
  check('nothing is left open', await openRows(C1), 0);
  const closed = await one<any>(
    `SELECT seconds, opened_by, closed_by, close_reason, stream_kind, stream_name
       FROM air_sessions WHERE stream_id=$1`, [C1]);
  check('the window is measured', closed?.seconds != null, true);
  check('it knows who opened it', closed?.opened_by, 'chris');
  check('and why it ended', closed?.close_reason, 'operator');
  check('the kind is recorded', closed?.stream_kind, 'channel');
  check('and the name is snapshotted', closed?.stream_name, 'Harbourside News');

  // ---- idempotence, and the no-double-open invariant ----------------------
  console.log('\n== asking for the state it is already in does nothing ==');
  await setOnAir('channel', C1, true, { actor: 'chris' });
  const again = await setOnAir('channel', C1, true, { actor: 'someone else' });
  check('the second call reports no change', again.changed, false);
  check('it did NOT open a second window', await openRows(C1), 1);
  check('and it is still on air', await onAirNow(C1), true);

  const offTwice = await setOnAir('channel', C1, false, { actor: 'chris' });
  check('coming off works', offTwice.changed, true);
  const offAgain = await setOnAir('channel', C1, false, { actor: 'chris' });
  check('and coming off twice is a no-op, not an error', offAgain.changed, false);
  check('with no stray closed rows',
    (await one<any>(`SELECT count(*)::int n FROM air_sessions WHERE stream_id=$1`, [C1]))!.n, 2);

  // ---- the open window must not grow for ever ----------------------------
  console.log('\n== an open window whose stream is not running gets closed ==');
  await setOnAir('radio', C2, true, { actor: 'chris' });
  check('the station is on air', await openRows(C2), 1);
  // Nothing is running for it: no un-terminated instance row exists.
  const reconciled = await closeOrphanAirSessions();
  check('the sweep closes it', reconciled >= 1, true);
  check('so nothing is left open', await openRows(C2), 0);
  check('and it is marked as reconciled rather than measured',
    (await one<any>(`SELECT close_reason FROM air_sessions
                      WHERE stream_id=$1 ORDER BY id DESC LIMIT 1`, [C2]))?.close_reason, 'reconciled');

  console.log('\n== but a window whose stream IS running is left alone ==');
  await query(
    `INSERT INTO instances(id,channel_id,role,state,launched_at,task_kind)
     VALUES ($1,$2,'primary','running',now(),'radio')`, [IN, C2]);
  await setOnAir('radio', C2, true, { actor: 'chris' });
  await closeOrphanAirSessions();
  check('a live broadcast survives the sweep', await openRows(C2), 1);

  // ---- totals, clipped to the period -------------------------------------
  console.log('\n== totals are clipped to the report period, never counted whole ==');
  await query(`DELETE FROM air_sessions WHERE stream_id=$1`, [C1]);
  // One broadcast: 10:00 to 14:00. Four hours.
  await query(
    `INSERT INTO air_sessions(account_id,stream_kind,stream_id,stream_name,channel_id,from_at,to_at,seconds)
     VALUES ($1,'channel',$2,'Harbourside News',$2,
             '2026-09-01T10:00:00Z','2026-09-01T14:00:00Z', 14400)`, [A, C1]);
  const whole = await airTotals(C1, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));
  near('a broadcast inside the period counts in full', whole.seconds, 14400);
  check('and is one session', whole.sessions, 1);

  const half = await airTotals(C1, new Date('2026-09-01T12:00:00Z'), new Date('2026-09-02T00:00:00Z'));
  near('one starting before the period contributes only the part inside it', half.seconds, 7200);
  const slice = await airTotals(C1, new Date('2026-09-01T11:00:00Z'), new Date('2026-09-01T12:00:00Z'));
  near('and a period inside the broadcast is the period itself', slice.seconds, 3600);
  const outside = await airTotals(C1, new Date('2026-09-05T00:00:00Z'), new Date('2026-09-06T00:00:00Z'));
  check('a period with no broadcast is zero, and knows it', outside.seconds, 0);
  check('with no sessions', outside.sessions, 0);

  console.log('\n== an open window is included up to now, and says it is live ==');
  const liveTot = await airTotals(C2, new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000));
  check('the open broadcast is counted', liveTot.sessions >= 1, true);
  check('and the total is flagged as still moving', liveTot.live, true);

  // ---- the record outlives the stream ------------------------------------
  console.log('\n== the history survives a rename and a deletion ==');
  await query(`UPDATE channels SET name='Harbourside News HD' WHERE id=$1`, [C1]);
  const renamed = await one<any>(`SELECT stream_name FROM air_sessions WHERE stream_id=$1`, [C1]);
  check('a rename does not rewrite history', renamed?.stream_name, 'Harbourside News');

  await query(`DELETE FROM channels WHERE id=$1`, [C1]);
  const survived = await one<any>(
    `SELECT stream_name, channel_id, seconds FROM air_sessions WHERE stream_id=$1`, [C1]);
  check('the row survives the channel', !!survived, true);
  check('the name is still there to label the report', survived?.stream_name, 'Harbourside News');
  check('and the foreign key is nulled rather than cascading the row away',
    survived?.channel_id, null);
  const stillTotals = await airTotals(C1, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'));
  near('so the report still reports', stillTotals.seconds, 14400);
  check('and can still list the windows', (await airSessions(C1,
    new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'))).length, 1);

  // ---- the rule that keeps all of the above true --------------------------
  //
  // STRUCTURAL, and deliberately so. Every case above passes just as happily
  // with a fifth caller writing the column directly somewhere else; the ledger
  // would simply be missing that window, and nothing would look broken until a
  // report came out short. The four original call sites already disagreed about
  // whether to record anything, so the property worth defending is that there
  // is no way to move the column without moving the ledger.
  console.log('\n== nothing writes on_air except the service that owns it ==');
  const root = join(__dirname, '../src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!f.name.endsWith('.ts')) continue;
      if (p.endsWith('services/airSessions.ts')) continue;   // the owner
      const src = readFileSync(p, 'utf8');
      if (/SET\s+on_air\s*=/i.test(src)) offenders.push(p.replace(root, 'src'));
    }
  };
  walk(root);
  check('no module sets on_air directly', offenders.join(', '), '');

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`DELETE FROM air_sessions WHERE stream_id IN ($1,$2)`, [C1, C2]);
  console.log(`\nair-sessions: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
