// ============================================================================
//  XMLTV IMPORT API (mounted at /api/epg/import). See services/xmltvImport.ts.
//
//   GET    /sources                      list, with the last run
//   POST   /sources                      create (url or upload)
//   PATCH  /sources/:id                  rename, re-point, reschedule, enable
//   DELETE /sources/:id                  remove the source; its FUTURE imported
//                                        programmes go with it, history stays
//   POST   /sources/:id/run              run a URL source now
//   POST   /sources/:id/test             fetch its first request and say what is
//                                        in it, writing nothing (guide APIs)
//   POST   /sources/:id/upload           run with the request body as the file
//                                        (XMLTV, optionally gzipped)
//   GET    /sources/:id/channels         the feed's lineup: each of their channels,
//                                        used (and on which Volt channel), not
//                                        used, or waiting; number, programmes,
//                                        span, same-named siblings, a suggestion
//   PUT    /aliases/:id                  use one of their channels on a Volt
//                                        channel, or mark it not used / waiting
//   POST   /sources/:id/channels/bulk    many at once: not used, waiting, accept
//                                        suggestions, or create Volt channels
//   GET    /sources/:id/runs             the run log
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, conflict, forbidden } from '../util/http';
import { runImport, claimSource, sourceRefPrefix, sourceHeaders, testSource, coverageOf } from '../services/xmltvImport';
import { planRequests, templateProblem, headerProblem, daysAheadOf, DATE_FORMATS } from '../services/xmltvRequests';
import { seal } from '../services/social/crypto';
import { suggest, duplicateNames, otherFeeders, aliasOf } from '../services/xmltvLineup';
import { validateEntityMetadata } from './metadataSchemas';
import { defaultTypeId } from '../services/contentTypes';
import { actor, writeAudit } from '../services/audit';
import { resolveAccess } from '../auth/roles';
import { XMLTV_ID_RX } from '../services/xmltv';

export const xmltvImportRouter = Router();
xmltvImportRouter.use(requireAuth);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

async function ownedSource(id: string, account: string) {
  return one<any>(`SELECT * FROM epg_import_sources WHERE id = $1 AND account_id = $2`, [id, account]);
}

function plannedUrls(s: any): { url: string; day: string | null }[] {
  if (s.kind !== 'url' || !s.url || templateProblem(s.url, s.request_mode)) return [];
  return planRequests({ template: s.url, mode: s.request_mode, daysAhead: s.days_ahead, dateFormat: s.date_format, zone: s.fallback_tz, now: new Date() })
    .requests.map((r) => ({ url: r.url, day: r.day }));
}

const sourceOut = (s: any) => ({
  id: s.id, name: s.name, kind: s.kind, url: s.url, refreshHours: s.refresh_hours, fallbackTz: s.fallback_tz,
  requestMode: s.request_mode, daysAhead: s.days_ahead, minDaysAhead: s.min_days_ahead, dateFormat: s.date_format,
  headerNames: Object.keys(sourceHeaders(s)), plannedRequests: plannedUrls(s), consecutiveFailures: s.consecutive_failures,
  coverageUntil: s.coverage_until, coverageDaysAhead: daysAheadOf(s.coverage_until ? new Date(s.coverage_until) : null, new Date()),
  coverageLow: !!s.coverage_low_since, newChannels: s.new_channels,
  notUsed: s.not_used ?? undefined,
  keepPastDays: s.keep_past_days, lang: s.lang, autoMap: s.auto_map, enabled: s.enabled,
  nextRunAt: s.next_run_at, running: !!s.running_since, lastRunAt: s.last_run_at, lastStatus: s.last_status, lastError: s.last_error,
  mapped: s.mapped ?? undefined, unmapped: s.unmapped ?? undefined, lastRun: s.last_run ?? undefined,
});

