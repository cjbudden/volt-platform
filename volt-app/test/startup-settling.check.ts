// ============================================================================
//  THE STARTUP SEQUENCE, AND WHY IT FLASHES AN ERROR THAT IS NOT TRUE YET.
//
//  Reported: "the error still shows on screen at startup and then disappears."
//
//  THERE IS A GAP, AND EVERY START GOES THROUGH IT.
//
//      t+0.0s  the orchestrator launches the task and writes status='live'
//      t+0.0s  ...but the encoder has not started, so it has posted nothing
//      t+1.5s  the encoder posts channel.start, then source.up, packager.up
//      t+4.0s  the first segment lands and the manifest starts advancing
//
//  Between the first line and the third, the newest channel.start in the table
//  belongs to the PREVIOUS run, and any channel.stop from that run is NEWER
//  than it. computePipelineHealth scopes itself to "everything at or after the
//  latest channel.start", which during the gap means the previous run's crash
//  is inside the window it is reasoning about. So a station that is starting
//  perfectly well is described using the reason the last one died.
//
//  That is the flash. It clears by itself the moment the encoder reports, which
//  is exactly why it looks like a ghost.
//
//  TWO SEPARATE FIXES, and both are needed:
//
//    1. A RUN BOUNDARY. Events older than the launch of the run now in progress
//       are not evidence about it. This is a correctness fix: attributing the
//       last run's crash to this one is simply wrong, at any delay.
//
//    2. A SETTLING WINDOW. Even within one run, a fault in the first seconds is
//       usually the pipeline still coming up, and auto connect will retry a
//       genuine failure without anybody watching. So a failure is RECORDED
//       immediately and PRESENTED as 'starting' until the window elapses. If it
//       recovers, nobody was ever shown a red box. If it does not, the error
//       surfaces with the reason that was captured at the time.
//
//  The distinction the suite pins is: recorded immediately, shown late. A fix
//  that simply swallowed early errors would pass a naive test and lose the
//  reason a station never came up.
//
//  Usage: npx tsx test/startup-settling.check.ts
// ============================================================================
import { computePipelineHealth, type HealthInput } from '../src/services/pipelineHealth';
import { config } from '../src/config';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

const NOW = Date.now();
const ev = (type: string, secsAgo: number, detail: any = {}) =>
  ({ type, detail, ts: new Date(NOW - secsAgo * 1000).toISOString(), seq: null } as any);

const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  ownerStatus: 'live',
  st: null,
  events: [],
  logTailErrors: [],
  hasPrimarySource: true,
  packagingLabel: 'MP3 + HLS + DASH',
  outputFresh: false,
  outputAgeMs: null,
  onAirPublished: false,
  ...over,
});

const gate = (h: any, name: string) => h.gates.find((g: any) => g.gate === name);

