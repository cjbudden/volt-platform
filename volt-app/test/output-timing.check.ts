// ============================================================================
//  THE NEGATIVE STATES ARE VISIBLE: an output timing fault and NO SOURCE.
//
//  23 Oct 2026: sound out of step with the picture, every gate green. The
//  encoder now reports output.timeline (bin/output_check.py) and source.waiting;
//  this checks the five gates turn them into something an operator sees, and
//  that a timing fault is NOT mistaken for "on air with no content".
//  Usage: npx tsx test/output-timing.check.ts
// ============================================================================
import { computePipelineHealth, type HealthInput } from '../src/services/pipelineHealth';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (got === want) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`); fail++ }
};
const NOW = Date.now();
const ev = (type: string, secsAgo: number, detail: any = {}) => ({ type, detail, ts: new Date(NOW - secsAgo * 1000).toISOString(), seq: null } as any);
const live = (over: Partial<HealthInput>): HealthInput => ({
  ownerStatus: 'live', runStartedAt: NOW - 600_000, outputFresh: true, outputAgeMs: 2000,
  st: { output_available: true, packager_ok: true, sources: { primary: { state: 'up' } }, updated_at: new Date(NOW - 3000).toISOString() },
  logTailErrors: [], hasPrimarySource: true, packagingLabel: 'HLS', events: [], ...over,
});
const gate = (h: any, g: string) => h.gates.find((x: any) => x.gate === g);

const clean = computePipelineHealth(live({ events: [ev('source.up', 500), ev('channel.start', 590)] }));
check('a clean run is ready', clean.overall, 'ready');

const msg = 'audio and video segments with the same number start 1.98s apart';
const bad = computePipelineHealth(live({ events: [ev('output.timeline', 60, { state: 'fault', message: msg }), ev('source.up', 500), ev('channel.start', 590)] }));
check('a timing fault degrades the output gate', gate(bad, 'output').status, 'degraded');
check('...with the encoder\'s own words', gate(bad, 'output').detail.includes('1.98s'), true);
check('...and the stream reads degraded', bad.overall, 'degraded');

const pub = computePipelineHealth(live({ onAirPublished: true, events: [ev('output.timeline', 60, { state: 'fault', message: msg }), ev('source.up', 500), ev('channel.start', 590)] }));
check('on air with a timing fault is NOT "no valid content"', gate(pub, 'public').status, 'healthy');

const cleared = computePipelineHealth(live({ events: [ev('output.timeline', 10, { state: 'ok', cleared: ['index_misaligned'] }), ev('output.timeline', 60, { state: 'fault', message: msg }), ev('source.up', 500), ev('channel.start', 590)] }));
check('an ok verdict clears it', gate(cleared, 'output').status, 'healthy');

const prev = computePipelineHealth(live({ runStartedAt: NOW - 30_000, events: [ev('channel.start', 25), ev('output.timeline', 700, { state: 'fault', message: msg })] }));
check('a fault from the previous run does not leak into this one', gate(prev, 'output').detail.startsWith('timing fault'), false);

const waiting = computePipelineHealth(live({ runStartedAt: NOW - 60_000, st: { output_available: false, packager_ok: true, sources: { primary: { state: 'waiting' } }, updated_at: new Date(NOW - 2000).toISOString() }, outputFresh: false, outputAgeMs: null, events: [ev('source.waiting', 40, { source: 'primary', waited_s: 20 }), ev('channel.start', 59)] }));
check('running with no source pushed has the AWAITING SOURCE badge', gate(waiting, 'input').badge, 'AWAITING SOURCE');
check('...and says it is waiting', /no source pushed yet/.test(gate(waiting, 'input').detail), true);
check('...as a state, not a failure', gate(waiting, 'input').status, 'starting');

const young = computePipelineHealth(live({ runStartedAt: NOW - 5_000, st: { output_available: false, packager_ok: true, sources: { primary: { state: 'unknown' } }, updated_at: new Date(NOW - 1000).toISOString() }, outputFresh: false, outputAgeMs: null, events: [ev('channel.start', 4)] }));
check('the first seconds of a start are not flagged', gate(young, 'input').badge, 'CONNECTING');
check('a timing fault has its own badge', gate(bad, 'output').badge, 'TIMING FAULT');

console.log(`\noutput-timing.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
