// ============================================================================
//  A FILTER BADGE COUNTS THE LIBRARY, NOT THE RESULT YOU ARE ALREADY LOOKING AT.
//
//  The Recordings page has five chips -- All, Channels, Radio, Events,
//  Recording now -- each carrying a number. GET /api/recordings/sources built
//  those numbers from `out`, the array it had just finished filtering by BOTH
//  the type chip and `recordingNow`. So every badge described the current
//  result rather than what clicking it would give you, and the number beside
//  "Radio" was the same number as the list underneath it.
//
//  THE FAILURE IS TOTAL, NOT PARTIAL, which is why it was worth a suite. The
//  chips COMBINE: type and recordingNow are separate pieces of state and the
//  server ANDs them. Select "Events" while the only thing recording is a radio
//  station and the result is legitimately empty -- and every badge went to zero
//  with it, All and Radio included. The console then showed:
//
//      All 0 · Channels 0 · Radio 0 · Events 0 · Recording now 0
//      "Nothing matches those filters"
//
//  for an account with a station recording at that moment. The one moment the
//  counts had something useful to say ("there is 1 radio source and it IS
//  capturing, you are just looking at events") was the exact moment they were
//  guaranteed to say nothing. It reads as data loss and it is a display bug.
//
//  WHAT STAYS INSIDE THE COUNT. The text search and the two date ranges narrow
//  the LIBRARY, so they narrow the badges too: with "def" typed, "All 1" is the
//  correct and useful answer. The chips only PARTITION whatever the search
//  left, so they must not move the totals. That split is the whole contract and
//  it is what this suite pins.
//
//  ALSO PINNED, deliberately: `capturing` comes from an open `instances` row
//  and NOT from `recordings.status = 'recording'`. The open row alone is the
//  stale flag that once put "RECORDING" on a dead station. So a run that died
//  without closing its recording reads here as NOT capturing, which is correct
//  and is not a leak, because reconcileOrphanRecordings() closes exactly that
//  row once the instance is gone (see stuck-recording.check.ts for the deadlock
//  that made it necessary). The last case states the display rule so that
//  changing it later has to be a decision rather than an accident.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/recordings-counts.check.ts
// ============================================================================
import jwt from 'jsonwebtoken';
import { pool, query } from '../src/db';

const API = process.env.API || 'http://localhost:8080';
const SECRET = process.env.JWT_ACCESS_SECRET || 'devsecret';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

// Ids namespaced to this suite.
const A     = '00000000-0000-0000-0000-0000c0117001';
const P     = '00000000-0000-0000-0000-0000c0117002';
const G     = '00000000-0000-0000-0000-0000c0117003';
const TV    = '00000000-0000-0000-0000-0000c0117010';
const RD    = '00000000-0000-0000-0000-0000c0117011';
const EV    = '00000000-0000-0000-0000-0000c0117012';
const QUIET = '00000000-0000-0000-0000-0000c0117013';
const INST  = '00000000-0000-0000-0000-0000c0117020';

const token = jwt.sign({ sub: 'u', account_id: A, role: 'owner', typ: 'access' }, SECRET, { expiresIn: 600 });

