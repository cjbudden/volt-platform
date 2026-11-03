// ============================================================================
//  NOW PLAYING, AT THE PLAYHEAD (build queue 1.7b).
//
//  A radio station's songs are in its own playlists (HLS EXT-X-DATERANGE
//  CLASS com.boomlabs.volt.song, DASH EventStream urn:com:boomlabs:volt:song:
//  2026; volt-app/src/services/radio/songTriggers.ts), and reach the player as
//  stream graphics like the programme markers (sdk/triggers.ts). So what is
//  playing is read at the PLAYHEAD: a listener who scrubs back an hour sees
//  that hour's song, the ones before it, and the one that came next, counting
//  down from there. No now-playing API call is made for it.
//
//  AT THE LIVE EDGE the next song is not known yet (nobody knows it until it
//  starts), so "next" is the guide's next programme there, when there is one.
//
//  Pure: no DOM, no Shaka. Tested in node (volt-app/test/player-sdk.check.ts).
// ============================================================================
import type { StreamGraphic, TrackInfo } from './types';

export interface SongsAt {
  /** True when the stream carries songs at all (the station sends titles). */
  carries: boolean;
  nowPlaying: TrackInfo | null;
  /** Newest first, at most five, all ended at or before the playhead. */
  history: TrackInfo[];
  /** The next song after the playhead, or at the live edge the next programme. */
  next: TrackInfo | null;
}

/** A song graphic as a track. `startedAt` is wall clock: the tag's own STARTED,
 *  or the media time on the stream's clock. */
export function trackOf(g: StreamGraphic, presentationStart: number | null): TrackInfo {
  const d = g.data;
  const started = d.started ? Date.parse(d.started) : NaN;
  return {
    title: d.title || '',
    artist: d.artist || null,
    album: d.album || null,
    artworkUrl: d.artwork || null,
    startedAt: Number.isFinite(started) ? started : presentationStart != null ? presentationStart + g.start * 1000 : null,
    listen: d.listen_url ? { service: d.listen_service || 'Apple Music', url: d.listen_url } : null,
  };
}

/**
 * Now playing, the history and what is next at media time `t`.
 * `guideNext` is the guide's next programme, used only when no song after the
 * playhead is known (the live edge).
 */
export function songsAt(all: Iterable<StreamGraphic>, t: number, presentationStart: number | null,
  guideNext: { title: string; subtitle?: string | null; imageUrl?: string | null; startsAt: number } | null = null): SongsAt {
  const songs = [...all].filter((g) => g.graphic === 'song').sort((a, b) => a.start - b.start);
  if (!songs.length) return { carries: false, nowPlaying: null, history: [], next: null };
  let current: StreamGraphic | null = null;
  for (const g of songs) if (g.start <= t && (g.end == null || t < g.end)) current = g;
  const history = songs.filter((g) => g !== current && g.start <= t && (g.end != null ? g.end <= t : false))
    .reverse().slice(0, 5).map((g) => trackOf(g, presentationStart));
  const after = songs.find((g) => g.start > t);
  const next = after ? trackOf(after, presentationStart)
    : guideNext ? { title: guideNext.title, artist: guideNext.subtitle ?? null, artworkUrl: guideNext.imageUrl ?? null, startedAt: guideNext.startsAt }
    : null;
  return { carries: true, nowPlaying: current ? trackOf(current, presentationStart) : null, history, next };
}
