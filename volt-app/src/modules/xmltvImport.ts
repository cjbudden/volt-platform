// ============================================================================
//  XMLTV IMPORT API (mounted at /api/epg/import). See services/xmltvImport.ts.
//
//   GET    /sources                      list, with the last run
//   POST   /sources                      create (url or upload)
//   PATCH  /sources/:id                  rename, re-point, reschedule, enable
//   DELETE /sources/:id                  remove the source; its FUTURE imported
//                                        programmes go with it, history stays
//   POST   /sources/:id/run              run a URL source now
//   POST   /sources/:id/upload           run with the request body as the file
//                                        (XMLTV, optionally gzipped)
//   GET    /sources/:id/channels         their channels and what each maps to
//   PUT    /aliases/:id                  map (or unmap) one of their channels
//   GET    /sources/:id/runs             the run log
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, conflict } from '../util/http';
import { runImport, claimSource, sourceRefPrefix } from '../services/xmltvImport';

export const xmltvImportRouter = Router();
xmltvImportRouter.use(requireAuth);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

async function ownedSource(id: string, account: string) {
  return one<any>(`SELECT * FROM epg_import_sources WHERE id = $1 AND account_id = $2`, [id, account]);
}

const sourceOut = (s: any) => ({
  id: s.id, name: s.name, kind: s.kind, url: s.url, refreshHours: s.refresh_hours, fallbackTz: s.fallback_tz,
  keepPastDays: s.keep_past_days, lang: s.lang, autoMap: s.auto_map, enabled: s.enabled,
  nextRunAt: s.next_run_at, running: !!s.running_since, lastRunAt: s.last_run_at, lastStatus: s.last_status, lastError: s.last_error,
  mapped: s.mapped ?? undefined, unmapped: s.unmapped ?? undefined, lastRun: s.last_run ?? undefined,
});

