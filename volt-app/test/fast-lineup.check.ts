/**
 * FAST lineup engine + break planning. Pure, no database.
 * Run: npx tsx test/fast-lineup.check.ts
 */
import {
  planLineup, rotationMath, everyForPlays, repeatReport, nominalLength, rebase, gridPad, shuffleOrder, episodesOf,
  type AssetInfo, type Lineup,
} from '../src/services/fast/lineup';
import { planBreaks, resolveAdPolicy, achievedLoad, DEFAULT_AD_POLICY } from '../src/services/fast/adPlan';
import { localTimeOf } from '../src/services/epgRepeat';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

const H = 3600;
const HMS = 3600_000;
const Z = 'Australia/Brisbane'; // no DST, so clock arithmetic in the checks is plain
const film = (id: string, title: string, min: number, extra: Partial<AssetInfo> = {}): AssetInfo => ({ id, title, durationSec: min * 60, ...extra });
const lib = (...a: AssetInfo[]) => new Map(a.map((x) => [x.id, x]));
const at = (iso: string) => new Date(iso);

// ---- HBO-style 14 hour free-running lineup over a week ------------------------
// Seven films of exactly two hours = a 14 hour run order.
const films = Array.from({ length: 7 }, (_, i) => film(`f${i}`, `Film ${i + 1}`, 120));
const assets = lib(...films);
const epoch = at('2026-10-19T06:00:00+10:00'); // Monday 06:00 Brisbane
const hbo: Lineup = { epoch, zone: Z, slots: films.map((f, i) => ({ id: `s${i}`, kind: 'title', pool: [{ assetId: f.id }] })) };
const week = planLineup(hbo, assets, epoch, new Date(epoch.getTime() + 7 * 86400_000));
ok(week.programmes.length === 84, `a 14h lineup fills a week with 84 two-hour films (got ${week.programmes.length})`);
ok(week.programmes.every((p, i, a) => i === 0 || p.start.getTime() === a[i - 1].end.getTime()), 'back to back, no gaps or overlaps');
const f1 = week.programmes.filter((p) => p.assetId === 'f0').map((p) => localTimeOf(p.start, Z));
ok(f1.length === 12, `Film 1 airs 12 times (168h / 14h) (got ${f1.length})`);
ok(f1.slice(0, 4).join() === '06:00,20:00,10:00,00:00', `start times walk round the clock: ${f1.slice(0, 4).join()}`);
ok(new Set(f1).size === 12, `twelve distinct clock times over the week (got ${new Set(f1).size})`);

const math = rotationMath(14 * H);
ok(math.passesPerWeek === 12 && math.dailyShiftMin === -600, `rotation maths: 12 passes, 10h earlier each day (got ${math.passesPerWeek}, ${math.dailyShiftMin})`);
ok(math.distinctClockTimes.length === 12 && math.warnings.length === 0, '12 distinct clock times, no warnings');
ok(rotationMath(12 * H).warnings.some((w) => w.includes('same time every day')), '12h lineup warns: same time every day');
ok(rotationMath(13 * H).warnings.some((w) => w.includes('does not divide the week')), '13h lineup warns: next week starts elsewhere');
const none = rotationMath(0);
ok(none.lengthSec === 0 && none.passesPerWeek === 0 && none.distinctClockTimes.length === 0 && none.warnings.length === 0,
  `an empty run order has no pass: 0 passes, no clock times, no warnings (got ${none.passesPerWeek} passes, ${none.warnings.length} warnings)`);
ok(everyForPlays(14 * H, 4) === 3, 'four plays a week from a 14h lineup = every third pass');
ok(nominalLength(hbo, assets) === 14 * H, 'nominal length = 14h');

