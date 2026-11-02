// ============================================================================
//  THE FRAME INDEX (build queue 3.2 (a)). Pure: no I/O.
//
//  Turns a segmented asset into a frame-addressable one without storing a file
//  per frame: for every segment of the asset's video rendition, the number of
//  the first frame in it and how many frames it holds. Frame N is then one
//  lookup away from the one segment that holds it and its place inside, so an
//  exact frame costs one segment read and one short decode (exactFrame.ts).
//
//  Counts come from the segments themselves (the fragment boxes, fmp4.ts, or
//  one ffprobe packet scan for MPEG-TS), never from EXTINF times the frame
//  rate: an encoder lands a segment where the keyframe lands, and a rounded
//  EXTINF is off by a frame often enough that frame numbers would drift.
//
//  Timecode is HH:MM:SS:FF at the asset's own rate. 29.97 and 59.94 use
//  drop-frame (HH:MM:SS;FF), the broadcast convention, so the timecode stays
//  on the clock over long programmes; every other rate is non-drop.
// ============================================================================

export interface Rate { num: number; den: number }

export interface IndexSegment {
  /** Segment URI as written in the media playlist (relative to it). */
  uri: string;
  /** Number of the first frame in this segment, from the start of the asset. */
  startFrame: number;
  /** Frames in this segment. */
  frames: number;
  /** Presentation time of its first frame, in timescale ticks. */
  firstPts: number;
}

export interface FrameIndex {
  v: 1;
  /** Media playlist the segments are listed in, relative to the asset's master. */
  playlist: string;
  /** init.mp4 of that playlist (CMAF), relative to the playlist; null for MPEG-TS. */
  init: string | null;
  container: 'fmp4' | 'ts';
  timescale: number;
  rate: Rate;
  totalFrames: number;
  durationMs: number;
  segments: IndexSegment[];
}

export interface MediaPlaylist { init: string | null; segments: { uri: string; durSec: number }[] }

/** Segments and init of an HLS media playlist. */
export function parseMediaPlaylist(text: string): MediaPlaylist {
  let init: string | null = null;
  let dur = 0;
  const segments: MediaPlaylist['segments'] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-MAP:')) init = /URI="([^"]+)"/.exec(l)?.[1] ?? init;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
    else if (!l.startsWith('#')) { segments.push({ uri: l, durSec: dur }); dur = 0; }
  }
  return { init, segments };
}

/**
 * The video variant of a master playlist to index: the tallest one (ties go to
 * the highest bandwidth). Frame timing is the same in every rung of a ladder,
 * and the tallest gives the best still. Null when the text is already a media
 * playlist or lists no variant.
 */
export function pickVideoVariant(master: string): string | null {
  if (/#EXTINF:/.test(master)) return null;
  const lines = master.split(/\r?\n/).map((l) => l.trim());
  let best: { uri: string; h: number; bw: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = lines[i];
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
    const codecs = /CODECS="([^"]*)"/.exec(attrs)?.[1] ?? '';
    // An audio-only variant has no RESOLUTION and only audio codecs.
    if (!res && codecs && !/avc1|avc3|hvc1|hev1|av01|vp09/i.test(codecs)) continue;
    const h = res ? Number(res[2]) : 0;
    const bw = Number(/BANDWIDTH=(\d+)/.exec(attrs)?.[1] ?? 0);
    if (!best || h > best.h || (h === best.h && bw > best.bw)) best = { uri, h, bw };
  }
  return best?.uri ?? null;
}

function gcd(a: number, b: number): number { while (b) [a, b] = [b, a % b]; return a; }

/** The frame rate a run of sample durations gives: the commonest duration, reduced. */
export function rateFromDurations(durations: number[], timescale: number): Rate | null {
  const count = new Map<number, number>();
  for (const d of durations) if (d > 0) count.set(d, (count.get(d) ?? 0) + 1);
  let best = 0, n = 0;
  for (const [d, c] of count) if (c > n || (c === n && d < best)) { best = d; n = c; }
  if (!best || !timescale) return null;
  const g = gcd(timescale, best);
  return { num: timescale / g, den: best / g };
}

