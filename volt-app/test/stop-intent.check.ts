// ============================================================================
//  STOPPED ON PURPOSE IS NOT AN ERROR (services/pipelineHealth.ts).
//
//  After Stop (or a scheduled stop) and until the next Start, whatever the
//  teardown throws off is the stop doing its job: the channel reads STOPPED,
//  with no error and no red gate. The one error a stop can have is that the
//  stream does not actually stop: still running 45 s after the stop was issued.
//  A fault stop (auto connect territory) is untouched: it still reads error.
//
//  Usage: npx tsx test/stop-intent.check.ts
// ============================================================================
import { computePipelineHealth, STOP_GRACE_MS, type HealthInput } from '../src/services/pipelineHealth';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (got === want) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`); fail++ }
};
const NOW = Date.now();
const ev = (type: string, secsAgo: number, detail: any = {}) => ({ type, detail, ts: new Date(NOW - secsAgo * 1000).toISOString(), seq: null } as any);
const base = (over: Partial<HealthInput>): HealthInput => ({
  ownerStatus: 'ended', st: null, events: [], logTailErrors: [], hasPrimarySource: true, packagingLabel: 'HLS', ...over,
});
// the teardown's own noise: the relay is killed, the packager exits non-zero
const teardown = [ev('channel.stop', 5, { reason: 'exited rc=255' }), ev('input.error', 6, { message: 'relay killed' }), ev('source.down', 6), ev('channel.start', 600)];
const stopped = { desiredStopped: true, stopRequestedAt: new Date(NOW - 8000).toISOString(), stopRequestedBy: 'operator: console stop' };

const before = computePipelineHealth(base({ events: teardown }));
check('without a recorded stop, that teardown reads as an error', before.overall, 'error');

const h = computePipelineHealth(base({ events: teardown, recovery: stopped }));
check('after Stop it reads STOPPED', h.overall, 'stopped');
check('...with no error', h.primaryError, null);
check('...and no failed or degraded gate', h.gates.some(g => g.status === 'failed' || g.status === 'degraded'), false);
check('...and says it was stopped on purpose', h.gates.find(g => g.gate === 'encoder')!.detail, 'stopped by an operator');

const stopping = computePipelineHealth(base({ ownerStatus: 'live', events: teardown, recovery: stopped }));
check('still running a few seconds after Stop: stopping, not an error', stopping.primaryError, null);
check('...overall stopped', stopping.overall, 'stopped');
check('...server badge STOPPING', stopping.gates[0].badge, 'STOPPING');
check('...server says stopping', stopping.gates[0].detail, 'stopping…');

const stuck = computePipelineHealth(base({ ownerStatus: 'live', recovery: { ...stopped, stopRequestedAt: new Date(NOW - STOP_GRACE_MS - 5000).toISOString() } }));
check('still running 45 s after Stop: that is the error', stuck.overall, 'error');
check('...on the server gate, saying the stop did not take', stuck.primaryError?.gate === 'server' && /still running/.test(stuck.primaryError!.message), true);

const fault = computePipelineHealth(base({ events: teardown, recovery: { desiredStopped: false, stopRequestedAt: null } }));
check('a fault stop (no operator stop) still reads as an error', fault.overall, 'error');

// THE WORDS (docs/STATUS_MAP.md): a stopped stream's server is not "stopped"
const sh = (f: any) => computePipelineHealth(base({ recovery: stopped, fleet: f })).gates[0]
check('stopped, one server runs everything: NOT CONNECTED', sh({ serversUp: 1, single: true }).badge, 'NOT CONNECTED')
check('stopped, a shared pool is running: UNASSIGNED', sh({ serversUp: 3, single: false }).badge, 'UNASSIGNED')
check('stopped, no server running: NO SERVER', sh({ serversUp: 0, single: false }).badge, 'NO SERVER')
check('the input of a stopped stream with a source: NOT CONNECTED', h.gates.find(g => g.gate === 'input')!.badge, 'NOT CONNECTED')
check('running and reporting: the server is READY', computePipelineHealth(base({ ownerStatus: 'live', runStartedAt: NOW - 30000, lastReportAt: NOW - 5000, events: [ev('channel.start', 25)] })).gates[0].badge, 'READY')
const lost = computePipelineHealth(base({ ownerStatus: 'live', runStartedAt: NOW - 600000, lastReportAt: NOW - 120000, events: [ev('channel.start', 590)] }))
check('running but silent for two minutes: CONNECTION LOST', [lost.gates[0].badge, lost.overall].join(), 'CONNECTION LOST,error')

const restarted = computePipelineHealth(base({ ownerStatus: 'live', runStartedAt: NOW - 3000, events: [ev('channel.start', 2)],
  recovery: { desiredStopped: true, stopRequestedAt: new Date(NOW - 60_000).toISOString() } }));
check('a stop from before the run now in progress does not apply', restarted.overall !== 'stopped', true);

console.log(`\nstop-intent.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
