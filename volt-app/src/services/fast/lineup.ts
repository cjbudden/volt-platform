// ============================================================================
//  FAST LINEUP ENGINE: a run order of slots becomes a channel schedule.
//
//  The idea is the cable movie channel, not the daily EPG. An HBO-style lineup
//  is a run order that is NOT a day long (say 14 hours) and simply loops. Every
//  pass of the lineup (a CYCLE) starts where the last one ended, so a film that
//  aired at 20:00 on Monday airs at 10:00 on Tuesday and 00:00 on Wednesday.
//  One lineup, written once, fills a week with every title at a spread of
//  clock times, which is exactly what a repeat-heavy movie channel wants.
//
//  What stops it being one fixed loop is that a SLOT is not a title. A slot is:
//
//    title   a POOL of titles that rotates by cycle: [A, B, C] airs A on the
//            first pass, B on the second, C on the third, then A again. A pool
//            entry may be "skip", so a slot can drop out every other pass.
//            `every: 3` plays the slot on one pass in three. This is how films
//            drop out and are replaced across the week without anyone editing
//            the run order again.
//    series  the next N episodes of a series, in order (or shuffled without
//            repeats for non-serial shows), each pass continuing where the
//            last left off. `encoreOf` replays what another slot just aired.
//
//  Plus three lineup-wide controls:
//    cycleShift  rotate the run order by k slots each pass, so the same title
//                does not keep landing in the same part of the lineup;
//    anchor      restart the lineup at a fixed local time every day (06:00),
//                instead of free-running;
//    gridMin     round each programme up to a 5/15/30/60 minute grid, padding
//                with filler, so the guide reads like a traditional grid.
//
//  DETERMINISTIC. The plan is a pure function of the lineup and its epoch, so
//  any window can be regenerated at any time and gives the same answer: the
//  EPG, the playout and the ad breaks all come from the same computation and
//  can never disagree. Series pointers are not stored state; they fall out of
//  walking the cycles from the epoch. An edit is a new lineup VERSION with a
//  new epoch that carries the cycle number and the pointers on (`rebase`).
//
//  PURE: no database, no clock. Tested in node (test/fast-lineup.check.ts).
// ============================================================================
import { localTimeOf, localDateOf, localToUtc, addDays } from '../epgRepeat';
import { planBreaks, type AdPolicy, type PlannedBreak, DEFAULT_AD_POLICY } from './adPlan';

export interface AssetInfo {
  id: string;
  title: string;
  durationSec: number;
  series?: string | null;
  season?: number | null;
  episode?: number | null;
  availableFrom?: Date | null;
  availableUntil?: Date | null;
  /** Editorial break points in the asset (seconds), from the asset's cue list. */
  breakCuesSec?: number[];
  /** False when the asset has no packaged media on the channel ladder yet. */
  ready?: boolean;
  imageUrl?: string | null;
  genre?: string | null;
}

export type PoolRef = { assetId: string } | { skip: true };

export interface TitleSlot {
  id: string;
  kind: 'title';
  pool: PoolRef[];
  /** Play on one pass in `every` (default 1 = every pass). */
  every?: number;
  /** Which pass of `every` it plays on (0-based). Also offsets the pool rotation. */
  phase?: number;
  label?: string;
}

export interface SeriesSlot {
  id: string;
  kind: 'series';
  series: string;
  /** Episodes back to back each time the slot plays. */
  count: number;
  order: 'sequential' | 'shuffle';
  /** At the end of the series: start again from the first episode, or drop out. */
  atEnd?: 'loop' | 'stop';
  every?: number;
  phase?: number;
  /** Replay the episodes another slot aired (its most recent play). */
  encoreOf?: string | null;
  label?: string;
}

export type Slot = TitleSlot | SeriesSlot;

