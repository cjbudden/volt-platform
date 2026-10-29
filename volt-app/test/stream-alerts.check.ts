// ============================================================================
//  STREAM ALERTS: which encoder events reach the admins' inbox and email.
//  Usage: npx tsx test/stream-alerts.check.ts (no database needed)
// ============================================================================
import { alertFor } from '../src/services/streamAlerts';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };

ok(alertFor('Berita', 'channel', { type: 'channel.stop', detail: { reason: 'exited rc=137' } }, { wasLive: true })?.topic === 'stream.encoder_died', 'an encoder that stops while live alerts');
ok(alertFor('Berita', 'channel', { type: 'channel.stop', detail: { reason: 'operator_stop' } }, { wasLive: false }) === null, 'an operator stop does not');
ok(alertFor('Berita', 'channel', { type: 'input.error', detail: { message: '404 Not Found' } })?.body.includes('404'), 'a source that cannot be read alerts, with the reason');
const f = alertFor('Berita', 'channel', { type: 'filler.engaged', detail: {} });
ok(f?.topic === 'stream.on_filler' && f.delayMs === 60000, 'all sources lost alerts only after a minute on the slate');
ok(alertFor('Berita', 'channel', { type: 'output.timeline', detail: { state: 'fault', faults: [{ code: 'timeline_backwards', message: 'went back' }] } })?.topic === 'stream.output_timing', 'the output going back in time alerts');
ok(alertFor('Berita', 'channel', { type: 'output.timeline', detail: { state: 'fault', faults: [{ code: 'index_misaligned', message: 'x' }] } }) === null, 'misaligned boundaries alone stay in the console');
ok(alertFor('Berita', 'channel', { type: 'output.timeline', detail: { state: 'ok' } }) === null, 'a cleared verdict does not alert');
ok(alertFor('Berita', 'channel', { type: 'source.up' }) === null, 'routine events do not alert');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
