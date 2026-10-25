/**
 * FAST ad scheduling between content (volt/SSAI.md section 3). Pure, no database.
 * Run: npx tsx test/fast-ad-schedule.check.ts
 */
import { planLineup, type AssetInfo, type Lineup } from '../src/services/fast/lineup';
import {
  planProgrammeBreaks, resolveAdPolicy, earnedBetween, daypartAt, localClock, policyAt, adRuleOf, DEFAULT_AD_POLICY,
} from '../src/services/fast/adPlan';
import { fillBreak } from '../src/services/fast/pod';
import { localDateOf, localTimeOf } from '../src/services/epgRepeat';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));
const Z = 'Australia/Brisbane';
const at = (iso: string) => new Date(iso);
const film = (id: string, min: number, extra: Partial<AssetInfo> = {}): AssetInfo => ({ id, title: id, durationSec: min * 60, ...extra });
const lib = (...a: AssetInfo[]) => new Map(a.map((x) => [x.id, x]));
const epoch = at('2026-10-19T06:00:00+10:00'); // Monday
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---- defaults unchanged ---------------------------------------------------------
const d = resolveAdPolicy({});
ok(d.placement === 'both' && d.betweenMode === 'fixed' && d.betweenEveryMin === 0 && d.maxPerHourMin === 0 && !d.padToAds && d.dayparts.length === 0,
  'a stored policy without the new fields keeps the old behaviour');
const legacy = resolveAdPolicy({ enabled: true, loadMinPerHour: 8, breakSec: 120, betweenSec: 60 });
const lb = planProgrammeBreaks(100 * 60, [], legacy, 2).breaks;
ok(lb.filter((b) => b.position === 'mid').length === 6 && lb[lb.length - 1].position === 'end' && lb[lb.length - 1].durationSec === 60, 'both: 6 mid breaks + 60 s after a 100 min film, as before');

// ---- placement --------------------------------------------------------------------
const btw = resolveAdPolicy({ enabled: true, placement: 'between', betweenSec: 90 });
const bb = planProgrammeBreaks(100 * 60, [10 * 60, 50 * 60], btw, 2).breaks;
ok(bb.length === 1 && bb[0].position === 'end' && bb[0].durationSec === 90, 'between only: a 100 min film gets no mid breaks, one 90 s break after');
const mid = resolveAdPolicy({ enabled: true, placement: 'mid', loadMinPerHour: 8, breakSec: 120, betweenSec: 60 });
const mb = planProgrammeBreaks(100 * 60, [], mid, 2).breaks;
ok(mb.length > 0 && mb.every((b) => b.position === 'mid'), 'mid only: no break after the programme');

// ---- earned between breaks -------------------------------------------------------
const earned = resolveAdPolicy({ enabled: true, placement: 'between', betweenMode: 'earned', loadMinPerHour: 9, betweenMinSec: 30, betweenMaxSec: 240, betweenStepSec: 15 });
ok(earnedBetween(22 * 60, earned) === 195, `earned: 9 min/h on a 22 min episode = 198 s, stepped to 195 (got ${earnedBetween(22 * 60, earned)})`);
ok(earnedBetween(60 * 60, earned) === 240, 'earned: clamped to the 240 s maximum on an hour');
ok(earnedBetween(2 * 60, earned) === 30, 'earned: raised to the 30 s minimum on a 2 min short');
ok(earnedBetween(10, earned) === 0, 'earned: nothing earned on 10 s of content (rounds to 0)');

// ---- accumulation over short titles ----------------------------------------------
const shorts = Array.from({ length: 6 }, (_, i) => film(`clip${i}`, 5));
const shortLineup: Lineup = {
  epoch, zone: Z, slots: shorts.map((s, i) => ({ id: `s${i}`, kind: 'title', pool: [{ assetId: s.id }] })),
  ads: resolveAdPolicy({ enabled: true, placement: 'between', betweenMode: 'earned', loadMinPerHour: 8, betweenEveryMin: 15, betweenMinSec: 30, betweenMaxSec: 240, betweenStepSec: 15 }),
};
const sp = planLineup(shortLineup, lib(...shorts), epoch, new Date(epoch.getTime() + 3 * 3600_000));
const withBreak = sp.programmes.map((p, i) => (p.breaks.length ? i : -1)).filter((i) => i >= 0);
ok(withBreak.slice(0, 4).join(',') === '2,5,8,11', `5 min clips, 15 min minimum: a break after every 3rd clip (got ${withBreak.slice(0, 4).join(',')})`);
ok(sp.programmes[2].breaks[0].durationSec === 120, `the break earns 8 min/h on the 15 min since the last one = 120 s (got ${sp.programmes[2].breaks[0].durationSec})`);
const sp2 = planLineup(shortLineup, lib(...shorts), at('2026-10-19T07:00:00+10:00'), at('2026-10-19T08:00:00+10:00'));
const full = sp.programmes.filter((p) => p.end.getTime() > at('2026-10-19T07:00:00+10:00').getTime() && p.start.getTime() < at('2026-10-19T08:00:00+10:00').getTime());
ok(JSON.stringify(sp2.programmes.map((p) => [p.key, p.breaks.length])) === JSON.stringify(full.map((p) => [p.key, p.breaks.length])),
  'deterministic: a window planned later carries the accumulator from the epoch, same breaks as the full walk');