export interface Lineup {
  /** When pass `epochCycle` starts. */
  epoch: Date;
  epochCycle?: number;
  /** Where in the run order the first pass starts (0 = the top). Set by `rebase`. */
  epochSlot?: number;
  /** Series pointer at the epoch (episodes already consumed), keyed by series. */
  seriesStart?: Record<string, number>;
  slots: Slot[];
  cycleShift?: number;
  /** Restart the run order at this local time every day ("06:00"). Null = free-running. */
  anchor?: string | null;
  zone: string;
  gridMin?: 0 | 5 | 15 | 30 | 60;
  segmentSec?: number;
  ads?: AdPolicy;
  /** Used when a slot's title is out of its rights window: best duration fit first. */
  backfill?: string[];
  seed?: string;
}

export interface PlannedProgramme {
  /** Stable key, used as the programme's source_ref. */
  key: string;
  cycle: number;
  slotId: string;
  slotIndex: number;
  /** Position in this pass's run order (after the cycle shift). */
  ordinal: number;
  assetId: string;
  title: string;
  start: Date;
  /** End of the last content second (before an end break and pad). */
  contentEnd: Date;
  /** End including breaks and grid pad: the EPG slot end. */
  end: Date;
  contentSec: number;
  breaks: PlannedBreak[];
  padSec: number;
  series?: { name: string; season: number | null; episode: number | null; index: number; pass: number };
  /** Why this title and not the slot's first choice. */
  note?: 'rotation' | 'backfill' | 'encore';
  warnings: string[];
}

export interface PlanResult {
  programmes: PlannedProgramme[];
  /** Things a planner should know: a dropped slot, a title out of rights, an empty lineup. */
  notices: { at: Date; slotId?: string; message: string }[];
  /** Cycle and series pointers at the end of the window, for `rebase`. */
  end: { cycle: number; seriesPointers: Record<string, number>; at: Date };
}

const SAFETY_ITEMS = 200_000;

// ---------------------------------------------------------------- helpers

/** Seconds since local midnight for an instant in a zone. */
export function localSecondsOfDay(t: Date, zone: string): number {
  const [h, m, s] = localTimeOf(t, zone).split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

/** Pad that takes an end time up to the next grid boundary (local wall clock). */
export function gridPad(end: Date, gridMin: number, zone: string): number {
  if (!gridMin) return 0;
  const g = gridMin * 60;
  const sod = localSecondsOfDay(end, zone) + (end.getTime() % 1000) / 1000;
  const r = sod % g;
  return r < 0.0005 ? 0 : Math.round((g - r) * 1000) / 1000;
}

/** Small deterministic PRNG, so a shuffle is the same every time it is computed. */
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Episode order for one pass of a shuffled series. A different permutation
 * each pass, and never the episode the previous pass ended on first, so the
 * join between passes does not repeat back to back.
 */
export function shuffleOrder(n: number, seed: string, pass: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rnd = mulberry32(hash(`${seed}:${pass}`));
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  if (pass > 0 && n > 1) {
    const prev = shuffleOrder(n, seed, pass - 1);
    if (idx[0] === prev[n - 1]) [idx[0], idx[1]] = [idx[1], idx[0]];
  }
  return idx;
}

/** Episodes of a series, in broadcast order: season, then episode, then title. */
export function episodesOf(series: string, assets: Map<string, AssetInfo>): AssetInfo[] {
  const key = series.trim().toLowerCase();
  return [...assets.values()]
    .filter((a) => (a.series ?? '').trim().toLowerCase() === key)
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title));
}

const plays = (slot: Slot, cycle: number) => {
  const every = Math.max(1, Math.round(slot.every ?? 1));
  const phase = ((Math.round(slot.phase ?? 0) % every) + every) % every;
  return ((cycle % every) + every) % every === phase;
};

/** The pass-th play of a slot that plays one pass in `every`. */
const playIndex = (slot: Slot, cycle: number) => Math.floor(cycle / Math.max(1, Math.round(slot.every ?? 1)));

function inRights(a: AssetInfo, start: Date, end: Date): boolean {
  if (a.availableFrom && a.availableFrom.getTime() > start.getTime()) return false;
  if (a.availableUntil && a.availableUntil.getTime() < end.getTime()) return false;
  return true;
}

// ---------------------------------------------------------------- the walk

interface Pick { asset: AssetInfo; note?: PlannedProgramme['note']; series?: PlannedProgramme['series'] }

