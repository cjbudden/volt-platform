/**
 * FAST / VOD-to-live channels API (docs/DESIGN_fast_channels.md).
 *
 *   /api/fast/...           the console: channels, library, lineups (preview,
 *                           activate, apply), ads (policy, house ads, ad
 *                           servers, test a tag), breaks (list, Go to break),
 *                           ad report.
 *   /api/fast-playout/...   the playout process (ingest token): the timeline.
 *   /fast/<id>/s/<sid>/...  the session stitcher (public): a viewer's own
 *                           playlists with that viewer's ads in each break.
 *
 * A FAST channel is an ordinary channel row with origin = 'playlist', so the
 * guide, graphics, player, share links and reports all work on it as is.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, one, tx } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, conflict } from '../util/http';
import { actorId } from '../util/actor';
import { assertPlanRoom } from '../services/plan';
import { requireIngestToken } from './status';
import {
  planLineup, rotationMath, everyForPlays, repeatReport, nominalLength, episodesOf, type Slot,
} from '../services/fast/lineup';
import { achievedLoad, resolveAdPolicy } from '../services/fast/adPlan';
import {
  libraryFor, lineupFromRow, adsFor, applyLineup, activateLineup, timelineFor, decideBreak, adReport, wireProgramme, DEFAULT_HORIZON_DAYS,
} from '../services/fast/store';
import { resolve as resolveVast, expandTag } from '../services/fast/vast';
import { stitchHls, type SessionState, type PodRendition } from '../services/fast/stitch';
import { isTimeZone } from '../services/epgRepeat';
import { sessionStore } from '../services/fast/sessionStore';
import { fastConfig, channelPlaylistUrl, readKey, readChannelPlaylist, assetUrlBase } from '../services/fast/media';

export const fastRouter = Router();
fastRouter.use(requireAuth);

async function ownChannel(req: Request, id: string) {
  const ch = await one<any>(
    `SELECT c.*, g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`,
    [id, accountId(req)]);
  if (!ch) throw notFound('Channel not found');
  return ch;
}
async function ownLineup(req: Request, id: string) {
  const l = await one<any>(
    `SELECT l.* FROM fast_lineups l JOIN channels c ON c.id = l.channel_id JOIN groups g ON g.id = c.group_id
      WHERE l.id = $1 AND g.account_id = $2`, [id, accountId(req)]);
  if (!l) throw notFound('Lineup not found');
  return l;
}
const uuid = z.string().uuid();

// ------------------------------------------------------------------ channels

fastRouter.get('/channels', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT c.id, c.name, c.status, c.group_id, c.origin,
            l.id AS lineup_id, l.name AS lineup_name, l.version, l.applied_until, l.zone,
            jsonb_array_length(l.slots) AS slot_count,
            (SELECT title FROM programmes p WHERE p.channel_id = c.id AND p.starts_at <= now() AND p.ends_at > now() ORDER BY starts_at DESC LIMIT 1) AS on_air,
            COALESCE(a.mode, 'off') AS ads_mode
       FROM channels c JOIN groups g ON g.id = c.group_id
       LEFT JOIN fast_lineups l ON l.channel_id = c.id AND l.status = 'active'
       LEFT JOIN channel_ads a ON a.channel_id = c.id
      WHERE g.account_id = $1 AND c.origin = 'playlist'
      ORDER BY c.name`, [accountId(req)]);
  res.json({ items: rows });
}));

const createChannel = z.object({
  name: z.string().trim().min(1).max(120),
  groupId: uuid,
  zone: z.string().default('UTC'),
});
fastRouter.post('/channels', asyncHandler(async (req, res) => {
  const b = createChannel.parse(req.body);
  if (!isTimeZone(b.zone)) throw badRequest(`Unknown time zone: ${b.zone}`);
  const group = await one<any>(`SELECT id, max_channels FROM groups WHERE id = $1 AND account_id = $2`, [b.groupId, accountId(req)]);
  if (!group) throw notFound('Group not found');
  await assertPlanRoom(accountId(req));
  const n = await one<any>(`SELECT count(*)::int AS n FROM channels WHERE group_id = $1`, [b.groupId]);
  if (n.n >= group.max_channels) throw conflict(`This group is full: it is given ${group.max_channels} channels and stations of the plan.`);
  const out = await tx(async (c) => {
    // A playlist channel has no source, no recording (the media is already in
    // the library) and no encoder; the FAST playout writes its playlists.
    const ch = (await c.query(
      `INSERT INTO channels (group_id, name, origin, recording_enabled, created_by, updated_by)
       VALUES ($1, $2, 'playlist', false, $3, $3) RETURNING *`, [b.groupId, b.name, actorId(req)])).rows[0];
    const l = (await c.query(
      `INSERT INTO fast_lineups (channel_id, name, epoch, zone, created_by) VALUES ($1, 'Main lineup', now(), $2, $3) RETURNING *`,
      [ch.id, b.zone, actorId(req)])).rows[0];
    await c.query(`INSERT INTO channel_ads (channel_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ch.id]);
    return { channel: ch, lineup: l };
  });
  res.status(201).json(out);
}));

fastRouter.get('/channels/:id', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const lineups = await query<any>(`SELECT * FROM fast_lineups WHERE channel_id = $1 ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 20`, [ch.id]);
  const ads = await adsFor(ch.id);
  const playout = await one<any>(
    `SELECT launcher, status, started_at, last_seen_at, last_pdt, media_sequence, restarts, error, unreadable,
            (last_seen_at > now() - make_interval(secs => $2)) AS fresh
       FROM fast_playouts WHERE channel_id = $1`, [ch.id, fastConfig.staleSec]);
  res.json({ channel: { id: ch.id, name: ch.name, status: ch.status, origin: ch.origin, groupId: ch.group_id, onAir: !!ch.on_air }, lineups, ads, playout,
    urls: { hls: channelPlaylistUrl(ch.id, 'master.m3u8'), dash: channelPlaylistUrl(ch.id, 'manifest.mpd'), session: `/fast/${ch.id}/s/{session}/master.m3u8` } });
}));

/** Is every asset the channel uses ready to air (packaged, splice-aligned, loudness, 1 s slate)? */
fastRouter.get('/channels/:id/readiness', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const { readiness } = await import('../services/fast/prepare');
  res.json({ items: await readiness(ch.id) });
}));
/** Queue the encodes that make them ready. */
fastRouter.post('/channels/:id/prepare', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const { prepare } = await import('../services/fast/prepare');
  res.json(await prepare(ch.id));
}));