// ---- per-title and per-slot rules -------------------------------------------------
ok(adRuleOf({ adRule: 'none' }) === 'none' && adRuleOf({ ads: false }) === 'none' && adRuleOf({ adRule: 'between_only' }) === 'no_mid' && adRuleOf({}) === 'default', 'title ad rule read from metadata');
const free = film('kids', 30, { adRule: 'none' });
const reg = film('reg', 30);
const rl: Lineup = { epoch, zone: Z, slots: [{ id: 'a', kind: 'title', pool: [{ assetId: 'kids' }] }, { id: 'b', kind: 'title', pool: [{ assetId: 'reg' }] }], ads: legacy };
const rp = planLineup(rl, lib(free, reg), epoch, new Date(epoch.getTime() + 2 * 3600_000));
ok(rp.programmes[0].breaks.length === 0 && rp.programmes[1].breaks.length > 0, 'an ad-free title gets no breaks; the next title does');
const nm: Lineup = { ...rl, slots: [{ id: 'b', kind: 'title', pool: [{ assetId: 'reg' }], adRule: 'no_mid' }] };
const np = planLineup(nm, lib(reg), epoch, new Date(epoch.getTime() + 3600_000));
ok(np.programmes[0].breaks.length === 1 && np.programmes[0].breaks[0].position === 'end', 'a slot set to no_mid: only the break after it');
const btwAcc = resolveAdPolicy({ enabled: true, placement: 'between', betweenMode: 'earned', loadMinPerHour: 8, betweenEveryMin: 20, betweenStepSec: 15 });
const acc = planProgrammeBreaks(30 * 60, [], btwAcc, 2, { sinceBreakSec: 600, rule: 'none' });
ok(acc.breaks.length === 0 && acc.sinceBreakSec === 600, 'ad-free content neither breaks nor earns ad time');

// ---- dayparts ---------------------------------------------------------------------
const dp = resolveAdPolicy({
  enabled: true, loadMinPerHour: 6, minGapMin: 5, dayparts: [
    { label: 'Prime', from: '18:00', to: '23:00', loadMinPerHour: 12, maxPerHourMin: 14 },
    { label: 'Sat late', from: '23:00', to: '02:00', days: [6], placement: 'between' },
    { label: 'bad', from: '25:00', to: '01:00' },
  ],
});
ok(dp.dayparts.length === 2, 'an invalid daypart is dropped');
ok(localClock(at('2026-10-19T19:30:00+10:00'), Z).min === 19 * 60 + 30 && localClock(at('2026-10-19T19:30:00+10:00'), Z).dow === 1, 'local clock and ISO weekday in the zone');
ok(daypartAt(dp, at('2026-10-19T19:30:00+10:00'), Z)?.label === 'Prime', '19:30 is prime');
ok(daypartAt(dp, at('2026-10-19T23:30:00+10:00'), Z) === null, 'Monday 23:30 is not "Sat late"');
ok(daypartAt(dp, at('2026-10-24T23:30:00+10:00'), Z)?.label === 'Sat late', 'Saturday 23:30 is "Sat late"');
ok(daypartAt(dp, at('2026-10-25T01:30:00+10:00'), Z)?.label === 'Sat late', 'Sunday 01:30 still belongs to Saturday\'s late daypart');
ok(policyAt(dp, at('2026-10-19T19:30:00+10:00'), Z).loadMinPerHour === 12 && policyAt(dp, at('2026-10-19T10:00:00+10:00'), Z).loadMinPerHour === 6, 'the policy in force follows the daypart');
const films = Array.from({ length: 12 }, (_, i) => film(`f${i}`, 60));
const dl: Lineup = { epoch, zone: Z, slots: films.map((f, i) => ({ id: `s${i}`, kind: 'title', pool: [{ assetId: f.id }] })), ads: { ...dp, betweenSec: 0 } };
const dpp = planLineup(dl, lib(...films), epoch, new Date(epoch.getTime() + 24 * 3600_000));
const load = (p: any) => sum(p.breaks.map((b: any) => b.durationSec)) / 60 / (p.contentSec / 3600);
const prime = dpp.programmes.find((p) => localTimeOf(p.start, Z).startsWith('19'));
const morning = dpp.programmes.find((p) => localTimeOf(p.start, Z).startsWith('0') && Number(localTimeOf(p.start, Z).slice(0, 2)) >= 7);
ok(!!prime && !!morning && load(prime) > load(morning), `prime-time programmes carry more ads than morning ones (${prime && load(prime)} vs ${morning && load(morning)} min/h)`);