(async () => {
  console.log(`\n(settling window is ${config.health.settleSeconds}s)`);

  // ======================================================================
  console.log('\n== THE FLASH: a fresh start still carrying the last run\'s crash ==');
  //
  // status='live' because the orchestrator has just launched it. The only
  // events in the table are the previous run's, which ended badly. This is the
  // state every single start passes through.
  // ======================================================================
  const ghost = computePipelineHealth(base({
    events: [
      ev('channel.stop', 40, { reason: 'encoder exited rc=251' }),
      ev('source.down', 40, { source: 'primary' }),
      ev('source.up', 60, { source: 'primary' }),
      ev('channel.start', 60, {}),
    ],
    logTailErrors: ['Failed to resolve hostname ice5.somafm.com'],
    runStartedAt: NOW - 2000,   // THIS run launched two seconds ago
  }));

  check('the server gate is not failed', gate(ghost, 'server').status, 'healthy');
  check('the input gate reads as starting, not failed', gate(ghost, 'input').status, 'starting');
  check('and so does the encoder', gate(ghost, 'encoder').status, 'starting');
  check('and the output', gate(ghost, 'output').status, 'starting');
  check('so the page is starting, not error', ghost.overall, 'starting');

  // ======================================================================
  console.log('\n== a fault in THIS run is recorded at once, shown later ==');
  //
  // The station really did just die. Auto connect will relaunch it within
  // twenty seconds and it may well come back on its own, so the operator is
  // told it is starting -- but the reason is captured now, while it is true,
  // rather than re-derived later from whatever happens to be in the log.
  // ======================================================================
  const young = computePipelineHealth(base({
    events: [
      ev('channel.stop', 1, { reason: 'encoder exited rc=251: Connection refused' }),
      ev('channel.start', 3, {}),
    ],
    runStartedAt: NOW - 3000,
  }));
  check('it is presented as starting while it settles', young.overall, 'starting');
  truthy('but the reason is already recorded',
         JSON.stringify(young).includes('rc=251'));
  truthy('and the page can say it is retrying',
         /settl|retry|starting/i.test(JSON.stringify(young.gates)));

  // ======================================================================
  console.log('\n== once the window passes, it is a real error ==');
  //
  // The other half, and the one that matters more: a station that has been
  // failing for two minutes is NOT starting, and hiding that would be worse
  // than the flash this suite exists to remove.
  // ======================================================================
  const old = computePipelineHealth(base({
    events: [
      ev('channel.stop', config.health.settleSeconds + 30, { reason: 'encoder exited rc=251' }),
      ev('channel.start', config.health.settleSeconds + 40, {}),
    ],
    runStartedAt: NOW - (config.health.settleSeconds + 40) * 1000,
  }));
  check('the failure surfaces', old.overall, 'error');
  truthy('with the reason intact', JSON.stringify(old).includes('rc=251'));

  // ======================================================================
  console.log('\n== a healthy start is unaffected ==');
  // The settling window must not make a working station look like it is still
  // coming up. Segments advancing is ground truth and beats everything.
  // ======================================================================
  const healthy = computePipelineHealth(base({
    st: { output_available: true, packager_ok: true, sources: { primary: { state: 'up' } } },
    events: [ev('packager.up', 1), ev('source.up', 2), ev('channel.start', 3)],
    outputFresh: true,
    outputAgeMs: 800,
    runStartedAt: NOW - 3000,
  }));
  check('the input is healthy', gate(healthy, 'input').status, 'healthy');
  check('the encoder is healthy', gate(healthy, 'encoder').status, 'healthy');
  check('the output is healthy', gate(healthy, 'output').status, 'healthy');
  // READY, not on air: the station is producing valid output but has not been
  // published. That distinction is the whole point of the public gate and the
  // settling window must not blur it.
  check('overall reads ready while it is still private', healthy.overall, 'ready');

  const published = computePipelineHealth(base({
    st: { output_available: true, packager_ok: true, sources: { primary: { state: 'up' } } },
    events: [ev('packager.up', 1), ev('source.up', 2), ev('channel.start', 3)],
    outputFresh: true, outputAgeMs: 800, onAirPublished: true,
    runStartedAt: NOW - 3000,
  }));
  check('and on air once published', published.overall, 'onair');

  // ======================================================================
  console.log('\n== a stopped station is not "settling" either ==');
  // Nothing is starting, so nothing should be excused. An operator who pressed
  // Stop must see stopped, immediately.
  // ======================================================================
  const stopped = computePipelineHealth(base({
    ownerStatus: 'ended',
    events: [ev('channel.stop', 2, { reason: 'operator' }), ev('channel.start', 60)],
    runStartedAt: NOW - 60000,
  }));
  check('it reads as stopped at once', stopped.overall, 'stopped');

  // ======================================================================
  console.log('\n== without a run boundary, nothing changes for old callers ==');
  // runStartedAt is optional: every existing caller that does not pass one gets
  // exactly the behaviour it had, which is what makes this safe to land.
  // ======================================================================
  const legacy = computePipelineHealth(base({
    ownerStatus: 'ended',
    events: [ev('channel.stop', 300, { reason: 'encoder exited rc=195' }), ev('channel.start', 400)],
  }));
  check('an old crash still reports as failed', legacy.overall, 'error');

  console.log(`\nstartup-settling: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
