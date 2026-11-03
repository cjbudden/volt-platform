// ============================================================================
//  SONGS IN THE MANIFEST, READ AT THE PLAYHEAD (build queue 1.7b).
//
//  Christian, 3 Nov 2026: DVR must show what was playing where the listener
//  is, not what is playing now. So every song the ICY reader logs becomes a
//  timed entry in the station's own playlists, beside the programme markers:
//
//    HLS   #EXT-X-DATERANGE CLASS="com.boomlabs.volt.song", START-DATE the
//          moment the title changed, X-TITLE, X-ARTIST, X-ALBUM, X-ARTWORK,
//          X-LISTEN-URL and X-LISTEN-SERVICE
//    DASH  an Event in an EventStream urn:com:boomlabs:volt:song:2026
//
//  built here and placed by the station container (volt-encoder/bin/
//  timed_events.py, the same path as the graphic triggers), so a player reads
//  the song at its own playhead (volt-player sdk/songs.ts) and needs no
//  now-playing API at all.
//
//  NOTHING ALREADY WRITTEN EVER CHANGES (the HLS rule for a DATERANGE that is
//  repeated: attributes may be ADDED, never altered). So:
//    - the song on air has no DURATION; it is added when the next title starts;
//    - X-ARTWORK is only ever the cover stored on the guide entry (ours, final:
//      jobs/handlers/songArtwork.ts), added once that job has found it, never
//      the live lookup's link that could later be replaced by it;
//    - X-ALBUM only once the metadata lookup has settled on a hit.
//  Entries are what the window holds: the encoder keeps only those that
//  overlap a playlist's own window (the DVR window), so they fall away with it.
// ============================================================================
import { query } from '../../db';
import type { Trigger } from '../graphicTriggers';
import { id3Fields } from './nowPlayingTimeline';

export const CLASS_SONG = 'com.boomlabs.volt.song';
export { SCHEME_SONG } from '../graphicTriggers';

export interface SongRow {
  id: string;
  title: string;
  startsAt: Date;
  cls: string | null;
  image: string | null;
  provider: string | null;
  link: string | null;
}

export interface SongExtras {
  album?: string | null;
  /** A signed URL of the stored cover, already resolved. */
  artwork?: string | null;
  listen?: { service: string; url: string } | null;
}

/**
 * The song triggers for a station's content log (newest last). Pure: each
 * entry ends where the next logged entry (of any class) starts; the last one
 * is open. Only songs become triggers: an advert or a DJ link is the end of
 * the song before it, not a song.
 */
export function songTriggers(rows: SongRow[], stationName: string, extras: (r: SongRow) => SongExtras = () => ({})): Trigger[] {
  const list = [...rows].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const out: Trigger[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if ((r.cls ?? 'song') !== 'song' || !String(r.title ?? '').trim()) continue;
    const next = list[i + 1];
    const dur = next ? (next.startsAt.getTime() - r.startsAt.getTime()) / 1000 : null;
    const f = id3Fields(r.title, stationName, 'song');
    const x = extras(r);
    out.push({
      id: `song:${r.id}`, cls: CLASS_SONG, graphic: 'song', start: r.startsAt,
      durationSec: dur != null && dur > 0 ? dur : null,
      data: {
        TITLE: f.title,
        ...(f.artist ? { ARTIST: f.artist } : {}),
        // When it started, for "played at" in a history list (the player only
        // gets media time from the tag's own START-DATE).
        STARTED: r.startsAt.toISOString(),
        ...(x.album ? { ALBUM: x.album } : {}),
        ...(x.artwork ? { ARTWORK: x.artwork } : {}),
        ...(x.listen ? { 'LISTEN-URL': x.listen.url, 'LISTEN-SERVICE': x.listen.service } : {}),
      },
    });
  }
  return out;
}

/**
 * A station's song triggers over [from, to): the entry in force at `from` and
 * every one after it, each with what has settled about it. Null for a channel
 * that is not a radio station. Cached ten seconds per station and minute: the
 * station's container asks every few seconds, and a new title announces
 * `asset:<id>`, which drops the entry at once.
 */
export async function songTriggersForStream(channelId: string, from: Date, to: Date): Promise<Trigger[] | null> {
  const { cached } = await import('../../scale/cache');
  const ch = await cached(`radiokind:${channelId}`, { ttlSec: 300, tags: [`asset:${channelId}`] }, async () =>
    (await query<any>(`SELECT kind, name FROM channels WHERE id = $1`, [channelId]))[0] ?? null);
  if (!ch || ch.kind !== 'radio') return null;
  const key = `songtrig:${channelId}:${Math.floor(from.getTime() / 60_000)}:${Math.floor(to.getTime() / 60_000)}`;
  return cached(key, { ttlSec: 10, tags: [`asset:${channelId}`] }, async () => {
    const rows = await query<any>(
      `WITH log AS (
         SELECT id, title, starts_at, metadata->>'class' AS cls, metadata->>'image' AS image,
                metadata->'music'->>'provider' AS provider, metadata->'music'->>'link' AS link
           FROM programmes
          WHERE channel_id = $1 AND status <> 'cancelled' AND metadata->>'source' = 'icy')
       (SELECT * FROM log WHERE starts_at <= $2 ORDER BY starts_at DESC LIMIT 1)
       UNION ALL
       (SELECT * FROM log WHERE starts_at > $2 AND starts_at < $3 ORDER BY starts_at LIMIT 500)
       ORDER BY starts_at`,
      [channelId, from.toISOString(), to.toISOString()]);
    const list: SongRow[] = rows.map((r) => ({ id: String(r.id), title: String(r.title ?? ''), startsAt: new Date(r.starts_at), cls: r.cls ?? null, image: r.image ?? null, provider: r.provider ?? null, link: r.link ?? null }));
    const { cachedTrackMeta } = await import('./trackMeta');
    const { signedImageUrl } = await import('../../modules/images');
    const albums = new Map<string, string | null>();
    for (const r of list) {
      if ((r.cls ?? 'song') !== 'song') continue;
      const m = await cachedTrackMeta(r.title).catch(() => null);
      albums.set(r.id, m && m.state === 'hit' ? (m.album ?? null) : null);
    }
    const artwork = (ref: string | null) => {
      if (!ref || !/^\/?library\//.test(ref)) return null;
      try { return signedImageUrl(ref, '600x600,inside'); } catch { return null; }
    };
    return songTriggers(list, ch.name, (r) => {
      const art = artwork(r.image);
      return {
        album: albums.get(r.id) ?? null,
        artwork: art,
        // Apple's artwork may be shown only with a link to the song on Apple Music.
        listen: art && r.provider === 'apple' && r.link && /^https:\/\/music\.apple\.com\//.test(r.link) ? { service: 'Apple Music', url: r.link } : null,
      };
    });
  });
}