/** A rate from ffprobe's "30000/1001" or "25/1". */
export function parseRate(s: string | null | undefined): Rate | null {
  const m = /^(\d+)\/(\d+)$/.exec(String(s ?? '').trim());
  if (!m || !Number(m[1]) || !Number(m[2])) return null;
  const g = gcd(Number(m[1]), Number(m[2]));
  return { num: Number(m[1]) / g, den: Number(m[2]) / g };
}

export const fps = (r: Rate) => r.num / r.den;

export interface SegmentFrames { uri: string; frames: number; firstPts: number }

/** Put the per-segment counts together into an index. */
export function buildIndex(parts: {
  playlist: string; init: string | null; container: 'fmp4' | 'ts'; timescale: number; rate: Rate; segments: SegmentFrames[];
}): FrameIndex {
  let at = 0;
  const segments: IndexSegment[] = parts.segments.map((s) => {
    const seg = { uri: s.uri, startFrame: at, frames: s.frames, firstPts: s.firstPts };
    at += s.frames;
    return seg;
  });
  return {
    v: 1, playlist: parts.playlist, init: parts.init, container: parts.container,
    timescale: parts.timescale, rate: parts.rate, totalFrames: at,
    durationMs: Math.round(msOfFrame(parts.rate, at)), segments,
  };
}

export interface Located { segmentIndex: number; segment: IndexSegment; localFrame: number }

/** The segment holding frame n and n's place inside it, or null when out of range. */
export function locateFrame(index: FrameIndex, n: number): Located | null {
  if (!Number.isInteger(n) || n < 0 || n >= index.totalFrames) return null;
  // Binary search: an hour at 25 fps in 4 s segments is 900 entries.
  let lo = 0, hi = index.segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = index.segments[mid];
    if (n < s.startFrame) hi = mid - 1;
    else if (n >= s.startFrame + s.frames) lo = mid + 1;
    else return { segmentIndex: mid, segment: s, localFrame: n - s.startFrame };
  }
  return null;
}

/** Milliseconds from the start to the start of frame n. */
export function msOfFrame(rate: Rate, n: number): number {
  return (n * rate.den * 1000) / rate.num;
}

/** The frame on screen at `ms` from the start (the last frame that began at or before it). */
export function frameAtMs(rate: Rate, ms: number): number {
  // The epsilon keeps 40.000000001 ms (float noise) on frame 1 at 25 fps.
  return Math.max(0, Math.floor((ms * rate.num) / (rate.den * 1000) + 1e-6));
}

/** Drop-frame applies to 29.97 and 59.94. */
export function isDropFrame(rate: Rate): boolean {
  return rate.den === 1001 && (rate.num === 30000 || rate.num === 60000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** HH:MM:SS:FF for frame n (HH:MM:SS;FF in drop-frame). */
export function timecode(rate: Rate, n: number): string {
  const nominal = Math.round(fps(rate));
  let f = Math.max(0, Math.floor(n));
  const drop = isDropFrame(rate);
  if (drop) {
    // SMPTE 12M: two frame numbers (four at 59.94) are skipped at the start of
    // every minute except each tenth one.
    const d = nominal === 60 ? 4 : 2;
    const per10 = nominal * 600 - 9 * d;
    const perMin = nominal * 60 - d;
    const tens = Math.floor(f / per10), rem = f % per10;
    f += 9 * d * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const ff = f % nominal;
  const s = Math.floor(f / nominal);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${drop ? ';' : ':'}${pad(ff)}`;
}

/** Frame number of a timecode at this rate, or null when it does not parse or names a dropped number. */
export function parseTimecode(rate: Rate, tc: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/.exec(String(tc).trim());
  if (!m) return null;
  const [h, mi, s, ff] = m.slice(1).map(Number);
  const nominal = Math.round(fps(rate));
  if (mi > 59 || s > 59 || ff >= nominal) return null;
  let n = ((h * 60 + mi) * 60 + s) * nominal + ff;
  if (isDropFrame(rate)) {
    const d = nominal === 60 ? 4 : 2;
    if (s === 0 && ff < d && mi % 10 !== 0) return null;       // a skipped number
    const mins = h * 60 + mi;
    n -= d * (mins - Math.floor(mins / 10));
  }
  return n;
}
