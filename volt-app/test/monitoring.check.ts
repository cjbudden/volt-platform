// ============================================================================
//  MONITORING — the live board and the alert list.
//
//  The thing worth testing here is not that the endpoints return JSON. It is
//  that they tell the TRUTH about a fleet in states that only occur when
//  something has already gone wrong, because that is precisely when an
//  operator relies on them and precisely when they are hardest to observe.
//
//  So the fixtures are built to be dishonest, and the checks assert the API
//  refuses to repeat the lie:
//
//    A STRANDED INSTANCE. An encoder crash leaves an instances row with no
//    terminated_at. Read that row alone and a dead channel reports days of
//    uptime. The board must report no uptime and raise the stranded record.
//
//    A CHANNEL WEDGED IN STARTING. Warm-up is a transition. One that has not
//    finished in ten minutes is a fault, and nothing in the gate model will
//    ever move it to failed on its own.
//
//    ORPHANED MEDIA. A media object the catalogue calls available with no
//    present location. Nothing errors until somebody builds a clip from it.
//
//    TENANCY. Another account's broken channel must not appear in this
//    account's alerts. A monitoring page that leaks across tenants is worse
//    than no monitoring page.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/monitoring.check.ts
// ============================================================================
import { pool, query, one } from '../src/db';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

// Ids namespaced to this suite so it can never collide with another's fixture.
const A = '00000000-0000-0000-0000-000009900001';
const A2 = '00000000-0000-0000-0000-000009900002';
const P = '00000000-0000-0000-0000-000009900010';
const G = '00000000-0000-0000-0000-000009900011';
const G2 = '00000000-0000-0000-0000-000009900012';
const U = '00000000-0000-0000-0000-000009900005';
const CH_STRANDED = '00000000-0000-0000-0000-000009900021';
const CH_WEDGED = '00000000-0000-0000-0000-000009900022';
const CH_IDLE = '00000000-0000-0000-0000-000009900023';
const CH_OTHER = '00000000-0000-0000-0000-000009900024';
const REC = '00000000-0000-0000-0000-000009900031';
const OBJ = '00000000-0000-0000-0000-000009900041';

async function reset() {
  // Media objects are detached, NOT deleted, when their owner goes: the FKs
  // are ON DELETE SET NULL by design. So the account delete alone would leave
  // this suite's object behind as an orphan — which is the very condition the
  // suite is about, and would collide on the next run. Remove it explicitly.
  await query(`DELETE FROM media_objects WHERE id = $1`, [OBJ]);
  // Instances cascade from channels since migration 0013.
  await query(`DELETE FROM accounts WHERE id = ANY($1)`, [[A, A2]]);
}

async function seed() {
  await reset();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'MonCo'),($2,'RivalCo')`, [A, A2]);
  // A REAL user row, because the token's `sub` is one. This suite used to sign
  // the ACCOUNT id as the subject, which every read endpoint tolerated (they
  // scope on account_id) right up until a write wanted to audit who did it.
  await query(
    `INSERT INTO users(id,account_id,email,password_hash,role,status)
     VALUES ($1,$2,'mon@example.test','x','owner','active')`,
    [U, A]
  );
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2800}]','package_only','both',2,60)`,
    [P, A]
  );
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'mon',$3,10),($4,$5,'rival',NULL,10)`, [G, A, P, G2, A2]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,on_air) VALUES
       ($1,$5,'Stranded One','live',true),
       ($2,$5,'Wedged One','live',false),
       ($3,$5,'Idle One','scheduled',false),
       ($4,$6,'Rival Broken','live',true)`,
    [CH_STRANDED, CH_WEDGED, CH_IDLE, CH_OTHER, G, G2]
  );

  // A crash leaves this behind: launched, never terminated, nothing running.
  await query(
    `INSERT INTO instances(channel_id,task_arn,state,launched_at)
     VALUES ($1,'mock:stranded','running', now() - interval '30 hours'),
            ($2,'mock:wedged','running',   now() - interval '3 hours'),
            ($3,'mock:rival','running',    now() - interval '2 hours')`,
    [CH_STRANDED, CH_WEDGED, CH_OTHER]
  );

  // Media the catalogue calls readable with no bytes behind it anywhere.
  await query(
    `INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms)
     VALUES ($1,'channel_day',$2,'2026-01-01','complete',1)`,
    [REC, CH_STRANDED]
  );
  await query(
    `INSERT INTO media_objects(id,recording_id,channel_id,logical_key,kind,state)
     VALUES ($1,$2,$3,'mon/orphan','recording','available')`,
    [OBJ, REC, CH_STRANDED]
  );
}