// On a grid the pass is as long as the guide makes it, not the content alone
// (1.14-G5c): three short episodes and a film on a half-hour grid is two hours.
{
  const sec = (id: string, title: string, s: number, extra: Partial<AssetInfo> = {}): AssetInfo => ({ id, title, durationSec: s, ...extra });
  const shortLib = lib(
    sec('e1', 'One', 48, { series: 'Kitchens', season: 1, episode: 1 }), sec('e2', 'Two', 52, { series: 'Kitchens', season: 1, episode: 2 }),
    sec('e3', 'Three', 50, { series: 'Kitchens', season: 1, episode: 3 }), sec('fv', 'Valley', 64));
  const slots: Lineup['slots'] = [{ id: 'a', kind: 'series', series: 'Kitchens', count: 3, order: 'sequential' }, { id: 'b', kind: 'title', pool: [{ assetId: 'fv' }] }];
  const free: Lineup = { epoch, zone: Z, slots };
  ok(nominalLength(free, shortLib) === 214, `no grid: one pass is the content, 214 s (got ${nominalLength(free, shortLib)})`);
  const grid: Lineup = { ...free, gridMin: 30 };
  const len = nominalLength(grid, shortLib);
  ok(len === 2 * H, `half-hour grid: one pass is four half hours, 2h (got ${len} s)`);
  const shortWeek = planLineup(grid, shortLib, epoch, new Date(epoch.getTime() + 86400_000));
  const firstPassEnd = shortWeek.programmes[3].end.getTime() - shortWeek.programmes[0].start.getTime();
  ok(firstPassEnd === len * 1000, `the planned guide agrees: the first pass takes ${firstPassEnd / 1000} s`);
  ok(rotationMath(len).passesPerWeek === 84, `84 passes a week on the grid (got ${rotationMath(len).passesPerWeek})`);
  const g15: Lineup = { ...free, slots: [...slots, { id: 'c', kind: 'series', series: 'Kitchens', count: 1, order: 'sequential', encoreOf: 'a' }], gridMin: 15 };
  ok(nominalLength(g15, shortLib) === 105 * 60, `an encore of the series counts on the grid too: 7 x 15 min (got ${nominalLength(g15, shortLib)} s)`);
}

const rep = repeatReport(week.programmes, Z);
ok(rep.length === 7 && rep[0].plays === 12 && rep[0].sameTimeRepeats === 0, 'repeat report: 7 titles, 12 plays, no same-clock repeats');
ok(rep.every((r) => r.minGapHours === 14), 'repeat report: plays are 14h apart');

// ---- rotation pools, drops and every-N ---------------------------------------
const pool = lib(...films, film('alt1', 'Alt A', 120), film('alt2', 'Alt B', 100));
const rot: Lineup = {
  ...hbo,
  slots: [
    { id: 'a', kind: 'title', pool: [{ assetId: 'f0' }, { assetId: 'alt1' }, { assetId: 'alt2' }] },
    { id: 'b', kind: 'title', pool: [{ assetId: 'f1' }, { skip: true }] },
    { id: 'c', kind: 'title', pool: [{ assetId: 'f2' }], every: 3 },
    { id: 'd', kind: 'title', pool: [{ assetId: 'f3' }] },
  ],
};
const r = planLineup(rot, pool, epoch, new Date(epoch.getTime() + 3 * 86400_000));
const byCycle = (c: number) => r.programmes.filter((p) => p.cycle === c).map((p) => p.assetId).join();
ok(byCycle(0) === 'f0,f1,f2,f3', `pass 0: f0,f1,f2,f3 (got ${byCycle(0)})`);
ok(byCycle(1) === 'alt1,f3', `pass 1: pool rotates to Alt A, slot b drops, slot c rests (got ${byCycle(1)})`);
ok(byCycle(2) === 'alt2,f1,f3', `pass 2: Alt B, b back (got ${byCycle(2)})`);
ok(byCycle(3) === 'f0,f2,f3', `pass 3: back to f0, c plays again on its third pass (got ${byCycle(3)})`);

// cycle shift: the run order rotates one slot each pass
const sh = planLineup({ ...hbo, cycleShift: 1 }, assets, epoch, new Date(epoch.getTime() + 30 * HMS));
ok(sh.programmes.filter((p) => p.cycle === 1)[0].assetId === 'f1', 'cycle shift 1: pass 1 opens with the second slot');

