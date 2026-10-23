// ============================================================================
//  A station's now-playing changes around now, for the ENCODER to write into
//  its audio segments as ID3 in emsg (volt-encoder/bin/id3_emsg.py).
//
//  Rides on the timed-events poll the radio container already makes
//  (GET /api/streams/:id/timed-events), as `now_playing`. Each entry is one
//  change: when it started, a stable id, and the title split the way players
//  show it (TIT2 title, TPE1 artist).
//
//  The source is the content log the ICY reader writes (programmes rows with
//  metadata.source = 'icy', starts_at = the moment the title changed). A
//  station that sends no titles falls back to its schedule, so a listener
//  still sees the programme name change. The entry in force when the window
//  opens is always included: a segment at the start of the window has to know
//  what was already playing.
// ============================================================================
import { query, one } from '../../db';
import { parseIcyTitle } from './trackMeta';

export interface NowPlayingEntry {
  id: string;
  start: string;          // ISO, when this title started
  title: string;          // TIT2
  artist: string | null;  // TPE1
  source: 'icy' | 'schedule';
}

/** How a logged title is shown. A song ("Artist - Title", the class the ICY
 *  reader gave it) is split; anything else is the title as sent, because
 *  "DJ Max morning show - your calls" is a programme, not an artist and a
 *  song; an empty title (a break on a music station) is the station's name,
 *  which is what a car radio shows between songs. Pure. */
export function id3Fields(raw: string | null | undefined, stationName: string, cls?: string | null): { title: string; artist: string | null } {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { title: (stationName || '').trim() || 'On air', artist: null };
  const split = cls == null || cls === 'song' ? parseIcyTitle(text) : null;
  if (split) return { title: split.title, artist: split.artist };
  return { title: text, artist: null };
}

const LIMIT = 200;

/**
 * The changes in [from, to), plus the one in force at `from`. Null for a
 * channel that is not a radio station (television carries no ID3 here).
 */
export async function nowPlayingTimeline(channelId: string, from: Date, to: Date): Promise<NowPlayingEntry[] | null> {
  const ch = await one<any>(`SELECT kind, name FROM channels WHERE id = $1`, [channelId]);
  if (!ch || ch.kind !== 'radio') return null;

  const rows = async (icy: boolean) => query<any>(
    `WITH log AS (
       SELECT id, title, starts_at, metadata->>'class' AS cls FROM programmes
        WHERE channel_id = $1 AND status <> 'cancelled'
          AND ${icy ? `metadata->>'source' = 'icy'` : `COALESCE(metadata->>'source','') <> 'icy'`})
     (SELECT * FROM log WHERE starts_at <= $2 ORDER BY starts_at DESC LIMIT 1)
     UNION ALL
     (SELECT * FROM log WHERE starts_at > $2 AND starts_at < $3 ORDER BY starts_at LIMIT ${LIMIT})
     ORDER BY starts_at`,
    [channelId, from.toISOString(), to.toISOString()]
  );

  let source: 'icy' | 'schedule' = 'icy';
  let list = await rows(true);
  if (!list.length) { list = await rows(false); source = 'schedule'; }
  return list.map((r) => ({
    id: String(r.id),
    start: new Date(r.starts_at).toISOString(),
    // A schedule row has no class: an operator's title is shown as typed.
    ...id3Fields(r.title, ch.name, source === 'icy' ? (r.cls ?? null) : 'content'),
    source,
  }));
}
