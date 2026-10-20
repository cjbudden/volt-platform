// ============================================================================
//  THE PLAYER'S ARITHMETIC: programmes, up next, start over, qualities,
//  playlists. Pure functions with no DOM and no Shaka, so every rule here is
//  tested in node (test/player-sdk.check.ts) and ported line for line to the
//  native SDKs.
// ============================================================================
import type { PlaylistItem, Programme, Quality, Source, UpNext } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The programme on air at an instant, or null in a gap. */
export function programmeAt(list: Programme[], at: number): Programme | null {
  for (const p of list) if (p.startsAt <= at && at < p.endsAt) return p;
  return null;
}

/** The first programme starting after an instant. */
export function programmeAfter(list: Programme[], at: number): Programme | null {
  let best: Programme | null = null;
  for (const p of list) if (p.startsAt >= at && (!best || p.startsAt < best.startsAt)) best = p;
  return best;
}

/** Sorted, de-duplicated, and only what is valid. Arrives from a feed; trust nothing. */
export function cleanSchedule(list: unknown): Programme[] {
  if (!Array.isArray(list)) return [];
  const out: Programme[] = [];
  const seen = new Set<string>();
  for (const x of list as any[]) {
    const s = Number(x?.startsAt), e = Number(x?.endsAt);
    if (!x || typeof x.title !== 'string' || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const id = String(x.id ?? `${s}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: x.title, subtitle: x.subtitle ?? null, description: x.description ?? null, imageUrl: x.imageUrl ?? null, startsAt: s, endsAt: e });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

export interface UpNextInput {
  /** VOD playlists */
  hasNextItem: boolean;
  nextItem?: PlaylistItem | null;
  currentTime: number;
  duration: number;
  /** Live EPG */
  live: boolean;
  programme: Programme | null;
  nextProgramme: Programme | null;
  /** What time it is AT THE PLAYHEAD (a viewer 30 s behind live sees the change 30 s later). */
  playheadClock: number | null;
  seconds: number;
  autoAdvance: boolean;
  dismissed: boolean;
}

/**
 * Should the up-next card show, and with what?
 *
 * VOD: in the last `seconds` of an item when there is a next one; it plays by
 * itself at the end when auto-advance is on. LIVE: in the last `seconds` of a
 * programme when the guide knows the next one; informational, because the
 * channel moves on by itself. The window is at least 5 s so a card never
 * flashes up for a frame.
 */
export function upNextFor(i: UpNextInput): UpNext | null {
  if (i.dismissed) return null;
  const windowMs = Math.max(5, i.seconds) * 1000;
  if (!i.live && i.hasNextItem && Number.isFinite(i.duration) && i.duration > 0) {
    const left = (i.duration - i.currentTime) * 1000;
    // Too short an item to be worth interrupting: no card for anything shorter than twice the window.
    if (i.duration * 1000 < windowMs * 2) return null;
    if (left > 0 && left <= windowMs) {
      const n = i.nextItem;
      return { kind: 'item', title: n?.title ?? 'Next', subtitle: n?.subtitle ?? null, artworkUrl: n?.artworkUrl ?? null,
        inMs: Math.max(0, Math.round(left)), autoAdvance: i.autoAdvance, totalMs: windowMs, source: 'playlist' };
    }
    return null;
  }
  if (i.live && i.programme && i.nextProgramme && i.playheadClock != null) {
    const left = i.programme.endsAt - i.playheadClock;
    // The next programme must follow on (allow a five-minute gap); a show that starts tomorrow is not "up next".
    if (i.nextProgramme.startsAt - i.programme.endsAt > 5 * 60_000) return null;
    if (left > 0 && left <= windowMs) {
      return { kind: 'programme', title: i.nextProgramme.title, subtitle: i.nextProgramme.subtitle ?? null,
        artworkUrl: i.nextProgramme.imageUrl ?? null, inMs: Math.round(left), autoAdvance: false, totalMs: windowMs,
        startsAt: i.nextProgramme.startsAt, source: 'guide' };
    }
  }
  return null;
}

/**
 * Where to seek to start the current programme from the beginning.
 *
 * `presentationStart` is the wall-clock instant of media time 0 (from the
 * stream's PROGRAM-DATE-TIME), so programme start S is at media time
 * (S - presentationStart) / 1000. When the start is older than the DVR window
 * the answer is the oldest point available, with `clippedMs` saying how much
 * of the beginning is missing, so the skin can say so rather than pretend.
 */
export function startOverTarget(programmeStart: number, presentationStart: number | null,
  seekable: { start: number; end: number } | null): { seconds: number; clippedMs: number } | null {
  if (presentationStart == null || !seekable || !Number.isFinite(programmeStart)) return null;
  const t = (programmeStart - presentationStart) / 1000;
  if (t > seekable.end) return null;                    // not started yet at the edge
  // A second inside the window: right at the edge of the buffer the segment
  // may already be gone by the time the seek lands.
  const floor = seekable.start + 1;
  if (t >= floor) return { seconds: t, clippedMs: 0 };
  return { seconds: floor, clippedMs: Math.round((floor - t) * 1000) };
}

/** Start over is offered only when the window reaches back to the programme start. */
export function canStartOver(programme: Programme | null, presentationStart: number | null,
  seekable: { start: number; end: number } | null, live: boolean): boolean {
  if (!live || !programme) return false;
  const r = startOverTarget(programme.startsAt, presentationStart, seekable);
  return !!r && r.clippedMs === 0;
}

/**
 * The quality menu from Shaka's variant tracks.
 *
 * ONE ENTRY PER PICTURE SIZE. A ladder often carries the same height at two
 * bitrates, or the same video with two audio languages; a menu listing all of
 * them makes a viewer choose between "720p" and "720p". The highest bitrate for
 * each height is kept (the others are what Auto is for). An audio-only ladder
 * is listed by bitrate instead.
 */
export function qualityList(tracks: Array<{ id: number | string; height?: number | null; width?: number | null; bandwidth: number; audioOnly?: boolean; videoBandwidth?: number | null }>): Quality[] {
  const video = tracks.filter((t) => (t.height ?? 0) > 0);
  if (!video.length) {
    const byRate = new Map<number, Quality>();
    for (const t of tracks) {
      const kbps = Math.round(t.bandwidth / 1000);
      if (!byRate.has(kbps)) byRate.set(kbps, { id: String(t.id), height: null, width: null, bitrate: t.bandwidth, label: `${kbps} kbps` });
    }
    return [...byRate.values()].sort((a, b) => b.bitrate - a.bitrate);
  }
  const byHeight = new Map<number, Quality>();
  for (const t of video) {
    const h = t.height as number;
    const cur = byHeight.get(h);
    if (!cur || t.bandwidth > cur.bitrate) byHeight.set(h, { id: String(t.id), height: h, width: t.width ?? null, bitrate: t.bandwidth, label: qualityLabel(h) });
  }
  return [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

export function qualityLabel(h: number): string {
  if (h >= 2100) return '4K';
  if (h >= 1400) return '1440p';
  return `${h}p`;
}

export function sourceKind(url: string): 'hls' | 'dash' | 'mp3' | 'mp4' {
  const p = url.split('?')[0].toLowerCase();
  if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return 'hls';
  if (p.endsWith('.mpd')) return 'dash';
  if (p.endsWith('.mp3') || p.endsWith('.aac') || p.endsWith('.m4a')) return 'mp3';
  return 'mp4';
}

/** A playlist from whatever was passed: items, asset ids, or URLs. */
export function normalizePlaylist(entries: Array<PlaylistItem | string> | null | undefined): PlaylistItem[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((e, i): PlaylistItem | null => {
    if (typeof e === 'string') {
      const s = e.trim();
      if (!s) return null;
      if (UUID.test(s)) return { id: s, assetId: s };
      return { id: `url-${i}`, source: { url: s }, title: titleFromUrl(s) };
    }
    if (!e || typeof e !== 'object') return null;
    return { ...e, id: String(e.id ?? e.assetId ?? `item-${i}`) };
    // An item with a title but nothing to play yet (a station that is off air)
    // is kept: the player shows it as "not on air" with a retry.
  }).filter((x): x is PlaylistItem => !!x && (!!x.assetId || hasSource(x.source) || !!x.title));
}

export function hasSource(s: Source | null | undefined): boolean {
  return !!s && !!(s.hls || s.dash || s.mp3 || s.url);
}

function titleFromUrl(u: string): string {
  try {
    const last = new URL(u, 'https://x').pathname.split('/').filter(Boolean);
    const name = last.length > 1 && /^(master|index|manifest|playlist)\./i.test(last[last.length - 1]) ? last[last.length - 2] : last[last.length - 1];
    return decodeURIComponent(name ?? u).replace(/\.[a-z0-9]+$/i, '');
  } catch { return u; }
}

/** "12:04", or "1:02:04" past an hour. */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor((sec / 60) % 60), h = Math.floor(sec / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** A wall-clock time in the viewer's own locale. */
export function fmtClock(ms: number): string {
  try { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

/** "in 12 s", "in 3 min". */
export function fmtIn(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}
