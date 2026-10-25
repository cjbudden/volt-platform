// ============================================================================
//  FILLING A BREAK: ad server answer + house ads + slate = exactly the break.
//
//  THE BREAK NEVER GOES EMPTY AND NEVER RUNS LONG. Its length is fixed by the
//  schedule (the content resumes at a set moment), so whatever the ad server
//  says, the pod is fitted to it:
//
//    1. the ad server's pod ads, in sequence order, then its buffet ads, each
//       only if it is CONDITIONED (already packaged to the channel ladder) and
//       still fits;
//    2. the channel's HOUSE ADS (in-house promos or sponsor spots, already on
//       the ladder) for whatever time is left, rotated so one break does not
//       repeat a spot and consecutive breaks do not open with the same one;
//    3. the channel SLATE for the last few seconds, in whole segments, so the
//       pod ends within half a segment of the break.
//
//  When the ad server times out, errors, returns nothing, or returns only
//  creatives we have not conditioned yet, step 1 is empty and the break is
//  house ads and slate. That is the "in-house replacement ad if the engine
//  fails" requirement, and it is not a special case: it is the same fill.
//
//  An unconditioned creative is not playable THIS time (it is an MP4 at some
//  random bitrate and resolution, not our CMAF ladder), so it is skipped and
//  returned in `toCondition`; the caller queues the one-off packaging job and
//  the creative plays from the next request on. Every commercial stitcher
//  works this way.
//
//  PURE. test/fast-ads.check.ts.
// ============================================================================
import type { VastAd } from './vast';

export interface HouseAd {
  assetId: string;
  title: string;
  durationSec: number;
  weight?: number;
}

export interface Conditioned {
  /** Our packaged copy of the creative. */
  assetId: string;
  durationSec: number;
}

export type PodItem =
  | { kind: 'ad'; adId: string; creativeKey: string; assetId: string; durationSec: number; title?: string; impressions: string[]; tracking: Record<string, string[]> }
  | { kind: 'house'; assetId: string; durationSec: number; title: string }
  | { kind: 'slate'; durationSec: number };

export interface PodPlan {
  items: PodItem[];
  breakSec: number;
  adSec: number;
  houseSec: number;
  slateSec: number;
  /** Paid ad seconds / break seconds. */
  fillRate: number;
  /** Why the break is not all paid ads. */
  fallback: null | 'ad-server-timeout' | 'ad-server-error' | 'no-ads' | 'not-conditioned' | 'partial' | 'off';
  /** Creatives to package now, so they play next time. */
  toCondition: { creativeKey: string; adId: string }[];
  skipped: { adId: string; reason: 'not-conditioned' | 'too-long' | 'no-media' | 'repeat' | 'pod-full' | 'over-max-length' | 'competitive' }[];
}

export interface FillInput {
  breakSec: number;
  segmentSec: number;
  ads: VastAd[];
  conditioned: (creativeKey: string) => Conditioned | null;
  house: HouseAd[];
  /** Which break this is on the channel (rotates the house ads). */
  breakIndex: number;
  /** Set when the ad server call itself failed. */
  serverProblem?: 'timeout' | 'error' | null;
  /** Ad decisioning switched off for this break: house ads and slate only. */
  adsOff?: boolean;
  /** Ads must not exceed the break by more than this. */
  toleranceSec?: number;
  /** Pod shape: most paid ads in one break, and the longest single ad (0 = no limit). */
  maxAds?: number;
  maxAdSec?: number;
  /** Competitive separation: one ad per advertiser (or category) in a pod. */
  separate?: (ad: VastAd) => string | null;
}

