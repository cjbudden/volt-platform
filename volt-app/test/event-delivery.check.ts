// ============================================================================
//  DOES THE LAST THING A DYING TASK SAYS ACTUALLY ARRIVE?
//
//  A station failed on a bad source, reported exactly why, and the console
//  showed STARTING for a day with no error, no reason and no recovery. The
//  reason was in the task's own log the whole time:
//
//    [volt-radio] ffmpeg exited unexpectedly (rc=183): Master Playlist tag
//                 found in a Media Playlist
//    {"type":"channel.stop","detail":{"reason":"encoder exited rc=183: ..."}}
//
//  It was emitted. It was never delivered.
//
//  events.py posts every report on a DAEMON thread, so the media path never
//  blocks on a slow control plane. Daemon threads are destroyed the instant the
//  interpreter exits. channel.stop is emitted microseconds before the process
//  ends, so its POST was started and then killed. Every time.
//
//  THE SHAPE OF THAT BUG IS WHY IT SURVIVED SO LONG. It was not flaky. It was
//  total, and it was precisely inverted: every routine event landed, because the
//  process kept running afterwards, and only the TERMINAL event was guaranteed
//  to be lost. So the control plane saw a station start and then go quiet, which
//  is exactly what a healthy station that has not finished starting looks like.
//  Nothing anywhere was in a position to notice.
//
//  A unit test of events.py could not have caught it either: in a test process
//  that keeps running, the daemon thread completes and the assertion passes.
//  The bug lives in the race between the POST and interpreter shutdown, so the
//  test has to be a REAL process that REALLY exits.
//
//  So this spawns radio.py against a source that fails immediately, lets it die,
//  and asserts on what a listening control plane actually received.
//
//  Usage: npx tsx test/event-delivery.check.ts     (no database)
// ============================================================================
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected something, got [${String(v)}]`));

const RADIO_PY = resolve(__dirname, '../../volt-encoder/bin/radio.py');
const done = (code: number) => { console.log(`\nevent-delivery: ${pass} passed, ${fail} failed`); process.exit(code); };

if (!existsSync(RADIO_PY) || !spawnSync('python3', ['--version']).stdout) {
  console.log('SKIP radio.py or python3 not reachable');
  done(0);
}
if (!spawnSync('ffmpeg', ['-version']).stdout) {
  console.log('SKIP ffmpeg is not installed — this suite runs the real entrypoint');
  done(0);
}

const PORT = 9187;
const CH = '00000000-0000-0000-0000-00000e910001';
const WORK = mkdtempSync(join(tmpdir(), 'evt-'));

interface Received { events: any[]; statuses: any[] }
const got: Received = { events: [], statuses: [] };

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const p = JSON.parse(body);
      if (p.event) got.events.push(p.event);
      if (p.status) got.statuses.push(p.status);
    } catch { /* ignore anything unparseable */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

  // A SOURCE THAT FAILS AT ONCE, on purpose. The window between emitting
  // channel.stop and the interpreter exiting is what is under test, and a run
  // that dies in under a second makes that window as small as it ever gets.
  // Port 9 is discard: the connection is refused immediately, no DNS, no wait.
  const job = {
    channel_id: CH,
    protocol: 'icecast',
    url: 'http://127.0.0.1:9/stream',
    outputs: { mp3: false, hls: true, dash: false },
    bitrate_kbps: 128,
    segment_seconds: 2,
    icecast: null,
    output: { mode: 'local', dir: join(WORK, 'origin') },
    status_report: { url: `http://127.0.0.1:${PORT}/report`, token: 'test-token' },
  };

  const child = spawn('python3', [RADIO_PY], {
    env: { ...process.env, JOB_CONFIG_JSON: JSON.stringify(job), WORK_DIR: join(WORK, 'origin'), LOCAL_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const exited = await new Promise<number>((r) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); r(-1); }, 60_000);
    child.on('exit', (code) => { clearTimeout(t); r(code ?? -1); });
  });

  // A moment for anything genuinely in flight. Deliberately generous: the point
  // is to prove delivery does not depend on luck, so a failure here has to mean
  // the report was never going to arrive rather than that we asked too soon.
  await sleep(1500);

  console.log(`\n== the station ran and died (exit ${exited}) ==`);
  truthy('it printed its own diagnosis to the task log',
    /ffmpeg exited|Error opening|FATAL/i.test(out));

  console.log('\n== what the control plane actually received ==');
  const types = got.events.map((e) => e.type);
  console.log(`   events delivered: ${types.length ? types.join(', ') : '(none)'}`);

  truthy('channel.start arrived (the easy one: the process kept running after it)',
    types.includes('channel.start'));

  // THE ASSERTION THIS SUITE EXISTS FOR.
  truthy('channel.stop ARRIVED — the terminal event is no longer lost with the process',
    types.includes('channel.stop'));

  const stop = got.events.find((e) => e.type === 'channel.stop');
  truthy('and it carries a reason, so the console can say what went wrong',
    stop?.detail?.reason);
  truthy('a reason that names the actual failure rather than an exit code alone',
    /refused|connection|invalid|resolve|error|fatal/i.test(String(stop?.detail?.reason ?? '')));
  console.log(`   reason: ${stop?.detail?.reason ?? '(none)'}`);

  // The closing snapshot matters as much as the event: it is what stops the
  // console describing a dead station as one with output available.
  const last = got.statuses[got.statuses.length - 1];
  truthy('a final status snapshot arrived too', last);
  if (last) {
    (last.output_available === false)
      ? ok('and it says the output is NOT available')
      : bad('and it says the output is NOT available', `output_available=${last.output_available}`);
  }

  // Ordering is not incidental. A stop that arrives before the start would be
  // applied and then overwritten by the start, and the station would look like
  // it was running again.
  const iStart = types.indexOf('channel.start');
  const iStop = types.indexOf('channel.stop');
  (iStart >= 0 && iStop > iStart)
    ? ok('the stop arrived after the start, so it is not overwritten by it')
    : bad('the stop arrived after the start', `start@${iStart} stop@${iStop}`);

  server.close();
  rmSync(WORK, { recursive: true, force: true });
  done(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  try { server.close(); } catch { /* */ }
  rmSync(WORK, { recursive: true, force: true });
  done(1);
});
