// ============================================================================
//  WHERE IS THE FAULT: diagnose() (volt-player/src/sdk/stats.ts), every rule.
//
//  The point of debug mode is to stop reporting viewer-side problems as
//  platform faults, so each case asserts both the side and whether it is
//  worth a report. Usage: npx tsx test/player-diagnose.check.ts
// ============================================================================
import { diagnose, statsReport, emptySample, isDebugKey, type StatsSample } from '../../volt-player/src/sdk/stats';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${JSON.stringify(d)}` : '')); } };
const S = (p: Partial<StatsSample>): StatsSample => ({ ...emptySample(), live: true, online: true, hidden: false, ...p });
const is = (p: Partial<StatsSample>, side: string, report: boolean, m: string) => {
  const d = diagnose(S(p));
  ok(d.side === side && d.report === report, m, d);
};

is({}, 'ok', false, 'a clean sample is healthy, nothing to report');
is({ server: { state: 'fault', detail: 'audio ahead' } }, 'server', true, 'the platform\'s own fault verdict is a server fault, reported');
is({ online: false }, 'local', false, 'offline is the viewer\'s side');
is({ httpStatus: 451 }, 'access', false, '451 is a rights rule, not a fault');
is({ httpStatus: 403 }, 'access', false, '403 is access (token / entitlement), not a fault');
is({ httpStatus: 404 }, 'server', true, '404 means output missing: server side, reported');
is({ httpStatus: 503 }, 'delivery', true, '5xx is delivery, reported');
is({ playlistMisses: 4 }, 'server', true, 'a live playlist that stopped advancing is server side');
is({ playlistMisses: 4, live: false }, 'ok', false, 'misses on VOD mean nothing');
is({ lastError: 'manifestIncompatibleCodecsError', errorType: 'media', errorFatal: true }, 'local', false, 'a codec the browser lacks is local');
is({ lastError: 'fragParsingError', errorType: 'media', errorFatal: true }, 'server', true, 'corrupt media is server side');
is({ lastError: 'internalException', errorType: 'other', errorFatal: true }, 'code', true, 'an internal player exception is code, reported');
is({ httpStatus: 0, errorType: 'network', errorFatal: true }, 'local', false, 'no response at all is the viewer\'s network');
is({ bandwidth: 900_000, lowestBitrate: 1_000_000 }, 'local', false, 'bandwidth under the lowest rung is local');
is({ bandwidth: 2_000_000, bitrate: 3_000_000, stalls: 2, lowestBitrate: 1_000_000 }, 'local', false, 'stalls on a connection below the playing rung are local');
is({ frames: { dropped: 300, total: 1000 } }, 'local', false, 'heavy frame drops are the device');
is({ hidden: true }, 'local', false, 'a background tab is local');
is({ stalls: 1, bandwidth: 20_000_000, bitrate: 3_000_000 }, 'ok', false, 'one recovered stall on a good line is not a report');
// priority: a server fault outranks the viewer's slow line
is({ server: { state: 'fault' }, bandwidth: 100_000, lowestBitrate: 1_000_000 }, 'server', true, 'server verdict outranks a slow connection');
// rights outrank a missing network status
is({ httpStatus: 451, errorType: 'network', errorFatal: true }, 'access', false, '451 wins over a generic network error');

const rep = statsReport(S({ httpStatus: 451 }));
ok(/Diagnosis\s+Access rules: Not available in this region/.test(rep) && /Report\s+no, not a platform fault/.test(rep), 'the copied report leads with the diagnosis and the report verdict', rep.split('\n').slice(0, 3));
const rep2 = statsReport(S({ httpStatus: 503 }));
ok(/Report\s+YES/.test(rep2), 'a delivery fault says YES to report');

// keys: Shift+D, Cmd+D, Ctrl+D; not in a text field; not Cmd+Shift+D
const k = (p: any) => isDebugKey({ key: 'd', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: null, ...p } as any);
ok(k({ key: 'D', shiftKey: true }) && k({ metaKey: true }) && k({ ctrlKey: true }), 'Shift+D, Cmd+D and Ctrl+D open debug mode');
ok(!k({}) && !k({ metaKey: true, shiftKey: true }) && !k({ metaKey: true, altKey: true }), 'plain d, Cmd+Shift+D and Cmd+Alt+D do not');
ok(!k({ metaKey: true, target: { closest: () => ({}) } }), 'never inside a text field');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
