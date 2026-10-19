/**
 * Site-wide search (top panel). Account-scoped, name/title match across channels,
 * events and recordings. Each entity is queried defensively so a missing table or
 * column never breaks the whole search.
 */
import { Router } from 'express';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler } from '../util/http';
import { can } from '../auth/roles';

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get('/', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const q = String(req.query.q ?? '').trim();
  if (!q) { res.json({ results: [] }); return; }
  const like = `%${q}%`;
  const results: Array<{ kind: string; id: string; name: string; href: string; sub?: string }> = [];

  // A RADIO STATION IS NOT A TV CHANNEL, AND THE ROW ALREADY SAYS SO.
  //
  // `kind: 'channel'` used to be a hardcoded literal here, so every station in
  // the account came back labelled CHANNEL and linked to /channels/<id>. The
  // label was wrong and the link was worse: it opened the television control
  // page for a station, which has a 16:9 video surface, no audio visualiser, no
  // now-playing metadata and no station settings.
  //
  // Nothing was wrong with the data. `channels.kind` has been 'tv' | 'radio'
  // since the first migration, and this query simply did not select it. The
  // literal was doing the classifying instead of the column.
  try {
    const chs = await query<any>(
      `SELECT c.id, c.name, c.status, c.kind FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1 AND c.name ILIKE $2 ORDER BY c.name LIMIT 8`, [acc, like]);
    for (const c of chs) {
      const radio = c.kind === 'radio';
      results.push({
        kind: radio ? 'radio' : 'channel',
        id: c.id,
        name: c.name,
        href: radio ? `/radio/${c.id}` : `/channels/${c.id}`,
        sub: c.status,
      });
    }
  } catch { /* table shape may differ */ }

  try {
    const evs = await query<any>(
      `SELECT e.id, e.name FROM events e JOIN groups g ON g.id = e.group_id
        WHERE g.account_id = $1 AND e.name ILIKE $2 ORDER BY e.name LIMIT 8`, [acc, like]);
    for (const e of evs) results.push({ kind: 'event', id: e.id, name: e.name, href: `/events/${e.id}`, sub: 'event' });
  } catch { /* ignore */ }

  try {
    const vods = await query<any>(
      `SELECT v.id, v.title FROM vod_assets v LEFT JOIN channels c ON c.id=v.channel_id
         LEFT JOIN events e ON e.id=v.event_id
         LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.title ILIKE $2 ORDER BY v.title LIMIT 8`, [acc, like]);
    for (const v of vods) results.push({ kind: 'recording', id: v.id, name: v.title, href: `/recordings`, sub: 'recording' });
  } catch { /* ignore */ }

  // Only what the caller's roles let them see (auth/roles.ts): a Radio
  // Manager's search finds stations, not TV channels or events.
  const need: Record<string, string> = { channel: 'channels', radio: 'radio', event: 'events', recording: 'vod' };
  res.json({ results: results.filter((r) => !need[r.kind] || can(req, need[r.kind], 'view')) });
}));
