// ============================================================================
//  SERVER-SIDE AD BEACONS for stitched breaks: WHEN each one is due.
//
//  An ad server only gets paid for what it is told was seen. In a stitched
//  break the player never sees the VAST (it plays our playlist, and the ad is
//  just more segments), so the stitcher has to send the ad's impression and
//  tracking pixels itself: impression, creativeView and start when the ad
//  begins, then firstQuartile, midpoint, thirdQuartile and complete, plus any
//  VAST 4 progress offsets. That is "server-side reporting" in IAB terms.
//
//  WHERE IS THE VIEWER? Every segment is a shared file on the CDN, so the
//  stitcher never sees segment requests. What it does see is the session's
//  own playlist refreshes, every target duration or so, and a live player
//  plays a known distance behind the newest segment it was given (HOLD-BACK
//  when the playlist states one, else three target durations, which is what
//  hls.js, Shaka and Safari default to). So on each refresh:
//
//      playhead = end of the newest segment in the session playlist - hold back
//
//  and every beacon whose moment the playhead has passed is due. A viewer who
//  closes the player stops refreshing, so the beacons after that moment are
//  never sent: a viewer who leaves halfway gives an impression, a start and a
//  first quartile, and no complete. That is the whole point of quartiles.
//
//  A GAP IS NOT VIEWING. If refreshes stop for longer than `maxGapMs` and
//  start again (a laptop lid, a lost connection), the time in between was not
//  seen, so its beacons are skipped, not sent late. The first refresh of a
//  session likewise only starts the clock.
//
//  ORDER. Due beacons come back sorted by their moment, and at the same moment
//  in VAST order (impression, creativeView, start, ...). The sender keeps that
//  order per session.
//
//  PURE: plan, playlist text and clock in, a list out. The sending (macros,
//  private address guard, the log) is beaconSender.ts.
//  test/fast-beacons.check.ts.
// ============================================================================
import type { PodItem } from './pod';
import { parseDuration } from './vast';
import { parsePlaylist } from './stitch';

/** The events a server can honestly send. Pause, mute, skip, click are the player's to report. */
export const SERVER_EVENTS = ['impression', 'creativeView', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete'] as const;
const FRACTION: Record<string, number> = { impression: 0, creativeView: 0, start: 0, firstQuartile: 0.25, midpoint: 0.5, thirdQuartile: 0.75, complete: 1 };
const RANK: Record<string, number> = { impression: 0, creativeView: 1, start: 2, firstQuartile: 4, midpoint: 5, thirdQuartile: 6, complete: 7 };

export interface BeaconEvent {
  /** impression, start, firstQuartile ... or progress@<offset> */
  event: string;
  /** Wall-clock (PROGRAM-DATE-TIME) moment it is due. */
  atMs: number;
  /** Seconds into the ad. */
  offsetSec: number;
  urls: string[];
}

export interface ScheduledAd {
  breakId: string;
  /** Position of the item in the pod (0 based, counting house spots and slate). */
  podIndex: number;
  adId: string;
  creativeKey: string;
  title?: string;
  startMs: number;
  durationSec: number;
  events: BeaconEvent[];
}

/** A VAST 4 progress offset ("00:00:05", "00:00:05.500" or "25%") to seconds into the ad. */
export function progressOffsetSec(offset: string, durationSec: number): number | null {
  const o = offset.trim();
  const pct = o.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return Math.min(100, Number(pct[1])) / 100 * durationSec;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(o)) return null;
  const s = parseDuration(o);
  return s <= durationSec ? s : null;
}

/**
 * The paid ads of a decided pod, laid on the break's clock, each with its
 * beacons. Mirrors the stitcher: items play back to back from the break
 * start, and nothing is placed in the last quarter second of the break (the
 * stitcher drops those segments), so an ad cut by the break end gets its
 * complete at the break end, and an ad that would start after it gets none.
 */
export function adSchedule(breakId: string, items: PodItem[], breakStartMs: number, breakSec: number): ScheduledAd[] {
  const out: ScheduledAd[] = [];
  const endMs = breakStartMs + breakSec * 1000;
  let t = breakStartMs;
  items.forEach((it, podIndex) => {
    const start = t;
    t += it.durationSec * 1000;
    if (it.kind !== 'ad') return;
    if (start >= endMs - 250) return;
    const dur = Math.min(it.durationSec, (endMs - start) / 1000);
    const events: BeaconEvent[] = [];
    const add = (event: string, offsetSec: number, urls: string[] | undefined) => {
      const u = (urls ?? []).map((x) => x.trim()).filter(Boolean);
      if (u.length) events.push({ event, atMs: Math.round(start + offsetSec * 1000), offsetSec, urls: u });
    };
    add('impression', 0, it.impressions);
    for (const e of SERVER_EVENTS) if (e !== 'impression') add(e, FRACTION[e] * dur, it.tracking?.[e]);
    for (const [k, urls] of Object.entries(it.tracking ?? {})) {
      if (!k.startsWith('progress@')) continue;
      const off = progressOffsetSec(k.slice('progress@'.length), dur);
      if (off != null) add(k, off, urls);
    }
    events.sort((a, b) => a.atMs - b.atMs || rank(a.event) - rank(b.event));
    out.push({ breakId, podIndex, adId: it.adId, creativeKey: it.creativeKey, title: it.title, startMs: start, durationSec: dur, events });
  });
  return out;
}
const rank = (e: string) => RANK[e] ?? 8; // a progress event comes after the standard event it shares a moment with

