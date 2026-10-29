/**
 * FAST / VOD-to-live channels API (docs/DESIGN_fast_channels.md).
 *
 *   /api/fast/...           the console: channels, library, lineups (preview,
 *                           activate, apply), ads (policy, house ads, ad
 *                           servers, test a tag), breaks (list, Go to break),
 *                           ad report.
 *   /api/fast-playout/...   the playout process (ingest token): the timeline.
 *   /fast/<id>/s/<sid>/...  the session stitcher (public): a viewer's own
 *                           playlists with that viewer's ads in each break,
 *                           the ads in them (ads.json) and a click on one
 *                           (click/<break>/<pod>: trackers sent, then on to
 *                           the advertiser's page).
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
import { actor } from '../services/audit';
import { assertPlanRoom } from '../services/plan';
import { requireIngestToken } from './status';
import {
  planLineup, rotationMath, everyForPlays, repeatReport, nominalLength, episodesOf, type Slot,
} from '../services/fast/lineup';
import { achievedLoad, resolveAdPolicy } from '../services/fast/adPlan';
import {
  libraryFor, libraryForMedia, airable, type FastMedia, lineupFromRow, adsFor, applyLineup, activateLineup, timelineFor, decideBreak, adReport, wireProgramme, DEFAULT_HORIZON_DAYS,
} from '../services/fast/store';
import { resolve as resolveVast, expandTag } from '../services/fast/vast';
import { stitchHls, type SessionState, type PodRendition } from '../services/fast/stitch';
import { isTimeZone } from '../services/epgRepeat';
import { sessionStore } from '../services/fast/sessionStore';
import { adSchedule, dueBeacons, playheadOf, type BeaconState, type ScheduledAd } from '../services/fast/beacons';
import { sendBeacons, beaconReport, breakBeacons, fetchTracker } from '../services/fast/beaconSender';
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

/**
 * BEHIND THE SCENES: whatever the channel now uses that is not packaged to its
 * ladder is queued (services/fast/prepare.ts), without holding up the save that
 * added it. A packaging that failed is not retried from here; Prepare does.
 */
function prepareSoon(channelId: string): void {
  void import('../services/fast/prepare').then((m) => m.prepare(channelId, { auto: true }))
    .catch((e) => console.error(`[fast] preparing ${channelId}:`, e?.message ?? e));
}

/** A ladder group this account owns that resolves to rungs, or a 400 saying why not. */
async function checkLadder(req: Request, groupId: string) {
  const { loadLadder } = await import('../services/encode/store');
  try { return await loadLadder(groupId, accountId(req)); }
  catch (e: any) { throw /not found/.test(String(e?.message)) ? notFound('Ladder not found') : badRequest(String(e?.message ?? e)); }
}

// ------------------------------------------------------------------ channels