export function fillBreak(i: FillInput): PodPlan {
  const tol = i.toleranceSec ?? 0.5;
  let left = i.breakSec;
  const items: PodItem[] = [];
  const toCondition: PodPlan['toCondition'] = [];
  const skipped: PodPlan['skipped'] = [];
  const usedCreatives = new Set<string>();
  const usedSeparation = new Set<string>();
  let paid = 0;
  let adSec = 0, houseSec = 0, slateSec = 0;

  if (!i.adsOff) {
    for (const ad of i.ads) {
      if (usedCreatives.has(ad.creativeKey)) { skipped.push({ adId: ad.id, reason: 'repeat' }); continue; }
      if (i.maxAds && paid >= i.maxAds) { skipped.push({ adId: ad.id, reason: 'pod-full' }); continue; }
      if (i.maxAdSec && ad.durationSec > i.maxAdSec + 0.5) { skipped.push({ adId: ad.id, reason: 'over-max-length' }); continue; }
      const sepKey = i.separate?.(ad) ?? null;
      if (sepKey && usedSeparation.has(sepKey)) { skipped.push({ adId: ad.id, reason: 'competitive' }); continue; }
      if (!ad.mediaFiles.length && !ad.mezzanine) { skipped.push({ adId: ad.id, reason: 'no-media' }); continue; }
      const c = i.conditioned(ad.creativeKey);
      if (!c) {
        skipped.push({ adId: ad.id, reason: 'not-conditioned' });
        if (!toCondition.some((x) => x.creativeKey === ad.creativeKey)) toCondition.push({ creativeKey: ad.creativeKey, adId: ad.id });
        continue;
      }
      if (c.durationSec > left + tol) { skipped.push({ adId: ad.id, reason: 'too-long' }); continue; }
      items.push({ kind: 'ad', adId: ad.id, creativeKey: ad.creativeKey, assetId: c.assetId, durationSec: c.durationSec, title: ad.title, impressions: ad.impressions, tracking: ad.tracking });
      usedCreatives.add(ad.creativeKey);
      if (sepKey) usedSeparation.add(sepKey);
      paid++;
      left -= c.durationSec;
      adSec += c.durationSec;
    }
  }

  // house ads: rotate the starting point by break, never repeat inside a pod
  const house = i.house.filter((h) => h.durationSec > 0);
  if (house.length && left > i.segmentSec / 2) {
    const order = weightedOrder(house, i.breakIndex);
    const used = new Set<string>();
    let progress = true;
    while (progress && left > i.segmentSec / 2) {
      progress = false;
      for (const h of order) {
        if (used.has(h.assetId)) continue;
        if (h.durationSec <= left + tol) {
          items.push({ kind: 'house', assetId: h.assetId, durationSec: h.durationSec, title: h.title });
          used.add(h.assetId);
          left -= h.durationSec;
          houseSec += h.durationSec;
          progress = true;
          break;
        }
      }
    }
  }

  // slate: whole segments, ending within half a segment of the break
  if (left > i.segmentSec / 2) {
    // round half DOWN: the pod may end a little early, never late
    const n = Math.floor(left / i.segmentSec + 0.5 - 1e-9);
    const d = n * i.segmentSec;
    items.push({ kind: 'slate', durationSec: d });
    slateSec = d;
    left -= d;
  }

  const fill = i.breakSec > 0 ? adSec / i.breakSec : 0;
  let fallback: PodPlan['fallback'] = null;
  if (i.adsOff) fallback = 'off';
  else if (i.serverProblem === 'timeout') fallback = 'ad-server-timeout';
  else if (i.serverProblem === 'error') fallback = 'ad-server-error';
  else if (!i.ads.length) fallback = 'no-ads';
  else if (adSec === 0 && toCondition.length) fallback = 'not-conditioned';
  else if (fill < 0.98) fallback = 'partial';

  return {
    items, breakSec: i.breakSec, adSec, houseSec, slateSec, fillRate: Math.round(fill * 1000) / 1000,
    fallback, toCondition, skipped,
  };
}

/** Deterministic weighted rotation: heavier spots come round more often. */
function weightedOrder(house: HouseAd[], breakIndex: number): HouseAd[] {
  const expanded: HouseAd[] = [];
  for (const h of house) for (let k = 0; k < Math.max(1, Math.round(h.weight ?? 1)); k++) expanded.push(h);
  const start = ((breakIndex % expanded.length) + expanded.length) % expanded.length;
  const rotated = [...expanded.slice(start), ...expanded.slice(0, start)];
  const seen = new Set<string>();
  return rotated.filter((h) => (seen.has(h.assetId) ? false : (seen.add(h.assetId), true)));
}

/**
 * The fill the SHARED channel output carries in a break: house ads and slate,
 * no ad server. This is what a viewer sees when nothing replaces the break
 * (a platform that does not stitch, a player with ads off, our stitcher
 * failing open), so it is a real promo break, never black.
 */
export function houseFill(breakSec: number, segmentSec: number, house: HouseAd[], breakIndex: number): PodPlan {
  return fillBreak({ breakSec, segmentSec, ads: [], conditioned: () => null, house, breakIndex, adsOff: true });
}
