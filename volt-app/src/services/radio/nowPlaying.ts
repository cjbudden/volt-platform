// ============================================================================
//  WHAT IS ON, AND HOW MANY ARE LISTENING. Two labels that were both wrong in
//  the same way: each stated a fact it had not measured.
//
//  "0 MP3 listeners" counted ONLY the clients attached to the control plane's
//  MP3 fan-out. An HLS or DASH audience contributed nothing to it, so a station
//  with four hundred people on HLS and nobody on MP3 read "0 MP3 listeners",
//  which is true of the words and false of the station. Renaming it to
//  "listeners" without changing the number would have made it plainly wrong
//  rather than narrowly right, so the number changes too: MP3 clients plus the
//  live player concurrency for the same stream.
//
//  "Untitled break" was the same mistake in the other direction. It is the
//  correct thing to say about an Icecast station BETWEEN two titles, and the
//  wrong thing to say about an HLS source, which never carries track metadata
//  at all and therefore has no break to be between. An operator reading it on
//  an HLS station concludes the metadata pipeline is broken. Nothing is broken:
//  there is simply nothing to receive, and the honest line names the station
//  and says a schedule has not been entered.
//
//  THE DECISION IS PURE AND LIVES HERE. The same four-way choice is made by the
//  station list, the detail payload and the now-playing poll, and when it lived
//  at the render site as `title || 'Untitled break'` only one of the three had
//  it. now-playing.check.ts pins it without a database.
// ============================================================================
import { query, one } from '../../db';

export type NowKind =
  | 'off'          // the station is not running
  | 'icy'          // a title arrived on the source's own metadata
  | 'epg'          // no title, but a scheduled programme covers now
  | 'gap'          // the source carries metadata and is between titles
  | 'no_metadata'; // the source cannot carry a title, and none is scheduled

export interface NowPlayingView {
  kind: NowKind;
  /** The line to show. Never null, so no caller invents a fallback. */
  text: string;
  /** A second line explaining an absence, when there is one to explain. */
  note: string | null;
}

/**
 * Which sources can carry a now-playing title at all.
 *
 * ICY is an Icecast/SHOUTcast feature: the title is interleaved in the audio
 * body. HLS and SRT have no equivalent that we read, so for those the absence
 * of a title is the normal state and not a fault. Timed ID3 in HLS could carry
 * one and is not implemented; when it is, this is the single place that changes.
 */
export function sourceCarriesTitles(protocol?: string | null, url?: string | null): boolean {
  const p = String(protocol ?? '').toLowerCase();
  const u = String(url ?? '');
  // A PLAYLIST URL SETTLES IT whatever the row says, the same rule
  // looks_like_hls() applies in radio.py: an .m3u8 is HLS even when the
  // protocol column was left as the default.
  if (p === 'hls' || p === 'srt' || p === 'dash' || /\.m3u8(\?|$)/i.test(u) || /\.mpd(\?|$)/i.test(u)) return false;
  return p === 'icecast' || p === 'shoutcast' || p === 'http' || p === 'https' || p === '';
}

/**
 * The one decision, made once.
 *
 * Ordered by how much the operator can trust each answer: a title the source
 * actually sent beats a schedule somebody typed, which beats a statement about
 * why there is nothing to show.
 */
export function resolveNowPlaying(input: {
  live: boolean;
  stationName: string;
  icyTitle?: string | null;
  epgTitle?: string | null;
  /** True when the source protocol can carry a title. See sourceCarriesTitles. */
  carriesTitles: boolean;
}): NowPlayingView {
  const name = (input.stationName || '').trim() || 'This station';
  if (!input.live) return { kind: 'off', text: 'Off air', note: null };

  const icy = (input.icyTitle ?? '').trim();
  if (icy) return { kind: 'icy', text: icy, note: null };

  const epg = (input.epgTitle ?? '').trim();
  if (epg) return { kind: 'epg', text: epg, note: null };

  // NOT A BREAK, AN ABSENCE OF THE CAPABILITY. Saying "Untitled break" here is
  // what makes an operator go looking for a metadata fault that does not exist.
  if (!input.carriesTitles) {
    return {
      kind: 'no_metadata',
      text: name,
      note: 'This source carries no track metadata, and no EPG schedule has been entered for this station.',
    };
  }

  // The source CAN send a title and is not sending one, which is a real break.
  return { kind: 'gap', text: 'Untitled break', note: null };
}

/**
 * The scheduled programme covering right now, if an operator entered one.
 *
 * Deliberately excludes rows the ICY capture wrote (`metadata.source = 'icy'`):
 * those are a LOG of what was received, not a schedule, and using them here
 * would make the EPG fallback echo the title that was already found missing.
 */
export async function scheduledNowTitle(channelId: string): Promise<string | null> {
  const r = await one<any>(
    `SELECT title FROM programmes
      WHERE channel_id = $1
        AND COALESCE(metadata->>'source','') <> 'icy'
        AND starts_at <= now()
        AND (ends_at IS NULL OR ends_at > now())
      ORDER BY starts_at DESC LIMIT 1`,
    [channelId]
  );
  return r?.title ?? null;
}

export interface ListenerCounts {
  /** Clients attached to the MP3 fan-out. */
  mp3: number;
  /** Live HLS/DASH players, from the concurrency snapshot. */
  players: number;
  /** What the console shows. The only number with the plain word "listeners". */
  total: number;
}

/** Freshness window on the concurrency snapshot, matching the fleet total in
 *  platform.ts. A player that stopped heartbeating two minutes ago is gone. */
const CONCURRENCY_FRESH_SEC = 120;

/**
 * Everyone currently receiving this station, however they are receiving it.
 *
 * Summed across asset kinds rather than assuming one, because the player
 * reports whichever kind its own context set and a count that silently omits a
 * delivery path is the bug this function exists to end.
 */
export async function listenerCounts(channelId: string, mp3: number | null): Promise<ListenerCounts> {
  const r = await one<any>(
    `SELECT COALESCE(SUM(concurrent), 0)::int AS n
       FROM stream_concurrency
      WHERE asset_id = $1
        AND updated_at > now() - ($2 || ' seconds')::interval`,
    [channelId, String(CONCURRENCY_FRESH_SEC)]
  );
  const players = Math.max(0, Number(r?.n ?? 0));
  const m = Math.max(0, Number(mp3 ?? 0));
  return { mp3: m, players, total: m + players };
}

/** The same count for a page of stations, in one query rather than one each. */
export async function listenerCountsMany(
  channelIds: string[],
  mp3By: Map<string, number | null>
): Promise<Map<string, ListenerCounts>> {
  const out = new Map<string, ListenerCounts>();
  if (!channelIds.length) return out;
  const rows = await query<any>(
    `SELECT asset_id, COALESCE(SUM(concurrent), 0)::int AS n
       FROM stream_concurrency
      WHERE asset_id = ANY($1)
        AND updated_at > now() - ($2 || ' seconds')::interval
      GROUP BY asset_id`,
    [channelIds, String(CONCURRENCY_FRESH_SEC)]
  );
  const byId = new Map<string, number>(rows.map((r: any) => [String(r.asset_id), Number(r.n) || 0]));
  for (const id of channelIds) {
    const players = Math.max(0, byId.get(id) ?? 0);
    const m = Math.max(0, Number(mp3By.get(id) ?? 0));
    out.set(id, { mp3: m, players, total: m + players });
  }
  return out;
}