fastRouter.get('/channels', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT c.id, c.name, c.status, c.group_id, c.origin, c.fast_media AS media, c.brand_ref,
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
  /** Video or audio: fixed for the channel, it decides what the library offers. */
  media: z.enum(['video', 'audio']).default('video'),
  /** The ladder every title on the channel is packaged to (an encode ladder group); omitted or null: the account default. */
  ladderGroupId: uuid.nullable().optional(),
});
fastRouter.post('/channels', asyncHandler(async (req, res) => {
  const b = createChannel.parse(req.body);
  if (!isTimeZone(b.zone)) throw badRequest(`Unknown time zone: ${b.zone}`);
  if (b.ladderGroupId && b.media === 'video') await checkLadder(req, b.ladderGroupId);
  const group = await one<any>(`SELECT id, max_channels FROM groups WHERE id = $1 AND account_id = $2`, [b.groupId, accountId(req)]);
  if (!group) throw notFound('Group not found');
  await assertPlanRoom(accountId(req));
  const n = await one<any>(`SELECT count(*)::int AS n FROM channels WHERE group_id = $1`, [b.groupId]);
  if (n.n >= group.max_channels) throw conflict(`This group is full: it is given ${group.max_channels} channels and stations of the plan.`);
  const out = await tx(async (c) => {
    // A playlist channel has no source, no recording (the media is already in
    // the library) and no encoder; the FAST playout writes its playlists.
    const ch = (await c.query(
      `INSERT INTO channels (group_id, name, origin, fast_media, recording_enabled, created_by, updated_by, fast_ladder_group_id)
       VALUES ($1, $2, 'playlist', $4, false, $3, $3, $5) RETURNING *`, [b.groupId, b.name, actorId(req), b.media, b.media === 'video' ? b.ladderGroupId ?? null : null])).rows[0];
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
  // The channel's own settings, for the FAST page's Settings and Overview: its
  // content type and metadata (title, description...), logo, guide icon, the
  // watermark the player draws over it (apps.ts fastBrandMark) and in-stream
  // graphics. Saved through PATCH /api/channels/:id like any channel.
  const settings = {
    version: ch.version ?? null, schemaId: ch.schema_id ?? null, metadata: ch.metadata ?? {}, brandRef: ch.brand_ref ?? null, guideIconRef: ch.guide_icon_ref ?? null,
    graphics: ch.graphics ?? {}, epgEnabled: ch.epg_enabled !== false,
    watermark: { enabled: !!ch.watermark_enabled, ref: ch.watermark_ref ?? null, position: ch.watermark_position ?? 'br', offsetX: Number(ch.watermark_offset_x ?? 24),
      offsetY: Number(ch.watermark_offset_y ?? 24), opacity: Number(ch.watermark_opacity ?? 100), scale: Number(ch.watermark_scale ?? 12) },
  };
  const { channelLadder } = await import('../services/fast/ladder');
  const ladder = await channelLadder(ch.id).catch(() => null);
  res.json({ channel: { id: ch.id, name: ch.name, status: ch.status, origin: ch.origin, groupId: ch.group_id, onAir: !!ch.on_air, media: (ch.fast_media ?? 'video') as FastMedia,
    ladderGroupId: ch.fast_ladder_group_id ?? null, ladder }, settings, lineups, ads, playout,
    urls: { hls: channelPlaylistUrl(ch.id, 'master.m3u8'), dash: channelPlaylistUrl(ch.id, 'manifest.mpd'), session: `/fast/${ch.id}/s/{session}/master.m3u8` } });
}));

/** Is every asset the channel uses ready to air (packaged, splice-aligned, loudness, 1 s slate)? */
fastRouter.get('/channels/:id/readiness', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const { readinessWithLadder } = await import('../services/fast/prepare');
  const r = await readinessWithLadder(ch.id);
  res.json({ items: r.items, ladder: r.ladder });
}));

/** The ladders a FAST channel can use (the account's encode ladder groups, with their rungs). */
fastRouter.get('/ladders', asyncHandler(async (req, res) => {
  const { fastLadders } = await import('../services/fast/ladder');
  res.json({ items: await fastLadders(accountId(req)) });
}));

/**
 * CHANGE THE CHANNEL'S LADDER (null: the account default). Everything on the
 * channel is packaged to the new one behind the scenes; what is already
 * packaged to it (for this or another channel) is reused. The playout keeps
 * its tracks until it restarts, so a running one is reported.
 */
fastRouter.put('/channels/:id/ladder', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  if ((ch.fast_media ?? 'video') === 'audio') throw badRequest('An audio channel has no video ladder.');
  const b = z.object({ ladderGroupId: uuid.nullable() }).parse(req.body ?? {});
  if (b.ladderGroupId) await checkLadder(req, b.ladderGroupId);
  await query(`UPDATE channels SET fast_ladder_group_id = $2, updated_at = now() WHERE id = $1`, [ch.id, b.ladderGroupId]);
  const { channelLadder } = await import('../services/fast/ladder');
  const ladder = await channelLadder(ch.id);
  const { prepare } = await import('../services/fast/prepare');
  const prepared = await prepare(ch.id, { auto: true });
  const running = await one<any>(`SELECT 1 FROM fast_playouts WHERE channel_id = $1 AND status IN ('starting', 'running') LIMIT 1`, [ch.id]).catch(() => null);
  res.json({ ladder, prepared, restartNeeded: !!running });
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
  // Public with nothing to play gave viewers an empty channel and counted
  // public hours that aired nothing. A run order has to be active first;
  // turning it private is always allowed (build queue 1.14-G5a).
  if (on && !ch.on_air) {
    const active = await one<any>(`SELECT 1 FROM fast_lineups WHERE channel_id = $1 AND status = 'active' LIMIT 1`, [ch.id]);
    if (!active) throw conflict('Activate a run order before making the channel public: until then it has nothing to play.');
  }
  // Through the air-session ledger like every other on-air switch, not a bare
  // UPDATE: a FAST channel's public hours otherwise never reached the
  // on-air totals and as-run reports (services/airSessions.ts).
  const { setOnAir } = await import('../services/airSessions');
  await setOnAir('channel', ch.id, on, { actor: actor(req).label, reason: on ? undefined : 'operator' });
  res.json({ onAir: on });
}));

// ------------------------------------------------------------------ library