/**
 * PUBLIC OR PRIVATE. The same switch as any channel (channels.on_air): off, the
 * playout still runs and the console previews it, but the public URL and the
 * player's play gate give nothing.
 */
fastRouter.post('/channels/:id/on-air', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const on = req.body?.on === true;
  await query(`UPDATE channels SET on_air = $2, updated_at = now() WHERE id = $1`, [ch.id, on]);
  res.json({ onAir: on });
}));

// ------------------------------------------------------------------ library

fastRouter.get('/library', asyncHandler(async (req, res) => {
  const lib = await libraryFor(accountId(req));
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const assets = [...lib.values()].filter((a) => !q || a.title.toLowerCase().includes(q) || (a.series ?? '').toLowerCase().includes(q));
  const series = new Map<string, { name: string; episodes: number; seasons: Set<number>; durationSec: number }>();
  for (const a of lib.values()) {
    if (!a.series) continue;
    const k = a.series.trim().toLowerCase();
    const s = series.get(k) ?? { name: a.series.trim(), episodes: 0, seasons: new Set<number>(), durationSec: 0 };
    s.episodes++; s.durationSec += a.durationSec; if (a.season != null) s.seasons.add(a.season);
    series.set(k, s);
  }
  res.json({
    assets: assets.slice(0, 2000),
    series: [...series.values()].map((s) => ({ name: s.name, episodes: s.episodes, seasons: [...s.seasons].sort((x, y) => x - y), durationSec: Math.round(s.durationSec) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}));

// ------------------------------------------------------------------ lineups

const poolRef = z.union([z.object({ assetId: uuid }), z.object({ skip: z.literal(true) })]);
const slotSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(40), kind: z.literal('title'), pool: z.array(poolRef).min(1).max(20), every: z.number().int().min(1).max(52).optional(), phase: z.number().int().min(0).max(51).optional(), label: z.string().max(80).optional() }),
  z.object({ id: z.string().min(1).max(40), kind: z.literal('series'), series: z.string().min(1).max(200), count: z.number().int().min(1).max(24), order: z.enum(['sequential', 'shuffle']), atEnd: z.enum(['loop', 'stop']).optional(), every: z.number().int().min(1).max(52).optional(), phase: z.number().int().min(0).max(51).optional(), encoreOf: z.string().max(40).nullable().optional(), label: z.string().max(80).optional() }),
]);
const settingsSchema = z.object({
  cycleShift: z.number().int().min(0).max(50).optional(),
  anchor: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  gridMin: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).optional(),
  backfill: z.array(uuid).max(200).optional(),
  seed: z.string().max(60).optional(),
  horizonDays: z.number().int().min(1).max(14).optional(),
});
const lineupBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  zone: z.string().optional(),
  epoch: z.string().datetime({ offset: true }).optional(),
  slots: z.array(slotSchema).max(500).optional(),
  settings: settingsSchema.optional(),
});

