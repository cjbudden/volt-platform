// ============================================================================
//  CLEAR QC (POST /api/channels/:id/reset-health, pipelineHealth.ts).
//
//  A crash from an earlier run keeps a stopped channel red ("SERVER ERROR")
//  until it runs cleanly again. Clearing QC writes a `qc.reset` event, and the
//  health model judges the channel only on what happened after it:
//
//    * a stopped channel that crashed is red before, stopped after;
//    * the crash stays in the events (nothing is deleted), it just no longer
//      decides the gates;
//    * a fault that happens AFTER the reset is reported as normal;
//    * the ground truth still wins: a live channel whose output has stopped
//      advancing is degraded whatever was cleared.
//
//  Usage: npx tsx test/qc-reset.check.ts
// ============================================================================
import { computePipelineHealth, type HealthInput } from '../src/services/pipelineHealth';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (got === want) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`); fail++ }
};
const NOW = Date.now();
const ev = (type: string, secsAgo: number, detail: any = {}) => ({ type, detail, ts: new Date(NOW - secsAgo * 1000).toISOString(), seq: null } as any);
const base = (over: Partial<HealthInput>): HealthInput => ({
  ownerStatus: 'ended', st: null, events: [], logTailErrors: [], hasPrimarySource: true, packagingLabel: 'HLS', ...over,
});

const crash = [ev('channel.stop', 240, { reason: 'exited rc=1' }), ev('channel.start', 300)];
const before = computePipelineHealth(base({ events: crash }));
check('a crashed, stopped channel is red', before.overall, 'error');
check('...on the server gate', before.primaryError?.gate, 'server');

const after = computePipelineHealth(base({ events: [ev('qc.reset', 10), ...crash] }));
check('after Clear QC it is stopped, not red', after.overall === 'error' || after.overall === 'degraded', false);
check('...with no primary error', after.primaryError, null);
check('...and the server gate reads stopped or idle', ['stopped', 'idle'].includes(after.gates.find(g => g.gate === 'server')!.status), true);

const later = computePipelineHealth(base({ events: [ev('channel.stop', 5, { reason: 'exited rc=137' }), ev('channel.start', 8), ev('qc.reset', 60), ...crash] }));
check('a crash after the reset is reported', later.overall, 'error');
check('...with its own reason', later.primaryError?.message.includes('rc=137'), true);

const stalled = computePipelineHealth(base({
  ownerStatus: 'live', runStartedAt: NOW - 600_000, outputAgeMs: 60_000,
  st: { output_available: true, packager_ok: true, sources: { primary: { state: 'up' } } },
  events: [ev('qc.reset', 5), ev('source.up', 500), ev('channel.start', 590)],
}));
check('ground truth still wins: a live channel whose output stopped advancing is degraded', stalled.overall, 'degraded');

console.log(`\nqc-reset.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
