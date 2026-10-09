// ============================================================================
//  RADIO TEARDOWN — what happens to a station when its encoder goes away.
//
//  This suite exists because of a bug that could not be seen from any page.
//  The exit handler used to do its teardown inside `if (code && code !== 0)`,
//  which is a test that only passes for one of the three ways a process can
//  end:
//
//    rc != 0    a real failure                       -> torn down (correct)
//    rc == 0    the source ended, the stream finished -> `code && …` is false
//    signal     killed; `code` is null                -> `code && …` is false
//
//  The two skipped cases are the common ones. A station that ended cleanly, or
//  was killed, stayed in the in-memory `running` map for the lifetime of the
//  control plane. Nothing crashed. The consequences were all quiet:
//
//    - isRadioRunning() kept answering true, so the orchestrator's reaper
//      believed the station was alive and never closed its instance row.
//    - The monitor kept polling a run directory nothing was writing to.
//    - Pressing Start was refused as "already running", and no amount of
//      pressing Stop helped, because stopRadio() signals a pid that is gone.
//    - MP3 listeners were never released.
//
//  The only cure was restarting the service, which is why it looked like an
//  infrastructure flake rather than a bug.
//
//  So the assertions here are deliberately about the two exits that used to be
//  skipped, and about the difference between them: a clean end is a
//  `channel.stop`, and only an unexpected one is also an `input.error`. A
//  teardown that reported every ending as a fault would pass the first half of
//  this suite and still be wrong.
//
//  It runs the real ffmpeg against a real (tiny, generated) source, because
//  the thing under test IS the process exit. A mocked child would test the
//  mock.
//
//  Usage: DATABASE_URL=... npx tsx test/radio-teardown.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, query, one } from '../src/db';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

// Ids namespaced to this suite.
const A = '00000000-0000-0000-0000-000009910001';
const P = '00000000-0000-0000-0000-000009910010';
const G = '00000000-0000-0000-0000-000009910011';
const CH_CLEAN = '00000000-0000-0000-0000-000009910021';
const CH_KILLED = '00000000-0000-0000-0000-000009910022';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, polling, up to `ms`. Returns whether it came true. */
async function until(fn: () => boolean, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}

async function seed() {
  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'RadioCo')`, [A]);
  await query(
    `INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
     VALUES ($1,$2,'p','[{"height":0,"bitrate_kbps":128}]','package_only','both',4,60)`,
    [P, A]
  );
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
               VALUES ($1,$2,'radio',$3,10)`, [G, A, P]);
  await query(
    `INSERT INTO channels(id,group_id,name,status,kind) VALUES ($1,$3,'Clean Exit','live','radio'),
                                                                ($2,$3,'Killed','live','radio')`,
    [CH_CLEAN, CH_KILLED, G]
  );
}

/** Generate a real audio file so ffmpeg has something honest to read. */
function makeSource(dir: string, seconds: number, name: string): string {
  const out = join(dir, name);
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', 'libmp3lame', '-b:a', '128k', out,
  ], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0 || !existsSync(out)) {
    throw new Error(`could not generate a source file: ${r.stderr || r.stdout}`);
  }
  return out;
}