xmltvImportRouter.get('/sources', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT s.*,
            (SELECT count(*)::int FROM epg_channel_aliases a WHERE a.source_id = s.id AND a.channel_id IS NOT NULL) AS mapped,
            (SELECT count(*)::int FROM epg_channel_aliases a WHERE a.source_id = s.id AND a.channel_id IS NULL AND NOT a.ignored) AS unmapped,
            (SELECT count(*)::int FROM epg_channel_aliases a WHERE a.source_id = s.id AND a.channel_id IS NULL AND a.ignored) AS not_used,
            (SELECT row_to_json(r) FROM (SELECT id, trigger, started_at, finished_at, status, counts, warnings, error
                                           FROM epg_import_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) r) AS last_run
       FROM epg_import_sources s WHERE s.account_id = $1 ORDER BY s.created_at`, [accountId(req)]);
  res.json(rows.map(sourceOut));
}));

const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['url', 'upload']),
  url: z.string().trim().min(8).max(2000).nullable(),
  refreshHours: z.number().int().min(1).max(168).nullable(),
  fallbackTz: z.string().nullable(),
  keepPastDays: z.number().int().min(0).max(365),
  lang: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).nullable(),
  autoMap: z.boolean(),
  enabled: z.boolean(),
  requestMode: z.enum(['single', 'per_day']),
  daysAhead: z.number().int().min(1).max(21),
  minDaysAhead: z.number().int().min(0).max(21),
  dateFormat: z.enum(DATE_FORMATS as [string, ...string[]]),
  /** Merged into the stored set: a string sets that header, null removes it. Values are never sent back. */
  headers: z.record(z.string(), z.string().max(4000).nullable()),
  /** What a channel the feed has never listed before starts as. */
  newChannels: z.enum(['review', 'ignore']),
};

function checkSource(b: any) {
  if (b.kind === 'url' && !b.url) throw badRequest('A URL source needs its URL');
  if (b.url && !/^https?:\/\//i.test(b.url)) throw badRequest('The guide URL must be http or https');
  if (b.kind === 'url' && b.url) { const why = templateProblem(b.url, b.requestMode ?? 'single'); if (why) throw badRequest(why); }
  if (b.fallbackTz && !validTz(b.fallbackTz)) throw badRequest(`Unknown time zone: ${b.fallbackTz}`);
  const days = b.daysAhead ?? 7, min = b.minDaysAhead ?? Math.min(5, days);
  if (min > days) throw badRequest(`The minimum (${min} days) cannot be more than the days ahead (${days})`);
}

/** The stored headers with `changes` applied, sealed; or the stored value when nothing changed. */
function mergeHeaders(cur: any, changes: Record<string, string | null> | undefined): string | null {
  const h: Record<string, string> = cur ? sourceHeaders(cur) : {};
  if (!changes) return cur?.request_headers ?? null;
  for (const [k, v] of Object.entries(changes)) {
    const name = k.trim().toLowerCase();
    const why = headerProblem(name);
    if (why) throw badRequest(why);
    if (v == null || v === '') delete h[name]; else h[name] = v;
  }
  if (Object.keys(h).length > 10) throw badRequest('At most 10 headers');
  return Object.keys(h).length ? seal(JSON.stringify(h)) : null;
}

xmltvImportRouter.post('/sources', asyncHandler(async (req, res) => {
  const b = z.object({ ...fields, url: fields.url.optional(), refreshHours: fields.refreshHours.optional(), fallbackTz: fields.fallbackTz.optional(),
    keepPastDays: fields.keepPastDays.optional(), lang: fields.lang.optional(), autoMap: fields.autoMap.optional(), enabled: fields.enabled.optional(),
    requestMode: fields.requestMode.optional(), daysAhead: fields.daysAhead.optional(), minDaysAhead: fields.minDaysAhead.optional(),
    dateFormat: fields.dateFormat.optional(), headers: fields.headers.optional(), newChannels: fields.newChannels.optional() }).parse(req.body ?? {});
  checkSource(b);
  const refresh = b.kind === 'url' ? (b.refreshHours ?? 24) : null;
  const days = b.daysAhead ?? 7;
  const row = await one<any>(
    `INSERT INTO epg_import_sources(account_id, name, kind, url, refresh_hours, fallback_tz, keep_past_days, lang, auto_map, enabled, next_run_at,
                                    request_mode, days_ahead, min_days_ahead, date_format, request_headers, new_channels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $3 = 'url' THEN now() ELSE NULL END, $11,$12,$13,$14,$15,$16) RETURNING *`,
    [accountId(req), b.name, b.kind, b.kind === 'url' ? b.url : null, refresh, b.fallbackTz ?? null, b.keepPastDays ?? 1, b.lang ?? null, b.autoMap ?? true, b.enabled ?? true,
     b.requestMode ?? 'single', days, b.minDaysAhead ?? Math.min(5, days), b.dateFormat ?? 'YYYY-MM-DD', b.kind === 'url' ? mergeHeaders(null, b.headers) : null, b.newChannels ?? 'review']);
  res.status(201).json(sourceOut(row));
}));

xmltvImportRouter.patch('/sources/:id', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  const b = z.object(fields).partial().omit({ kind: true }).parse(req.body ?? {});
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const next = {
    url: has('url') ? b.url : cur.url, fallbackTz: has('fallbackTz') ? b.fallbackTz : cur.fallback_tz,
    requestMode: b.requestMode ?? cur.request_mode, daysAhead: b.daysAhead ?? cur.days_ahead,
    minDaysAhead: b.minDaysAhead ?? (has('daysAhead') ? Math.min(cur.min_days_ahead, b.daysAhead!) : cur.min_days_ahead),
  };
  checkSource({ kind: cur.kind, ...next });
  const headers = cur.kind === 'url' ? mergeHeaders(cur, b.headers) : null;
  // Any change means the next scheduled run reads the guide in full (no 304 shortcut).
  const row = await one<any>(
    `UPDATE epg_import_sources SET name=$2, url=$3, refresh_hours=$4::int, fallback_tz=$5, keep_past_days=$6, lang=$7, auto_map=$8, enabled=$9::boolean,
            request_mode=$10, days_ahead=$11, min_days_ahead=$12, date_format=$13, request_headers=$14, new_channels=$15,
            etag=NULL, last_modified=NULL, conditional_url=NULL,
            next_run_at = CASE WHEN kind = 'url' AND $9::boolean AND $4::int IS NOT NULL THEN COALESCE(last_run_at, now()) + make_interval(hours => $4::int) ELSE NULL END,
            updated_at=now()
      WHERE id=$1 RETURNING *`,
    [cur.id, b.name ?? cur.name, next.url, has('refreshHours') ? b.refreshHours : cur.refresh_hours, next.fallbackTz,
     b.keepPastDays ?? cur.keep_past_days, has('lang') ? b.lang : cur.lang, b.autoMap ?? cur.auto_map, b.enabled ?? cur.enabled,
     next.requestMode, next.daysAhead, next.minDaysAhead, b.dateFormat ?? cur.date_format, headers, b.newChannels ?? cur.new_channels]);
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

xmltvImportRouter.post('/sources/:id/test', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  if (cur.kind !== 'url') throw badRequest('Only a URL source can be tried');
  res.json(await testSource(cur));
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

const lcnOrder = (v: string | null) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; };

xmltvImportRouter.get('/sources/:id/channels', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  const rows = await query<any>(
    `SELECT a.*, c.name AS channel_name, c.kind AS channel_kind FROM epg_channel_aliases a LEFT JOIN channels c ON c.id = a.channel_id
      WHERE a.source_id = $1`, [cur.id]);
  const ours = await query<any>(`SELECT c.id, c.name FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1`, [accountId(req)]);
  const used = new Set(rows.filter((r) => r.channel_id).map((r) => r.channel_id));
  // Suggestions only for the undecided, and only to a Volt channel this source does not already feed.
  const sugg = suggest(rows.filter((r) => !r.channel_id && !r.ignored).map((r) => ({ id: r.id, name: r.display_name, lcn: r.lcn, count: r.programmes_in_feed })), ours.filter((o) => !used.has(o.id)));
  const dup = duplicateNames(rows);
  const others = await otherFeeders(cur.id, [...used]);
  const cov = new Map((await coverageOf(cur)).map((c) => [c.externalId, c.until]));
  const ourName = new Map(ours.map((o) => [o.id, o.name]));
  const now = new Date();
  rows.sort((x, y) => lcnOrder(x.lcn) - lcnOrder(y.lcn) || String(x.display_name ?? x.external_id).localeCompare(String(y.display_name ?? y.external_id)));
  res.json(rows.map((r) => ({
    id: r.id, externalId: r.external_id, displayName: r.display_name, icon: r.icon, lcn: r.lcn,
    state: r.channel_id ? 'used' : r.ignored ? 'not_used' : 'waiting',
    channelId: r.channel_id, channelName: r.channel_name, channelKind: r.channel_kind, mappedBy: r.mapped_by,
    lastSeenAt: r.last_seen_at, firstSeenAt: r.first_seen_at, lastProgrammes: r.last_programmes,
    programmesInFeed: r.programmes_in_feed, feedFrom: r.feed_from, feedTo: r.feed_to,
    sameNameAs: dup.get(r.id) ?? [],
    suggestion: sugg.has(r.id) ? { channelId: sugg.get(r.id)!, channelName: ourName.get(sugg.get(r.id)!) } : null,
    alsoFedBy: r.channel_id ? (others.get(r.channel_id) ?? []) : [],
    guideUntil: cov.get(r.external_id)?.toISOString() ?? null, guideDaysAhead: daysAheadOf(cov.get(r.external_id) ?? null, now),
  })));
}));

/** Map one of their channels (or clear it); set it not used; or back to waiting. */
async function setAlias(a: any, account: string, to: { channelId: string | null; ignored: boolean }): Promise<number> {
  if (to.channelId) {
    const ch = await one(`SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`, [to.channelId, account]);
    if (!ch) throw badRequest('That channel is not in this account');
    const clash = await one<any>(`SELECT display_name, external_id, lcn FROM epg_channel_aliases WHERE source_id = $1 AND channel_id = $2 AND id <> $3`, [a.source_id, to.channelId, a.id]);
    if (clash) throw conflict(`That Volt channel already takes this feed's ${clash.display_name ?? clash.external_id}${clash.lcn ? ` (${clash.lcn})` : ''}. One feed channel per Volt channel: set that one to another channel or not used first.`);
  }
  // Re-pointing (or dropping) a mapping takes this source's FUTURE programmes
  // off the old channel: they were the other channel's guide all along. Aired ones stay.
  let moved = 0;
  if (a.channel_id && a.channel_id !== to.channelId) {
    const gone = await query<any>(
      `DELETE FROM programmes WHERE channel_id = $1 AND source_ref LIKE $2 ESCAPE '\\' AND starts_at > now() AND clip_status = 'none' RETURNING id`,
      [a.channel_id, escapeLike(sourceRefPrefix(a.source_id, a.external_id)) + '%']);
    moved = gone.length;
  }
  await query(`UPDATE epg_channel_aliases SET channel_id = $2, ignored = $3,
                      mapped_by = CASE WHEN $2::uuid IS NULL THEN NULL WHEN $2::uuid IS NOT DISTINCT FROM channel_id THEN mapped_by ELSE 'user' END
                WHERE id = $1`, [a.id, to.channelId, to.channelId ? false : to.ignored]);
  // The lineup changed, so the next scheduled run must read the guide in full.
  await query(`UPDATE epg_import_sources SET etag = NULL, last_modified = NULL, conditional_url = NULL WHERE id = $1`, [a.source_id]);
  return moved;
}

