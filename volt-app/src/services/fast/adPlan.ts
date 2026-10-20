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
//  PURE. test/fast-lineup.check.ts.
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
  source: 'cue' | 'even' | 'between';
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
  };
}

const snap = (sec: number, seg: number) => Math.floor(sec / seg) * seg;

/**
 * Breaks for one title of `contentSec` seconds. Returned in order, each with
 * its position in the asset and the break time before it.
 */
export function planBreaks(contentSec: number, cuesSec: number[], policy: AdPolicy, segmentSec = 2): PlannedBreak[] {
  if (!policy.enabled || contentSec <= 0) return [];
  const seg = Math.max(0.5, segmentSec);
  const out: PlannedBreak[] = [];

  const lo = policy.firstAfterMin * 60;
  const hi = contentSec - policy.endGuardMin * 60;
  const gap = policy.minGapMin * 60;
  const totalTarget = (policy.loadMinPerHour * 60 * contentSec) / 3600;
  const midTarget = Math.max(0, totalTarget - policy.betweenSec);
  let nMid = policy.breakSec > 0 ? Math.round(midTarget / policy.breakSec) : 0;
  if (contentSec < policy.minProgrammeMin * 60 || hi <= lo) nMid = 0;
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
  if (policy.betweenSec > 0) {
    out.push({ atAssetSec: contentSec, durationSec: policy.betweenSec, position: 'end', offsetBeforeSec: before, source: 'between' });
  }
  return out;
}

/** Minutes of ads per hour a plan actually ended up with (for the console's load meter). */
export function achievedLoad(contentSec: number, breaks: PlannedBreak[]): number {
  if (contentSec <= 0) return 0;
  const ad = breaks.reduce((s, b) => s + b.durationSec, 0);
  return Math.round(((ad / 60) / (contentSec / 3600)) * 10) / 10;
}