(async () => {
  if (!spawnSync('ffmpeg', ['-version']).stdout) {
    console.log('SKIP ffmpeg is not installed — this suite tests a real process exit.');
    console.log('\nradio-teardown: 0 passed, 0 failed');
    await pool.end();
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'radio-teardown-'));
  // The pipeline writes under config.testStream.originDir, resolved at import
  // time from the environment, so it has to be set BEFORE the module loads.
  process.env.ORIGIN_DIR = join(work, 'origin');

  const { startRadio, stopRadio, isRadioRunning, radioStatus } =
    await import('../src/services/radio/pipeline');

  await seed();

  try {
    // ---- a source that simply ends (rc=0) ---------------------------------
    //
    // Two seconds of audio, read as fast as ffmpeg can, then the input is
    // exhausted and ffmpeg exits 0. This is what a station whose upstream shut
    // down for the night looks like, and it is exactly the case the old
    // handler stepped over.
    const shortSrc = makeSource(work, 2, 'short.mp3');
    const started = startRadio({
      channelId: CH_CLEAN, protocol: 'file', url: shortSrc,
      cfg: { bitrateKbps: 128, outputs: { mp3: true, hls: true, dash: false } },
    });
    truthy('the pipeline started', started.pid > 0);
    check('and reports itself running', isRadioRunning(CH_CLEAN), true);

    const cleanedUp = await until(() => !isRadioRunning(CH_CLEAN));
    check('a source that ends cleanly tears the station down', cleanedUp, true);
    check('and the status is no longer "running"', radioStatus(CH_CLEAN).running, false);

    // Stop is now a no-op rather than a signal to a dead pid, and — the part
    // that actually mattered to an operator — Start is no longer refused.
    stopRadio(CH_CLEAN, 'test');
    check('a second start is not refused as "already running"',
      startRadio({
        channelId: CH_CLEAN, protocol: 'file', url: shortSrc,
        cfg: { bitrateKbps: 128, outputs: { mp3: true, hls: false, dash: false } },
      }).pid > 0, true);
    stopRadio(CH_CLEAN, 'test');

    // Give the telemetry writes (fire-and-forget) a moment to land.
    await sleep(750);
    const cleanEvents = await query<any>(
      `SELECT type, detail FROM stream_events WHERE channel_id = $1 ORDER BY id`, [CH_CLEAN]);
    const types = cleanEvents.map((e: any) => e.type);
    truthy('a clean end is reported as a stop', types.includes('channel.stop'));
    falsy('a clean end is NOT reported as an input error', types.includes('input.error'));
    const stopEv = cleanEvents.find((e: any) => e.type === 'channel.stop');
    truthy('and the stop says why, in words an operator can act on',
      /rc=0|source ended/i.test(String(stopEv?.detail?.reason ?? '')));

    // ---- a process that is killed (code null, signal set) ------------------
    //
    // Ten minutes of audio so it cannot end on its own, then SIGKILL to the
    // process group, which is what an OOM kill or a container eviction looks
    // like from in here. `code` is null, so the old `code && code !== 0`
    // guard was false and nothing was torn down.
    const longSrc = makeSource(work, 600, 'long.mp3');
    const killed = startRadio({
      channelId: CH_KILLED, protocol: 'file', url: longSrc,
      cfg: { bitrateKbps: 128, outputs: { mp3: true, hls: true, dash: false } },
    });
    check('the second station is running', isRadioRunning(CH_KILLED), true);

    // Kill it BEHIND the control plane's back: stopRadio() deregisters first,
    // so going through it would prove nothing about the exit handler.
    try { process.kill(-killed.pid, 'SIGKILL'); } catch { process.kill(killed.pid, 'SIGKILL'); }

    const reaped = await until(() => !isRadioRunning(CH_KILLED));
    check('a killed encoder tears the station down too', reaped, true);

    await sleep(750);
    const killEvents = await query<any>(
      `SELECT type, detail FROM stream_events WHERE channel_id = $1 ORDER BY id`, [CH_KILLED]);
    const killTypes = killEvents.map((e: any) => e.type);
    truthy('an unexpected exit IS reported as an input error', killTypes.includes('input.error'));
    truthy('and as a stop, so the gates go down', killTypes.includes('channel.stop'));
    const errEv = killEvents.find((e: any) => e.type === 'input.error');
    truthy('the error names the signal rather than inventing a return code',
      errEv?.detail?.signal === 'SIGKILL' || /signal/i.test(String(errEv?.detail?.message ?? '')));
    check('and carries no return code, because there was none', errEv?.detail?.rc ?? null, null);
    // ---- the instance row must be closed too --------------------------------
    //
    // Tearing down the pipeline is only half of it. `billable` is derived from
    // an instance row with no terminated_at, so a station whose ffmpeg is gone
    // keeps metering until something closes the row. For television the
    // reconciler asks the launcher; for radio the launcher knows nothing, and
    // the radio branch used to count the row alive without asking anything at
    // all. The channel moved out of `live` and the row stayed open forever.
    const GHOST = '00000000-0000-0000-0000-000009910023';
    await query(
      `INSERT INTO channels(id,group_id,name,status,kind,radio_config)
       VALUES ($1,$2,'Ghost FM','live','radio','{}'::jsonb)`, [GHOST, G]);
    await query(
      `INSERT INTO instances(channel_id,task_arn,state,launched_at)
       VALUES ($1,'radio:99999:20260101T000000Z','running', now() - interval '20 hours')`,
      [GHOST]);

    const { orchestrator } = await import('../src/services/orchestrator');
    await orchestrator.reconcileStreamStatus();

    const ghostCh = await one<any>(`SELECT status FROM channels WHERE id = $1`, [GHOST]);
    check('a station with no pipeline stops being live', ghostCh?.status, 'ended');
    const ghostInst = await one<any>(
      `SELECT state, terminated_at FROM instances WHERE channel_id = $1`, [GHOST]);
    truthy('and its instance row is closed, so billing stops', !!ghostInst?.terminated_at);
    check('with the same shape a clean stop writes', ghostInst?.state, 'terminated');

    // The converse: a station that IS running must survive the same sweep.
    // A reconciler that closed every radio row would "fix" the leak by taking
    // every healthy station off air.
    const liveSrc = makeSource(work, 600, 'keep.mp3');
    startRadio({
      channelId: CH_CLEAN, protocol: 'file', url: liveSrc,
      cfg: { bitrateKbps: 128, outputs: { mp3: true, hls: false, dash: false } },
    });
    await query(`UPDATE channels SET status='live' WHERE id = $1`, [CH_CLEAN]);
    await query(
      `INSERT INTO instances(channel_id,task_arn,state,launched_at)
       VALUES ($1,'radio:1:20260101T000000Z','running', now())`, [CH_CLEAN]);
    await orchestrator.reconcileStreamStatus();
    const keptInst = await one<any>(
      `SELECT terminated_at FROM instances WHERE channel_id = $1 AND task_arn = 'radio:1:20260101T000000Z'`,
      [CH_CLEAN]);
    falsy('a station that IS running keeps its instance row', !!keptInst?.terminated_at);
    stopRadio(CH_CLEAN, 'test');
  } finally {
    stopRadio(CH_CLEAN, 'cleanup');
    stopRadio(CH_KILLED, 'cleanup');
    await query(`DELETE FROM accounts WHERE id = $1`, [A]).catch(() => { /* */ });
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`\nradio-teardown: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
