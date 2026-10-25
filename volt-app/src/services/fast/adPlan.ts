// ============================================================================
//  AD BREAK PLANNING for VOD-to-live: where the breaks go inside a title.
//
//  On a VOD-built channel a break INSERTS time. The film pauses at a segment
//  boundary, the break plays, the film carries on from the same frame. So the
//  programme's slot in the guide is content + breaks (+ grid pad), and the
//  break windows are known hours ahead, which is what lets every consumer
//  (graphics, the ad decision call, the guide, the recorder) prepare for them.
//
//  WHERE, in order of preference:
//    1. the asset's own cue points (chapter / act breaks an editor marked, or
//       black-frame + silence detection), when they satisfy the spacing rules;
//    2. otherwise evenly spread over the title;
//  and always snapped DOWN to a segment boundary, because the playout cuts on
//  segment boundaries and never re-encodes.
//
//  HOW MUCH: a target ad load in minutes per hour of content (FAST channels
//  run roughly 8 to 12), with a first break no earlier than `firstAfterMin`,
//  none in the last `endGuardMin`, and at least `minGapMin` between breaks.
//  A title shorter than `minProgrammeMin` gets no mid breaks, only the
//  between-programmes break when that is switched on.
//
//  BETWEEN-PROGRAMME SCHEDULING (26 Oct 2026, docs: volt/SSAI.md):
//    placement      breaks inside titles, between them, or both;
//    betweenMode    a fixed between break, or one EARNED by the content
//                   since the last break (load x minutes, rounded to a step,
//                   clamped), which is what keeps the ad load right when
//                   programmes vary in length or are only a few minutes long;
//    betweenEveryMin  short titles ACCUMULATE: no between break until at
//                   least N minutes of content have played since the last one;
//    dayparts       load, lengths and caps by local time of day and weekday;
//    maxPerHourMin  a cap on ad minutes per local clock hour (applied by the
//                   lineup walk, which knows the wall clock);
//    padToAds       grid pad long enough becomes sellable break time;
//    podMaxAds / maxAdSec  pod shape the stitcher enforces (pod.ts);
//    per-title rule  none / no_mid (asset metadata or the slot).
//
//  PURE. test/fast-lineup.check.ts, test/fast-ad-schedule.check.ts.
// ============================================================================

export interface AdPolicy {
  enabled: boolean;
  /** Target minutes of ads per hour of content, mid breaks plus the between break. */
  loadMinPerHour: number;
  /** Length of one mid-programme break. */
  breakSec: number;
  firstAfterMin: number;
  minGapMin: number;
  endGuardMin: number;
  minProgrammeMin: number;
  /** A break between programmes (after the end credits). */
  betweenSec: number;
  /** Prefer the asset's cue points over even spacing. */
  useCues: boolean;
  /** Where breaks go: inside titles and between them, only between, only inside. */
  placement: Placement;
  /** The between break: a fixed length, or earned by the content before it. */
  betweenMode: 'fixed' | 'earned';
  /** Earned between breaks: bounds and the step they are rounded to. */
  betweenMinSec: number;
  betweenMaxSec: number;
  betweenStepSec: number;
  /** No between break until this much content has played since the last break (0 = after every programme). */
  betweenEveryMin: number;
  /** Cap on ad minutes in any one local clock hour (0 = no cap). */
  maxPerHourMin: number;
  /** Grid pad of at least `padToAdsMinSec` becomes ad time (up to `padToAdsMaxSec`); the rest stays promos/slate. */
  padToAds: boolean;
  padToAdsMinSec: number;
  padToAdsMaxSec: number;
  /** Pod shape for stitched breaks: most ads in one break, longest single ad (0 = no limit). */
  podMaxAds: number;
  maxAdSec: number;
  /** Overrides by local time of day and weekday, first match wins. */
  dayparts: Daypart[];
}

export type Placement = 'both' | 'between' | 'mid';

/** Per title (asset metadata `adRule`) or per slot: no ads at all, or no breaks inside it. */
export type AdRule = 'default' | 'none' | 'no_mid';

export interface Daypart {
  label?: string;
  /** Local "HH:MM". `to` before `from` runs past midnight. */
  from: string;
  to: string;
  /** ISO weekdays the daypart STARTS on, 1 = Monday ... 7 = Sunday. Empty = every day. */
  days?: number[];
  loadMinPerHour?: number;
  breakSec?: number;
  betweenSec?: number;
  maxPerHourMin?: number;
  placement?: Placement;
}

