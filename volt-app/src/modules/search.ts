/**
 * Site-wide search (top panel). Account-scoped, name/title match across channels,
 * events and recordings. Each entity is queried defensively so a missing table or
 * column never breaks the whole search.
 */
import { Router } from 'express';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler } from '../util/http';

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get('/', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const q = String(req.query.q ?? '').trim();
  if (!q) { res.json({ results: [] }); return; }
  const like = `%${q}%`;
  const results: Array<{ kind: string; id: string; name: string; href: string; sub?: string }> = [];

  try {
    const chs = await query<any>(
      `SELECT c.id, c.name, c.status FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1 AND c.name ILIKE $2 ORDER BY c.name LIMIT 8`, [acc, like]);
    for (const c of chs) results.push({ kind: 'channel', id: c.id, name: c.name, href: `/channels/${c.id}`, sub: c.status });
  } catch { /* table shape may differ */ }

  try {
    const evs = await query<any>(
      `SELECT e.id, e.name FROM events e JOIN groups g ON g.id = e.group_id
        WHERE g.account_id = $1 AND e.name ILIKE $2 ORDER BY e.name LIMIT 8`, [acc, like]);
    for (const e of evs) results.push({ kind: 'event', id: e.id, name: e.name, href: `/events/${e.id}`, sub: 'event' });
  } catch { /* ignore */ }

  try {
    const vods = await query<any>(
      `SELECT v.id, v.title FROM vod_assets v JOIN channels c ON c.id = v.channel_id
         JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1 AND v.title ILIKE $2 ORDER BY v.title LIMIT 8`, [acc, like]);
    for (const v of vods) results.push({ kind: 'recording', id: v.id, name: v.title, href: `/recordings`, sub: 'recording' });
  } catch { /* ignore */ }

  res.json({ results });
}));