/**
 * Plan [from, to). Programmes that START before `from` but run into it are
 * included, so a window always opens with what is on air.
 */
export function planLineup(lineup: Lineup, assets: Map<string, AssetInfo>, from: Date, to: Date): PlanResult {
  const zone = lineup.zone || 'UTC';
  const grid = lineup.gridMin ?? 0;
  const seg = lineup.segmentSec ?? 2;
  const ads = lineup.ads ?? DEFAULT_AD_POLICY;
  const shift = Math.round(lineup.cycleShift ?? 0);
  const out: PlannedProgramme[] = [];
  const notices: PlanResult['notices'] = [];
  const ptr: Record<string, number> = { ...(lineup.seriesStart ?? {}) };
  const lastPlay: Record<string, Pick[]> = {};
  const noticeOnce = new Set<string>();
  const notice = (at: Date, message: string, slotId?: string) => {
    const k = `${slotId}:${message}`;
    if (noticeOnce.has(k)) return;
    noticeOnce.add(k);
    notices.push({ at, slotId, message });
  };

  let t = lineup.epoch.getTime();
  let cycle = lineup.epochCycle ?? 0;
  const n = lineup.slots.length;
  if (!n) {
    notices.push({ at: from, message: 'The lineup has no slots.' });
    return { programmes: [], notices, end: { cycle, seriesPointers: ptr, at: new Date(t) } };
  }

  // Anchor: each local day restarts the run order at the anchor time.
  const anchorAt = (ms: number): number | null => {
    if (!lineup.anchor) return null;
    const d = localDateOf(new Date(ms), zone);
    let a = Date.parse(localToUtc(d, lineup.anchor, zone));
    if (a <= ms) a = Date.parse(localToUtc(addDays(d, 1), lineup.anchor, zone));
    return a;
  };
  let nextAnchor = anchorAt(t);

  const backfill = (lineup.backfill ?? []).map((id) => assets.get(id)).filter(Boolean) as AssetInfo[];

  let items = 0;
  let emptyCycles = 0;
  let last: PlannedProgramme | null = null;
  const toMs = to.getTime();
  while (t < toMs) {
    let placed = 0;
    let restarted = false;
    const firstK = cycle === (lineup.epochCycle ?? 0) && items === 0 ? Math.max(0, Math.min(n - 1, Math.round(lineup.epochSlot ?? 0))) : 0;
    for (let k = firstK; k < n && t < toMs && !restarted; k++) {
      if (++items > SAFETY_ITEMS) { notices.push({ at: new Date(t), message: 'Stopped: the window is too long to plan in one go.' }); t = toMs; break; }
      const slotIndex = (((k + shift * cycle) % n) + n) % n;
      const slot = lineup.slots[slotIndex];
      if (!plays(slot, cycle)) continue;
      const picks = pickFor(slot, cycle, t, assets, ptr, lastPlay, backfill, lineup.seed ?? 'volt', notice);
      if (!picks.length) continue;
      lastPlay[slot.id] = picks;
      for (const p of picks) {
        const breaks = planBreaks(p.asset.durationSec, p.asset.breakCuesSec ?? [], ads, seg);
        const breakSec = breaks.reduce((s, b) => s + b.durationSec, 0);
        const contentSec = p.asset.durationSec;
        // ANCHOR: an item that would run past the daily restart is not started.
        // The programme before it is padded up to the anchor and the run order
        // starts again from the top.
        if (nextAnchor != null && placed > 0 && t + (contentSec + breakSec) * 1000 > nextAnchor) {
          if (last && last.end.getTime() <= nextAnchor) {
            const extra = (nextAnchor - last.end.getTime()) / 1000;
            last.padSec = Math.round((last.padSec + extra) * 1000) / 1000;
            last.end = new Date(nextAnchor);
            if (extra > 15 * 60) notice(last.end, `${Math.round(extra / 60)} minutes of filler before the ${lineup.anchor} restart. A shorter title in the lineup would fill it.`);
          }
          t = nextAnchor;
          nextAnchor = anchorAt(t);
          restarted = true;
          break;
        }
        const midSec = breaks.filter((b) => b.position === 'mid').reduce((x, b) => x + b.durationSec, 0);
        const endMs = t + Math.round((contentSec + breakSec) * 1000);
        const padSec = gridPad(new Date(endMs), grid, zone);
        const warnings: string[] = [];
        if (p.asset.ready === false) warnings.push('Not prepared for this channel yet: it is packaged to the channel ladder before it airs.');
        const prog: PlannedProgramme = {
          key: `c${cycle}:${slot.id}${p.series ? `:e${p.series.pass}.${p.series.index}` : ''}`,
          cycle, slotId: slot.id, slotIndex, ordinal: k, assetId: p.asset.id, title: p.asset.title,
          start: new Date(t),
          contentEnd: new Date(t + Math.round((contentSec + midSec) * 1000)),
          end: new Date(endMs + Math.round(padSec * 1000)),
          contentSec,
          breaks: breaks.map((b) => ({ ...b, start: new Date(t + Math.round((b.atAssetSec + b.offsetBeforeSec) * 1000)) })),
          padSec, series: p.series, note: p.note, warnings,
        };
        if (prog.end.getTime() > from.getTime()) out.push(prog);
        last = prog;
        t = prog.end.getTime();
        placed++;
        // landed on (or past) the restart: the next pass starts the run order again
        if (nextAnchor != null && t >= nextAnchor) { nextAnchor = anchorAt(t); restarted = true; break; }
        if (t >= toMs) break;
      }
    }
    if (placed === 0 && !restarted) {
      if (++emptyCycles > Math.max(3, ...lineup.slots.map((s) => Math.round(s.every ?? 1)))) {
        notices.push({ at: new Date(t), message: 'Nothing in the lineup can air (every slot is dropped, out of rights or empty).' });
        break;
      }
    } else emptyCycles = 0;
    cycle++;
  }

  return { programmes: out.filter((p) => p.end.getTime() > from.getTime() && p.start.getTime() < to.getTime()), notices, end: { cycle, seriesPointers: ptr, at: new Date(t) } };
}