function checkSlots(slots: Slot[]) {
  const ids = new Set<string>();
  for (const s of slots) {
    if (ids.has(s.id)) throw badRequest(`Two slots have the id "${s.id}"`);
    ids.add(s.id);
  }
  for (const s of slots) if (s.kind === 'series' && s.encoreOf && !ids.has(s.encoreOf)) throw badRequest(`Slot "${s.id}" repeats a slot that is not in the lineup`);
}

fastRouter.post('/channels/:id/lineups', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const b = lineupBody.extend({ copyFrom: uuid.optional() }).parse(req.body ?? {});
  const src = b.copyFrom ? await ownLineup(req, b.copyFrom) : await one<any>(`SELECT * FROM fast_lineups WHERE channel_id = $1 AND status = 'active'`, [ch.id]);
  const slots = b.slots ?? src?.slots ?? [];
  checkSlots(slots as Slot[]);
  const zone = b.zone ?? src?.zone ?? 'UTC';
  if (!isTimeZone(zone)) throw badRequest(`Unknown time zone: ${zone}`);
  const row = await one<any>(
    `INSERT INTO fast_lineups (channel_id, name, epoch, zone, slots, settings, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING *`,
    [ch.id, b.name ?? (src ? `${src.name} (draft)` : 'Lineup'), b.epoch ?? new Date().toISOString(), zone,
     JSON.stringify(slots), JSON.stringify(b.settings ?? src?.settings ?? {}), actorId(req)]);
  res.status(201).json(row);
}));

fastRouter.get('/lineups/:lid', asyncHandler(async (req, res) => res.json(await ownLineup(req, String(req.params.lid)))));

