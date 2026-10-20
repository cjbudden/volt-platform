/**
 * Ad breaks and graphics: the break is one signal, and nothing of ours is on
 * screen during it. Server triggers (graphicTriggers.ts) and the player's
 * reading of them (volt-player/src/sdk/triggers.ts). Pure.
 * Run: npx tsx test/fast-graphics.check.ts
 */
import { buildTriggers, hlsTag, dashEvent, resolveGraphics, triggersFor, type ScheduleItem } from '../src/services/graphicTriggers';
import { fromHlsRegions, fromDashRegion, adBreakAt, activeAt } from '../../volt-player/src/sdk/triggers';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));
const T = (s: string) => new Date(`2026-10-20T${s}Z`);

const progs: ScheduleItem[] = [
  { id: 'p1', title: 'Film A', startsAt: T('10:00:00'), endsAt: T('11:45:00') },
  { id: 'p2', title: 'Film B', startsAt: T('11:45:00'), endsAt: T('13:30:00') },
];
const g = resolveGraphics({});
const plain = buildTriggers(progs, g);
const up1 = plain.find((t) => t.id === 'up-next:p1')!;
ok(up1.start.getTime() === T('11:43:00').getTime(), 'without breaks: Up next 2 min before the end');

// FAST: a 2 min break at the end of Film A (between programmes)
const breaks = [{ id: 'b-end', start: T('11:43:00'), durationSec: 120, source: 'fast' }];
const tr = buildTriggers(progs, g, breaks);
const up = tr.find((t) => t.id === 'up-next:p1')!;
ok(up.start.getTime() + up.durationSec! * 1000 <= T('11:43:00').getTime(), `Up next moved to finish before the break (${up.start.toISOString().slice(11, 19)})`);
const brk = tr.find((t) => t.graphic === 'ad-break')!;
ok(!!brk && brk.id === 'brk:b-end' && brk.cls === 'com.boomlabs.volt.ad' && brk.durationSec === 120, 'an ad-break trigger for the break');
const line = hlsTag(brk);
ok(line.includes('X-GRAPHIC="ad-break"') && line.includes('X-HIDE-GRAPHICS="all"') && line.includes('X-BREAK="b-end"') && line.includes('DURATION=120.000'), 'HLS: DATERANGE with the hide flag');
const de = dashEvent(brk);
ok(de.schemeIdUri === 'urn:com:boomlabs:volt:ad:2026' && de.value === 'ad-break' && JSON.parse(de.messageData)['hide-graphics'] === 'all', 'DASH: its own scheme, JSON payload');

// two breaks back to back where the card would go: it moves before both
const two = buildTriggers(progs, g, [{ id: 'm', start: T('11:41:00'), durationSec: 120 }, { id: 'e', start: T('11:43:00'), durationSec: 120 }]);
const up2 = two.find((t) => t.id === 'up-next:p1')!;
ok(up2.start.getTime() + 12_000 <= T('11:41:00').getTime(), 'moved past every break in the way');

// too close to the programme start: no card
const shortP: ScheduleItem[] = [{ id: 's', title: 'Short', startsAt: T('10:00:00'), endsAt: T('10:04:00') }, { id: 'n', title: 'Next', startsAt: T('10:04:00'), endsAt: T('11:00:00') }];
const sp = buildTriggers(shortP, { upNext: { enabled: true, leadSec: 60, durationSec: 12 } }, [{ id: 'x', start: T('10:00:30'), durationSec: 200 }]);
ok(!sp.some((t) => t.id === 'up-next:s'), 'no room before the break: no card at all, rather than one during it');

// a break that keeps graphics up (sponsored): not moved, flag says none
const keep = buildTriggers(progs, g, [{ id: 'sp', start: T('11:43:00'), durationSec: 120, hideGraphics: false }]);
ok(keep.find((t) => t.id === 'up-next:p1')!.start.getTime() === T('11:43:00').getTime(), 'a keep-graphics break does not move the card');
ok(hlsTag(keep.find((t) => t.graphic === 'ad-break')!).includes('X-HIDE-GRAPHICS="none"'), 'and says so');
ok(triggersFor(tr, T('11:42:00'), T('11:44:00')).some((t) => t.graphic === 'ad-break'), 'the break is inside a window that overlaps it');

// ---- the player ---------------------------------------------------------------
// Shaka HLS splits a DATERANGE into one region per attribute
const regions = ['ID', 'X-ID', 'X-GRAPHIC', 'X-BREAK', 'X-HIDE-GRAPHICS'].map((k) => ({
  startTime: 100, endTime: 220, metadataType: 'com.boomlabs.volt.ad',
  payload: { key: k, data: ({ ID: 'brk:b-end', 'X-ID': 'brk:b-end', 'X-GRAPHIC': 'ad-break', 'X-BREAK': 'b-end', 'X-HIDE-GRAPHICS': 'all' } as any)[k] },
}));
const gs = fromHlsRegions(regions);
ok(gs.length === 1 && gs[0].graphic === 'ad-break' && gs[0].data.hide_graphics === 'all', 'player: HLS regions regrouped into one ad-break');
const upG = { id: 'up', graphic: 'up-next', start: 90, end: 102, data: { title: 'Film B' } };
const all = [...gs, upG];
ok(adBreakAt(all, 150)?.data.break === 'b-end' && adBreakAt(all, 95) === null && adBreakAt(all, 230) === null, 'player: in the break at 150 s, not before or after');
ok(activeAt(all, 101).length === 2 && adBreakAt(all, 101) !== null, 'overlap at 101 s: the player knows a break is on, so it draws only the break');
const keepG = fromHlsRegions(regions.map((r) => (r.payload.key === 'X-HIDE-GRAPHICS' ? { ...r, payload: { key: r.payload.key, data: 'none' } } : r)));
ok(adBreakAt(keepG, 150) === null, 'player: a keep-graphics break does not hide anything');
const dashG = fromDashRegion({ schemeIdUri: 'urn:com:boomlabs:volt:ad:2026', value: 'ad-break', startTime: 10, endTime: 40, id: 'brk:x', eventElement: { getAttribute: () => '{&quot;graphic&quot;:&quot;ad-break&quot;,&quot;break&quot;:&quot;x&quot;,&quot;hide-graphics&quot;:&quot;all&quot;}' } });
ok(!!dashG && dashG.graphic === 'ad-break' && adBreakAt([dashG], 20)?.data.break === 'x', 'player: the DASH event (one per period) reads the same');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