export const DEFAULT_AD_POLICY: AdPolicy = {
  enabled: false,
  loadMinPerHour: 8,
  breakSec: 120,
  firstAfterMin: 8,
  minGapMin: 10,
  endGuardMin: 5,
  minProgrammeMin: 20,
  betweenSec: 60,
  useCues: true,
  placement: 'both',
  betweenMode: 'fixed',
  betweenMinSec: 30,
  betweenMaxSec: 240,
  betweenStepSec: 15,
  betweenEveryMin: 0,
  maxPerHourMin: 0,
  padToAds: false,
  padToAdsMinSec: 30,
  padToAdsMaxSec: 180,
  podMaxAds: 0,
  maxAdSec: 0,
  dayparts: [],
};

export interface PlannedBreak {
  /** Where in the asset the content pauses (seconds of content before it). */
  atAssetSec: number;
  durationSec: number;
  position: 'mid' | 'end';
  /** Sum of the breaks before this one in the same programme. */
  offsetBeforeSec: number;
  /** Wall-clock start, filled in by the lineup. */
  start?: Date;
  /** Placed on an editorial cue, or spread evenly. */
  source: 'cue' | 'even' | 'between' | 'pad';
  /** Seconds of this break that came from grid pad (padToAds). */
  fromPadSec?: number;
  /** Shortened or dropped by the hourly cap. */
  capped?: boolean;
}

const num = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

/** Stored policy, whatever shape it arrived in, to one that is always valid. */
export function resolveAdPolicy(raw: unknown): AdPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const d = DEFAULT_AD_POLICY;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    loadMinPerHour: num(r.loadMinPerHour, 0, 20, d.loadMinPerHour),
    breakSec: Math.round(num(r.breakSec, 15, 600, d.breakSec)),
    firstAfterMin: num(r.firstAfterMin, 0, 60, d.firstAfterMin),
    minGapMin: num(r.minGapMin, 3, 60, d.minGapMin),
    endGuardMin: num(r.endGuardMin, 0, 30, d.endGuardMin),
    minProgrammeMin: num(r.minProgrammeMin, 0, 120, d.minProgrammeMin),
    betweenSec: Math.round(num(r.betweenSec, 0, 600, d.betweenSec)),
    useCues: typeof r.useCues === 'boolean' ? r.useCues : d.useCues,
    placement: PLACEMENTS.includes(r.placement) ? r.placement : d.placement,
    betweenMode: r.betweenMode === 'earned' ? 'earned' : 'fixed',
    betweenMinSec: Math.round(num(r.betweenMinSec, 0, 600, d.betweenMinSec)),
    betweenMaxSec: Math.round(num(r.betweenMaxSec, 15, 900, d.betweenMaxSec)),
    betweenStepSec: Math.round(num(r.betweenStepSec, 1, 120, d.betweenStepSec)),
    betweenEveryMin: num(r.betweenEveryMin, 0, 120, d.betweenEveryMin),
    maxPerHourMin: num(r.maxPerHourMin, 0, 30, d.maxPerHourMin),
    padToAds: typeof r.padToAds === 'boolean' ? r.padToAds : d.padToAds,
    padToAdsMinSec: Math.round(num(r.padToAdsMinSec, 10, 600, d.padToAdsMinSec)),
    padToAdsMaxSec: Math.round(num(r.padToAdsMaxSec, 10, 900, d.padToAdsMaxSec)),
    podMaxAds: Math.round(num(r.podMaxAds, 0, 20, d.podMaxAds)),
    maxAdSec: Math.round(num(r.maxAdSec, 0, 300, d.maxAdSec)),
    dayparts: Array.isArray(r.dayparts) ? r.dayparts.map(resolveDaypart).filter(Boolean).slice(0, 24) as Daypart[] : [],
  };
}

