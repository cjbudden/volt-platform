// ============================================================================
//  HTML GRAPHICS IN THE PLAYER, the pure parts:
//    volt-player/src/sdk/overlay.ts         snapshot at the playhead, merging, what came on
//    src/services/graphics/playerFeed.ts    what the server records and sends
//  Usage: npx tsx test/player-overlay.check.ts
// ============================================================================
import { snapshotAt, mergeSnapshots, cameOn, feedUrl } from '../../volt-player/src/sdk/overlay';
import { playerState, stableJson, stateAt } from '../src/services/graphics/playerFeed';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), m, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);

const S = (at: number, home: number, on = true) => ({ at, state: { sb: { on, v: on ? { homeScore: home } : {} } } });
const snaps = [S(1000, 14), S(5000, 21), S(9000, 21, false)];

console.log('== in step with the picture ==');
eq(snapshotAt(snaps, 999), null, 'before the first snapshot: nothing');
eq(snapshotAt(snaps, 1000)?.state.sb.v, { homeScore: 14 }, 'at a snapshot: that one');
eq(snapshotAt(snaps, 4999)?.state.sb.v, { homeScore: 14 }, 'a viewer behind live still sees 14 until their picture reaches the try');
eq(snapshotAt(snaps, 5000)?.state.sb.v, { homeScore: 21 }, 'and 21 from that moment');
eq(snapshotAt(snaps, 9500)?.state.sb.on, false, 'taken off later');
eq(snapshotAt([S(5000, 21), S(1000, 14)], 3000)?.state.sb.v, { homeScore: 14 }, 'order of arrival does not matter');

console.log('== merging ==');
const m = mergeSnapshots([S(1000, 14), S(5000, 21)], [S(5000, 21), S(9000, 21, false), { at: NaN, state: {} } as any], 6000);
eq(m.map((s) => s.at), [5000, 9000], 'deduped by time, the baseline in force at keepFrom kept, older dropped, junk ignored');
eq(mergeSnapshots([], [S(3000, 1), S(1000, 0)], 0).map((s) => s.at), [1000, 3000], 'sorted');

console.log('== impressions ==');
eq(cameOn(new Set(['a']), new Set(['a', 'b'])), ['b'], 'only what newly came on');
eq(cameOn(new Set(['a', 'b']), new Set(['a'])), [], 'going off is not an impression');
ok(/since=1234$/.test(feedUrl('https://v.example', 'pk_1', 'id', 1234.9)), 'feed url, since in whole ms');

console.log('== server state ==');
const items = [
  { id: 'p', targets: 'player', enabled: true, onAir: true, values: { a: 1 } },
  { id: 'b', targets: 'both', enabled: true, onAir: false, values: { secret: 'next score' } },
  { id: 'x', targets: 'burn', enabled: true, onAir: true, values: {} },
  { id: 'o', targets: 'player', enabled: false, onAir: true, values: {} },
];
eq(playerState(items), { p: { on: true, v: { a: 1 } }, b: { on: false, v: {} } }, 'player and both only, switched-off left out, off-air carries no values');
eq(stableJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), stableJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }), 'key order is not a change');
eq(stateAt([{ at: 1 }, { at: 5 }], 4), { at: 1 }, 'server-side stateAt agrees');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