// ---- hourly cap -------------------------------------------------------------------
const tens = Array.from({ length: 6 }, (_, i) => film(`t${i}`, 10));
const capL: Lineup = {
  epoch, zone: Z, slots: tens.map((s, i) => ({ id: `s${i}`, kind: 'title', pool: [{ assetId: s.id }] })),
  ads: resolveAdPolicy({ enabled: true, placement: 'between', betweenSec: 90, maxPerHourMin: 6 }),
};
const cp = planLineup(capL, lib(...tens), epoch, new Date(epoch.getTime() + 12 * 3600_000));
const perHour = new Map<string, number>();
for (const p of cp.programmes) for (const b of p.breaks) {
  const k = `${localDateOf(b.start!, Z)}T${localTimeOf(b.start!, Z).slice(0, 2)}`;
  perHour.set(k, (perHour.get(k) ?? 0) + b.durationSec);
}
ok([...perHour.values()].every((v) => v <= 360), `no local clock hour over the 6 min cap (max ${Math.max(...perHour.values())} s)`);
ok(cp.programmes.some((p) => !p.breaks.length) && cp.notices.some((n) => /hourly cap/.test(n.message)), 'breaks over the cap were dropped, and the plan says so');
ok(cp.programmes.every((p, i, a) => i === 0 || p.start.getTime() === a[i - 1].end.getTime()), 'capped breaks still leave the guide back to back');

// ---- pad to ads ---------------------------------------------------------------------
const ep = film('ep', 22);
const padL: Lineup = { epoch, zone: Z, gridMin: 30, slots: [{ id: 's', kind: 'title', pool: [{ assetId: 'ep' }] }],
  ads: resolveAdPolicy({ enabled: true, placement: 'between', betweenSec: 60, padToAds: true, padToAdsMinSec: 30, padToAdsMaxSec: 180 }) };
const pp = planLineup(padL, lib(ep), epoch, new Date(epoch.getTime() + 3600_000)).programmes[0];
ok(pp.breaks.length === 1 && pp.breaks[0].durationSec === 240 && pp.breaks[0].fromPadSec === 180, `22 min + 60 s on a 30 min grid: 180 s of the pad sold, a 240 s break (got ${pp.breaks[0]?.durationSec})`);
ok(pp.padSec === 240 && pp.end.getTime() === epoch.getTime() + 30 * 60_000, `the slot still ends on the grid with 240 s of promos (pad ${pp.padSec})`);
const padOff = planLineup({ ...padL, ads: { ...padL.ads!, padToAds: false } }, lib(ep), epoch, new Date(epoch.getTime() + 3600_000)).programmes[0];
ok(padOff.breaks[0].durationSec === 60 && padOff.padSec === 420, 'pad to ads off: the pad stays promos/slate');
const padNone = planLineup({ ...padL, ads: { ...padL.ads!, betweenSec: 0 } }, lib(ep), epoch, new Date(epoch.getTime() + 3600_000)).programmes[0];
ok(padNone.breaks.length === 1 && padNone.breaks[0].source === 'pad' && padNone.breaks[0].durationSec === 180, 'no between break set: the pad becomes a break of its own');

// ---- pod shape --------------------------------------------------------------------
const ad = (id: string, sec: number, extra: any = {}) => ({ id, sequence: 1, creativeKey: id, durationSec: sec, mediaFiles: [{ url: `https://x/${id}.mp4` }], impressions: [], tracking: {}, errors: [], ...extra }) as any;
const cond = (k: string) => ({ assetId: `a-${k}`, durationSec: Number(k.split('_')[1]) });
const pf = fillBreak({ breakSec: 120, segmentSec: 2, ads: [ad('a_30', 30), ad('b_30', 30), ad('c_30', 30)], conditioned: cond, house: [], breakIndex: 0, maxAds: 2 });
ok(pf.items.filter((i) => i.kind === 'ad').length === 2 && pf.skipped.some((s) => s.reason === 'pod-full'), 'most ads per break: the third ad is skipped');
const ml = fillBreak({ breakSec: 120, segmentSec: 2, ads: [ad('a_60', 60), ad('b_30', 30)], conditioned: cond, house: [], breakIndex: 0, maxAdSec: 30 });
ok(ml.adSec === 30 && ml.skipped.some((s) => s.reason === 'over-max-length'), 'longest ad: a 60 s spot is skipped at a 30 s limit');
const sep = (x: any) => (x.advertiser ? `adv:${x.advertiser}` : null);
const cs = fillBreak({ breakSec: 120, segmentSec: 2, ads: [ad('a_30', 30, { advertiser: 'Acme Cars' }), ad('b_30', 30, { advertiser: 'Acme Cars' }), ad('c_30', 30, { advertiser: 'Bean Co' })], conditioned: cond, house: [], breakIndex: 0, separate: sep });
ok(cs.adSec === 60 && cs.skipped.some((s) => s.reason === 'competitive'), 'competitive separation: one ad per advertiser in a pod');
ok(cs.slateSec + cs.adSec + cs.houseSec <= 120.5, 'the pod still fits the break');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