async function sources(qs: string) {
  const r = await fetch(`${API}/api/recordings/sources${qs}`, {
    headers: { authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error(`GET /sources${qs} -> ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ sources: any[]; counts: Record<string, number> }>;
}
const names = (d: { sources: any[] }) => d.sources.map((s) => s.name).sort().join(', ') || '(none)';

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'CountCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','package_only')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent)
               VALUES ($1,$2,'g',$3,20,10)`, [G, A, P]);

  // One of each kind with recordings, plus a channel that has NEVER recorded,
  // which must be invisible to both the list and the counts.
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,recording_enabled) VALUES
       ($1,$4,'Zed News TV','ended','tv',true),
       ($2,$4,'DEF Radio','live','radio',true),
       ($3,$4,'Never Recorded','ended','tv',true)`, [TV, RD, QUIET, G]);
  await query(`INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end)
               VALUES ($1,$2,'Zed Cup Final','ended', now() - interval '2 hours', now() - interval '1 hour')`,
              [EV, G]);

  const now = Date.now();
  await query(
    `INSERT INTO recordings(kind,channel_id,day_utc,status,start_epoch_ms,end_epoch_ms,duration_ms,master_key,hi_res_rendition)
     VALUES ('channel_day',$1,CURRENT_DATE,'complete',$2,$3,3600000,'channel/tv','720p')`,
    [TV, now - 7_200_000, now - 3_600_000]);
  // The station is recording RIGHT NOW: an open row and a live instance.
  await query(
    `INSERT INTO recordings(kind,channel_id,day_utc,status,start_epoch_ms,master_key,hi_res_rendition)
     VALUES ('channel_day',$1,CURRENT_DATE,'recording',$2,'channel/radio','128k')`, [RD, now - 600_000]);
  await query(
    `INSERT INTO recordings(kind,event_id,day_utc,status,start_epoch_ms,end_epoch_ms,duration_ms,master_key,hi_res_rendition)
     VALUES ('event',$1,CURRENT_DATE,'complete',$2,$3,1800000,'event/zed','720p')`,
    [EV, now - 7_200_000, now - 5_400_000]);
  await query(
    `INSERT INTO instances(id,channel_id,role,state,launched_at,task_kind)
     VALUES ($1,$2,'primary','running',now(),'radio')`, [INST, RD]);

  // ---- the baseline -------------------------------------------------------
  console.log('== with no chips selected, the badges describe the library ==');
  const all = await sources('');
  check('three sources have recorded content', all.counts.all, 3);
  check('one is a television channel', all.counts.channel, 1);
  check('one is a radio station', all.counts.radio, 1);
  check('one is an event', all.counts.event, 1);
  check('and one of them is capturing right now', all.counts.capturing, 1);
  check('the channel that never recorded is absent', names(all),
    'DEF Radio, Zed Cup Final, Zed News TV');

  // ---- a chip narrows the LIST and leaves the COUNTS alone ----------------
  console.log('\n== selecting a chip narrows the list, never the badges ==');
  const ev = await sources('?type=event');
  check('the list is just the event', names(ev), 'Zed Cup Final');
  check('All still reads 3', ev.counts.all, 3);
  check('Radio still reads 1', ev.counts.radio, 1);
  check('Recording now still reads 1', ev.counts.capturing, 1);

  const live = await sources('?recordingNow=1');
  check('Recording now lists the station', names(live), 'DEF Radio');
  check('and All still reads 3', live.counts.all, 3);
  check('and Channels still reads 1', live.counts.channel, 1);

  // ---- THE REGRESSION -----------------------------------------------------
  //
  // This is the exact combination that produced a page of zeroes while a
  // station was recording. The empty list is CORRECT: no event is capturing.
  // The badges must still point at where the data actually is.
  console.log('\n== Events + Recording now: empty list, and the badges still say why ==');
  const both = await sources('?type=event&recordingNow=1');
  check('no event is capturing, so the list is empty', both.sources.length, 0);
  check('but All does NOT read 0', both.counts.all, 3);
  check('Radio still says there is a station', both.counts.radio, 1);
  check('and Recording now still says one thing is capturing', both.counts.capturing, 1);
  check('Channels is still countable too', both.counts.channel, 1);

  // ---- what SHOULD narrow the counts --------------------------------------
  //
  // The other half of the contract. A search term and a date range narrow the
  // library itself, so a badge that ignored them would be lying in the other
  // direction.
  console.log('\n== the search box and the dates DO narrow the badges ==');
  const q = await sources('?q=DEF');
  check('searching narrows All to the match', q.counts.all, 1);
  check('and the matching kind is radio', q.counts.radio, 1);
  check('while the other kinds fall to zero', q.counts.channel, 0);
  check('the list agrees', names(q), 'DEF Radio');

  const older = await sources(`?recordedTo=${now - 6_000_000}`);
  check('a recorded-before range narrows All', older.counts.all, 2);
  check('and drops the station that only started ten minutes ago', older.counts.radio, 0);

  const combined = await sources('?q=DEF&type=event');
  check('search narrows the badge, the chip does not', combined.counts.all, 1);
  check('and the chip still empties the list', combined.sources.length, 0);

  // ---- capturing is evidence, not a stored flag ---------------------------
  //
  // With the instance gone and the recording row still open, the source reads
  // as NOT capturing. That is deliberate: the open row alone once put
  // RECORDING on a dead station. The row does not linger either -- the
  // orphan reconciler closes it -- so this asserts the DISPLAY rule during the
  // window before that runs, and will fail loudly if the rule ever changes.
  console.log('\n== capturing follows the running instance, not the open row ==');
  await query(`UPDATE instances SET terminated_at = now() WHERE id=$1`, [INST]);
  const after = await sources('');
  check('the station stops counting as capturing', after.counts.capturing, 0);
  check('though its recording row is still open',
    (await query<any>(`SELECT count(*)::int n FROM recordings
                        WHERE channel_id=$1 AND status='recording' AND end_epoch_ms IS NULL`, [RD]))[0].n, 1);
  check('and it is still listed as a source with content', after.counts.radio, 1);

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  console.log(`\nrecordings-counts: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
