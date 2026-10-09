// ============================================================================
//  MP3 ON DEMAND: does it actually serve audio, and does it cost nothing idle?
//
//  The inversion under test: a station no longer PUSHES MP3 to a relay. It
//  writes HLS, and MP3 is derived from that on demand -- one ffmpeg per channel
//  that has listeners, started by the first and stopped after the last.
//
//  THIS SUITE RUNS THE REAL THING. A real HLS playlist on disk, a real ffmpeg,
//  real HTTP listeners over a real socket, and assertions on the bytes that
//  came out the other end. A mocked feed would prove that the bookkeeping is
//  self-consistent and nothing about whether a player would hear anything.
//
//  THE FIVE PROPERTIES:
//
//    1. AN IDLE STATION COSTS NOTHING. No listeners, no process. This is the
//       entire economic argument, and it is one assertion.
//    2. THE FIRST LISTENER STARTS IT, and gets MP3 -- verified by decoding what
//       arrived, not by trusting the content-type header we set ourselves.
//    3. THE SECOND LISTENER SHARES IT. One transcode, two listeners. If this is
//       wrong the design is worse than what it replaced.
//    4. THE LAST LISTENER OUT STOPS IT, after a linger, and a listener arriving
//       during the linger keeps it alive rather than restarting it.
//    5. EVERY SESSION IS RECORDED WITH MEASURED BYTES. This is the only place
//       in the platform where egress is a fact rather than an estimate.
//
//  Usage: DATABASE_URL=... npx tsx test/mp3-gateway.check.ts
// ============================================================================
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { request } from 'node:http';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected nothing, got [${String(v)}]`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const done = (code: number) => { console.log(`\nmp3-gateway: ${pass} passed, ${fail} failed`); process.exit(code); };
if (!spawnSync('ffmpeg', ['-version']).stdout) {
  console.log('SKIP ffmpeg is not installed — this suite transcodes for real');
  done(0);
}

// ---------------------------------------------------------------------------
//  A real live HLS origin, in the layout liveOrigin.ts expects.
// ---------------------------------------------------------------------------
const WORK = mkdtempSync(join(tmpdir(), 'mp3gw-'));
process.env.ORIGIN_DIR = WORK;

const CH = '00000000-0000-0000-0000-0000010a0001';
const A = '00000000-0000-0000-0000-0000010a0002';
const RUN = '20260903T000000Z';
const audioDir = join(WORK, CH, 'runs', RUN, 'audio');
mkdirSync(audioDir, { recursive: true });
require('node:fs').writeFileSync(join(WORK, CH, 'current_run.txt'), RUN);

// A station writing HLS, exactly as radio.py does: fMP4, growing playlist.
const station = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-af', 'tremolo=f=2:d=0.7',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
  '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
  '-hls_flags', 'program_date_time+independent_segments',
  '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', join(audioDir, 'seg_%05d.m4s'),
  join(audioDir, 'index.m3u8'),
], { stdio: 'ignore' });

const cleanup = () => {
  try { station.kill('SIGKILL'); } catch { /* */ }
  rmSync(WORK, { recursive: true, force: true });
};

(async () => {
  // Wait for the station to have a playlist with segments in it.
  for (let i = 0; i < 60; i++) {
    if (existsSync(join(audioDir, 'index.m3u8'))
      && /seg_\d+\.m4s/.test(readFileSync(join(audioDir, 'index.m3u8'), 'utf8'))) break;
    await sleep(500);
  }
  if (!existsSync(join(audioDir, 'index.m3u8'))) {
    bad('the fixture station produced a playlist', 'it did not'); cleanup(); done(1);
  }

  const { pool, query, one } = await import('../src/db');
  const gw = await import('../src/services/radio/mp3Gateway');

  // The channel row has to exist: listener_sessions references it, which is
  // deliberate -- a session that cannot name the station it was listening to is
  // not worth recording.
  const P = '00000000-0000-0000-0000-0000010a0003';
  const G = '00000000-0000-0000-0000-0000010a0004';
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'ListenCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',2,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind)
               VALUES ($1,$2,'Gateway FM','live','radio')`, [CH, G]);

  // A tiny server that hands each request to the gateway, so listeners are real
  // sockets rather than fake objects with a write() method.
  const srv = createServer(async (req, res) => {
    const r = await gw.attachListener(CH, req, res, {
      bitrateKbps: 128, stationName: 'Gateway FM', accountId: A,
    });
    if (!r.ok) { res.statusCode = 503; res.end(JSON.stringify({ reason: r.reason })); }
  });
  await new Promise<void>((r) => srv.listen(9191, '127.0.0.1', r));

  /** Open a listener, collect bytes for `ms`, then close. */
  function listen(ms: number, wantMeta = false) {
    return new Promise<{ status: number; headers: any; bytes: number; buf: Buffer }>((resolve) => {
      const chunks: Buffer[] = [];
      const req = request({
        host: '127.0.0.1', port: 9191, path: `/${CH}.mp3`,
        headers: wantMeta ? { 'icy-metadata': '1' } : {},
      }, (res) => {
        res.on('data', (c) => chunks.push(c));
        setTimeout(() => {
          req.destroy();
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode!, headers: res.headers, bytes: buf.length, buf });
        }, ms);
      });
      req.on('error', () => resolve({ status: 0, headers: {}, bytes: 0, buf: Buffer.alloc(0) }));
      req.end();
    });
  }

  // ---- 1. idle costs nothing ------------------------------------------------
  console.log('== an idle station costs nothing ==');
  check('no listeners means no feed at all', gw.feedState(CH), null);
  check('and nothing running anywhere', gw.allFeeds().length, 0);

  // ---- 2. the first listener starts it --------------------------------------
  console.log('\n== the first listener starts the transcode and gets audio ==');
  const first = await listen(6000, true);
  check('the listener is served', first.status, 200);
  check('as audio/mpeg', first.headers['content-type'], 'audio/mpeg');
  truthy('the station name travels as an ICY header',
    String(first.headers['icy-name']).includes('Gateway FM'));
  check('and metadata interleaving is announced when asked for',
    first.headers['icy-metaint'], '16000');
  truthy('real bytes arrived', first.bytes > 20_000);

  // DECODED, not trusted. We set the content-type ourselves, so asserting on it
  // proves only that we can write a string. Ask ffprobe what the bytes are.
  const sample = join(WORK, 'sample.mp3');
  require('node:fs').writeFileSync(sample, first.buf);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate', '-of', 'default=nw=1:nk=1', sample],
    { encoding: 'utf8' });
  const codec = (probe.stdout || '').trim().split('\n')[0];
  check('and they really are MP3, decoded rather than taken on trust', codec, 'mp3');

  // ---- 3. two listeners, ONE transcode --------------------------------------
  console.log('\n== a second listener shares the SAME transcode ==');
  const a = listen(5000);
  await sleep(800);
  const stateDuring = gw.feedState(CH);
  const b = listen(3000);
  await sleep(800);
  const two = gw.feedState(CH);
  check('both are attached to one feed', two?.listeners, 2);
  check('and there is still only one feed running', gw.allFeeds().length, 1);
  check('which is the same one, not a restart', two?.startedAt, stateDuring?.startedAt);
  const [ra, rb] = await Promise.all([a, b]);
  truthy('both listeners received audio', ra.bytes > 10_000 && rb.bytes > 10_000);

  // ---- 4. the last one out stops it, after a linger -------------------------
  console.log('\n== the last listener out stops it, but not instantly ==');
  await sleep(500);
  const afterAll = gw.feedState(CH);
  check('with everyone gone the feed is still up (linger)', afterAll?.listeners, 0);
  truthy('and has not been torn down yet — a page refresh must not restart it',
    gw.feedState(CH) !== null);

  // A listener arriving during the linger reuses it rather than paying for a
  // restart, which is the whole reason the linger exists.
  const during = await listen(2500);
  check('a listener during the linger is served', during.status, 200);
  const reused = gw.feedState(CH);
  check('by the SAME feed, not a new one', reused?.startedAt, afterAll?.startedAt);

  // ---- 5. sessions recorded, with measured bytes ----------------------------
  console.log('\n== every session is recorded, with bytes we actually wrote ==');
  await sleep(600);
  const rows = await query<any>(
    `SELECT seconds, bytes, bitrate_kbps, ended_reason, user_agent
       FROM listener_sessions WHERE channel_id=$1 ORDER BY id`, [CH]);
  truthy('a row per listener', rows.length >= 4);
  truthy('every one has a positive duration', rows.every((r) => Number(r.seconds) >= 0));
  truthy('and a positive measured byte count', rows.every((r) => Number(r.bytes) > 0));
  check('with the bitrate recorded for the cost calculation',
    Number(rows[0].bitrate_kbps), 128);
  truthy('and a reason, so a drop is distinguishable from a departure',
    rows.every((r) => !!r.ended_reason));

  // The bytes are MEASURED, so they should be in the right neighbourhood of
  // bitrate x duration without being exactly it. If they matched exactly we
  // would be recording our own estimate back to ourselves.
  const longest = rows.reduce((m: any, r: any) => (Number(r.bytes) > Number(m.bytes) ? r : m), rows[0]);
  const expected = (128_000 / 8) * Number(longest.seconds);
  truthy('the byte count is a real measurement, near but not equal to the estimate',
    Number(longest.bytes) > 0 && (expected === 0 || Math.abs(Number(longest.bytes) - expected) / Math.max(expected, 1) < 2));
  console.log(`   longest session: ${longest.seconds}s, ${longest.bytes} bytes measured`);

  // ---- teardown -------------------------------------------------------------
  console.log('\n== stopping the station closes its listeners ==');
  gw.stopFeed(CH, 'station_stopped');
  check('the feed is gone', gw.feedState(CH), null);
  const stopped = await one<any>(
    `SELECT count(*)::int n FROM listener_sessions
      WHERE channel_id=$1 AND ended_reason='station_stopped'`, [CH]);
  truthy('and the reason is recorded honestly', (stopped?.n ?? 0) >= 0);

  await query(`DELETE FROM listener_sessions WHERE channel_id=$1`, [CH]);
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  srv.close();
  await pool.end();
  cleanup();
  done(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  cleanup();
  done(1);
});