// ---- rights windows and backfill ---------------------------------------------
const rights = lib(
  film('x', 'Expiring', 120, { availableUntil: at('2026-10-20T00:00:00+10:00') }),
  film('y', 'Steady', 90),
  film('bf1', 'Backfill 118', 118), film('bf2', 'Backfill 60', 60),
);
const rr = planLineup({ epoch, zone: Z, slots: [{ id: 'x', kind: 'title', pool: [{ assetId: 'x' }] }, { id: 'y', kind: 'title', pool: [{ assetId: 'y' }] }], backfill: ['bf2', 'bf1'] }, rights, epoch, new Date(epoch.getTime() + 2 * 86400_000));
const late = rr.programmes.filter((p) => p.start >= at('2026-10-20T00:00:00+10:00') && p.slotId === 'x');
ok(late.length > 0 && late.every((p) => p.assetId === 'bf1' && p.note === 'backfill'), 'after its rights end, the slot takes the closest-length backfill');
ok(rr.notices.some((n) => n.message.includes('outside its rights window')), 'a notice says why');

// ---- series: in order, continuing across passes ------------------------------
const eps = Array.from({ length: 5 }, (_, i) => film(`e${i}`, `Ep ${i + 1}`, 30, { series: 'Blue Heelers', season: 1, episode: i + 1 }));
const ser = lib(...eps, ...films);
ok(episodesOf('blue heelers', ser).map((e) => e.id).join() === 'e0,e1,e2,e3,e4', 'episodes found case-insensitively, in order');
const sl: Lineup = {
  epoch, zone: Z,
  slots: [
    { id: 'm', kind: 'title', pool: [{ assetId: 'f0' }] },
    { id: 'bh', kind: 'series', series: 'Blue Heelers', count: 2, order: 'sequential', atEnd: 'loop' },
  ],
};
const sp = planLineup(sl, ser, epoch, new Date(epoch.getTime() + 12 * HMS));
const seq = sp.programmes.filter((p) => p.slotId === 'bh').map((p) => p.assetId).join();
ok(seq.startsWith('e0,e1,e2,e3,e4,e0,e1'), `two episodes a pass, continuing, then back to episode 1 (got ${seq})`);
ok(new Set(sp.programmes.map((p) => p.key)).size === sp.programmes.length, 'every planned programme has a unique key');

// stop at the end
const stop = planLineup({ ...sl, slots: [sl.slots[0], { ...(sl.slots[1] as any), atEnd: 'stop' }] }, ser, epoch, new Date(epoch.getTime() + 20 * HMS));
ok(stop.programmes.filter((p) => p.slotId === 'bh').length === 5 && stop.notices.some((n) => n.message.includes('run out')), 'atEnd stop: five episodes then the slot drops out');

// encore
const enc = planLineup({ epoch, zone: Z, slots: [
  { id: 'new', kind: 'series', series: 'Blue Heelers', count: 1, order: 'sequential' },
  { id: 'f', kind: 'title', pool: [{ assetId: 'f0' }] },
  { id: 'enc', kind: 'series', series: 'Blue Heelers', count: 1, order: 'sequential', encoreOf: 'new' },
] }, ser, epoch, new Date(epoch.getTime() + 8 * HMS));
const pairs = enc.programmes.filter((p) => p.slotId !== 'f').map((p) => p.assetId).join();
ok(pairs.startsWith('e0,e0,e1,e1'), `encore replays the episode that just aired (got ${pairs})`);
ok(enc.programmes.find((p) => p.slotId === 'enc')?.note === 'encore', 'marked as an encore');