/**
 * THE BUILDER'S LIBRARY. With ?channel=<id> it is that channel's library: an
 * audio channel sees audio assets only, a video channel video assets only, and
 * either sees only what can air (packaged for splicing, or a source file on
 * this server to prepare it from). `hidden` says how many were left out and
 * why, so an empty list can explain itself. Without a channel: everything.
 */
fastRouter.get('/library', asyncHandler(async (req, res) => {
  const all = await libraryFor(accountId(req));
  const chId = req.query.channel ? String(req.query.channel) : null;
  const media: FastMedia | null = chId ? ((await ownChannel(req, chId)).fast_media ?? 'video') : null;
  let lib = media ? libraryForMedia(all, media) : airable(all);
  let otherMedia = 0, noSource = 0, notReady = 0, belowLadder = 0;
  for (const a of all.values()) {
    if (media && a.media !== media) otherMedia++;
    else if (media && !a.sourceOk) noSource++;
    else if (a.usageStatus !== 'ready') notReady++;
  }
  // THE CHANNEL'S LADDER (services/fast/ladder.ts): only sources that can fill
  // its top rung, by picture and bitrate, unless ?all=1. Each title says how it
  // fits, so the list can mark the ones whose bitrate was never measured.
  const { channelLadder, fitToTop } = await import('../services/fast/ladder');
  const ladder = chId && media === 'video' ? await channelLadder(chId) : null;
  const fits = new Map<string, { fit: string; why: string | null }>();
  if (ladder) {
    const showAll = req.query.all === '1';
    const kept: typeof lib = new Map();
    for (const [id, a] of lib) {
      const f = fitToTop(a.quality ?? { width: null, height: null, kbps: null }, ladder.rungs[0]);
      fits.set(id, f);
      if (f.fit === 'below') { belowLadder++; if (!showAll) continue; }
      kept.set(id, a);
    }
    lib = kept;
  }
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
  // Titles the channel's lineups already use but the filter leaves out keep
  // their names in the run order (and show up as wrong there, not as "Missing").
  let inUse: typeof assets = [];
  if (chId) {
    const used = new Set<string>();
    for (const l of await query<any>(`SELECT slots, settings FROM fast_lineups WHERE channel_id = $1 AND status <> 'archived'`, [chId])) {
      for (const sl of (l.slots ?? []) as Slot[]) if (sl.kind === 'title') for (const p of sl.pool) if ('assetId' in p) used.add(p.assetId);
      for (const b of l.settings?.backfill ?? []) used.add(String(b));
    }
    inUse = [...used].filter((u) => !lib.has(u) && all.has(u)).map((u) => all.get(u)!);
  }
  const withFit = <T extends { id: string }>(a: T) => (ladder ? { ...a, fit: fits.get(a.id)?.fit ?? 'ok', fitWhy: fits.get(a.id)?.why ?? null } : a);
  res.json({
    media,
    hidden: { otherMedia, noSource, notReady, belowLadder },
    // why each title below the ladder is not offered, so Find media can say so instead of guessing
    belowLadder: ladder ? [...fits].filter(([, f]) => f.fit === 'below').slice(0, 2000).map(([id, f]) => ({ id, why: f.why })) : [],
    ladder: ladder ? { groupId: ladder.groupId, name: ladder.groupName, inherited: ladder.inherited, top: ladder.rungs[0] ?? null, rungs: ladder.rungs } : null,
    inUse: inUse.map(withFit),
    assets: assets.slice(0, 2000).map(withFit),
    series: [...series.values()].map((s) => ({ name: s.name, episodes: s.episodes, seasons: [...s.seasons].sort((x, y) => x - y), durationSec: Math.round(s.durationSec) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}));

// ------------------------------------------------------------------ lineups

const poolRef = z.union([z.object({ assetId: uuid }), z.object({ skip: z.literal(true) })]);
const slotSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(40), kind: z.literal('title'), pool: z.array(poolRef).min(1).max(20), every: z.number().int().min(1).max(52).optional(), phase: z.number().int().min(0).max(51).optional(), label: z.string().max(80).optional(), adRule: z.enum(['default', 'none', 'no_mid']).optional() }),
  z.object({ id: z.string().min(1).max(40), kind: z.literal('series'), series: z.string().min(1).max(200), count: z.number().int().min(1).max(24), order: z.enum(['sequential', 'shuffle']), atEnd: z.enum(['loop', 'stop']).optional(), every: z.number().int().min(1).max(52).optional(), phase: z.number().int().min(0).max(51).optional(), encoreOf: z.string().max(40).nullable().optional(), label: z.string().max(80).optional(), adRule: z.enum(['default', 'none', 'no_mid']).optional() }),
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

/**
 * A lineup draws only on its channel's media: no video title on an audio
 * channel or the other way round (the playout's tracks are the channel's).
 */
async function checkMedia(req: Request, channelId: string, slots: Slot[] | undefined, backfill: string[] | undefined) {
  if (!slots?.length && !backfill?.length) return;
  const ch = await ownChannel(req, channelId);
  const media: FastMedia = ch.fast_media ?? 'video';
  const lib = await libraryFor(accountId(req));
  const wrong = new Set<string>();
  const ids = [...(slots ?? []).flatMap((s) => s.kind === 'title' ? s.pool.flatMap((p) => 'assetId' in p ? [p.assetId] : []) : []), ...(backfill ?? [])];
  for (const id of ids) { const a = lib.get(id); if (a && a.media !== media) wrong.add(a.title); }
  for (const s of slots ?? []) {
    if (s.kind !== 'series' || s.encoreOf) continue;
    const eps = [...lib.values()].filter((a) => a.series?.trim().toLowerCase() === s.series.trim().toLowerCase());
    if (eps.length && !eps.some((a) => a.media === media)) wrong.add(`${s.series} (series)`);
  }
  if (wrong.size) throw badRequest(`This is ${media === 'audio' ? 'an audio' : 'a video'} channel, so it cannot use ${[...wrong].slice(0, 5).join(', ')}${wrong.size > 5 ? ` and ${wrong.size - 5} more` : ''}.`);
}

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
  if (b.slots || b.settings?.backfill) await checkMedia(req, ch.id, b.slots as Slot[] | undefined, b.settings?.backfill);
  const zone = b.zone ?? src?.zone ?? 'UTC';
  if (!isTimeZone(zone)) throw badRequest(`Unknown time zone: ${zone}`);
  const row = await one<any>(
    `INSERT INTO fast_lineups (channel_id, name, epoch, zone, slots, settings, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING *`,
    [ch.id, b.name ?? (src ? `${src.name} (draft)` : 'Lineup'), b.epoch ?? new Date().toISOString(), zone,
     JSON.stringify(slots), JSON.stringify(b.settings ?? src?.settings ?? {}), actorId(req)]);
  if (slots.length) prepareSoon(ch.id);
  res.status(201).json(row);
}));