fastRouter.put('/lineups/:lid', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  if (l.status === 'archived') throw conflict('This lineup version is archived. Make a new draft from it instead.');
  const b = lineupBody.parse(req.body ?? {});
  if (b.slots) checkSlots(b.slots as Slot[]);
  if (b.zone && !isTimeZone(b.zone)) throw badRequest(`Unknown time zone: ${b.zone}`);
  if (l.status === 'active' && (b.slots || b.settings || b.zone || b.epoch)) {
    throw conflict('The active lineup is on air. Edit a draft and activate it: the run order and every series carry on from where they are.');
  }
  const row = await one<any>(
    `UPDATE fast_lineups SET name = COALESCE($2, name), zone = COALESCE($3, zone), epoch = COALESCE($4::timestamptz, epoch),
            slots = COALESCE($5::jsonb, slots), settings = COALESCE($6::jsonb, settings), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [l.id, b.name ?? null, b.zone ?? null, b.epoch ?? null, b.slots ? JSON.stringify(b.slots) : null, b.settings ? JSON.stringify(b.settings) : null]);
  res.json(row);
}));

fastRouter.delete('/lineups/:lid', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  if (l.status === 'active') throw conflict('The active lineup cannot be removed. Activate another one first.');
  await query(`DELETE FROM fast_lineups WHERE id = $1`, [l.id]);
  res.status(204).end();
}));

/**
 * PREVIEW: plan a window without writing anything. What the builder shows
 * while someone edits: the programmes, the notices, the repeat report and the
 * rotation maths ("a 14 h lineup airs each title 12 times a week at 12
 * different times").
 */
const previewBody = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  days: z.number().min(0.25).max(14).default(7),
  slots: z.array(slotSchema).max(500).optional(),
  settings: settingsSchema.optional(),
  zone: z.string().optional(),
});
fastRouter.post('/lineups/:lid/preview', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  const b = previewBody.parse(req.body ?? {});
  const ads = await adsFor(l.channel_id);
  const row = { ...l, slots: b.slots ?? l.slots, settings: { ...(l.settings ?? {}), ...(b.settings ?? {}) }, zone: b.zone ?? l.zone };
  if (b.slots) checkSlots(b.slots as Slot[]);
  const lineup = lineupFromRow(row, ads.policy);
  // a draft previews from when it would start: now (or its own epoch if later)
  if (l.status !== 'active' && lineup.epoch.getTime() < Date.now()) lineup.epoch = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const lib = await libraryFor(accountId(req));
  const from = b.from ? new Date(b.from) : lineup.epoch;
  const to = new Date(from.getTime() + b.days * 86400_000);
  const plan = planLineup(lineup, lib, from, to);
  const len = nominalLength(lineup, lib);
  const totalContent = plan.programmes.reduce((s, p) => s + p.contentSec, 0);
  const totalAds = plan.programmes.reduce((s, p) => s + p.breaks.reduce((x, y) => x + y.durationSec, 0), 0);
  res.json({
    from: from.toISOString(), to: to.toISOString(), zone: lineup.zone,
    programmes: plan.programmes.map(wireProgramme),
    notices: plan.notices.map((n) => ({ at: n.at.toISOString(), slotId: n.slotId ?? null, message: n.message })),
    repeats: repeatReport(plan.programmes, lineup.zone),
    rotation: { ...rotationMath(len), everyFor4: everyForPlays(len, 4) },
    ads: { minutesPerHour: achievedLoad(totalContent, plan.programmes.flatMap((p) => p.breaks)), breaks: plan.programmes.reduce((s, p) => s + p.breaks.length, 0), adSec: totalAds },
    series: [...new Set((row.slots as Slot[]).filter((s) => s.kind === 'series').map((s: any) => s.series))].map((name) => ({
      name, episodes: episodesOf(name, lib).length,
    })),
  });
}));

fastRouter.post('/lineups/:lid/activate', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  if (!(l.slots ?? []).length) throw badRequest('The lineup has no slots yet.');
  const r = await activateLineup(l.id);
  const applied = await applyLineup(l.id, { days: l.settings?.horizonDays ?? DEFAULT_HORIZON_DAYS });
  // anything not ready to air is prepared now (splice-aligned re-encodes, loudness, the 1 s slate)
  const prepared = await import('../services/fast/prepare').then((m) => m.prepare(l.channel_id)).catch(() => null);
  const { startPlayout } = await import('../services/fast/playoutRunner');
  const playout = await startPlayout(l.channel_id).catch((e: any) => `could not start: ${e?.message ?? e}`);
  res.json({ ...r, applied, playout, prepared, urls: { hls: channelPlaylistUrl(l.channel_id, 'master.m3u8'), dash: channelPlaylistUrl(l.channel_id, 'manifest.mpd') } });
}));

const applyBody = z.object({ days: z.number().int().min(1).max(14).optional(), dryRun: z.boolean().optional() });
fastRouter.post('/lineups/:lid/apply', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  if (l.status !== 'active') throw conflict('Only the active lineup writes the guide. Activate it first (or preview it).');
  const b = applyBody.parse(req.body ?? {});
  res.json(await applyLineup(l.id, { days: b.days, dryRun: b.dryRun }));
}));

// ------------------------------------------------------------------ ads

const adsBody = z.object({
  mode: z.enum(['off', 'markers', 'stitched']).optional(),
  policy: z.record(z.any()).optional(),
  adServerId: uuid.nullable().optional(),
  houseAds: z.array(z.object({ assetId: uuid, weight: z.number().int().min(1).max(10).optional() })).max(100).optional(),
  scope: z.enum(['channel', 'session']).optional(),
});
fastRouter.get('/channels/:id/ads', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const servers = await query<any>(`SELECT id, name, vendor, enabled FROM ad_servers WHERE account_id = $1 ORDER BY name`, [accountId(req)]);
  res.json({ ...(await adsFor(ch.id)), servers });
}));
fastRouter.put('/channels/:id/ads', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const b = adsBody.parse(req.body ?? {});
  if (b.adServerId) {
    const s = await one<any>(`SELECT id FROM ad_servers WHERE id = $1 AND account_id = $2`, [b.adServerId, accountId(req)]);
    if (!s) throw notFound('Ad server not found');
  }
  if (b.mode === 'stitched' && !b.adServerId) {
    const cur = await one<any>(`SELECT ad_server_id FROM channel_ads WHERE channel_id = $1`, [ch.id]);
    if (!cur?.ad_server_id) throw badRequest('Stitched ads need an ad server. Add one, or choose "Markers only" to let a FAST platform insert the ads.');
  }
  // `enabled` follows the mode (off = no breaks) unless it is set on purpose
  const policy = b.policy ? (() => { const r: any = { ...resolveAdPolicy(b.policy), slateAssetId: b.policy.slateAssetId ?? null }; if (typeof b.policy.enabled !== 'boolean') delete r.enabled; return r; })() : null;
  await query(
    `INSERT INTO channel_ads (channel_id, mode, policy, ad_server_id, house_ads, decision_scope)
     VALUES ($1, COALESCE($2, 'off'), COALESCE($3::jsonb, '{}'::jsonb), $4, COALESCE($5::jsonb, '[]'::jsonb), COALESCE($6, 'session'))
     ON CONFLICT (channel_id) DO UPDATE SET
       mode = COALESCE($2, channel_ads.mode), policy = COALESCE($3::jsonb, channel_ads.policy),
       ad_server_id = CASE WHEN $7 THEN $4 ELSE channel_ads.ad_server_id END,
       house_ads = COALESCE($5::jsonb, channel_ads.house_ads), decision_scope = COALESCE($6, channel_ads.decision_scope), updated_at = now()`,
    [ch.id, b.mode ?? null, policy ? JSON.stringify(policy) : null, b.adServerId ?? null, b.houseAds ? JSON.stringify(b.houseAds) : null, b.scope ?? null, b.adServerId !== undefined]);
  res.json(await adsFor(ch.id));
}));

const serverBody = z.object({
  name: z.string().trim().min(1).max(120),
  vendor: z.enum(['vast', 'gam', 'freewheel', 'springserve', 'magnite', 'publica', 'beachfront', 'other']).default('vast'),
  tagTemplate: z.string().url().max(4000),
  timeoutMs: z.number().int().min(200).max(5000).default(1500),
  maxWrappers: z.number().int().min(0).max(10).default(5),
  enabled: z.boolean().default(true),
});
fastRouter.get('/ad-servers', asyncHandler(async (req, res) => {
  res.json({ items: await query<any>(`SELECT * FROM ad_servers WHERE account_id = $1 ORDER BY name`, [accountId(req)]) });
}));
fastRouter.post('/ad-servers', asyncHandler(async (req, res) => {
  const b = serverBody.parse(req.body ?? {});
  const r = await one<any>(
    `INSERT INTO ad_servers (account_id, name, vendor, tag_template, timeout_ms, max_wrappers, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [accountId(req), b.name, b.vendor, b.tagTemplate, b.timeoutMs, b.maxWrappers, b.enabled]);
  res.status(201).json(r);
}));
fastRouter.put('/ad-servers/:sid', asyncHandler(async (req, res) => {
  const b = serverBody.partial().parse(req.body ?? {});
  const r = await one<any>(
    `UPDATE ad_servers SET name = COALESCE($3, name), vendor = COALESCE($4, vendor), tag_template = COALESCE($5, tag_template),
            timeout_ms = COALESCE($6, timeout_ms), max_wrappers = COALESCE($7, max_wrappers), enabled = COALESCE($8, enabled), updated_at = now()
      WHERE id = $1 AND account_id = $2 RETURNING *`,
    [String(req.params.sid), accountId(req), b.name ?? null, b.vendor ?? null, b.tagTemplate ?? null, b.timeoutMs ?? null, b.maxWrappers ?? null, b.enabled ?? null]);
  if (!r) throw notFound('Ad server not found');
  res.json(r);
}));
fastRouter.delete('/ad-servers/:sid', asyncHandler(async (req, res) => {
  await query(`DELETE FROM ad_servers WHERE id = $1 AND account_id = $2`, [String(req.params.sid), accountId(req)]);
  res.status(204).end();
}));

