// ============================================================================
//  THE CAPTIONS LANE (pipelineHealth.ts captionsLane): live captions in QC.
//
//  From the encoder's caption.status / caption.error events for the current
//  run: starting, healthy (cues being written), degraded (windows skipped
//  after cues were flowing), failed (cannot start or never produced),
//  stopped. A side lane: failed captions never make the channel red.
//
//  Usage: npx tsx test/captions-lane.check.ts
// ============================================================================
import { computePipelineHealth, captionsLane, type HealthInput } from '../src/services/pipelineHealth';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  if (got === want) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(want)}] got [${String(got)}]`); fail++ }
};
const NOW = Date.now();
const ev = (type: string, secsAgo: number, detail: any = {}) => ({ type, detail, ts: new Date(NOW - secsAgo * 1000).toISOString(), seq: null } as any);
const start = ev('caption.status', 50, { state: 'starting', engine: 'whisper', langs: ['en', 'ms'], chunk_sec: 8 });
const producing = ev('caption.status', 40, { state: 'producing', langs: ['en', 'ms'] });

check('no caption events: no lane', captionsLane([ev('channel.start', 60)], true), null);
let l = captionsLane([start, ev('channel.start', 60)], true)!;
check('starting', l.status, 'starting');
check('...names the engine', l.engine, 'whisper');
check('...and languages', l.languages.join(), 'en,ms');
l = captionsLane([producing, start], true)!;
check('producing is healthy', l.status, 'healthy');
check('...detail lists the languages', l.detail, 'writing captions (en, ms)');
l = captionsLane([ev('caption.error', 30, { stage: 'transcribe', reason: 'CUDA out of memory', count: 3 }), producing, start], true)!;
check('transcribe errors after producing: degraded', l.status, 'degraded');
check('...with the count', l.errors, 3);
l = captionsLane([ev('caption.status', 20, { state: 'producing', langs: ['en', 'ms'], recovered: true, errors: 3 }), ev('caption.error', 30, { stage: 'transcribe', reason: 'x', count: 3 }), producing, start], true)!;
check('recovered: healthy again', l.status, 'healthy');
check('...says it recovered', l.detail.includes('recovered'), true);
l = captionsLane([ev('caption.error', 45, { stage: 'init', reason: 'no GLADIA_API_KEY', hint: 'set GLADIA_API_KEY for the gladia engine, or use whisper' }), ev('caption.status', 50, { state: 'starting', engine: 'gladia', langs: ['en'] })], true)!;
check('init error: failed', l.status, 'failed');
check('...with the stage', l.stage, 'init');
check('...and the hint', l.hint?.startsWith('set GLADIA_API_KEY'), true);
l = captionsLane([ev('caption.error', 45, { stage: 'transcribe', reason: 'model crashed', count: 1 }), start], true)!;
check('transcribe error before anything was produced: failed', l.status, 'failed');
check('not live: stopped', captionsLane([producing, start], false)!.status, 'stopped');

// Through the whole model: a failed lane does not make the channel red, and
// only the current run counts.
const base = (over: Partial<HealthInput>): HealthInput => ({
  ownerStatus: 'live', st: { packager_ok: true, output_available: true, active_source: 'primary', sources: { primary: { state: 'up' } } },
  events: [], logTailErrors: [], hasPrimarySource: true, packagingLabel: 'HLS', outputFresh: true, outputAgeMs: 1000, onAirPublished: true, ...over,
});
const h = computePipelineHealth(base({ events: [ev('caption.error', 30, { stage: 'init', reason: 'no key' }), ev('caption.status', 35, { state: 'starting', engine: 'gladia' }), ev('channel.start', 60)] }));
check('health carries the lane', h.captions?.status, 'failed');
check('failed captions leave the channel on air', h.overall, 'onair');
check('...with no primary error from captions', h.primaryError, null);
const h2 = computePipelineHealth(base({ events: [ev('channel.start', 20), ev('caption.error', 30, { stage: 'init', reason: 'old run' }), ev('channel.start', 60)] }));
check("a previous run's caption error is not this run's lane", h2.captions ?? null, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
