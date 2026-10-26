// ============================================================================
//  ON-DEMAND ADS: WHERE THE BREAKS GO, AND THE TWO CLOCKS (SSAI.md section 5).
//
//  A rule (vod_ad_rules.policy) says where breaks go in a title:
//    pre-roll    before the content, only for content of at least N seconds,
//                so a 20 second clip does not open with 15 seconds of ads;
//    mid-rolls   at the title's own cue points (break_cues_ms, the act breaks
//                an editor marked) when it has them, else every N minutes,
//                never in the first minutes, never close to the end, never two
//                closer than a minimum gap;
//    post-roll   after the content (off by default: viewers leave).
//  A title's metadata can opt out (adRule none) or keep only pre and post
//  (adRule no_mid), the same switch FAST channels read (fast/adPlan.ts).
//
//  BREAKS SIT ON SEGMENT BOUNDARIES. A stitched playlist can only switch to an
//  ad between two content segments, so every mid-roll is moved to the nearest
//  segment start. The guided (interstitial) form uses the same moments, so
//  both deliveries put the ads in the same places.
//
//  TWO CLOCKS. Content time is what bookmarks, resume, chapters, captions and
//  the playback reports use; stitched time is what a player playing a stitched
//  playlist sees (content plus the ads before it). `toContent` and `toStitched`
//  convert, and `snapbackFor` says which break a seek skipped over and must
//  play first (the rule's snapback setting, on by default).
//
//  PURE. test/vod-ads.check.ts.
// ============================================================================

export type Position = 'pre' | 'mid' | 'post';
export type Delivery = 'auto' | 'stitched' | 'guided';

export interface VodAdPolicy {
  preroll: { on: boolean; sec: number; minContentSec: number };
  midroll: { on: boolean; sec: number; everyMin: number; firstAfterMin: number; endGuardMin: number; minGapMin: number; useCues: boolean; maxBreaks: number };
  postroll: { on: boolean; sec: number; minContentSec: number };
  /** Paid ad pod shape (0 = no limit). */
  podMaxAds: number;
  maxAdSec: number;
  /** Viewers who play without ads: those who paid for it (entitlement), signed-in members. */
  adFreeFor: ('entitlement' | 'members')[];
  /** Seeking past an unwatched mid-roll plays it first, then goes where the viewer asked. */
  snapback: boolean;
  /** Resuming part way: play the pre-roll anyway. */
  prerollOnResume: boolean;
  /** How the ads reach the player: guided where the player supports interstitials, else stitched. */
  delivery: Delivery;
}

export const DEFAULT_VOD_AD_POLICY: VodAdPolicy = {
  preroll: { on: true, sec: 15, minContentSec: 60 },
  midroll: { on: true, sec: 60, everyMin: 10, firstAfterMin: 8, endGuardMin: 3, minGapMin: 5, useCues: true, maxBreaks: 12 },
  postroll: { on: false, sec: 15, minContentSec: 300 },
  podMaxAds: 0,
  maxAdSec: 0,
  adFreeFor: ['entitlement'],
  snapback: true,
  prerollOnResume: false,
  delivery: 'auto',
};

const num = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, n));
};
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** A stored policy, whatever shape it arrived in, to one that is always valid. */
export function resolveVodAdPolicy(raw: unknown): VodAdPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const d = DEFAULT_VOD_AD_POLICY;
  const pre = r.preroll ?? {}, mid = r.midroll ?? {}, post = r.postroll ?? {};
  const adFree = Array.isArray(r.adFreeFor) ? r.adFreeFor.filter((x: any) => x === 'entitlement' || x === 'members') : d.adFreeFor;
  return {
    preroll: { on: bool(pre.on, d.preroll.on), sec: Math.round(num(pre.sec, 5, 300, d.preroll.sec)), minContentSec: Math.round(num(pre.minContentSec, 0, 7200, d.preroll.minContentSec)) },
    midroll: {
      on: bool(mid.on, d.midroll.on), sec: Math.round(num(mid.sec, 5, 600, d.midroll.sec)),
      everyMin: num(mid.everyMin, 2, 120, d.midroll.everyMin), firstAfterMin: num(mid.firstAfterMin, 0, 120, d.midroll.firstAfterMin),
      endGuardMin: num(mid.endGuardMin, 0, 60, d.midroll.endGuardMin), minGapMin: num(mid.minGapMin, 1, 120, d.midroll.minGapMin),
      useCues: bool(mid.useCues, d.midroll.useCues), maxBreaks: Math.round(num(mid.maxBreaks, 0, 50, d.midroll.maxBreaks)),
    },
    postroll: { on: bool(post.on, d.postroll.on), sec: Math.round(num(post.sec, 5, 300, d.postroll.sec)), minContentSec: Math.round(num(post.minContentSec, 0, 7200, d.postroll.minContentSec)) },
    podMaxAds: Math.round(num(r.podMaxAds, 0, 20, d.podMaxAds)),
    maxAdSec: Math.round(num(r.maxAdSec, 0, 300, d.maxAdSec)),
    adFreeFor: [...new Set(adFree)] as VodAdPolicy['adFreeFor'],
    snapback: bool(r.snapback, d.snapback),
    prerollOnResume: bool(r.prerollOnResume, d.prerollOnResume),
    delivery: (['auto', 'stitched', 'guided'] as const).includes(r.delivery) ? r.delivery : d.delivery,
  };
}