const PLACEMENTS: Placement[] = ['both', 'between', 'mid'];
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function resolveDaypart(raw: any): Daypart | null {
  if (!raw || typeof raw !== 'object' || !HM.test(String(raw.from)) || !HM.test(String(raw.to))) return null;
  const o: Daypart = { from: String(raw.from), to: String(raw.to) };
  if (raw.label) o.label = String(raw.label).slice(0, 40);
  if (Array.isArray(raw.days)) o.days = [...new Set(raw.days.map(Number).filter((x: number) => x >= 1 && x <= 7))].sort() as number[];
  if (raw.loadMinPerHour != null && raw.loadMinPerHour !== '') o.loadMinPerHour = num(raw.loadMinPerHour, 0, 20, 8);
  if (raw.breakSec != null && raw.breakSec !== '') o.breakSec = Math.round(num(raw.breakSec, 15, 600, 120));
  if (raw.betweenSec != null && raw.betweenSec !== '') o.betweenSec = Math.round(num(raw.betweenSec, 0, 600, 60));
  if (raw.maxPerHourMin != null && raw.maxPerHourMin !== '') o.maxPerHourMin = num(raw.maxPerHourMin, 0, 30, 0);
  if (PLACEMENTS.includes(raw.placement)) o.placement = raw.placement;
  return o;
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local minutes since midnight and ISO weekday of an instant in a zone. */
export function localClock(t: Date, zone: string): { min: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const g = (k: string) => parts.find((x) => x.type === k)?.value ?? '';
  return { min: Number(g('hour')) * 60 + Number(g('minute')), dow: WD[g('weekday')] ?? 1 };
}

/** The daypart a moment falls in (first match), or null. */
export function daypartAt(policy: AdPolicy, t: Date, zone: string): Daypart | null {
  if (!policy.dayparts?.length) return null;
  const { min, dow } = localClock(t, zone);
  for (const d of policy.dayparts) {
    const a = toMin(d.from), b = toMin(d.to);
    let inside = false, startDow = dow;
    if (a === b) inside = true;                                   // all day
    else if (a < b) inside = min >= a && min < b;
    else if (min >= a) inside = true;                             // before midnight
    else if (min < b) { inside = true; startDow = dow === 1 ? 7 : dow - 1; } // after midnight: it started yesterday
    if (inside && (!d.days?.length || d.days.includes(startDow))) return d;
  }
  return null;
}

/** The policy in force at a moment: the base policy with its daypart's overrides. */
export function policyAt(policy: AdPolicy, t: Date, zone: string): AdPolicy {
  const d = daypartAt(policy, t, zone);
  if (!d) return policy;
  const o: AdPolicy = { ...policy };
  if (d.loadMinPerHour != null) o.loadMinPerHour = d.loadMinPerHour;
  if (d.breakSec != null) o.breakSec = d.breakSec;
  if (d.betweenSec != null) o.betweenSec = d.betweenSec;
  if (d.maxPerHourMin != null) o.maxPerHourMin = d.maxPerHourMin;
  if (d.placement) o.placement = d.placement;
  return o;
}

/** A title's ad rule from its metadata (`adRule`, or `ads: false`). */
export function adRuleOf(md: any): AdRule {
  const v = String(md?.adRule ?? md?.ad_rule ?? '').toLowerCase();
  if (v === 'none' || md?.ads === false || md?.adFree === true) return 'none';
  if (v === 'no_mid' || v === 'between_only' || v === 'between-only') return 'no_mid';
  return 'default';
}

const snap = (sec: number, seg: number) => Math.floor(sec / seg) * seg;

/**
 * Breaks for one title of `contentSec` seconds. Returned in order, each with
 * its position in the asset and the break time before it.
 */
export function planBreaks(contentSec: number, cuesSec: number[], policy: AdPolicy, segmentSec = 2): PlannedBreak[] {
  return planProgrammeBreaks(contentSec, cuesSec, policy, segmentSec).breaks;
}

export interface BreakContext {
  /** Content seconds played since the last break, before this programme. */
  sinceBreakSec?: number;
  rule?: AdRule;
}

/**
 * Breaks for one programme, carrying the between-break accumulator across
 * programmes: returns the breaks and the content seconds since the last
 * break after it (0 when it ends on a break).
 */
export function planProgrammeBreaks(contentSec: number, cuesSec: number[], policy: AdPolicy, segmentSec = 2, ctx: BreakContext = {}): { breaks: PlannedBreak[]; sinceBreakSec: number } {
  const since0 = Math.max(0, ctx.sinceBreakSec ?? 0);
  const rule = ctx.rule ?? 'default';
  if (!policy.enabled || contentSec <= 0 || rule === 'none') return { breaks: [], sinceBreakSec: since0 };
  const seg = Math.max(0.5, segmentSec);
  const out: PlannedBreak[] = [];
  const placement = policy.placement ?? 'both';
  const allowMid = placement !== 'between' && rule !== 'no_mid';
  const allowBetween = placement !== 'mid';
  const betweenEst = allowBetween ? policy.betweenSec : 0;

  const lo = policy.firstAfterMin * 60;
  const hi = contentSec - policy.endGuardMin * 60;
  const gap = policy.minGapMin * 60;
  const totalTarget = (policy.loadMinPerHour * 60 * contentSec) / 3600;
  const midTarget = Math.max(0, totalTarget - betweenEst);
  let nMid = policy.breakSec > 0 ? Math.round(midTarget / policy.breakSec) : 0;
  if (!allowMid || contentSec < policy.minProgrammeMin * 60 || hi <= lo) nMid = 0;
  // geometry: how many fit with the spacing rules
  if (nMid > 0) nMid = Math.min(nMid, Math.floor((hi - lo) / gap) + 1);

  let points: { at: number; source: 'cue' | 'even' }[] = [];
  if (nMid > 0) {
    const ideal = Array.from({ length: nMid }, (_, i) => lo + ((hi - lo) * (i + 1)) / (nMid + 1));
    const cues = policy.useCues ? [...new Set(cuesSec.map((c) => snap(c, seg)))].filter((c) => c >= lo && c <= hi).sort((a, b) => a - b) : [];
    for (const want of ideal) {
      // nearest cue that keeps the gap to what is already chosen
      const okCue = cues
        .filter((c) => points.every((p) => Math.abs(p.at - c) >= gap))
        .sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0];
      if (okCue != null && Math.abs(okCue - want) <= (hi - lo) / (nMid + 1)) points.push({ at: okCue, source: 'cue' });
      else {
        const at = snap(want, seg);
        if (points.every((p) => Math.abs(p.at - at) >= gap) && at >= lo && at <= hi) points.push({ at, source: 'even' });
      }
    }
    points = points.sort((a, b) => a.at - b.at);
  }

  let before = 0;
  for (const p of points) {
    out.push({ atAssetSec: p.at, durationSec: policy.breakSec, position: 'mid', offsetBeforeSec: before, source: p.source });
    before += policy.breakSec;
  }
  // content since the last break once this programme ends
  const lastMid = points.length ? points[points.length - 1].at : null;
  let since = lastMid != null ? contentSec - lastMid : since0 + contentSec;
  if (allowBetween && since >= policy.betweenEveryMin * 60 - 1e-6) {
    const len = policy.betweenMode === 'earned' ? earnedBetween(since, policy) : policy.betweenSec;
    if (len > 0) {
      out.push({ atAssetSec: contentSec, durationSec: len, position: 'end', offsetBeforeSec: before, source: 'between' });
      since = 0;
    }
  }
  return { breaks: out, sinceBreakSec: since };
}