/**
 * Where a live player is on this playlist: the end of the newest segment
 * minus the hold back (EXT-X-SERVER-CONTROL HOLD-BACK, else 3 target durations).
 * Null when the playlist has no PROGRAM-DATE-TIME to place it on.
 */
export function playheadOf(text: string): number | null {
  const p = parsePlaylist(text);
  if (!p || !p.entries.length) return null;
  const last = p.entries[p.entries.length - 1];
  if (last.pdtMs == null || !Number.isFinite(last.pdtMs)) return null;
  const target = Number(p.header.find((h) => h.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1] ?? NaN);
  const sc = p.header.find((h) => h.startsWith('#EXT-X-SERVER-CONTROL:'));
  const hb = Number(sc?.match(/HOLD-BACK=([\d.]+)/)?.[1] ?? NaN);
  const holdBackSec = Number.isFinite(hb) ? hb : 3 * (Number.isFinite(target) && target > 0 ? target : last.dur);
  return Math.round(last.pdtMs + last.dur * 1000 - holdBackSec * 1000);
}

export interface BeaconState {
  /** Wall clock of the last refresh that moved the playhead. */
  lastNowMs?: number;
  lastPlayheadMs?: number;
  /** "<break>/<podIndex>/<event>" already sent or skipped. */
  done: string[];
}

export interface DueBeacon extends BeaconEvent {
  breakId: string;
  podIndex: number;
  adId: string;
  creativeKey: string;
}

export const MAX_GAP_MS = 30_000;

/**
 * The beacons this refresh makes due, in the order they must be sent, and
 * the ones it skips because the viewer was not watching when they fell due.
 * Updates `state`.
 */
export function dueBeacons(state: BeaconState, ads: ScheduledAd[], playheadMs: number, nowMs: number, maxGapMs = MAX_GAP_MS): { due: DueBeacon[]; skipped: DueBeacon[] } {
  const done = new Set(state.done);
  const continuous = state.lastNowMs != null && state.lastPlayheadMs != null && nowMs - state.lastNowMs <= maxGapMs;
  // the playhead only moves forward: audio and video playlists end a little apart
  const head = continuous ? Math.max(playheadMs, state.lastPlayheadMs!) : playheadMs;
  const due: DueBeacon[] = [], skipped: DueBeacon[] = [];
  for (const ad of ads) {
    for (const ev of ad.events) {
      const key = `${ad.breakId}/${ad.podIndex}/${ev.event}`;
      if (done.has(key) || ev.atMs > head) continue;
      const b: DueBeacon = { ...ev, breakId: ad.breakId, podIndex: ad.podIndex, adId: ad.adId, creativeKey: ad.creativeKey };
      // seen = between the last refresh's playhead and this one's
      if (continuous && ev.atMs >= state.lastPlayheadMs! - 1) due.push(b); else skipped.push(b);
      done.add(key);
    }
  }
  due.sort((a, b) => a.atMs - b.atMs || a.breakId.localeCompare(b.breakId) || a.podIndex - b.podIndex || rank(a.event) - rank(b.event));
  // forget breaks that are no longer in play, so the state stays small
  const live = new Set(ads.map((a) => a.breakId));
  state.done = [...done].filter((k) => live.has(k.split('/')[0]));
  state.lastNowMs = nowMs;
  state.lastPlayheadMs = head;
  return { due, skipped };
}

// ---------------------------------------------------------------- macros

const hms = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
};

/**
 * Fill the IAB macros a tracking URL may carry, in the plain [MACRO] form and
 * the percent-encoded %5BMACRO%5D form some servers write. Unknown macros are
 * left alone, as the VAST spec asks.
 */
export function fillBeaconUrl(u: string, m: { nowMs: number; adPlayheadSec: number; cacheBuster?: string; breakPosition?: number }): string {
  const v: Record<string, string> = {
    TIMESTAMP: new Date(m.nowMs).toISOString(),
    CACHEBUSTING: m.cacheBuster ?? String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
    ADPLAYHEAD: hms(m.adPlayheadSec),
    MEDIAPLAYHEAD: hms(m.adPlayheadSec),
    // 2 = mid-roll; a live or FAST break is always inside the content
    BREAKPOSITION: String(m.breakPosition ?? 2),
  };
  const sub = (w: string, n: string) => (Object.prototype.hasOwnProperty.call(v, n) ? encodeURIComponent(v[n]) : w);
  return u.replace(/\[([A-Z][A-Z0-9_]*)\]/g, (w, n) => sub(w, n)).replace(/%5B([A-Z][A-Z0-9_]*)%5D/gi, (w, n) => sub(w, n.toUpperCase()));
}