/** "What would the ad server send for a 120 s break?" One real request, nothing played or logged. */
fastRouter.post('/ad-servers/:sid/test', asyncHandler(async (req, res) => {
  const s = await one<any>(`SELECT * FROM ad_servers WHERE id = $1 AND account_id = $2`, [String(req.params.sid), accountId(req)]);
  if (!s) throw notFound('Ad server not found');
  const durationSec = Math.max(15, Math.min(600, Number(req.body?.durationSec ?? 120)));
  const url = expandTag(s.tag_template, { sessionId: 'test', breakId: 'test', breakIndex: 1, durationSec, channelId: String(req.body?.channelId ?? 'test'), cacheBuster: String(Date.now()) });
  const r = await resolveVast(url, async (u, t) => {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), t);
    try { const x = await fetch(u, { signal: ac.signal }); return { status: x.status, body: await x.text() }; } finally { clearTimeout(tm); }
  }, { budgetMs: s.timeout_ms, maxDepth: s.max_wrappers });
  res.json({
    request: url, elapsedMs: r.elapsedMs, requests: r.requests, problems: r.problems.map((p) => ({ code: p.code, message: p.message })),
    ads: r.ads.map((a) => ({ id: a.id, sequence: a.sequence, title: a.title ?? null, adSystem: a.adSystem ?? null, durationSec: a.durationSec, creativeKey: a.creativeKey, mediaFiles: a.mediaFiles.length })),
    adSec: r.ads.reduce((x, a) => x + a.durationSec, 0),
  });
}));