// shuffle: every pass is a permutation, no back-to-back repeat at the join
let good = true;
for (let pss = 0; pss < 20; pss++) {
  const o = shuffleOrder(6, 'seed', pss);
  if ([...o].sort().join() !== '0,1,2,3,4,5') good = false;
  if (pss > 0 && o[0] === shuffleOrder(6, 'seed', pss - 1)[5]) good = false;
}
ok(good, 'shuffle: each pass a full permutation, never repeating across the join');
ok(shuffleOrder(6, 'seed', 3).join() === shuffleOrder(6, 'seed', 3).join(), 'shuffle is deterministic');

// ---- anchor: restart every day at 06:00 --------------------------------------
const an = planLineup({ ...hbo, anchor: '06:00' }, assets, epoch, new Date(epoch.getTime() + 3 * 86400_000));
const sixes = an.programmes.filter((p) => localTimeOf(p.start, Z) === '06:00');
ok(sixes.length === 3 && sixes.every((p) => p.assetId === 'f0'), 'anchored: Film 1 opens every day at 06:00');
ok(an.programmes.every((p, i, a) => i === 0 || p.start.getTime() === a[i - 1].end.getTime()), 'anchored: still no gaps (the last item before the anchor is padded)');
const f130 = films.map((f) => ({ ...f, durationSec: 130 * 60 }));
const an2 = planLineup({ ...hbo, anchor: '06:00' }, lib(...f130), epoch, new Date(epoch.getTime() + 3 * 86400_000));
const padded = an2.programmes.find((p) => p.padSec > 0);
ok(an2.programmes.filter((p) => localTimeOf(p.start, Z) === '06:00').every((p) => p.assetId === 'f0'), '130 min films, anchored: still Film 1 at 06:00 each day');
ok(!!padded && localTimeOf(padded.end, Z) === '06:00', `the programme before 06:00 is padded to it (pad ${padded?.padSec}s)`);
ok(padded?.padSec === 600, '11 x 130 min = 23h50: ten minutes of pad');

// ---- grid rounding -----------------------------------------------------------
ok(gridPad(at('2026-10-19T08:47:10+10:00'), 15, Z) === 770, '08:47:10 pads 770s to 09:00 on a 15 min grid');
ok(gridPad(at('2026-10-19T09:00:00+10:00'), 30, Z) === 0, 'on the grid already: no pad');
const odd = lib(film('o1', 'Odd 97', 97), film('o2', 'Odd 83', 83));
const gr = planLineup({ epoch, zone: Z, gridMin: 15, slots: [{ id: 'o1', kind: 'title', pool: [{ assetId: 'o1' }] }, { id: 'o2', kind: 'title', pool: [{ assetId: 'o2' }] }] }, odd, epoch, new Date(epoch.getTime() + 10 * HMS));
ok(gr.programmes.every((p) => [0, 15, 30, 45].includes(Number(localTimeOf(p.start, Z).slice(3, 5)))), 'every programme starts on the 15 minute grid');
ok(gr.programmes[0].padSec === 8 * 60, `97 min pads 8 min to 1h45 (got ${gr.programmes[0].padSec}s)`);

// ---- breaks ------------------------------------------------------------------
const pol = resolveAdPolicy({ enabled: true, loadMinPerHour: 8, breakSec: 120, betweenSec: 60 });
const b = planBreaks(100 * 60, [], pol, 2);
const mids = b.filter((x) => x.position === 'mid');
ok(mids.length === 6 && b[b.length - 1].position === 'end', `100 min film: 6 two-minute mid breaks + between (got ${mids.length})`);
ok(mids.every((x) => x.atAssetSec % 2 === 0), 'breaks snap to 2s segment boundaries');
ok(mids.every((x, i) => i === 0 || x.atAssetSec - mids[i - 1].atAssetSec >= 600), 'at least 10 min apart');
ok(mids[0].atAssetSec >= 480 && mids[mids.length - 1].atAssetSec <= 95 * 60, 'none in the first 8 or last 5 minutes');
ok(Math.abs(achievedLoad(100 * 60, b) - 7.8) < 0.5, `achieved load about 8 min/h (got ${achievedLoad(100 * 60, b)})`);
const cued = planBreaks(60 * 60, [13 * 60 + 1, 29 * 60 + 33, 44 * 60 + 9], { ...pol, loadMinPerHour: 7 }, 2);
ok(cued.filter((x) => x.source === 'cue').map((x) => x.atAssetSec).join() === `${13 * 60},${29 * 60 + 32},${44 * 60 + 8}`, `cue points used, snapped down (got ${cued.map((x) => x.atAssetSec).join()})`);
ok(planBreaks(15 * 60, [], pol, 2).every((x) => x.position === 'end'), 'a 15 min short gets only the between break');
ok(planBreaks(60 * 60, [], DEFAULT_AD_POLICY, 2).length === 0, 'ads off: no breaks');

