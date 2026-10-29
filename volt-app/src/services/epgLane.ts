// ============================================================================
//  THE GUIDE LANE: programmes from two hours back to eight ahead, with now,
//  next and each entry's flag (programmeMedia.ts). One builder for every page
//  that shows a guide strip: channel, event and radio station (24 Oct 2026).
//
//  A station's now-playing log lives in the same programmes table (metadata
//  source 'icy'); those are songs, not the schedule, so they stay out of the
//  lane and have their own log on the station page.
// ============================================================================
import { query } from '../db';
import { programmeMedia } from './programmeMedia';

const pad = (n: number) => String(n).padStart(2, '0');
function hhmm(ms: number) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/** A programme outside the lane's window: what the strip names when the window is empty. */
export interface EpgNeighbour { name: string; startMs: number; endMs: number }
export interface EpgLane {
  now: any; next: any; lane: any[];
  /**
   * Only when the lane is empty: the last programme before the window and the
   * first after it. Without these the strip said "No programme guide yet" to a
   * channel whose guide starts tomorrow (build queue 1.14-G5b (d)), which sent
   * the operator off to add programmes that were already there.
   */
  outside?: { previous: EpgNeighbour | null; upcoming: EpgNeighbour | null };
}

export async function epgLane(col: 'channel_id' | 'event_id', ownerId: string, nowMs = Date.now()): Promise<EpgLane> {
  const progs = await query<any>(
    `SELECT id, channel_id, event_id, title, starts_at, ends_at, actual_start, actual_end, clip_asset_id, auto_vod, clip_status, clip_error FROM programmes
       WHERE ${col} = $1 AND ends_at > now() - interval '2 hours' AND starts_at < now() + interval '8 hours'
         AND COALESCE(metadata->>'source', '') <> 'icy'
       ORDER BY starts_at`, [ownerId]);
  const progMedia = await programmeMedia(progs, nowMs).catch(() => new Map());
  let nowObj: any = null; let nextObj: any = null;
  const lane = progs.map((p: any) => {
    const s = new Date(p.starts_at).getTime(); const en = new Date(p.ends_at).getTime();
    const mins = Math.max(1, Math.round((en - s) / 60000));
    const isNow = nowMs >= s && nowMs < en;
    const state = en <= nowMs ? 'past' : isNow ? 'now' : '';
    const entry: any = { id: p.id, name: p.title, start: hhmm(s), end: hhmm(en), mins, state, startMs: s, endMs: en, media: progMedia.get(p.id) ?? null };
    if (isNow) { entry.progress = Math.round(((nowMs - s) / (en - s)) * 100); nowObj = { ...entry, elapsedMin: Math.floor((nowMs - s) / 60000) }; }
    return entry;
  });
  const nextRow = progs.find((p: any) => new Date(p.starts_at).getTime() > nowMs);
  if (nextRow) nextObj = { name: nextRow.title, start: hhmm(new Date(nextRow.starts_at).getTime()), startMs: new Date(nextRow.starts_at).getTime() };
  if (lane.length) return { now: nowObj, next: nextObj, lane };
  // Empty window: look either side of it, so the strip can tell "no guide at
  // all" from "nothing around now". Same filter as the lane (no ICY songs).
  const side = async (where: string, order: string) => {
    const r = await query<any>(
      `SELECT title, starts_at, ends_at FROM programmes
         WHERE ${col} = $1 AND ${where} AND COALESCE(metadata->>'source', '') <> 'icy'
         ORDER BY ${order} LIMIT 1`, [ownerId]);
    return r[0] ? { name: r[0].title, startMs: new Date(r[0].starts_at).getTime(), endMs: new Date(r[0].ends_at).getTime() } : null;
  };
  const [previous, upcoming] = await Promise.all([
    side(`ends_at <= now() - interval '2 hours'`, 'ends_at DESC'),
    side(`starts_at >= now() + interval '8 hours'`, 'starts_at'),
  ]);
  return { now: nowObj, next: nextObj, lane, outside: { previous, upcoming } };
}
