// ============================================================================
//  FAILURE DIAGNOSIS — the QC report says what it thinks went wrong.
//
//  One fixture per cause. Each pins: the verdict an operator reads, the gate
//  it is attributed to, that the raw line is carried as evidence, and what
//  the retry note says about auto connect. Pure: no database, no ffmpeg.
//
//  Usage: npx tsx test/failure-diagnosis.check.ts
// ============================================================================
import { diagnoseFailure, eventLine } from '../src/services/failureDiagnosis';
import type { Gate } from '../src/services/pipelineHealth';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

const gates = (failed: string, detail: string): Gate[] => ([
  { gate: 'server', label: 'Server', status: failed === 'server' ? 'failed' : 'healthy', detail: failed === 'server' ? detail : 'up', billable: true },
  { gate: 'input', label: 'Input', status: failed === 'input' ? 'failed' : 'starting', detail: failed === 'input' ? detail : '', billable: false },
  { gate: 'encoder', label: 'Encoder', status: failed === 'encoder' ? 'failed' : 'idle', detail: failed === 'encoder' ? detail : '', billable: false },
  { gate: 'output', label: 'Output', status: 'idle', detail: 'no output', billable: false },
  { gate: 'public', label: 'On air', status: 'idle', detail: 'off air', billable: false },
]);
const primary = (gate: 'server' | 'input' | 'encoder', message: string) => ({ gate, label: gate, message });

// ---- healthy: nothing to say ----------------------------------------------
check('a healthy pipeline has no diagnosis',
      diagnoseFailure({ gates: gates('', ''), primaryError: null, eventLines: [], logLines: [] }), null);

// ---- one fixture per cause --------------------------------------------------
const cases: { name: string; gate: 'server' | 'input' | 'encoder'; line: string; verdict: string; wantGate: string }[] = [
  { name: 'refused', gate: 'input', line: 'input.error: Connection refused', verdict: 'Source refused the connection', wantGate: 'input' },
  { name: 'dns', gate: 'input', line: 'getaddrinfo ENOTFOUND stream.example', verdict: 'Source hostname does not resolve', wantGate: 'input' },
  { name: 'timeout', gate: 'input', line: 'Connection timed out', verdict: 'Source is unreachable', wantGate: 'input' },
  { name: 'auth', gate: 'input', line: 'Server returned 401 Unauthorized', verdict: 'Source rejected the credentials', wantGate: 'input' },
  { name: '404', gate: 'input', line: 'Server returned 404 Not Found', verdict: 'Source path was not found', wantGate: 'input' },
  { name: 'undecodable', gate: 'input', line: 'Invalid data found when processing input', verdict: 'Source is reachable but not decodable', wantGate: 'input' },
  { name: 'port', gate: 'encoder', line: 'bind failed: Address already in use', verdict: 'A port the encoder needs is already in use', wantGate: 'encoder' },
  { name: 'disk', gate: 'encoder', line: 'file_failure: No space left on device', verdict: 'The encoder could not write its output', wantGate: 'encoder' },
  { name: 'packager', gate: 'encoder', line: 'channel.stop: packager exited', verdict: 'The packager failed', wantGate: 'encoder' },
  { name: 'killed', gate: 'server', line: 'channel.stop: encoder exited rc=-9', verdict: 'The encoder process was killed', wantGate: 'server' },
  { name: 'exit', gate: 'encoder', line: 'channel.stop: ffmpeg exited rc=1', verdict: 'The encoder exited with an error', wantGate: 'encoder' },
  { name: 'no source', gate: 'input', line: 'this channel has no source configured', verdict: 'No input source is configured', wantGate: 'input' },
];
for (const c of cases) {
  const d = diagnoseFailure({
    gates: gates(c.gate, c.line), primaryError: primary(c.gate, c.line), eventLines: [c.line], logLines: [],
  });
  check(`${c.name}: verdict`, d?.verdict, c.verdict);
  check(`${c.name}: gate`, d?.gate, c.wantGate);
  truthy(`${c.name}: the raw line is carried as evidence`, d?.evidence.includes(c.line));
}

// ---- a specific cause outranks a generic one --------------------------------
const both = diagnoseFailure({
  gates: gates('input', 'exited rc=1'), primaryError: primary('input', 'exited rc=1'),
  eventLines: ['channel.stop: ffmpeg exited rc=1'], logLines: ['[tcp @ 0x1] Connection refused'],
});
check('"connection refused" in the log outranks a bare exit code', both?.verdict, 'Source refused the connection');
check('and the same line twice raises confidence to high',
      diagnoseFailure({ gates: gates('input', 'Connection refused'), primaryError: primary('input', 'Connection refused'),
                        eventLines: ['input.error: Connection refused'], logLines: [] })?.confidence, 'high');

// ---- no pattern: the gate's own words, low confidence -----------------------
const unknown = diagnoseFailure({
  gates: gates('encoder', 'something odd happened'), primaryError: primary('encoder', 'something odd happened'),
  eventLines: [], logLines: [],
});
check('an unrecognised fault keeps the gate detail as the reason', unknown?.reason, 'something odd happened');
check('at low confidence', unknown?.confidence, 'low');

// ---- the retry note reflects auto connect ----------------------------------
const base = { gates: gates('input', 'Connection refused'), primaryError: primary('input', 'Connection refused'), eventLines: [], logLines: [] };
check('not armed: says nothing will retry',
      diagnoseFailure({ ...base, recovery: { autoConnect: true, armed: false } })?.retry.willRetry, false);
truthy('and says why',
       /not armed/.test(diagnoseFailure({ ...base, recovery: { autoConnect: true, armed: false } })?.retry.note ?? ''));
check('armed and within budget: will retry',
      diagnoseFailure({ ...base, recovery: { autoConnect: true, armed: true, attempts: 1, maxAttempts: 5 } })?.retry.willRetry, true);
check('switched off by hand: will not',
      diagnoseFailure({ ...base, recovery: { autoConnect: false, armed: true } })?.retry.willRetry, false);
check('gave up: will not',
      diagnoseFailure({ ...base, recovery: { autoConnect: true, armed: true, gaveUp: true, attempts: 5 } })?.retry.willRetry, false);

// ---- eventLine pulls words out of any detail shape --------------------------
check('eventLine: object detail', eventLine({ type: 'channel.stop', detail: { reason: 'exited rc=1' } }), 'channel.stop: exited rc=1');
check('eventLine: json string detail', eventLine({ type: 'input.error', detail: '{"message":"Connection refused"}' }), 'input.error: Connection refused');
check('eventLine: plain string detail', eventLine({ type: 'x', detail: 'y' }), 'x: y');

console.log(`failure-diagnosis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