fastRouter.get('/channels/:id/ad-report', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const days = Math.max(1, Math.min(90, Number(req.query.days ?? 7)));
  const creatives = await query<any>(
    `SELECT c.creative_key, c.title, c.ad_system, c.plays, c.last_seen_at,
            CASE WHEN v.master_key IS NOT NULL THEN 'ready' ELSE c.status END AS status
       FROM ad_creatives c LEFT JOIN vod_assets v ON v.id = c.vod_asset_id
      WHERE c.account_id = $1 ORDER BY c.last_seen_at DESC LIMIT 50`, [accountId(req)]);
  res.json({ ...(await adReport(ch.id, new Date(Date.now() - days * 86400_000))), creatives });
}));

// ------------------------------------------------------------------ breaks

/** Breaks on a stream. Works for every channel and event, not only FAST: a live channel's Go to break lands here too. */
async function ownStream(req: Request, kind: string, id: string) {
  if (kind === 'event') {
    const e = await one<any>(`SELECT e.id FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1 AND g.account_id = $2`, [id, accountId(req)]);
    if (!e) throw notFound('Event not found');
    return { col: 'event_id', id };
  }
  await ownChannel(req, id);
  return { col: 'channel_id', id };
}
fastRouter.get('/streams/:kind/:id/breaks', asyncHandler(async (req, res) => {
  const s = await ownStream(req, String(req.params.kind), String(req.params.id));
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 3600_000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 86400_000);
  const rows = await query<any>(
    `SELECT b.*, p.title AS programme_title FROM stream_breaks b LEFT JOIN programmes p ON p.id = b.programme_id
      WHERE b.${s.col} = $1 AND b.starts_at < $3 AND b.starts_at + make_interval(secs => b.duration_ms / 1000.0) > $2
      ORDER BY b.starts_at LIMIT 2000`, [s.id, from.toISOString(), to.toISOString()]);
  res.json({ items: rows });
}));
const breakBody = z.object({
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationSec: z.number().min(5).max(900),
  hideGraphics: z.boolean().default(true),
  note: z.string().max(200).optional(),
});
/** GO TO BREAK: an operator (or an automation) puts a break on a stream now, or at a time. */
fastRouter.post('/streams/:kind/:id/breaks', asyncHandler(async (req, res) => {
  const s = await ownStream(req, String(req.params.kind), String(req.params.id));
  const b = breakBody.parse(req.body ?? {});
  const row = await one<any>(
    `INSERT INTO stream_breaks (${s.col}, source, starts_at, duration_ms, position, hide_graphics, meta, created_by)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, 'live', $5, $6::jsonb, $7) RETURNING *`,
    [s.id, req.header('X-Volt-Automation') ? 'api' : 'manual', b.startsAt ?? null, Math.round(b.durationSec * 1000), b.hideGraphics,
     JSON.stringify(b.note ? { note: b.note } : {}), actorId(req)]);
  res.status(201).json(row);
}));
fastRouter.delete('/streams/:kind/:id/breaks/:bid', asyncHandler(async (req, res) => {
  const s = await ownStream(req, String(req.params.kind), String(req.params.id));
  const r = await one<any>(`UPDATE stream_breaks SET status = 'cancelled' WHERE id = $1 AND ${s.col} = $2 RETURNING id`, [String(req.params.bid), s.id]);
  if (!r) throw notFound('Break not found');
  res.status(204).end();
}));