// breaks inside the plan: slot length = content + breaks, break start times
const adl = planLineup({ ...hbo, ads: pol }, assets, epoch, new Date(epoch.getTime() + 6 * HMS));
const p0 = adl.programmes[0];
const brk = p0.breaks.reduce((s, x) => s + x.durationSec, 0);
ok(p0.end.getTime() - p0.start.getTime() === (7200 + brk) * 1000, 'the guide slot includes the breaks');
ok(p0.breaks[0].start!.getTime() === p0.start.getTime() + p0.breaks[0].atAssetSec * 1000, 'first break starts at its asset position');
ok(p0.breaks[1].start!.getTime() === p0.start.getTime() + (p0.breaks[1].atAssetSec + p0.breaks[0].durationSec) * 1000, 'later breaks are pushed on by the ones before');
ok(p0.contentEnd.getTime() === p0.end.getTime() - p0.breaks[p0.breaks.length - 1].durationSec * 1000, 'content ends where the between break starts');

// ---- determinism + rebase ----------------------------------------------------
const w1 = planLineup(sl, ser, at('2026-10-21T00:00:00+10:00'), at('2026-10-21T12:00:00+10:00'));
const w2 = planLineup(sl, ser, at('2026-10-21T00:00:00+10:00'), at('2026-10-21T12:00:00+10:00'));
ok(JSON.stringify(w1.programmes) === JSON.stringify(w2.programmes), 'the same window plans identically every time');
const cut = at('2026-10-20T15:10:00+10:00');
const rb = rebase(sl, ser, cut);
const after = planLineup({ ...sl, ...rb }, ser, rb.epoch, new Date(rb.epoch.getTime() + 4 * HMS));
const before = planLineup(sl, ser, epoch, rb.epoch);
const lastEp = before.programmes.filter((p) => p.slotId === 'bh').pop()!;
const firstEp = after.programmes.find((p) => p.slotId === 'bh')!;
ok(rb.epoch.getTime() === cut.getTime(), 'rebase starts exactly where asked (the end of the programme on air in the guide)');
const nxt = after.programmes[0];
ok(nxt.start.getTime() === cut.getTime(), 'the carried-on plan has a programme starting right there: no hole');
ok(Number(firstEp.assetId.slice(1)) === (Number(lastEp.assetId.slice(1)) + 1) % 5, `rebase carries the series on (${lastEp.assetId} then ${firstEp.assetId})`);
const rbNew = rebase(sl, ser, cut, false);
ok(rbNew.epochSlot === 0 && rbNew.epochCycle > 0, 'a new version starts its own run order from the top, on the next pass');

// ---- empty and broken lineups ------------------------------------------------
ok(planLineup({ epoch, zone: Z, slots: [] }, assets, epoch, new Date(epoch.getTime() + H)).notices[0].message.includes('no slots'), 'empty lineup: a notice, no crash');
const dead = planLineup({ epoch, zone: Z, slots: [{ id: 'z', kind: 'title', pool: [{ skip: true }] }] }, assets, epoch, new Date(epoch.getTime() + H));
ok(dead.programmes.length === 0 && dead.notices.some((n) => n.message.includes('Nothing in the lineup')), 'all-skip lineup terminates with a notice');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