/** A title's own say, from its metadata (`adRule`, `ads: false`), as FAST reads it. */
export function titleRule(md: any): 'default' | 'none' | 'no_mid' {
  const v = String(md?.adRule ?? md?.ad_rule ?? '').toLowerCase();
  if (v === 'none' || md?.ads === false || md?.adFree === true) return 'none';
  if (v === 'no_mid' || v === 'between_only' || v === 'between-only') return 'no_mid';
  return 'default';
}

export interface PlannedBreak {
  index: number;
  position: Position;
  /** Content time the break plays at (0 = before the content, contentSec = after it). */
  atSec: number;
  /** The break's planned length; the pod decided for it may be shorter. */
  durationSec: number;
  /** Where the moment came from. */
  source: 'pre' | 'cue' | 'interval' | 'post';
}

/** Nearest segment start to `t` (boundaries ascending, starting at 0). */
export function snapToBoundary(t: number, boundaries: number[]): number {
  if (!boundaries.length) return t;
  let best = boundaries[0];
  for (const b of boundaries) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
  return best;
}

/**
 * The breaks for a title of `contentSec`, in order. `cuesSec` are the title's
 * own cue points; `boundaries` its segment start times (from its playlist).
 */
export function planVodBreaks(contentSec: number, policy: VodAdPolicy, opts: { cuesSec?: number[]; boundaries?: number[]; titleRule?: 'default' | 'none' | 'no_mid' } = {}): PlannedBreak[] {
  const rule = opts.titleRule ?? 'default';
  if (rule === 'none' || !(contentSec > 0)) return [];
  const out: Omit<PlannedBreak, 'index'>[] = [];
  if (policy.preroll.on && contentSec >= policy.preroll.minContentSec) out.push({ position: 'pre', atSec: 0, durationSec: policy.preroll.sec, source: 'pre' });
  const m = policy.midroll;
  if (m.on && rule !== 'no_mid' && m.maxBreaks > 0) {
    const first = m.firstAfterMin * 60, guard = contentSec - m.endGuardMin * 60, gap = m.minGapMin * 60;
    const cues = (opts.cuesSec ?? []).filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
    let wanted: { t: number; source: 'cue' | 'interval' }[];
    if (m.useCues && cues.length) {
      // An editor's act breaks are where the story pauses: honour them, but not
      // inside the opening minutes or the end guard, and not two too close.
      wanted = cues.filter((c) => c > 0 && c < contentSec).map((t) => ({ t, source: 'cue' as const }));
    } else {
      wanted = [];
      for (let t = Math.max(first, m.everyMin * 60); t < guard; t += m.everyMin * 60) wanted.push({ t, source: 'interval' });
    }
    let last = -Infinity;
    for (const w of wanted) {
      const at = opts.boundaries?.length ? snapToBoundary(w.t, opts.boundaries) : w.t;
      if (at <= 0 || at < first || at > guard || at - last < gap) continue;
      if (out.filter((b) => b.position === 'mid').length >= m.maxBreaks) break;
      out.push({ position: 'mid', atSec: at, durationSec: m.sec, source: w.source });
      last = at;
    }
  }
  if (policy.postroll.on && contentSec >= policy.postroll.minContentSec) out.push({ position: 'post', atSec: contentSec, durationSec: policy.postroll.sec, source: 'post' });
  return out.map((b, index) => ({ ...b, index }));
}

// ---------------------------------------------------------------- the two clocks

/** A break as the timeline carries it: where it sits in content time and how long its pod is. */
export interface ClockBreak { index: number; atSec: number; durationSec: number }

/** Stitched start of each break (content before it plus every earlier pod). */
export function stitchedStarts(breaks: ClockBreak[]): number[] {
  let shift = 0;
  return breaks.map((b) => { const s = b.atSec + shift; shift += b.durationSec; return s; });
}

/** Stitched time to content time. Inside a break: the content moment the break sits at. */
export function toContent(stitchedSec: number, breaks: ClockBreak[]): { contentSec: number; inBreak: number | null } {
  const starts = stitchedStarts(breaks);
  let shift = 0;
  for (let i = 0; i < breaks.length; i++) {
    if (stitchedSec < starts[i]) break;
    if (stitchedSec < starts[i] + breaks[i].durationSec) return { contentSec: breaks[i].atSec, inBreak: breaks[i].index };
    shift += breaks[i].durationSec;
  }
  return { contentSec: Math.max(0, stitchedSec - shift), inBreak: null };
}

/**
 * Content time to stitched time. `afterBreakAt` decides a break sitting
 * exactly at that content moment: true lands after it (resume, a seek that has
 * already played its snapback), false lands at its start.
 */
export function toStitched(contentSec: number, breaks: ClockBreak[], afterBreakAt = true): number {
  let shift = 0;
  for (const b of breaks) {
    if (b.atSec < contentSec || (afterBreakAt && b.atSec === contentSec)) shift += b.durationSec;
    else break;
  }
  return contentSec + shift;
}

/**
 * A seek forward from content time `fromSec` to `toSec`: the break it skipped
 * that must play first (the latest unwatched mid-roll in between), or null.
 * A seek backwards never replays a break.
 */
export function snapbackFor(fromSec: number, toSec: number, breaks: (ClockBreak & { position?: Position })[], watched: Set<number>): ClockBreak | null {
  if (toSec <= fromSec) return null;
  const skipped = breaks.filter((b) => (b.position ?? 'mid') === 'mid' && b.atSec > fromSec && b.atSec <= toSec && !watched.has(b.index));
  return skipped.length ? skipped[skipped.length - 1] : null;
}