/** An earned between break: the load on the content since the last break, stepped and clamped. */
export function earnedBetween(contentSinceSec: number, policy: AdPolicy): number {
  const raw = (policy.loadMinPerHour * 60 * contentSinceSec) / 3600;
  const step = Math.max(1, policy.betweenStepSec);
  const stepped = Math.round(raw / step) * step;
  if (stepped <= 0) return 0;
  return Math.max(policy.betweenMinSec, Math.min(policy.betweenMaxSec, stepped));
}

/**
 * The hourly cap. Breaks are charged to the local clock hour they START in;
 * one that would take the hour over the cap is shortened (to whole steps of
 * `segmentSec`, at least `minSec`) or dropped. Returns the adjusted breaks,
 * re-timed from `startMs`, and what to charge to each hour.
 */
export function capBreaks(breaks: PlannedBreak[], startMs: number, capMin: number, used: (hourKey: string) => number, hourKeyOf: (t: Date) => string, segmentSec = 2, minSec = 15): { breaks: PlannedBreak[]; charge: Map<string, number>; trimmedSec: number } {
  const charge = new Map<string, number>();
  let trimmedSec = 0;
  const out: PlannedBreak[] = [];
  let before = 0;
  for (const b of breaks) {
    const start = new Date(startMs + Math.round((b.atAssetSec + before) * 1000));
    let dur = b.durationSec;
    let capped = false;
    if (capMin > 0) {
      const k = hourKeyOf(start);
      const left = capMin * 60 - used(k) - (charge.get(k) ?? 0);
      if (dur > left + 1e-6) {
        capped = true;
        dur = Math.floor(Math.max(0, left) / segmentSec) * segmentSec;
        if (dur < minSec) dur = 0;
      }
      if (dur > 0) charge.set(k, (charge.get(k) ?? 0) + dur);
    }
    if (dur < b.durationSec) trimmedSec += b.durationSec - dur;
    if (dur <= 0) continue;
    out.push({ ...b, durationSec: dur, offsetBeforeSec: before, start, ...(capped ? { capped: true } : {}) });
    before += dur;
  }
  return { breaks: out, charge, trimmedSec };
}

/** Minutes of ads per hour a plan actually ended up with (for the console's load meter). */
export function achievedLoad(contentSec: number, breaks: PlannedBreak[]): number {
  if (contentSec <= 0) return 0;
  const ad = breaks.reduce((s, b) => s + b.durationSec, 0);
  return Math.round(((ad / 60) / (contentSec / 3600)) * 10) / 10;
}
