// What a hook or an add-on run is ABOUT: a recording, an asset, a channel or
// an event. Resolving one gives the owning account (every query is tenant
// scoped by it), a title for people, and the media links an add-on needs.
import { one } from '../../db';
import { config } from '../../config';
import type { SubjectType } from './map';

export interface Subject {
  type: SubjectType;
  id: string;
  accountId: string;
  title: string;
  channelId: string | null;
  eventId: string | null;
  durationMs: number | null;
  /** Links the add-on can use to fetch the media. See WORKFLOWS.md "Media access". */
  media: Record<string, unknown>;
  /** The subject in the Volt API, for an add-on holding an account key. */
  apiUrl: string;
}

const base = () => config.publicBaseUrl.replace(/\/$/, '');

export async function resolveSubject(type: SubjectType, id: string): Promise<Subject | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (type === 'recording') {
    const r = await one<any>(
      `SELECT r.*, g.account_id, COALESCE(c.name, e.name) AS owner_name
         FROM recordings r
         LEFT JOIN channels c ON c.id = r.channel_id
         LEFT JOIN events   e ON e.id = r.event_id
         JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE r.id = $1`, [id]);
    if (!r) return null;
    const from = Number(r.start_epoch_ms) || 0;
    const to = Number(r.end_epoch_ms) || (from + (Number(r.duration_ms) || 0));
    return {
      type, id, accountId: r.account_id,
      title: r.title || `${r.owner_name ?? 'Recording'}${r.day_utc ? ` · ${String(r.day_utc).slice(0, 10)}` : ''}`,
      channelId: r.channel_id, eventId: r.event_id,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
      media: {
        hls: from && to > from ? `${base()}/api/recordings/${id}/range/master.m3u8?from=${from}&to=${to}` : null,
        auth: 'account_key',
        startEpochMs: from || null, endEpochMs: to || null,
      },
      apiUrl: `${base()}/api/recordings/${id}`,
    };
  }
  if (type === 'vod_asset') {
    const v = await one<any>(
      `SELECT v.*, COALESCE(v.account_id, g.account_id) AS acct
         FROM vod_assets v
         LEFT JOIN channels c ON c.id = v.channel_id
         LEFT JOIN events   e ON e.id = v.event_id
         LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE v.id = $1`, [id]);
    if (!v || !v.acct) return null;
    return {
      type, id, accountId: v.acct,
      title: v.title || v.original_filename || 'Untitled asset',
      channelId: v.channel_id ?? null, eventId: v.event_id ?? null,
      durationMs: v.duration_ms != null ? Number(v.duration_ms) : null,
      media: {
        hls: v.master_key ? `${base()}/origin/${String(v.master_key).replace(/^\//, '')}` : null,
        progressive: v.progressive_key ? `${base()}/origin/${String(v.progressive_key).replace(/^\//, '')}` : null,
        auth: 'public_origin',
      },
      apiUrl: `${base()}/api/vod/${id}`,
    };
  }
  const tbl = type === 'channel' ? 'channels' : 'events';
  const s = await one<any>(
    `SELECT t.id, t.name, g.account_id FROM ${tbl} t JOIN groups g ON g.id = t.group_id WHERE t.id = $1`, [id]);
  if (!s) return null;
  return {
    type, id, accountId: s.account_id, title: s.name,
    channelId: type === 'channel' ? id : null, eventId: type === 'event' ? id : null,
    durationMs: null, media: {}, apiUrl: `${base()}/api/${tbl}/${id}`,
  };
}
