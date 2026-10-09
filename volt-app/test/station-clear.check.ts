// ============================================================================
//  PUTTING DOWN A GIVE-UP NOTICE, AND EMPTYING A LOG, WITHOUT LOSING THE TRUTH.
//
//  Two operator actions that look trivial and both have a trap in them.
//
//  1. DISMISSING THE GIVE-UP NOTICE MUST NOT RE-ARM THE RETRY LOOP.
//
//     `resume_gave_up_at IS NULL` is one of four conditions that make a stream
//     eligible for auto connect. Another is `desired_state = 'running'`, which
//     a FAILED stream still carries, deliberately: a fault does not change what
//     an operator asked for. So clearing the give-up on its own hands the crash
//     loop straight back -- five more attempts against the same broken source,
//     another give-up, another banner, for ever.
//
//     Dismissing is therefore an acknowledgement, not a retry: it clears the
//     give-up AND stands the intent down. Pressing Start afterwards sets the
//     intent back and clears the state itself, so nothing is lost. This suite
//     asserts BOTH halves, because either one alone is a bug: without the clear
//     the banner never goes, and without the stand-down the loop returns.
//
//  2. A CLEARED LOG MUST NOT READ AS A LOG OF NOTHING.
//
//     "nothing has ever happened here" and "somebody cleared this at 07:15" are
//     different facts and only one of them is a reason to go looking elsewhere.
//     So the delete is immediately followed by one `log.cleared` entry naming
//     the actor and the count, and the audit trail gets its own row, because
//     the event log is the thing being deleted and cannot be its own witness.
//
//     Also asserted: the delete is scoped to ONE station. A route that could
//     empty stream_events wholesale is one mistyped id away from destroying
//     every other stream's history.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/station-clear.check.ts
// ============================================================================
import jwt from 'jsonwebtoken';
import { pool, query, one } from '../src/db';

const API = process.env.API || 'http://localhost:8080';
const SECRET = process.env.JWT_ACCESS_SECRET || 'devsecret';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const A  = '00000000-0000-0000-0000-0000c1ea7001';
const P  = '00000000-0000-0000-0000-0000c1ea7002';
const G  = '00000000-0000-0000-0000-0000c1ea7003';
const S1 = '00000000-0000-0000-0000-0000c1ea7010';   // the station being cleared
const S2 = '00000000-0000-0000-0000-0000c1ea7011';   // the bystander

const token = jwt.sign({ sub: 'u', account_id: A, role: 'owner', typ: 'access' }, SECRET, { expiresIn: 600 });
const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

const evCount = async (id: string) =>
  (await one<any>(`SELECT count(*)::int n FROM stream_events WHERE channel_id=$1`, [id]))!.n;
const chan = (id: string) => one<any>(`SELECT * FROM channels WHERE id=$1`, [id]);

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'ClearCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','package_only')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent)
               VALUES ($1,$2,'g',$3,20,10)`, [G, A, P]);

  // A station in exactly the state the screenshot showed: stopped, written off
  // by auto connect after five attempts, and still WANTED running.
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,desired_state,auto_connect,
                          resume_attempts,resume_gave_up_at,resume_last_error) VALUES
       ($1,$3,'ABC Classic (HLS)','ended','radio','running',true,5,now(),
        'encoder exited rc=183: Master Playlist tag found in a Media Playlist'),
       ($2,$3,'Bystander FM','ended','radio','stopped',true,0,NULL,NULL)`,
    [S1, S2, G]);

  for (const id of [S1, S2]) {
    await query(
      `INSERT INTO stream_events(channel_id,type,detail,ts) VALUES
         ($1,'channel.start','{"workflow":"transcode"}'::jsonb, now() - interval '3 minutes'),
         ($1,'channel.stop','{"reason":"encoder exited rc=183"}'::jsonb, now() - interval '2 minutes'),
         ($1,'channel.stop','{"reason":"stopped by launcher"}'::jsonb, now() - interval '1 minute')`,
      [id]);
  }

  // ---- dismissing the notice ---------------------------------------------
  console.log('== the give-up notice can be put down without starting anything ==');
  const before = await chan(S1);
  check('the station starts written off', !!before.resume_gave_up_at, true);
  check('and is still WANTED running', before.desired_state, 'running');

  const r = await fetch(`${API}/api/radio/${S1}/clear-recovery`, { method: 'POST', headers: H });
  check('the call succeeds', r.status, 200);

  const after = await chan(S1);
  check('the give-up is cleared', after.resume_gave_up_at, null);
  check('the attempt budget is returned', after.resume_attempts, 0);
  check('the last error is cleared with it', after.resume_last_error, null);
  // THE HALF THAT IS EASY TO FORGET.
  check('and the intent is stood down, so auto connect does not re-arm',
    after.desired_state, 'stopped');
  check('the station was NOT started', after.status, 'ended');

  console.log('\n== and the fact that it happened survives ==');
  const cleared = await one<any>(
    `SELECT detail FROM stream_events WHERE channel_id=$1 AND type='recovery.cleared'`, [S1]);
  check('a recovery.cleared entry is written', !!cleared, true);
  check('naming the reason it had given up',
    String(cleared?.detail?.last_error ?? '').includes('rc=183'), true);
  const audited = await one<any>(
    `SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND entity_type='radio_station'`, [S1]);
  check('and the audit trail records it too', (audited?.n ?? 0) >= 1, true);

  // ---- clearing the log ---------------------------------------------------
  console.log('\n== clearing the log empties this station and nothing else ==');
  const mine = await evCount(S1), theirs = await evCount(S2);
  check('the station has entries to clear', mine >= 4, true);   // 3 seeded + recovery.cleared
  check('so does the bystander', theirs, 3);

  const c = await fetch(`${API}/api/radio/${S1}/events`, { method: 'DELETE', headers: H });
  check('the call succeeds', c.status, 200);
  const body = await c.json();
  check('and reports how many went', body.removed, mine);

  check('the bystander is untouched', await evCount(S2), 3);

  console.log('\n== but a cleared log is not an empty log ==');
  check('exactly one entry remains', await evCount(S1), 1);
  const note = await one<any>(`SELECT type, detail FROM stream_events WHERE channel_id=$1`, [S1]);
  check('and it says the log was cleared', note?.type, 'log.cleared');
  check('with the count', note?.detail?.removed, mine);
  check('and who did it', typeof note?.detail?.actor === 'string', true);
  check('the returned log is not empty either', (body.log?.length ?? 0) >= 1, true);

  const auditDel = await one<any>(
    `SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND entity_type='stream_events'`, [S1]);
  check('the deletion is audited outside the log it deleted', (auditDel?.n ?? 0) >= 1, true);

  // ---- the tenant boundary -----------------------------------------------
  console.log('\n== neither action reaches outside the account ==');
  const other = jwt.sign(
    { sub: 'u2', account_id: '00000000-0000-0000-0000-0000c1ea7fff', role: 'owner', typ: 'access' },
    SECRET, { expiresIn: 600 });
  const oh = { authorization: 'Bearer ' + other, 'content-type': 'application/json' };
  check('another tenant cannot dismiss this notice',
    (await fetch(`${API}/api/radio/${S1}/clear-recovery`, { method: 'POST', headers: oh })).status, 404);
  check('nor clear this log',
    (await fetch(`${API}/api/radio/${S1}/events`, { method: 'DELETE', headers: oh })).status, 404);
  check('and the log is still where we left it', await evCount(S1), 1);

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  console.log(`\nstation-clear: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