fastRouter.get('/lineups/:lid', asyncHandler(async (req, res) => res.json(await ownLineup(req, String(req.params.lid)))));

fastRouter.put('/lineups/:lid', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  if (l.status === 'archived') throw conflict('This lineup version is archived. Make a new draft from it instead.');
  const b = lineupBody.parse(req.body ?? {});
  if (b.slots) checkSlots(b.slots as Slot[]);
  if (b.zone && !isTimeZone(b.zone)) throw badRequest(`Unknown time zone: ${b.zone}`);
  await checkMedia(req, l.channel_id, b.slots as Slot[] | undefined, b.settings?.backfill);
  if (l.status === 'active' && (b.slots || b.settings || b.zone || b.epoch)) {
    throw conflict('The active lineup is on air. Edit a draft and activate it: the run order and every series carry on from where they are.');
  }
  const row = await one<any>(
    `UPDATE fast_lineups SET name = COALESCE($2, name), zone = COALESCE($3, zone), epoch = COALESCE($4::timestamptz, epoch),
            slots = COALESCE($5::jsonb, slots), settings = COALESCE($6::jsonb, settings), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [l.id, b.name ?? null, b.zone ?? null, b.epoch ?? null, b.slots ? JSON.stringify(b.slots) : null, b.settings ? JSON.stringify(b.settings) : null]);
  if (b.slots || b.settings?.backfill) prepareSoon(l.channel_id);
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
  const lib = airable(await libraryFor(accountId(req)));
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

/**
 * START, RESTART OR STOP THE PLAYOUT by hand: the channel page's Start. The
 * scheduler keeps a playout running for every channel with an active run
 * order (reconcilePlayouts, every 30 s); this is for not waiting, for kicking
 * a stuck one, and for stopping it. Start needs an active run order; Stop
 * holds until the next scheduler tick restarts it unless the run order is
 * deactivated.
 */
fastRouter.post('/channels/:id/playout', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const action = String(req.body?.action ?? 'start');
  const runner = await import('../services/fast/playoutRunner');
  if (action === 'stop') { await runner.stopPlayout(ch.id, 'stopped from the console'); return res.json({ playout: 'stopped' }); }
  const active = await one<any>(`SELECT id FROM fast_lineups WHERE channel_id = $1 AND status = 'active' LIMIT 1`, [ch.id]);
  if (!active) throw conflict('Activate a run order first: the playout plays the active run order.');
  if (action === 'restart') await runner.stopPlayout(ch.id, 'restarted from the console');
  const playout = await runner.startPlayout(ch.id, action === 'restart');
  if (playout === 'run separately') throw conflict('This server runs no FAST playouts (FAST_LAUNCHER=off or an unsupported launcher). Set FAST_LAUNCHER=local, or run fast_playout.py --channel <id>.');
  res.json({ playout });
}));

/**
 * SLATES & LOOPS AS FILLER. Pick the channel's slate and gap loop from Loops
 * & Fillers. Each is rendered once into a library asset (fillerBridge.ts),
 * set as the channel's slate (ad breaks nobody sold, gaps) or loop (gaps, in
 * the slate's place; with breaksUseLoop, breaks too) and prepared for air.
 * null takes it off; leaving a key out keeps it.
 */
const fillerBody = z.object({
  slateFillerId: z.string().uuid().nullable().optional(),
  loopFillerId: z.string().uuid().nullable().optional(),
  breaksUseLoop: z.boolean().optional(),
});
fastRouter.put('/channels/:id/filler', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const b = fillerBody.parse(req.body ?? {});
  const { vodForFiller, FillerError } = await import('../services/fast/fillerBridge');
  const cur = await one<any>(`SELECT policy FROM channel_ads WHERE channel_id = $1`, [ch.id]);
  const policy: any = { ...(cur?.policy ?? {}) };
  const sources: Record<string, string> = { ...(policy.fillerSources ?? {}) };
  const brand: any = { mode: 'off', identIds: [], ...(policy.brand ?? {}) };
  try {
    if (b.slateFillerId !== undefined) {
      if (policy.slateAssetId && sources[policy.slateAssetId]) delete sources[policy.slateAssetId];
      if (b.slateFillerId) { const v = await vodForFiller(String(ch.account_id), b.slateFillerId); policy.slateAssetId = v.assetId; sources[v.assetId] = b.slateFillerId; }
      else policy.slateAssetId = null;
    }
    if (b.loopFillerId !== undefined) {
      if (brand.loopAssetId && sources[brand.loopAssetId]) delete sources[brand.loopAssetId];
      if (b.loopFillerId) { const v = await vodForFiller(String(ch.account_id), b.loopFillerId); brand.loopAssetId = v.assetId; sources[v.assetId] = b.loopFillerId; }
      else brand.loopAssetId = null;
    }
  } catch (e: any) {
    if (e instanceof FillerError) throw e.status === 404 ? notFound(e.message) : conflict(e.message);
    throw e;
  }
  if (b.breaksUseLoop !== undefined) policy.breaksUseLoop = b.breaksUseLoop;
  policy.fillerSources = sources;
  policy.brand = brand;
  await query(
    `INSERT INTO channel_ads (channel_id, mode, policy) VALUES ($1, 'off', $2::jsonb)
     ON CONFLICT (channel_id) DO UPDATE SET policy = $2::jsonb, updated_at = now()`, [ch.id, JSON.stringify(policy)]);
  const prepared = await import('../services/fast/prepare').then((m) => m.prepare(ch.id, { auto: true })).catch(() => null);
  res.json({ ...(await adsFor(ch.id)), prepared });
}));

fastRouter.post('/lineups/:lid/activate', asyncHandler(async (req, res) => {
  const l = await ownLineup(req, String(req.params.lid));
  if (!(l.slots ?? []).length) throw badRequest('The lineup has no slots yet.');
  const r = await activateLineup(l.id);
  const applied = await applyLineup(l.id, { days: l.settings?.horizonDays ?? DEFAULT_HORIZON_DAYS });
  // anything not ready to air is prepared now (splice-aligned re-encodes, loudness, the 1 s slate)
  const prepared = await import('../services/fast/prepare').then((m) => m.prepare(l.channel_id, { auto: true })).catch(() => null);
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
  /** The channel's brand loop: idents between programmes (store.ts ChannelBrand). */
  brand: z.object({
    mode: z.enum(['off', 'pad', 'between']),
    identIds: z.array(uuid).max(20).default([]),
    loopAssetId: uuid.nullable().optional(),
  }).optional(),
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
    if (!cur?.ad_server_id) throw badRequest('Stitched ads need an ad server. Add one, or choose "Ad markers for a FAST platform" to let the platform that carries the channel insert the ads.');
  }
  // `enabled` follows the mode (off = no breaks) unless it is set on purpose
  const policy = b.policy ? (() => { const r: any = { ...resolveAdPolicy(b.policy), slateAssetId: b.policy.slateAssetId ?? null }; if (typeof b.policy.enabled !== 'boolean') delete r.enabled; return r; })() : null;
  // The brand lives in the same stored policy: saving the ad policy keeps it,
  // and a brand change is written on its own below.
  if (policy) {
    // kept from the stored policy: the brand, and where the slate and loop came from (Loops & Fillers)
    const cur = await one<any>(`SELECT policy->'brand' AS brand, policy->'fillerSources' AS sources, policy->'breaksUseLoop' AS bul FROM channel_ads WHERE channel_id = $1`, [ch.id]);
    if (cur?.brand) policy.brand = cur.brand;
    if (cur?.sources) policy.fillerSources = cur.sources;
    if (cur?.bul != null) policy.breaksUseLoop = cur.bul;
  }
  if (b.brand) {
    const ids = [...new Set([...b.brand.identIds, ...(b.brand.loopAssetId ? [b.brand.loopAssetId] : [])])];
    if (ids.length) {
      const own = await query<any>(
        `SELECT v.id FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
           LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
          WHERE v.id = ANY($1::uuid[]) AND COALESCE(g.account_id, v.account_id) = $2`, [ids, accountId(req)]);
      if (own.length !== ids.length) throw notFound('An ident or brand loop was not found in this account');
    }
  }
  await query(
    `INSERT INTO channel_ads (channel_id, mode, policy, ad_server_id, house_ads, decision_scope)
     VALUES ($1, COALESCE($2, 'off'), COALESCE($3::jsonb, '{}'::jsonb), $4, COALESCE($5::jsonb, '[]'::jsonb), COALESCE($6, 'session'))
     ON CONFLICT (channel_id) DO UPDATE SET
       mode = COALESCE($2, channel_ads.mode), policy = COALESCE($3::jsonb, channel_ads.policy),
       ad_server_id = CASE WHEN $7 THEN $4 ELSE channel_ads.ad_server_id END,
       house_ads = COALESCE($5::jsonb, channel_ads.house_ads), decision_scope = COALESCE($6, channel_ads.decision_scope), updated_at = now()`,
    [ch.id, b.mode ?? null, policy ? JSON.stringify(policy) : null, b.adServerId ?? null, b.houseAds ? JSON.stringify(b.houseAds) : null, b.scope ?? null, b.adServerId !== undefined]);
  if (b.brand) {
    await query(`UPDATE channel_ads SET policy = jsonb_set(COALESCE(policy, '{}'::jsonb), '{brand}', $2::jsonb), updated_at = now() WHERE channel_id = $1`,
      [ch.id, JSON.stringify({ mode: b.brand.mode, identIds: b.brand.identIds, loopAssetId: b.brand.loopAssetId ?? null })]);
  }
  // a house spot, slate, ident or loop just added is packaged for the channel
  if (b.houseAds || b.brand || b.policy?.slateAssetId !== undefined) prepareSoon(ch.id);
  res.json(await adsFor(ch.id));
}));

/**
 * GOING TO AIR: what the playout plays over the next few hours, exactly as
 * it will play it (the same timeline the playout reads, services/fast/store.ts
 * timelineFor): programmes cut around their breaks, each break, and each gap
 * with its ident, house spots and brand loop. For the On air tab's rundown
 * beside the preview. `hours` ahead (default 3, at most 12), `back` hours
 * behind (default 0.5, at most 3).
 */
fastRouter.get('/channels/:id/rundown', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const num = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const hours = num(req.query.hours, 3, 0.25, 12), back = num(req.query.back, 0.5, 0, 3);
  const now = Date.now();
  const tl = await timelineFor(ch.id, new Date(now - back * 3600_000), new Date(now + hours * 3600_000));
  const ms = (iso: string) => Date.parse(iso);
  const iso = (n: number) => new Date(n).toISOString();
  const rows: RundownRow[] = [];
  for (const it of tl.items) {
    const start = ms(it.start), end = start + it.durationSec * 1000;
    if (it.kind === 'content') {
      const [programmeId, inSec] = it.id.split(':');
      rows.push({ kind: 'programme', id: it.id, programmeId, start: iso(start), end: iso(end), durationSec: it.durationSec, title: it.title, part: Number(inSec) > 0 ? 'resumes' : 'starts', assetId: it.assetId, inSec: it.inSec });
    } else if (it.kind === 'break') {
      rows.push({ kind: 'break', id: it.id, start: iso(start), end: iso(end), durationSec: it.durationSec, title: it.position === 'mid' ? 'Ad break' : 'Ad break (end)',
        fill: it.fill.map((f) => ({ kind: f.kind, title: f.title ?? null, durationSec: f.durationSec })) });
    } else {
      // a gap: one row per thing that plays in it
      let t = start;
      it.fill.forEach((f, k) => {
        const kind: RundownRow['kind'] = f.kind === 'ident' ? 'ident' : f.kind === 'house' ? 'house' : f.title === 'Brand loop' ? 'loop' : 'slate';
        const d = Math.min(f.durationSec, (end - t) / 1000);
        if (d <= 0.05) return;
        rows.push({ kind, id: `${it.id}:${k}`, start: iso(t), end: iso(t + d * 1000), durationSec: Math.round(d * 1000) / 1000, title: f.title ?? (kind === 'slate' ? 'Slate' : 'Filler'), assetId: f.assetId ?? null });
        t += d * 1000;
      });
    }
  }
  const brand = (await adsFor(ch.id)).brand;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ now: iso(now), from: tl.from, to: tl.to, adsMode: tl.adsMode, brandMode: brand.mode, items: rows.filter((r) => ms(r.end) > now - back * 3600_000) });
}));
interface RundownRow {
  kind: 'programme' | 'break' | 'ident' | 'loop' | 'house' | 'slate';
  id: string; start: string; end: string; durationSec: number; title: string;
  programmeId?: string; part?: 'starts' | 'resumes';
  /** The library asset that plays (programme, ident, house spot, loop); `inSec` is where in it this row starts. */
  assetId?: string | null; inSec?: number;
  fill?: { kind: string; title: string | null; durationSec: number }[];
}

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
  const since = new Date(Date.now() - days * 86400_000);
  res.json({ ...(await adReport(ch.id, since)), beacons: await beaconReport(ch.id, since), creatives });
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

/**
 * What the stitcher reported to the ad servers for one break: per ad in the
 * pod, per beacon event, how many viewers reached it and how many pixels were
 * answered or failed, plus the latest 100 rows (tracker host, not the URL).
 */
fastRouter.get('/channels/:id/breaks/:bid/beacons', asyncHandler(async (req, res) => {
  const ch = await ownChannel(req, String(req.params.id));
  const bid = String(req.params.bid);
  if (!uuid.safeParse(bid).success) throw notFound('Break not found');
  const b = await one<any>(`SELECT id, starts_at, duration_ms FROM stream_breaks WHERE id = $1 AND channel_id = $2`, [bid, ch.id]);
  if (!b) throw notFound('Break not found');
  res.json({ breakId: b.id, startsAt: b.starts_at, durationSec: Number(b.duration_ms) / 1000, ...(await breakBeacons(b.id)) });
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
    if (l.startsWith('#EXT-X-STREAM-INF:') && lines[i + 1]) {
      const h = l.match(/RESOLUTION=\d+x(\d+)/)?.[1];
      // an audio-only asset (a song, an audio ad) lists its audio as the variant itself: that is the 'audio' track
      if (h) out[`v${h}`] = await media(lines[i + 1]);
      else if (!out.audio) out.audio = await media(lines[i + 1]);
    }
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

/** The session whose decisions a viewer's stitched playlist uses (one per channel when the channel decides once for everyone). */
async function decisionSidFor(channelId: string, sid: string) {
  const ads = await adsFor(channelId);
  return ads.scope === 'channel' ? `channel-${channelId}` : sid;
}

/**
 * THE ADS IN A VIEWER'S BREAKS, for the player: when each paid ad plays (wall
 * clock, the playlist's PROGRAM-DATE-TIME) and where a click on it goes.
 * A server cannot see a click, so this is how the player learns which ad is
 * on screen and what to open.
 */
fastPublicRouter.get('/:id/s/:sid/ads.json', asyncHandler(async (req, res) => {
  const id = String(req.params.id), sid = String(req.params.sid);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{8,80}$/.test(sid)) throw notFound();
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  const dsid = await decisionSidFor(id, sid);
  const recent = await query<any>(
    `SELECT id, starts_at, duration_ms FROM stream_breaks WHERE channel_id = $1 AND status = 'scheduled'
        AND starts_at BETWEEN now() - interval '15 minutes' AND now() + interval '2 minutes' ORDER BY starts_at`, [id]);
  const out = [];
  for (const b of recent) {
    const plan = await sessionStore.pod<any>(dsid, b.id);
    if (!plan?.items) continue;
    const startMs = new Date(b.starts_at).getTime();
    let t = startMs;
    const ads = [];
    for (let p = 0; p < plan.items.length; p++) {
      const it = plan.items[p];
      if (it.kind === 'ad') ads.push({ podIndex: p, title: it.title ?? null, startsAt: new Date(t).toISOString(), durationSec: it.durationSec,
        clickUrl: it.clickThrough ? `/fast/${id}/s/${sid}/click/${b.id}/${p}` : null });
      t += it.durationSec * 1000;
    }
    out.push({ breakId: b.id, startsAt: b.starts_at, durationSec: Number(b.duration_ms) / 1000, ads });
  }
  res.json({ breaks: out });
}));

/** A click on a stitched ad: recorded with the beacons, its click trackers sent, then on to the advertiser. */
fastPublicRouter.get('/:id/s/:sid/click/:bid/:p', asyncHandler(async (req, res) => {
  const id = String(req.params.id), sid = String(req.params.sid), bid = String(req.params.bid), p = Number(req.params.p);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{8,80}$/.test(sid) || !/^[0-9a-f-]{36}$/i.test(bid) || !Number.isInteger(p) || p < 0 || p > 100) throw notFound();
  const plan = await sessionStore.pod<any>(await decisionSidFor(id, sid), bid);
  const it = plan?.items?.[p];
  if (!it || it.kind !== 'ad' || !it.clickThrough || !/^https?:\/\//i.test(it.clickThrough)) throw notFound('This ad has no page to open');
  const ctx = await sessionStore.context(sid, () => ({ channelId: id, ip: req.ip, userAgent: req.header('user-agent') ?? null }));
  const urls: (string | null)[] = (it.clickTracking ?? []).length ? it.clickTracking : [null];
  void Promise.all(urls.map(async (url, urlIndex) => {
    const claimed = await one<{ id: string }>(
      `INSERT INTO ad_beacons (channel_id, break_id, session_id, pod_index, ad_id, creative_key, event, url_index, url, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,'click',$7,$8, now()) ON CONFLICT (session_id, break_id, pod_index, event, url_index) DO NOTHING RETURNING id`,
      [id, bid, sid, p, it.adId, it.creativeKey, url ? urlIndex : -1, url ?? '']).catch(() => null);
    if (!claimed || !url) return;
    const t0 = Date.now();
    const r = await fetchTracker(url, { ip: (ctx as any).ip ?? null, userAgent: (ctx as any).userAgent ?? null });
    await query(`UPDATE ad_beacons SET status = $2, ok = $3, error = $4, elapsed_ms = $5, sent_at = now() WHERE id = $1`, [claimed.id, r.status, r.error == null, r.error, Date.now() - t0]).catch(() => null);
  })).catch(() => null);
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, it.clickThrough);
}));
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
    `SELECT id, starts_at, duration_ms FROM stream_breaks WHERE channel_id = $1 AND status = 'scheduled'
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
  const plans = new Map<string, any>();
  for (const b of recent) {
    const plan = await sessionStore.pod<any>(decisionSid, b.id);
    if (plan) { plans.set(b.id, plan); podCache.set(`brk:${b.id}`, await podSegments(plan, track, slate).catch(() => null)); }
  }
  const st = (await sessionStore.track<SessionState>(sid, track)) ?? { startedMs: Number((ctx as any).started ?? Date.now()), breaks: {} };
  // the channel playlist names a break brk:<id>; the pod is looked up by that
  const out = stitchHls(text, st, (breakId) => podCache.get(breakId) ?? null).replace(/#loop\d+/g, '');
  await sessionStore.saveTrack(sid, track, st);
  res.send(out);
  // SERVER-SIDE BEACONS (beacons.ts, beaconSender.ts), after the answer: the
  // paid ads this viewer was actually given, placed where its player now is.
  if (ads.mode === 'stitched') {
    (async () => {
      const head = playheadOf(out);
      if (head == null) return;
      const sched: ScheduledAd[] = [];
      for (const [bid, plan] of plans) {
        const bs = st.breaks[`brk:${bid}`];
        if (!bs?.eligible || bs.podSegs == null || !Array.isArray(plan?.items)) continue; // this viewer got the house fill
        sched.push(...adSchedule(`brk:${bid}`, plan.items, bs.startMs, bs.durationSec));
      }
      // one beacon clock per session, whichever of its playlists refreshed
      const bst = (await sessionStore.track<BeaconState>(sid, '_beacons')) ?? { done: [] };
      const { due } = dueBeacons(bst, sched, head, Date.now());
      await sessionStore.saveTrack(sid, '_beacons', bst);
      await sendBeacons({ channelId: id, sessionId: sid, ip: (ctx as any).ip ?? null, userAgent: (ctx as any).userAgent ?? null }, due);
    })().catch(() => null);
  }
}));