function pickFor(
  slot: Slot, cycle: number, atMs: number, assets: Map<string, AssetInfo>, ptr: Record<string, number>,
  lastPlay: Record<string, Pick[]>, backfill: AssetInfo[], seed: string,
  notice: (at: Date, m: string, slotId?: string) => void,
): Pick[] {
  const at = new Date(atMs);
  if (slot.kind === 'title') {
    const pool = slot.pool.length ? slot.pool : [{ skip: true as const }];
    const rot = playIndex(slot, cycle) + Math.round(slot.phase ?? 0);
    // The rotation's choice first, then the rest of the pool in order, then backfill.
    for (let i = 0; i < pool.length; i++) {
      const ref = pool[(((rot + i) % pool.length) + pool.length) % pool.length];
      if ('skip' in ref) { if (i === 0) return []; continue; }
      const a = assets.get(ref.assetId);
      if (!a) { notice(at, `A title in slot ${slot.label ?? slot.id} no longer exists.`, slot.id); continue; }
      const end = new Date(atMs + a.durationSec * 1000);
      if (!inRights(a, at, end)) { notice(at, `"${a.title}" is outside its rights window.`, slot.id); continue; }
      return [{ asset: a, note: i === 0 ? (pool.length > 1 ? 'rotation' : undefined) : 'rotation' }];
    }
    const fit = bestBackfill(backfill, pool, assets, atMs);
    if (fit) return [{ asset: fit, note: 'backfill' }];
    notice(at, `Slot ${slot.label ?? slot.id} has nothing it can air, so it is skipped.`, slot.id);
    return [];
  }

  // series
  if (slot.encoreOf) {
    const prev = lastPlay[slot.encoreOf];
    if (prev?.length) return prev.map((p) => ({ ...p, note: 'encore' as const }));
    return [];
  }
  const eps = episodesOf(slot.series, assets);
  if (!eps.length) { notice(at, `Series "${slot.series}" has no episodes in the library.`, slot.id); return []; }
  const key = slot.series.trim().toLowerCase();
  const out: Pick[] = [];
  let tries = 0;
  let t = atMs;
  while (out.length < Math.max(1, slot.count) && tries < eps.length * 2) {
    tries++;
    const consumed = ptr[key] ?? 0;
    const pass = Math.floor(consumed / eps.length);
    if (pass > 0 && slot.atEnd === 'stop') { notice(at, `Series "${slot.series}" has run out of episodes.`, slot.id); break; }
    const within = consumed % eps.length;
    const idx = slot.order === 'shuffle' ? shuffleOrder(eps.length, `${seed}:${key}`, pass)[within] : within;
    ptr[key] = consumed + 1;
    const a = eps[idx];
    const end = new Date(t + a.durationSec * 1000);
    if (!inRights(a, new Date(t), end)) { notice(new Date(t), `"${a.title}" is outside its rights window and was passed over.`, slot.id); continue; }
    out.push({ asset: a, series: { name: slot.series, season: a.season ?? null, episode: a.episode ?? null, index: within, pass } });
    t = end.getTime();
  }
  return out;
}

