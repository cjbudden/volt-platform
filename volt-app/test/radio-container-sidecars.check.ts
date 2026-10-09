// ============================================================================
//  WHAT THE CONTROL PLANE STILL HAS TO DO AFTER RADIO MOVED INTO A CONTAINER.
//
//  Containerising radio was right, and it lost things. Twice now, in the same
//  way, and neither loss produced an error anywhere:
//
//    THE LEVEL MONITOR. The in-process pipeline started it; the container path
//    did not. A station went on air with a waveform that never moved, a QC
//    verdict stuck on 'unknown', and silence that was never detected. Nothing
//    said so, because "no levels yet" and "no levels ever" look identical.
//
//    ICY METADATA CAPTURE. The in-process pipeline started it
//    (radio/pipeline.ts); the container path did not. Every station's
//    now-playing log was empty. That reads as "this station sends no metadata",
//    which is a statement about the station rather than about us, so it looked
//    like an upstream limitation rather than a missing call.
//
//  Both are CONTROL-PLANE work and neither can move into the container, which
//  is exactly why they were easy to drop. The level monitor reads segments off
//  the origin and writes samples nobody else can see. Metadata capture opens a
//  SECOND connection to the source, negotiated with `Icy-MetaData: 1`, and
//  writes titles into the database -- and the container has no database and
//  must not be given one.
//
//  So this suite asserts the side effects of starting a station that are NOT
//  the container. It uses the mock launcher on purpose: the question is not
//  whether ffmpeg runs, it is what the control plane does either side of
//  launching it.
//
//  Usage: DATABASE_URL=... ORCH_LAUNCHER=mock npx tsx test/radio-container-sidecars.check.ts
// ============================================================================
process.env.ORCH_LAUNCHER = 'mock';
process.env.RADIO_MODE = 'container';

import { pool, query } from '../src/db';
import { radioMonitorState } from '../src/services/radio/monitor';
import { icyState } from '../src/services/radio/icyMeta';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected nothing, got [${String(v)}]`));

const A  = '00000000-0000-0000-0000-00000c710001';
const P  = '00000000-0000-0000-0000-00000c710002';
const G  = '00000000-0000-0000-0000-00000c710003';
const ICE = '00000000-0000-0000-0000-00000c710010';
const HLS = '00000000-0000-0000-0000-00000c710011';
const OFF = '00000000-0000-0000-0000-00000c710012';

// A source URL that is REACHABLE BY DNS AND THEN REFUSED, on purpose. What is
// under test is whether the capture is registered at all, not whether it
// connects, and a URL that resolves nowhere would leave the question of a
// registered-but-failed capture confused with an unregistered one.
const DEAD_ICE = 'http://127.0.0.1:9/stream';
const DEAD_HLS = 'http://127.0.0.1:9/master.m3u8';

async function seed() {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'SidecarCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'radio',$3,10)`, [G, A, P]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind,recording_enabled,radio_config) VALUES
       ($1,$4,'Icecast Station','ended','radio',false,'{"metadataCapture":true}'::jsonb),
       ($2,$4,'HLS Station','ended','radio',false,'{"metadataCapture":true}'::jsonb),
       ($3,$4,'Metadata Off','ended','radio',false,'{"metadataCapture":false}'::jsonb)`,
    [ICE, HLS, OFF, G]);
  await query(
    `INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url) VALUES
       ($1,'primary','icecast',$4), ($2,'primary','hls',$5), ($3,'primary','icecast',$4)`,
    [ICE, HLS, OFF, DEAD_ICE, DEAD_HLS]);
}

(async () => {
  await seed();
  const { orchestrator } = await import('../src/services/orchestrator');

  // ---- an Icecast station gets both sidecars -------------------------------
  await orchestrator.startStream('channel', ICE, 'test');
  truthy('starting a station starts the level monitor, or the waveform never moves',
    radioMonitorState(ICE));
  truthy('and starts metadata capture, or the now-playing log is silently empty',
    icyState(ICE));

  // ---- an HLS station gets one ---------------------------------------------
  //
  // Not a shortcut and not a limitation to fix later: a playlist has no ICY
  // channel to negotiate. A capture opened against one would poll a server that
  // can never answer with a metadata frame, and produce the same empty log
  // while burning a socket and looking like it was working.
  await orchestrator.startStream('channel', HLS, 'test');
  truthy('an HLS station is metered like any other', radioMonitorState(HLS));
  falsy('but has no ICY capture, because a playlist has no metadata channel',
    icyState(HLS));

  // ---- the setting is honoured ---------------------------------------------
  await orchestrator.startStream('channel', OFF, 'test');
  truthy('a station with metadata capture off is still metered', radioMonitorState(OFF));
  falsy('and capture really is off, not merely absent from the form',
    icyState(OFF));

  // ---- stopping releases both ----------------------------------------------
  //
  // The metadata connection is the control plane's OWN socket. Nothing else
  // closes it, so a leak here is a stopped station that goes on appending
  // titles to its log: the one way an off-air station can look like it is
  // still playing something.
  await orchestrator.stopStream('channel', ICE, 'test');
  falsy('stopping a station stops its meter, rather than freezing the last value',
    radioMonitorState(ICE));
  falsy('and closes the metadata connection, rather than leaking a reader',
    icyState(ICE));

  await orchestrator.stopStream('channel', HLS, 'test').catch(() => {});
  await orchestrator.stopStream('channel', OFF, 'test').catch(() => {});

  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  console.log(`\nradio-container-sidecars: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
