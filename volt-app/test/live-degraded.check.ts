// ============================================================================
//  "DEGRADED 0" NEXT TO A STATION WHOSE MP3 DOES NOT SERVE.
//
//  Reported from a real machine: DEF CON Radio up for 14 minutes, all five
//  gates green, its MP3 row reading "unavailable -- no Icecast relay listening
//  at localhost:8000", and the Live Streams board showing DEGRADED 0 · none.
//
//  Both numbers were right about their own definition, which is what made it
//  worth a suite rather than a one-line change.
//
//    * The five gates describe the PIPELINE: source arriving, encoder up,
//      packager advancing. All true. HLS and DASH really are being written.
//    * `stream_status.degraded_outputs` describes DELIVERY: the running encoder
//      probed the Icecast relay, found nothing there, dropped MP3 and went on
//      air with the rest.
//
//  The board counted only the first, so a stream could be simultaneously
//  healthy and not delivering what it was asked for, and the tile that exists
//  to say so said "none". THE TWO CONDITIONS ARE A UNION, not alternatives, and
//  this suite states that numerically: the gate roll-up must still report zero
//  degraded (the gates are not lying) while the board reports one.
//
//  WHY ONLY MP3 CAN DO THIS. HLS and DASH are files the encoder writes to the
//  origin; if the process lives, they exist. MP3 in the relay topology is a
//  push to a second piece of infrastructure, so it is the one output that can
//  be missing for a reason that has nothing to do with the source, the encoder
//  or the packager.
//
//  ALSO PINNED: a dropped output is only reported while something is actually
//  running. The row is cleared on start, but attributing a previous run's
//  refusal to a stopped stream would be the same mistake as trusting an
//  instance row that outlived its process.
//
//  Usage: DATABASE_URL=... API=http://localhost:8080 npx tsx test/live-degraded.check.ts
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

const A    = '00000000-0000-0000-0000-0000de6de001';
const P    = '00000000-0000-0000-0000-0000de6de002';
const G    = '00000000-0000-0000-0000-0000de6de003';
const RD   = '00000000-0000-0000-0000-0000de6de010';   // the degraded station
const OK_C = '00000000-0000-0000-0000-0000de6de011';   // a station with nothing wrong
const INST = '00000000-0000-0000-0000-0000de6de020';
const IN2  = '00000000-0000-0000-0000-0000de6de021';

const token = jwt.sign({ sub: 'u', account_id: A, role: 'owner', typ: 'access' }, SECRET, { expiresIn: 600 });
const REASON = 'no Icecast relay listening at localhost:8000';

async function board() {
  const r = await fetch(`${API}/api/monitoring/live`, { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`GET /api/monitoring/live -> ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
}
const row = (b: any, id: string) => b.streams.find((s: any) => s.id === id);

(async () => {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'DegradedCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
     VALUES ($1,$2,'p','[{"height":720,"bitrate_kbps":2500}]','package_only')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent)
               VALUES ($1,$2,'g',$3,20,10)`, [G, A, P]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,on_air) VALUES
       ($1,$3,'DEF CON Radio','live','radio',false),
       ($2,$3,'Clean Station','live','radio',false)`, [RD, OK_C, G]);

  // Both stations are RUNNING: a live instance and a fresh encoder report.
  await query(
    `INSERT INTO instances(id,channel_id,role,state,launched_at,task_kind) VALUES
       ($1,$3,'primary','running', now() - interval '14 minutes','radio'),
       ($2,$4,'primary','running', now() - interval '9 minutes','radio')`,
    [INST, IN2, RD, OK_C]);
  // One of them had its MP3 refused. The other is delivering everything.
  await query(
    `INSERT INTO stream_status(channel_id, degraded_outputs, updated_at) VALUES
       ($1, $3::jsonb, now()),
       ($2, '{}'::jsonb, now())`,
    [RD, OK_C, JSON.stringify({ mp3: REASON })]);

  console.log('== the station is running and its MP3 was refused ==');
  const b = await board();
  const def = row(b, RD), clean = row(b, OK_C);
  check('the station is on the board', !!def, true);
  check('its pipeline is up', def.uptimeMs != null, true);
  check('the dropped output is reported', def.degradedOutputs?.mp3, REASON);
  check('and it names the address it could not reach',
    String(def.degradedOutputs?.mp3).includes('localhost:8000'), true);
  check('the healthy station reports nothing dropped',
    Object.keys(clean.degradedOutputs ?? {}).length, 0);

  console.log('\n== the gates are NOT lying, and the board still counts it ==');
  // This pair of assertions IS the bug. The gate roll-up is entitled to say
  // nothing is degraded, because the pipeline is not degraded. The board is
  // not entitled to agree, because delivery is incomplete.
  check('no stream is degraded by the five-gate roll-up', b.counts.degraded ?? 0, 0);
  check('but the board reports one degraded stream', b.degraded, 1);
  check('and it is not counted as down', b.counts.error ?? 0, 0);

  console.log('\n== the other numbers on the tile row ==');
  check('two encoders are up', b.running, 2);
  check('nothing is published yet', b.onAir, 0);
  check('the fleet is both stations', b.streams.length, 2);

  console.log('\n== a second dropped output counts the STREAM once, not twice ==');
  await query(
    `UPDATE stream_status SET degraded_outputs = $2::jsonb, updated_at = now() WHERE channel_id = $1`,
    [RD, JSON.stringify({ mp3: REASON, dash: 'packager refused the DASH mount' })]);
  const b2 = await board();
  check('both outputs are reported on the row',
    Object.keys(row(b2, RD).degradedOutputs).sort().join(','), 'dash,mp3');
  check('and the tile still counts one degraded stream', b2.degraded, 1);

  console.log('\n== a dropped output belongs to a RUNNING stream, not a dead one ==');
  // The row is cleared on start, so this should not arise -- but reporting a
  // previous run's refusal against a stopped stream is the same class of
  // mistake as believing an instance row that outlived its process.
  await query(`UPDATE instances SET terminated_at = now() WHERE channel_id = $1`, [RD]);
  await query(`UPDATE stream_status SET updated_at = now() - interval '30 minutes' WHERE channel_id = $1`, [RD]);
  const b3 = await board();
  check('the stopped station reports no uptime', row(b3, RD).uptimeMs, null);
  check('and no dropped outputs', Object.keys(row(b3, RD).degradedOutputs).length, 0);
  check('so the board is back to zero degraded', b3.degraded, 0);
  check('while the encoder count drops to one', b3.running, 1);

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  console.log(`\nlive-degraded: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