function bestBackfill(backfill: AssetInfo[], pool: PoolRef[], assets: Map<string, AssetInfo>, atMs: number): AssetInfo | null {
  const wanted = pool.map((r) => ('assetId' in r ? assets.get(r.assetId)?.durationSec : undefined)).find((d) => d != null) ?? 0;
  const ok = backfill.filter((a) => inRights(a, new Date(atMs), new Date(atMs + a.durationSec * 1000)));
  ok.sort((a, b) => Math.abs(a.durationSec - wanted) - Math.abs(b.durationSec - wanted));
  return ok[0] ?? null;
}

// ---------------------------------------------------------------- repeat tools

/**
 * What a free-running lineup of a given length does to a week. The numbers a
 * planner needs before they build one: passes per week, how far each pass
 * drifts against the clock, and the distinct clock times a title will air at.
 */
export function rotationMath(lengthSec: number, days = 7) {
  // An empty run order has no pass. It used to be treated as a one-minute
  // pass: 10 080 passes a week and "divides a day exactly".
  if (!(lengthSec > 0)) {
    return { lengthSec: 0, passesPerWeek: 0, dailyShiftMin: 0, distinctClockTimes: [] as string[], warnings: [] as string[] };
  }
  const L = Math.max(60, lengthSec);
  const week = days * 86400;
  const passes = week / L;
  const drift = ((L % 86400) + 86400) % 86400; // how much later (mod a day) each pass starts
  const times = new Set<number>();
  for (let i = 0; i < Math.floor(passes + 1e-9); i++) times.add(Math.round(((i * L) % 86400) / 60));
  const warnings: string[] = [];
  if (86400 % L === 0) warnings.push('The lineup divides a day exactly, so every title airs at the same time every day.');
  if (Math.abs(passes - Math.round(passes)) > 0.01) warnings.push('The lineup does not divide the week, so next week starts at a different point in the run order.');
  if (L < 3 * 3600) warnings.push('A lineup this short repeats titles within a few hours.');
  return {
    lengthSec: L,
    passesPerWeek: Math.round(passes * 100) / 100,
    dailyShiftMin: Math.round((drift <= 43200 ? drift : drift - 86400) / 60),
    distinctClockTimes: [...times].sort((a, b) => a - b).map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`),
    warnings,
  };
}

/** `every` that gives a title about `perWeek` plays, for a lineup of this length. */
export function everyForPlays(lengthSec: number, perWeek: number): number {
  const passes = (7 * 86400) / Math.max(60, lengthSec);
  return Math.max(1, Math.round(passes / Math.max(0.01, perWeek)));
}

export interface RepeatReport {
  assetId: string;
  title: string;
  plays: number;
  times: string[];
  /** Shortest gap between two plays, hours. */
  minGapHours: number | null;
  /** Plays starting 18:00 to 23:00 local. */
  primetime: number;
  /** Plays at a clock time this title already had in the window. */
  sameTimeRepeats: number;
}

/** Per title over a planned window: how often, when, how close together. */
export function repeatReport(progs: PlannedProgramme[], zone: string): RepeatReport[] {
  const by = new Map<string, PlannedProgramme[]>();
  for (const p of progs) { const l = by.get(p.assetId) ?? []; l.push(p); by.set(p.assetId, l); }
  const out: RepeatReport[] = [];
  for (const [assetId, list] of by) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
    let minGap: number | null = null;
    for (let i = 1; i < list.length; i++) {
      const g = (list[i].start.getTime() - list[i - 1].start.getTime()) / 3600_000;
      minGap = minGap == null ? g : Math.min(minGap, g);
    }
    const clock = list.map((p) => localTimeOf(p.start, zone).slice(0, 5));
    const seen = new Set<string>();
    let same = 0;
    for (const c of clock) { if (seen.has(c)) same++; seen.add(c); }
    const prime = list.filter((p) => { const h = Math.floor(localSecondsOfDay(p.start, zone) / 3600); return h >= 18 && h < 23; }).length;
    out.push({
      assetId, title: list[0].title, plays: list.length,
      times: list.map((p) => `${localDateOf(p.start, zone)} ${localTimeOf(p.start, zone).slice(0, 5)}`),
      minGapHours: minGap == null ? null : Math.round(minGap * 10) / 10,
      primetime: prime, sameTimeRepeats: same,
    });
  }
  return out.sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title));
}

/** Length of one pass with each slot's FIRST choice, ignoring breaks and pads. */
export function nominalLength(lineup: Lineup, assets: Map<string, AssetInfo>): number {
  let s = 0;
  for (const slot of lineup.slots) {
    if (slot.kind === 'title') {
      const r = slot.pool.find((x) => 'assetId' in x) as { assetId: string } | undefined;
      s += r ? assets.get(r.assetId)?.durationSec ?? 0 : 0;
    } else if (!slot.encoreOf) {
      const eps = episodesOf(slot.series, assets);
      const avg = eps.length ? eps.reduce((x, e) => x + e.durationSec, 0) / eps.length : 0;
      s += avg * Math.max(1, slot.count);
    } else {
      const ref = lineup.slots.find((x) => x.id === slot.encoreOf);
      if (ref && ref.kind === 'series') {
        const eps = episodesOf(ref.series, assets);
        s += eps.length ? (eps.reduce((x, e) => x + e.durationSec, 0) / eps.length) * Math.max(1, ref.count) : 0;
      }
    }
  }
  return s;
}

/**
 * Carry a lineup on from a moment. The returned position starts at `at`
 * exactly (the end of whatever is on air in the GUIDE, which may differ from
 * the plan after an edit), continuing the run order after the plan's programme
 * at that moment, with the cycle and series pointers it had reached. So an
 * edit never restarts a series from episode one or replays the start of the
 * run order, and never leaves a hole after the programme on air.
 *
 * `sameOrder` false (a NEW version, with a different run order): start that
 * run order from its top on the next pass, keeping the pass count (so
 * rotation pools keep turning) and the series pointers.
 */
export function rebase(old: Lineup, assets: Map<string, AssetInfo>, at: Date, sameOrder = true): { epoch: Date; epochCycle: number; epochSlot: number; seriesStart: Record<string, number> } {
  const n = old.slots.length;
  const r = planLineup(old, assets, new Date(at.getTime() - 1), at);
  const p = r.programmes[r.programmes.length - 1];
  if (!p || n === 0) return { epoch: at, epochCycle: old.epochCycle ?? 0, epochSlot: old.epochSlot ?? 0, seriesStart: { ...(old.seriesStart ?? {}) } };
  if (!sameOrder) return { epoch: at, epochCycle: p.cycle + 1, epochSlot: 0, seriesStart: r.end.seriesPointers };
  const next = p.ordinal + 1;
  return next >= n
    ? { epoch: at, epochCycle: p.cycle + 1, epochSlot: 0, seriesStart: r.end.seriesPointers }
    : { epoch: at, epochCycle: p.cycle, epochSlot: next, seriesStart: r.end.seriesPointers };
}