xmltvImportRouter.put('/aliases/:id', asyncHandler(async (req, res) => {
  const b = z.object({ channelId: z.string().uuid().nullable().optional(), ignored: z.boolean().optional() }).parse(req.body ?? {});
  const a = await aliasOf(req.params.id, accountId(req));
  if (!a) throw notFound('Channel mapping not found');
  const channelId = b.channelId !== undefined ? b.channelId : (b.ignored ? null : a.channel_id);
  const ignored = b.ignored ?? false;
  const moved = await setAlias(a, accountId(req), { channelId, ignored });
  res.json({ id: a.id, channelId, ignored: channelId ? false : ignored, state: channelId ? 'used' : ignored ? 'not_used' : 'waiting', removedFromPrevious: moved });
}));

/**
 * Many of their channels at once:
 *   not_used | waiting      set them so (a used one is taken off its Volt channel)
 *   accept_suggestions      use each on its suggested Volt channel (only the undecided)
 *   create                  create a Volt channel for each (name, XMLTV id = theirs,
 *                           TV or radio) in a group, and use it. Needs manage on channels.
 */
xmltvImportRouter.post('/sources/:id/channels/bulk', asyncHandler(async (req, res) => {
  const account = accountId(req);
  const cur = await ownedSource(req.params.id, account);
  if (!cur) throw notFound('Import source not found');
  const b = z.object({
    aliasIds: z.array(z.string().uuid()).min(1).max(500),
    action: z.enum(['not_used', 'waiting', 'accept_suggestions', 'create']),
    groupId: z.string().uuid().optional(),
    kind: z.enum(['tv', 'radio']).optional(),
    /** The new channels' time zone; default the source's zone, else the channel default. */
    tz: z.string().optional(),
  }).parse(req.body ?? {});
  const rows = await query<any>(`SELECT * FROM epg_channel_aliases WHERE source_id = $1 AND id = ANY($2::uuid[])`, [cur.id, b.aliasIds]);
  if (rows.length !== new Set(b.aliasIds).size) throw notFound('Some of those channels are not in this source');
  const done: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  if (b.action === 'not_used' || b.action === 'waiting') {
    for (const a of rows) { await setAlias(a, account, { channelId: null, ignored: b.action === 'not_used' }); done.push(a.id); }
  } else if (b.action === 'accept_suggestions') {
    const all = await query<any>(`SELECT id, display_name, lcn, programmes_in_feed, channel_id, ignored FROM epg_channel_aliases WHERE source_id = $1`, [cur.id]);
    const ours = await query<any>(`SELECT c.id, c.name FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1`, [account]);
    const used = new Set(all.filter((r) => r.channel_id).map((r) => r.channel_id));
    // Suggestions are worked out over the whole lineup (the same ones the console shows), one to one.
    const sugg = suggest(all.filter((r) => !r.channel_id && !r.ignored).map((r) => ({ id: r.id, name: r.display_name, lcn: r.lcn, count: r.programmes_in_feed })), ours.filter((o) => !used.has(o.id)));
    for (const a of rows) {
      const target = sugg.get(a.id);
      if (a.channel_id) { skipped.push({ id: a.id, reason: 'already in use' }); continue; }
      if (!target) { skipped.push({ id: a.id, reason: 'no suggestion' }); continue; }
      await setAlias(a, account, { channelId: target, ignored: false });
      await query(`UPDATE epg_channel_aliases SET mapped_by = 'suggestion' WHERE id = $1`, [a.id]);
      done.push(a.id);
    }
  } else {
    const access = await resolveAccess(String(req.auth!.sub), String(req.auth!.role));
    if (access.perms.channels !== 'manage') throw forbidden('Creating channels needs permission to manage channels');
    if (!b.groupId) throw badRequest('Choose the group the new channels go in');
    const group = await one<any>('SELECT id, max_channels FROM groups WHERE id = $1 AND account_id = $2', [b.groupId, account]);
    if (!group) throw notFound('Group not found');
    const todo = rows.filter((a) => !a.channel_id);
    for (const a of rows.filter((x) => x.channel_id)) skipped.push({ id: a.id, reason: 'already in use' });
    const have = (await one<any>('SELECT count(*)::int AS n FROM channels WHERE group_id = $1', [b.groupId])).n;
    if (have + todo.length > group.max_channels) throw conflict(`That group allows ${group.max_channels} channels and has ${have}: ${todo.length} more will not fit`);
    const who = actor(req);
    const kind = b.kind ?? 'tv';
    const tz = b.tz || cur.fallback_tz || null;
    if (tz && !validTz(tz)) throw badRequest(`Unknown time zone: ${tz}`);
    const typeId = await defaultTypeId(account, kind);
    for (const a of todo) {
      const name = (a.display_name ?? a.external_id).trim().slice(0, 200);
      // Their id becomes ours when it is a valid XMLTV id nobody here uses, so exports line up with this feed.
      const idFree = XMLTV_ID_RX.test(a.external_id) && !(await one(
        `SELECT 1 FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND (lower(c.xmltv_id) = lower($2) OR c.id::text = lower($2))`, [account, a.external_id]));
      const md = await validateEntityMetadata(account, typeId, { name }, ['channel']);
      const ch = await one<any>(
        `INSERT INTO channels(group_id, name, kind, xmltv_id, created_by, updated_by, schema_id, metadata, radio_config, dvr_window_sec, tz)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7::jsonb,$8::jsonb, 3600, COALESCE($9, 'Europe/London')) RETURNING id`,
        [b.groupId, name, kind, idFree ? a.external_id : null, who.userId, md.schemaId, JSON.stringify(md.metadata), kind === 'radio' ? '{}' : null, tz]);
      await writeAudit(null, { accountId: account, userId: who.userId, label: who.label, action: 'create', entityType: 'channel', entityId: ch.id,
        snapshot: { name, group_id: b.groupId, from: `XMLTV import "${cur.name}"`, xmltv_id: idFree ? a.external_id : null } });
      await setAlias(a, account, { channelId: ch.id, ignored: false });
      await query(`UPDATE epg_channel_aliases SET mapped_by = 'created' WHERE id = $1`, [a.id]);
      done.push(a.id);
    }
  }
  res.json({ done: done.length, skipped });
}));

xmltvImportRouter.get('/sources/:id/runs', asyncHandler(async (req, res) => {
  const cur = await ownedSource(req.params.id, accountId(req));
  if (!cur) throw notFound('Import source not found');
  res.json(await query(`SELECT id, trigger, started_at, finished_at, status, counts, warnings, error FROM epg_import_runs
                          WHERE source_id = $1 ORDER BY started_at DESC LIMIT 50`, [cur.id]));
}));