xmltvImportRouter.get('/sources', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT s.*,
            (SELECT count(*)::int FROM epg_channel_aliases a WHERE a.source_id = s.id AND a.channel_id IS NOT NULL) AS mapped,
            (SELECT count(*)::int FROM epg_channel_aliases a WHERE a.source_id = s.id AND a.channel_id IS NULL) AS unmapped,
            (SELECT row_to_json(r) FROM (SELECT id, trigger, started_at, finished_at, status, counts, warnings, error
                                           FROM epg_import_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) r) AS last_run
       FROM epg_import_sources s WHERE s.account_id = $1 ORDER BY s.created_at`, [accountId(req)]);
  res.json(rows.map(sourceOut));
}));

const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['url', 'upload']),
  url: z.string().trim().url().nullable(),
  refreshHours: z.number().int().min(1).max(168).nullable(),
  fallbackTz: z.string().nullable(),
  keepPastDays: z.number().int().min(0).max(365),
  lang: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).nullable(),
  autoMap: z.boolean(),
  enabled: z.boolean(),
};

function checkSource(b: any) {
  if (b.kind === 'url' && !b.url) throw badRequest('A URL source needs its URL');
  if (b.url && !/^https?:\/\//i.test(b.url)) throw badRequest('The guide URL must be http or https');
  if (b.fallbackTz && !validTz(b.fallbackTz)) throw badRequest(`Unknown time zone: ${b.fallbackTz}`);
}

xmltvImportRouter.post('/sources', asyncHandler(async (req, res) => {
  const b = z.object({ ...fields, url: fields.url.optional(), refreshHours: fields.refreshHours.optional(), fallbackTz: fields.fallbackTz.optional(),
    keepPastDays: fields.keepPastDays.optional(), lang: fields.lang.optional(), autoMap: fields.autoMap.optional(), enabled: fields.enabled.optional() }).parse(req.body ?? {});
  checkSource(b);
  const refresh = b.kind === 'url' ? (b.refreshHours ?? 24) : null;
  const row = await one<any>(
    `INSERT INTO epg_import_sources(account_id, name, kind, url, refresh_hours, fallback_tz, keep_past_days, lang, auto_map, enabled, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $3 = 'url' THEN now() ELSE NULL END) RETURNING *`,
    [accountId(req), b.name, b.kind, b.kind === 'url' ? b.url : null, refresh, b.fallbackTz ?? null, b.keepPastDays ?? 1, b.lang ?? null, b.autoMap ?? true, b.enabled ?? true]);
  res.status(201).json(sourceOut(row));
}));

xmltvImportRouter.patch('/sources/:id', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  const b = z.object(fields).partial().omit({ kind: true }).parse(req.body ?? {});
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const next = { ...cur, ...(has('url') ? { url: b.url } : {}), kind: cur.kind, fallback_tz: has('fallbackTz') ? b.fallbackTz : cur.fallback_tz };
  checkSource({ kind: next.kind, url: next.url, fallbackTz: next.fallback_tz });
  const row = await one<any>(
    `UPDATE epg_import_sources SET name=$2, url=$3, refresh_hours=$4::int, fallback_tz=$5, keep_past_days=$6, lang=$7, auto_map=$8, enabled=$9::boolean,
            next_run_at = CASE WHEN kind = 'url' AND $9::boolean AND $4::int IS NOT NULL THEN COALESCE(last_run_at, now()) + make_interval(hours => $4::int) ELSE NULL END,
            updated_at=now()
      WHERE id=$1 RETURNING *`,
    [cur.id, b.name ?? cur.name, next.url, has('refreshHours') ? b.refreshHours : cur.refresh_hours, next.fallback_tz,
     b.keepPastDays ?? cur.keep_past_days, has('lang') ? b.lang : cur.lang, b.autoMap ?? cur.auto_map, b.enabled ?? cur.enabled]);
  res.json(sourceOut(row));
}));

xmltvImportRouter.delete('/sources/:id', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  // Future programmes this source wrote go with it: a guide nobody imports any
  // more should not keep promising tomorrow's schedule. What already aired stays.
  const gone = await query<any>(
    `DELETE FROM programmes WHERE source_ref LIKE $1 ESCAPE '\\' AND starts_at > now() AND clip_status = 'none' RETURNING id`,
    [escapeLike(`xmltv:${cur.id}:`) + '%']);
  await query(`DELETE FROM epg_import_sources WHERE id = $1`, [cur.id]);
  res.json({ deleted: true, removedProgrammes: gone.length });
}));

xmltvImportRouter.post('/sources/:id/run', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  if (cur.kind !== 'url') throw badRequest('This source takes uploaded files: upload one to run it');
  if (!(await claimSource(cur.id))) throw conflict('This source is already importing');
  res.json(await runImport(cur.id, 'manual'));
}));

/** The request body IS the file: send it as application/xml, text/xml, application/gzip or octet-stream. */
xmltvImportRouter.post('/sources/:id/upload', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  const ct = String(req.headers['content-type'] ?? '');
  if (/json|form/i.test(ct)) throw badRequest('Send the XMLTV file itself as the request body (application/xml or application/gzip)');
  if (!(await claimSource(cur.id))) throw conflict('This source is already importing');
  res.json(await runImport(cur.id, 'upload', req));
}));

xmltvImportRouter.get('/sources/:id/channels', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  const rows = await query<any>(
    `SELECT a.id, a.external_id, a.display_name, a.icon, a.channel_id, a.mapped_by, a.last_seen_at, a.last_programmes, c.name AS channel_name
       FROM epg_channel_aliases a LEFT JOIN channels c ON c.id = a.channel_id
      WHERE a.source_id = $1 ORDER BY (a.channel_id IS NULL) DESC, lower(coalesce(a.display_name, a.external_id))`, [cur.id]);
  res.json(rows.map((r) => ({ id: r.id, externalId: r.external_id, displayName: r.display_name, icon: r.icon, channelId: r.channel_id,
    channelName: r.channel_name, mappedBy: r.mapped_by, lastSeenAt: r.last_seen_at, lastProgrammes: r.last_programmes })));
}));

xmltvImportRouter.put('/aliases/:id', asyncHandler(async (req, res) => {
  const b = z.object({ channelId: z.string().uuid().nullable() }).parse(req.body ?? {});
  const a = await one<any>(`SELECT * FROM epg_channel_aliases WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!a) throw notFound('Channel mapping not found');
  if (b.channelId) {
    const ch = await one(`SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`, [b.channelId, accountId(req)]);
    if (!ch) throw badRequest('That channel is not in this account');
  }
  // Re-pointing a mapping takes this source's FUTURE programmes off the old
  // channel: they were the other channel's guide all along. Aired ones stay.
  let moved = 0;
  if (a.channel_id && a.channel_id !== b.channelId) {
    const gone = await query<any>(
      `DELETE FROM programmes WHERE channel_id = $1 AND source_ref LIKE $2 ESCAPE '\\' AND starts_at > now() AND clip_status = 'none' RETURNING id`,
      [a.channel_id, escapeLike(sourceRefPrefix(a.source_id, a.external_id)) + '%']);
    moved = gone.length;
  }
  await query(`UPDATE epg_channel_aliases SET channel_id = $2, mapped_by = CASE WHEN $2::uuid IS NULL THEN NULL ELSE 'user' END WHERE id = $1`, [a.id, b.channelId]);
  res.json({ id: a.id, channelId: b.channelId, removedFromPrevious: moved });
}));

xmltvImportRouter.get('/sources/:id/runs', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  res.json(await query(`SELECT id, trigger, started_at, finished_at, status, counts, warnings, error FROM epg_import_runs
                          WHERE source_id = $1 ORDER BY started_at DESC LIMIT 50`, [cur.id]));
}));