/** Decide one break now, as the stitcher would, for a test session. Logged like a real decision. */
fastRouter.post('/channels/:id/breaks/:bid/decide', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  res.json(await decideBreak({ channelId: ch.id, breakId: String(req.params.bid), sessionId: String(req.body?.sessionId ?? 'console-test') }));
}));

// ------------------------------------------------------------------ playout (ingest token)

export const fastPlayoutRouter = Router();
fastPlayoutRouter.use(requireIngestToken);
/** The playout's heartbeat: its state (carried across restarts), what it last published. */
fastPlayoutRouter.post('/:id/heartbeat', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('id must be a uuid');
  const { heartbeat } = await import('../services/fast/playoutRunner');
  await heartbeat(id, req.body ?? {});
  res.status(204).end();
}));
/** What a starting playout carries on from (null: start fresh). */
fastPlayoutRouter.get('/:id/state', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('id must be a uuid');
  const { savedState } = await import('../services/fast/playoutRunner');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ state: await savedState(id) });
}));
fastPlayoutRouter.get('/:id/timeline', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('id must be a uuid');
  const now = Date.now();
  const at = (v: unknown, d: number) => { const t = v ? Date.parse(String(v)) : NaN; return new Date(Number.isFinite(t) ? t : d); };
  const from = at(req.query.from, now - 3600_000), to = at(req.query.to, now + 3600_000);
  if (to.getTime() - from.getTime() > 12 * 3600_000 || to <= from) throw badRequest('window must be positive and at most twelve hours');
  res.setHeader('Cache-Control', 'no-store');
  res.json(await timelineFor(id, from, to));
}));

// ------------------------------------------------------------------ the session stitcher (public)
//
// LOCAL / SINGLE-PROCESS FORM. Session state lives in this process's memory;
// the production form is the same functions in a small stateless service with
// the state in Redis (DESIGN_fast_channels.md, "Stitcher in production").

const LOOKAHEAD_MS = 60_000;

const assetTracks = new Map<string, { at: number; tracks: Record<string, { init: string; segs: { uri: string; dur: number }[] }> }>();
/** An asset's segments per channel track name (v<height> / audio), from its VOD playlists. */
async function tracksOf(master: string) {
  const hit = assetTracks.get(master);
  if (hit && Date.now() - hit.at < 3600_000) return hit.tracks;
  // local '/clips/vod/<id>/...' or production 'vod/<id>/...' (media.ts), and
  // the segment URLs exactly as the playout writes them (absolute on the CDN in production)
  const folder = master.replace(/\/[^/]+$/, '');
  const base = assetUrlBase(master);
  const text = await readKey(master);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: Record<string, { init: string; segs: { uri: string; dur: number }[] }> = {};
  const media = async (uri: string) => {
    const t = await readKey(`${folder}/${uri}`);
    let init = '', pend: number | null = null;
    const segs: { uri: string; dur: number }[] = [];
    for (const l of t.split(/\r?\n/)) {
      const x = l.trim();
      if (x.startsWith('#EXT-X-MAP:')) init = base + (x.match(/URI="([^"]+)"/)?.[1] ?? '');
      else if (x.startsWith('#EXTINF:')) pend = Number(x.slice(8).split(',')[0]);
      else if (x && !x.startsWith('#') && pend != null) { segs.push({ uri: base + x, dur: pend }); pend = null; }
    }
    return { init, segs };
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-MEDIA:') && l.includes('TYPE=AUDIO')) { const u = l.match(/URI="([^"]+)"/)?.[1]; if (u && !out.audio) out.audio = await media(u); }
    if (l.startsWith('#EXT-X-STREAM-INF:') && lines[i + 1]) { const h = Number(l.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? 0); out[`v${h}`] = await media(lines[i + 1]); }
  }
  assetTracks.set(master, { at: Date.now(), tracks: out });
  return out;
}
function nearestTrack(tracks: Record<string, any>, name: string) {
  if (tracks[name]) return tracks[name];
  if (name === 'audio') return null;
  const h = Number(name.slice(1));
  const vs = Object.keys(tracks).filter((k) => k.startsWith('v')).sort((a, b) => Math.abs(Number(a.slice(1)) - h) - Math.abs(Number(b.slice(1)) - h));
  return vs.length ? tracks[vs[0]] : null;
}