async function token(): Promise<string> {
  // Mint directly rather than logging in (this suite owns its tenant), but
  // against the seeded USER, not the account: `sub` is a user id everywhere
  // else in the system and audit writes resolve it as one.
  const { signAccess } = await import('../src/auth/jwt');
  return signAccess({ sub: U, account_id: A, role: 'owner' } as any);
}

const j = (t: string) => ({ Authorization: `Bearer ${t}`, 'content-type': 'application/json' });

async function get(path: string, tok: string) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json() as any;
}

(async () => {
  await seed();
  const tok = await token();

  // ---- the live board ----------------------------------------------------
  const board = await get('/api/monitoring/live', tok);
  const byName = new Map<string, any>(board.streams.map((s: any) => [s.name, s]));

  check('the board lists every stream in the account', board.streams.length, 3);
  falsy("another account's channel is not on the board", byName.has('Rival Broken'));

  const stranded = byName.get('Stranded One');
  truthy('the stranded channel is on the board', !!stranded);
  check('a stranded instance reports NO uptime', stranded.uptimeMs, null);
  check('and is flagged as a stranded record', stranded.orphanedInstance, true);

  const idle = byName.get('Idle One');
  check('a channel that never ran has no uptime', idle.uptimeMs, null);
  check('and is not flagged as stranded', idle.orphanedInstance, false);

  truthy('every row carries the five gates',
    board.streams.every((s: any) => Array.isArray(s.gates) && s.gates.length === 5));
  truthy('every row carries an origin preview url',
    board.streams.every((s: any) => s.previewUrl.startsWith('/origin/') && s.previewUrl.endsWith('master.m3u8')));

  // Trouble sorts first, whatever the rows are called.
  const RANK: Record<string, number> = { error: 0, degraded: 1, starting: 2, onair: 3, ready: 4, stopped: 5, idle: 6 };
  const ranks = board.streams.map((s: any) => RANK[s.overall] ?? 9);
  truthy('the board is ordered worst-first', ranks.every((r: number, i: number) => i === 0 || ranks[i - 1] <= r));

  // ---- alerts ------------------------------------------------------------
  const ov = await get('/api/monitoring/overview', tok);
  const ids = new Set(ov.alerts.map((a: any) => a.id));
  const titles = ov.alerts.map((a: any) => a.title).join(' | ');

  truthy('a stranded encoder record raises an alert', ids.has(`instance:${CH_STRANDED}`));
  truthy('orphaned media raises an alert', ids.has('media:orphaned'));
  falsy("another account's channel never appears in the alerts", /Rival/.test(titles));

  const orphan = ov.alerts.find((a: any) => a.id === 'media:orphaned');
  check('orphaned media is serious, not a warning', orphan.severity, 'serious');

  truthy('alerts are ordered by severity', (() => {
    const R: Record<string, number> = { critical: 0, serious: 1, warning: 2 };
    return ov.alerts.every((a: any, i: number) => i === 0 || R[ov.alerts[i - 1].severity] <= R[a.severity]);
  })());

  check('the counts match the list',
    ov.counts.critical + ov.counts.serious + ov.counts.warning, ov.alerts.length);
  check('the fleet total matches the board', ov.fleet.total, board.streams.length);

  // The alert list must never repeat one problem per row. Four failures of the
  // same job type is one line, and the id is what enforces it.
  check('alert ids are unique', ids.size, ov.alerts.length);

  // ---- the media alert reflects reality, not a cached count ---------------
  await query(
    `INSERT INTO media_locations(object_id,tier,uri,present) VALUES ($1,'local','file:///tmp/mon.bin',true)`,
    [OBJ]
  );
  const ov2 = await get('/api/monitoring/overview', tok);
  falsy('giving the object a location clears the alert',
    ov2.alerts.some((a: any) => a.id === 'media:orphaned'));

  // ---- tenancy on the feed ------------------------------------------------
  await query(
    `INSERT INTO stream_events(channel_id,seq,type,detail) VALUES
       ($1,1,'channel.start','{"note":"mine"}'),
       ($2,1,'channel.start','{"note":"theirs"}')`,
    [CH_STRANDED, CH_OTHER]
  );
  const ov3 = await get('/api/monitoring/overview', tok);
  truthy('the feed shows this account’s events',
    ov3.feed.some((f: any) => f.name === 'Stranded One'));
  falsy('the feed never shows another account’s events',
    ov3.feed.some((f: any) => f.name === 'Rival Broken'));

  // ---- a live channel may not be deleted ---------------------------------
  //
  // Migration 0013 made the instances FK CASCADE, which is right — but it also
  // means deleting a live channel takes the ONLY record of its encoder with it.
  // The task keeps running, keeps writing to the origin and keeps costing, and
  // nothing can reach it: stopStream looks instances up by channel_id and the
  // channel is gone. Events already refused this; channels did not.
  const delLive = await fetch(`${API}/api/channels/${CH_STRANDED}`, {
    method: 'DELETE', headers: j(tok),
  });
  check('a live channel refuses to be deleted', delLive.status, 400);
  const liveStill = await one<any>(`SELECT 1 FROM channels WHERE id = $1`, [CH_STRANDED]);
  truthy('and is still there afterwards', !!liveStill);

  // Not-live but still holding an instance is the same orphan by a slower
  // route, so it is refused for the same reason.
  await query(`UPDATE channels SET status = 'ended' WHERE id = $1`, [CH_STRANDED]);
  const delStranded = await fetch(`${API}/api/channels/${CH_STRANDED}`, {
    method: 'DELETE', headers: j(tok),
  });
  check('nor one that still has a running encoder record', delStranded.status, 400);

  // With nothing running, it deletes cleanly.
  await query(`UPDATE instances SET terminated_at = now(), state = 'terminated'
                WHERE channel_id = $1`, [CH_STRANDED]);
  const delIdle = await fetch(`${API}/api/channels/${CH_STRANDED}`, {
    method: 'DELETE', headers: j(tok),
  });
  check('once nothing is running it deletes', delIdle.status, 204);

  // ---- a subject that is not a user row -----------------------------------
  //
  // audit_log.user_id is a FK to users.id, but `sub` is not always a user: a
  // service token, a platform token, or a user deleted mid-request all carry a
  // well-formed UUID with nothing behind it. The audit write then failed with
  // 23503 AFTER the delete had committed, so the caller got a 500 for work that
  // had already succeeded and would never succeed again on retry.
  const ghost = '00000000-0000-0000-0000-0000099000ff';
  const { signAccess } = await import('../src/auth/jwt');
  const ghostTok = signAccess({ sub: ghost, account_id: A, role: 'owner' } as any);
  const delGhost = await fetch(`${API}/api/channels/${CH_IDLE}`, {
    method: 'DELETE', headers: j(ghostTok),
  });
  check('a subject with no user row still deletes cleanly', delGhost.status, 204);
  const gone = await one<any>(`SELECT 1 FROM channels WHERE id = $1`, [CH_IDLE]);
  falsy('and the channel is really gone', !!gone);
  const auditRow = await one<any>(
    `SELECT user_id, detail->>'actor' AS actor FROM audit_log
      WHERE entity_id = $1 AND action = 'delete' ORDER BY created_at DESC LIMIT 1`,
    [CH_IDLE]
  );
  truthy('an audit row was still written', !!auditRow);
  check('with no user id', auditRow?.user_id, null);
  check('but the actor is still recorded', auditRow?.actor, ghost);

  // ---- deleting a channel that ran (migration 0013) -----------------------
  // Before the FK became CASCADE this threw, so a channel that had ever been
  // started could not be removed at all.
  let deleted = true;
  try {
    await query(`DELETE FROM channels WHERE id = $1`, [CH_WEDGED]);
  } catch { deleted = false; }
  check('a channel with instances can be deleted', deleted, true);
  const left = await one<any>(`SELECT count(*)::int n FROM instances WHERE channel_id = $1`, [CH_WEDGED]);
  check('its instance rows go with it', left.n, 0);

  await reset();
  console.log(`\nmonitoring: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