/** A decided pod for one track: each item's segments, the slate cut to its share. */
async function podSegments(plan: any, track: string, slateMaster: string | null): Promise<PodRendition | null> {
  const out: PodRendition = [];
  for (const it of plan.items) {
    const master = it.kind === 'slate' ? slateMaster : (await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [it.assetId]))?.master_key;
    if (!master) return null;
    const t = nearestTrack(await tracksOf(master), track);
    if (!t) return null;
    let left = it.durationSec;
    let guard = 0;
    while (left > 0.25 && guard++ < 200) {
      for (const s of t.segs) {
        if (left <= 0.25) break;
        out.push({ uri: s.uri, dur: s.dur, init: t.init + (it.kind === 'slate' ? `#loop${guard}` : '') });
        left -= s.dur;
      }
      if (it.kind !== 'slate') break;
    }
  }
  // the "#loopN" marker makes each slate loop its own item (a discontinuity) and is stripped on output
  return out;
}

export const fastPublicRouter = Router();
fastPublicRouter.get('/:id/s/:sid/:file', asyncHandler(async (req, res) => {
  const id = String(req.params.id), sid = String(req.params.sid), file = String(req.params.file);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{8,80}$/.test(sid) || !/^(master|v\d+|audio)\.m3u8$/.test(file)) throw notFound();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/vnd.apple.mpegurl');
  const text = await readChannelPlaylist(id, file);
  if (text == null) throw notFound('The channel is not playing');
  if (file === 'master.m3u8') return res.send(text); // relative media URIs resolve under this session's path
  // SESSION STATE IS SHARED (sessionStore.ts): refreshes land on any API task.
  const ctx = await sessionStore.context(sid, () => ({ channelId: id, ip: req.ip, userAgent: req.header('user-agent') ?? null, country: req.header('cloudfront-viewer-country') ?? null }));
  const track = file.replace(/\.m3u8$/, '');
  // PRE-FETCH: decide breaks that start in the next minute, without waiting
  const ads = await adsFor(id);
  const recent = await query<any>(
    `SELECT id, starts_at FROM stream_breaks WHERE channel_id = $1 AND status = 'scheduled'
        AND starts_at BETWEEN now() - interval '10 minutes' AND now() + make_interval(secs => $2)`, [id, LOOKAHEAD_MS / 1000]);
  const decisionSid = ads.scope === 'channel' ? `channel-${id}` : sid;
  if (ads.mode === 'stitched') {
    for (const b of recent) {
      if (new Date(b.starts_at).getTime() < Date.now() - 10_000) continue;      // already started: too late to stitch
      if ((await sessionStore.pod(decisionSid, b.id)) !== undefined) continue;   // decided
      if (!(await sessionStore.claim(decisionSid, b.id))) continue;              // another task is deciding
      decideBreak({ channelId: id, breakId: b.id, sessionId: decisionSid, ctx: ctx as any })
        .then((plan) => sessionStore.savePod(decisionSid, b.id, plan))
        .catch(() => sessionStore.savePod(decisionSid, b.id, null));
    }
  }
  const slate = ads.policy.slateAssetId ? (await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [ads.policy.slateAssetId]))?.master_key ?? null : null;
  const podCache = new Map<string, PodRendition | null>();
  for (const b of recent) {
    const plan = await sessionStore.pod<any>(decisionSid, b.id);
    if (plan) podCache.set(`brk:${b.id}`, await podSegments(plan, track, slate).catch(() => null));
  }
  const st = (await sessionStore.track<SessionState>(sid, track)) ?? { startedMs: Number((ctx as any).started ?? Date.now()), breaks: {} };
  // the channel playlist names a break brk:<id>; the pod is looked up by that
  const out = stitchHls(text, st, (breakId) => podCache.get(breakId) ?? null).replace(/#loop\d+/g, '');
  await sessionStore.saveTrack(sid, track, st);
  res.send(out);
}));
