// ============================================================================
//  THE EMBEDDABLE PLAYER'S API.
//
//  Two surfaces with opposite trust models, in one file because keeping them
//  apart in the reader's head is the whole point.
//
//    playerRouter        PUBLIC. Called by a player running on somebody
//                        else's website. Authenticated by a PUBLISHABLE key
//                        plus the app's origin allow-list. Never a JWT.
//
//    playerAdminRouter   The console. Ordinary session auth, tenant-scoped,
//                        mounted under /api/player-config.
//
//  ------------------------------------------------------------------------
//  WHAT THE KEY ACTUALLY PROVES, AND WHAT IT DOES NOT.
//
//  A publishable key ships inside a web page. Anyone who can view source can
//  read it, and no amount of care changes that — so it is not a secret and is
//  not treated as one. What it provides is ATTRIBUTION and REVOCATION: which
//  app is this, whose account does it belong to, and can it be turned off. The
//  origin allow-list is what stops the key working when it is lifted and
//  pasted into another site, and it is enforced server-side on every session
//  request rather than trusted from anything the page says about itself.
//
//  THE STATION ID IS CHECKED AGAINST THE KEY'S ACCOUNT. Without that, a
//  publishable key would only prove the caller had SOME key, and any tenant
//  could open a player onto another tenant's station. A station that is not
//  theirs is answered exactly like one that does not exist, so the endpoint is
//  not an oracle for guessing ids.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { verifyKey, checkRestrictions, appForKey } from '../services/apiKeys';
import { cachedTrackMeta, buildCard } from '../services/radio/trackMeta';
import { publicMp3Url } from '../services/radio/jobConfig';
import { icyState } from '../services/radio/icyMeta';
import { cached } from '../scale/cache';
import { scaleConfig } from '../scale/config';
import { assetKindFor } from '../services/viewerPath';
import { playerEventBatch } from '../scale/batches';

export const playerRouter = Router();
export const playerAdminRouter = Router();

// ---------------------------------------------------------------------------
//  Shared shapes
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  layout: 'card' as const,
  primaryColor: '#3f7bff',
  secondaryColor: '#0f1218',
  options: {} as Record<string, any>,
  fallbackTitle: null as string | null,
  fallbackText: null as string | null,
  fallbackArtworkUrl: null as string | null,
};

function shapeConfig(row: any) {
  if (!row) return { ...DEFAULT_CONFIG, id: null, name: 'Default', source: 'default' as const };
  return {
    id: row.id,
    name: row.name,
    layout: row.layout,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    options: row.options ?? {},
    fallbackTitle: row.fallback_title ?? null,
    fallbackText: row.fallback_text ?? null,
    fallbackArtworkUrl: row.fallback_artwork_url ?? null,
    source: (row.channel_id ? 'channel' : 'account') as 'channel' | 'account',
  };
}

/**
 * The config for one station: its own, else the account default, else built in.
 *
 * A three-level fallback rather than two so a customer can style every station
 * at once and still override one, which is what a broadcaster with a dozen
 * stations and one brand actually wants.
 */
async function configFor(accountIdVal: string, channelId: string) {
  // Cached: every listener start asked for it. Edits invalidate through the
  // player_configs trigger (migration 0046).
  return cached(`pcfg:${accountIdVal}:${channelId}`,
    { ttlSec: scaleConfig.cache.rulesTtlSec, tags: [`playercfg:${accountIdVal}`, `asset:${channelId}`] },
    () => configForUncached(accountIdVal, channelId));
}

/**
 * The station as the public player sees it, cached. 404 for another tenant's
 * station or a missing one alike (the null is cached under the asking account).
 */
function radioStation(acct: string, channelId: string): Promise<any | null> {
  return cached(`radiost:${acct}:${channelId}`,
    { ttlSec: scaleConfig.cache.rulesTtlSec, tags: [`asset:${channelId}`, `acct:${acct}`] },
    () => one<any>(
      `SELECT c.id, c.name, c.kind, c.status, c.metadata, c.brand_ref, g.account_id
         FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2 AND c.kind = 'radio'`,
      [channelId, acct]));
}

async function configForUncached(accountIdVal: string, channelId: string) {
  const row = await one<any>(
    `SELECT * FROM player_configs
      WHERE account_id = $1 AND (channel_id = $2 OR channel_id IS NULL)
      ORDER BY (channel_id IS NULL)   -- the station's own row sorts first
      LIMIT 1`,
    [accountIdVal, channelId]
  );
  return shapeConfig(row);
}

// ---------------------------------------------------------------------------
//  PUBLIC: the session handshake
// ---------------------------------------------------------------------------

const sessionSchema = z.object({
  appKey: z.string().min(8),
  channelId: z.string().uuid(),
});

/**
 * Everything the player needs to start, in one request.
 *
 * One round trip on purpose: an embed that has to fetch a key check, then a
 * config, then a manifest URL, then now-playing, is four chances to be slow on
 * somebody else's website and four things to get wrong in a CORS policy.
 *
 * The response deliberately contains NO secret. The URLs it returns are the
 * same public delivery URLs the CDN serves; the gate is on being told which
 * ones, not on the bytes.
 */
playerRouter.post('/session', asyncHandler(async (req, res) => {
  const b = sessionSchema.parse(req.body);
  const key = await verifyKey(b.appKey);
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');

  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, {
    referrer: req.get('referer') || undefined,
    origin: req.get('origin') || undefined,
    ip: req.ip,
  });
  // The message names the reason because the person reading it is a developer
  // embedding the player, and "forbidden" would send them looking at their key
  // when the problem is their domain not being on the list.
  if (reason) throw new ApiError(403, reason);

  // THE STATION MUST BELONG TO THE KEY'S ACCOUNT. Answered as 404 whether it
  // is another tenant's or does not exist, so this cannot be used to discover
  // which uuids are real.
  const ch = await radioStation(key.account_id, b.channelId);
  if (!ch) throw notFound('Station not found');

  const cfg = await configFor(key.account_id, ch.id);
  const base = config.publicBaseUrl.replace(/\/$/, '');

  res.json({
    station: {
      id: ch.id,
      name: ch.name,
      description: cfg.fallbackText ?? ch.metadata?.description ?? null,
      artworkUrl: cfg.fallbackArtworkUrl ?? ch.brand_ref ?? null,
      onAir: ch.status === 'live',
    },
    // ALL THREE, and the player picks. Shaka handles HLS and DASH; MP3 is a
    // plain media element source and is the one that works in an embed with no
    // Media Source Extensions at all. Sending all three lets the player fall
    // back without another round trip when a manifest fails on somebody's
    // corporate network.
    sources: {
      mp3: publicMp3Url(ch.id),
      hls: `${base}/live/${ch.id}/master.m3u8`,
      dash: `${base}/live/${ch.id}/manifest.mpd`,
    },
    config: cfg,
    // Where to send telemetry, so the bundle needs no build-time base URL and
    // the same file works on every deployment.
    report: { url: `${base}/api/player/events`, ttlSec: config.player.sessionTtlSec },
  });
}));

/**
 * PUBLIC: what is playing now.
 *
 * Reads the CACHE only. The MusicBrainz lookup runs in the station's metadata
 * reader, behind a one-per-second process-wide queue; putting it in this path
 * would mean every player polling every station queued behind every other, and
 * the first thing to break would be the rate limit that is enforced by
 * blocking our IP for every tenant at once.
 *
 * The fallback is applied SERVER SIDE and returned already resolved, so three
 * layouts cannot each implement "what do we show when there is no track"
 * slightly differently.
 */
playerRouter.post('/now-playing', asyncHandler(async (req, res) => {
  const b = sessionSchema.parse(req.body);
  const key = await verifyKey(b.appKey);
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, {
    referrer: req.get('referer') || undefined,
    origin: req.get('origin') || undefined,
    ip: req.ip,
  });
  if (reason) throw new ApiError(403, reason);

  const ch = await radioStation(key.account_id, b.channelId);
  if (!ch) throw notFound('Station not found');

  const cfg = await configFor(key.account_id, ch.id);
  const icy = icyState(ch.id);
  const meta = await cachedTrackMeta(icy?.title ?? null);
  const card = buildCard(meta, {
    name: cfg.fallbackTitle ?? ch.name,
    description: cfg.fallbackText ?? ch.metadata?.description ?? null,
    artworkUrl: cfg.fallbackArtworkUrl ?? ch.brand_ref ?? null,
  });

  // THE LAST FIVE TRACKS (the SDK's now-playing skin), each with what the
  // metadata cache knows (artwork, album). Cache reads only, like the card.
  const recent = await recentTracks(ch.id, icy?.title ?? null).catch(() => []);
  const history = [];
  for (const r of recent) {
    const m = await cachedTrackMeta(r.raw).catch(() => null);
    if (!m || !m.title) continue;
    history.push({ title: m.title, artist: m.artist ?? null, album: m.album ?? null, year: m.year ?? null,
      artworkUrl: m.artworkUrl ?? null, startedAt: r.startedAt });
  }

  res.json({
    ...card,
    onAir: ch.status === 'live',
    // The raw ICY line, so an embedder debugging a bad parse can see what the
    // station actually sent rather than guessing from the parsed result.
    raw: icy?.title ?? null,
    since: icy?.since ?? null,
    history,
    // What is next is only known from a schedule, not from ICY; the SDK reads the guide for that.
    next: null,
  });
}));

/**
 * The last tracks a station played, from its content log (the ICY titles the
 * metadata reader records as programmes). Songs only: idents and ad breaks are
 * not "recently played". Cached for a few seconds, because every listener's
 * player asks the same question.
 */
function recentTracks(channelId: string, excludeRaw: string | null): Promise<Array<{ raw: string; startedAt: number }>> {
  return cached(`np-hist:${channelId}`, { ttlSec: 10, tags: [`asset:${channelId}`] }, async () => {
    const rows = await query<any>(
      `SELECT title, starts_at FROM programmes
        WHERE channel_id = $1 AND source_ref LIKE 'icy:%' AND COALESCE(metadata->>'class', 'song') = 'song'
        ORDER BY starts_at DESC LIMIT 7`, [channelId]);
    return rows.map((r: any) => ({ raw: r.title as string, startedAt: new Date(r.starts_at).getTime() }));
  }).then((list) => {
    // The newest row is the track playing now: leave it out of the history.
    const out = list.filter((x, i) => !(i === 0 && excludeRaw && x.raw === excludeRaw));
    return out.slice(0, 5);
  });
}

// ---------------------------------------------------------------------------
//  PUBLIC: the guide, for the SDK player's schedule, up next and start over
// ---------------------------------------------------------------------------

const epgQuery = z.object({
  appKey: z.string().min(8),
  channelId: z.string().uuid(),
  /** Hours back and forward. Back so "start over" and the schedule show what aired. */
  past: z.coerce.number().min(0).max(24).default(6),
  hours: z.coerce.number().min(1).max(72).default(24),
});

/**
 * GET /api/player/epg?appKey=pk_…&channelId=<channel or event>
 *
 * The published guide around now: programmes from `past` hours ago to `hours`
 * ahead. Keyed and origin-checked like every player call; a channel of another
 * account answers 404 like one that does not exist. The radio content log (the
 * as-run ICY titles) is not a guide and is left out. Cached briefly and safe
 * for the edge: the same for every viewer of the channel.
 */
playerRouter.get('/epg', asyncHandler(async (req, res) => {
  const q = epgQuery.parse(req.query);
  const key = await verifyKey(q.appKey);
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
  if (reason) throw new ApiError(403, reason);
  const kind = await assetKindFor(key.account_id, q.channelId);
  if (kind !== 'channel' && kind !== 'event') throw notFound('Channel not found');
  const col = kind === 'event' ? 'event_id' : 'channel_id';
  const programmes = await cached(`player-epg:${q.channelId}:${q.past}:${q.hours}:${Math.floor(Date.now() / 60000)}`,
    { ttlSec: 60, tags: [`asset:${q.channelId}`, `epg:${q.channelId}`] }, async () => {
      const rows = await query<any>(
        `SELECT id, title, starts_at, ends_at, metadata FROM programmes
          WHERE ${col} = $1 AND (source_ref IS NULL OR source_ref NOT LIKE 'icy:%')
            AND status <> 'cancelled'
            AND ends_at > now() - make_interval(hours => $2::int) AND starts_at < now() + make_interval(hours => $3::int)
          ORDER BY starts_at LIMIT 400`, [q.channelId, Math.round(q.past), Math.round(q.hours)]);
      return rows.map((r: any) => {
        const md = r.metadata ?? {};
        const img = [md.imageUrl, md.image, md.poster].find((v) => typeof v === 'string' && /^(https?:\/\/|\/(?!\/))/.test(v)) ?? null;
        return {
          id: r.id, title: r.title,
          subtitle: md.subtitle ?? md.episodeTitle ?? null,
          description: md.description ?? md.synopsis ?? null,
          imageUrl: img,
          startsAt: new Date(r.starts_at).getTime(), endsAt: new Date(r.ends_at).getTime(),
        };
      });
    });
  res.set('cache-control', 'public, max-age=60');
  res.json({ channelId: q.channelId, programmes });
}));

// ---------------------------------------------------------------------------
//  PUBLIC: an event, for the SDK's event skin (countdown, phases, replay)
// ---------------------------------------------------------------------------

const eventQuery = z.object({ appKey: z.string().min(8), eventId: z.string().uuid() });

/**
 * GET /api/player/event?appKey=pk_…&eventId=<uuid>
 *
 * Everything the event skin shows around the stream: the title and promo
 * (poster, teams or performers), when it starts in the viewer's own clock,
 * which phase it is in, the promoter's messages, and the published replay.
 *
 * THE PHASE IS DECIDED HERE, not by the player's clock: a start time passing
 * does not mean the event started, and a called-off match must not count down.
 *
 *   cancelled / postponed  from the metadata's schema.org eventStatus
 *   live                   live, inside its public window, output valid
 *   pre                    before the start
 *   replay / ended         after it, with or without a published replay
 *   offline                past the start but not producing (a delayed start)
 */
playerRouter.get('/event', asyncHandler(async (req, res) => {
  const q = eventQuery.parse(req.query);
  const key = await verifyKey(q.appKey);
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
  if (reason) throw new ApiError(403, reason);
  if ((await assetKindFor(key.account_id, q.eventId)) !== 'event') throw notFound('Event not found');
  const body = await cached(`player-event:${q.eventId}`, { ttlSec: 10, tags: [`asset:${q.eventId}`] }, async () => {
    const e = await one<any>(
      `SELECT id, name, status, scheduled_start, scheduled_end, public_start, public_end, metadata FROM events WHERE id = $1`, [q.eventId]);
    if (!e) return null;
    const md = e.metadata ?? {};
    const ms = (v: any) => (v ? new Date(v).getTime() : null);
    const startsAt = ms(e.public_start) ?? ms(e.scheduled_start);
    const endsAt = ms(e.public_end) ?? ms(e.scheduled_end);
    const replay = await one<any>(
      `SELECT id FROM vod_assets WHERE event_id = $1 AND published ORDER BY created_at DESC LIMIT 1`, [q.eventId]);
    const { presentationFromEventStatus, promoFromMetadata } = await import('../services/eventPromo');
    const { resolveEventManifest } = await import('./publicLive');
    const live = (await resolveEventManifest(q.eventId, 'master.m3u8')).ok;
    const now = Date.now();
    const presentation = presentationFromEventStatus(md.eventStatus)
      ?? (live ? 'live'
        : e.status === 'ended' || (endsAt != null && now > endsAt) ? (replay ? 'replay' : 'ended')
        : startsAt != null && now < startsAt ? 'pre'
        : 'offline');
    const prev = ms(md.previousStartDate);
    const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      id: e.id, title: str(md.name) ?? e.name, description: str(md.description),
      startsAt, endsAt, previousStartsAt: prev && prev !== startsAt ? prev : null,
      presentation,
      preMessage: str(md.preMessage), endedMessage: str(md.endedMessage),
      promo: promoFromMetadata(md, { type: md['@type'] ?? md.type ?? null }),
      replayAssetId: replay?.id ?? null,
    };
  });
  if (!body) throw notFound('Event not found');
  res.set('cache-control', 'public, max-age=10');
  res.json(body);
}));

// ---------------------------------------------------------------------------
//  PUBLIC: telemetry
// ---------------------------------------------------------------------------

const EVENTS = [
  'player.load',        // the bundle initialised
  'player.ready',       // a source was selected and attached
  'manifest.ok',        // the manifest parsed
  'manifest.error',     // it did not
  'play', 'pause', 'stop',
  'stall', 'recover',
  'error',
] as const;

const eventSchema = z.object({
  appKey: z.string().min(8),
  channelId: z.string().uuid(),
  sessionId: z.string().min(6).max(64),
  events: z.array(z.object({
    event: z.enum(EVENTS),
    at: z.number().optional(),
    layout: z.string().max(32).optional(),
    detail: z.record(z.any()).optional(),
  })).min(1).max(50),
});

/**
 * Player telemetry.
 *
 * BATCHED, because the alternative is a request per play/pause from every
 * embed on the internet. Capped at fifty per call so a broken or hostile
 * client cannot post a megabyte of events in one go.
 *
 * The ORIGIN is taken from the request header and never from the body. The
 * commonest support question is "it works on one of our sites and not the
 * other", and an origin the client could set would answer it wrongly.
 */
playerRouter.post('/events', asyncHandler(async (req, res) => {
  const b = eventSchema.parse(req.body);
  const key = await verifyKey(b.appKey);
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, {
    referrer: req.get('referer') || undefined,
    origin: req.get('origin') || undefined,
    ip: req.ip,
  });
  if (reason) throw new ApiError(403, reason);

  // Scoped like everything else: events for a station that is not this
  // account's are dropped rather than recorded against the wrong tenant.
  // Ownership comes from the cache, and the rows go into a batch: one
  // multi-row INSERT per second per process instead of one per event.
  if ((await assetKindFor(key.account_id, b.channelId)) !== 'channel') throw notFound('Station not found');

  const origin = req.get('origin') || req.get('referer') || null;
  for (const e of b.events) {
    playerEventBatch.add([key.account_id, b.channelId, app.id, b.sessionId, e.event, origin?.slice(0, 300) ?? null,
      e.layout ?? null, JSON.stringify(e.detail ?? {}), e.at != null ? new Date(e.at) : new Date()]);
  }
  // 204: there is nothing useful to say back, and a body would be parsed by
  // clients that should be using sendBeacon and ignoring the response.
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
//  CONSOLE: configuration and reporting
// ---------------------------------------------------------------------------
playerAdminRouter.use(requireAuth);

const HEX = /^#[0-9a-fA-F]{6}$/;
const configSchema = z.object({
  channelId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(80).optional(),
  layout: z.enum(['card', 'bar', 'hero', 'stage', 'video', 'event', 'audio_square', 'audio_wave', 'audio_nowplaying', 'audio_radio']).optional(),
  primaryColor: z.string().regex(HEX, 'colour must be #rrggbb').optional(),
  secondaryColor: z.string().regex(HEX, 'colour must be #rrggbb').optional(),
  options: z.record(z.any()).optional(),
  fallbackTitle: z.string().max(120).nullable().optional(),
  fallbackText: z.string().max(300).nullable().optional(),
  fallbackArtworkUrl: z.string().max(1000).nullable().optional(),
});

/** The effective config for a station, with where each level came from. */
playerAdminRouter.get('/:channelId', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const ch = await one<any>(
    `SELECT c.id, c.name FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE c.id=$1 AND g.account_id=$2`, [req.params.channelId, acct]);
  if (!ch) throw notFound('Station not found');
  res.json({
    channel: { id: ch.id, name: ch.name },
    config: await configFor(acct, ch.id),
    layouts: LAYOUTS,
  });
}));

/**
 * Save. Upsert rather than create/update, because there is exactly one config
 * per station by construction and making the console decide which verb to send
 * would be a race the first time two tabs are open.
 */
playerAdminRouter.put('/:channelId', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = configSchema.parse(req.body ?? {});
  const ch = await one<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE c.id=$1 AND g.account_id=$2`, [req.params.channelId, acct]);
  if (!ch) throw notFound('Station not found');

  const row = await one<any>(
    `INSERT INTO player_configs
       (account_id, channel_id, name, layout, primary_color, secondary_color, options,
        fallback_title, fallback_text, fallback_artwork_url)
     VALUES ($1,$2,COALESCE($3,'Default'),COALESCE($4,'card'),
             COALESCE($5,'#3f7bff'),COALESCE($6,'#0f1218'),COALESCE($7,'{}')::jsonb,$8,$9,$10)
     ON CONFLICT (channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET
       name            = COALESCE(EXCLUDED.name, player_configs.name),
       layout          = COALESCE(EXCLUDED.layout, player_configs.layout),
       primary_color   = COALESCE(EXCLUDED.primary_color, player_configs.primary_color),
       secondary_color = COALESCE(EXCLUDED.secondary_color, player_configs.secondary_color),
       options         = COALESCE(EXCLUDED.options, player_configs.options),
       fallback_title  = EXCLUDED.fallback_title,
       fallback_text   = EXCLUDED.fallback_text,
       fallback_artwork_url = EXCLUDED.fallback_artwork_url,
       updated_at      = now()
     RETURNING *`,
    [acct, ch.id, b.name ?? null, b.layout ?? null, b.primaryColor ?? null, b.secondaryColor ?? null,
     b.options ? JSON.stringify(b.options) : null,
     b.fallbackTitle ?? null, b.fallbackText ?? null, b.fallbackArtworkUrl ?? null]
  );
  res.json(shapeConfig(row));
}));

/**
 * PLAYER HEALTH for one station.
 *
 * Sessions, not events, is the headline: one broken embed reloading in a loop
 * produces hundreds of error events and is ONE problem. Counting events would
 * make it look like hundreds and would rank it above a fault affecting every
 * listener on a quieter site.
 */
playerAdminRouter.get('/:channelId/report', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const hours = Math.min(720, Math.max(1, Number(req.query.hours ?? 24) || 24));
  const ch = await one<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE c.id=$1 AND g.account_id=$2`, [req.params.channelId, acct]);
  if (!ch) throw notFound('Station not found');

  const totals = await query<any>(
    `SELECT event,
            COUNT(*)::int                      AS events,
            COUNT(DISTINCT session_id)::int    AS sessions
       FROM player_events
      WHERE account_id=$1 AND channel_id=$2 AND at > now() - make_interval(hours => $3)
      GROUP BY event ORDER BY 2 DESC`,
    [acct, ch.id, hours]
  );
  const byOrigin = await query<any>(
    `SELECT COALESCE(origin,'(none)') AS origin,
            COUNT(DISTINCT session_id)::int AS sessions,
            COUNT(*) FILTER (WHERE event IN ('error','manifest.error'))::int AS errors
       FROM player_events
      WHERE account_id=$1 AND channel_id=$2 AND at > now() - make_interval(hours => $3)
      GROUP BY 1 ORDER BY 2 DESC LIMIT 25`,
    [acct, ch.id, hours]
  );
  const recentErrors = await query<any>(
    `SELECT at, event, origin, detail FROM player_events
      WHERE account_id=$1 AND channel_id=$2 AND event IN ('error','manifest.error')
        AND at > now() - make_interval(hours => $3)
      ORDER BY at DESC LIMIT 25`,
    [acct, ch.id, hours]
  );
  res.json({ hours, totals, byOrigin, recentErrors });
}));

/** The layouts on offer, described rather than just named. */
export const LAYOUTS = [
  { id: 'card', name: 'Card',
    detail: 'Artwork, track and station in a rounded panel. The default, and the one that shows album art properly.' },
  { id: 'bar', name: 'Bar',
    detail: 'A single row: play control, scrolling title, volume. For a site header or a sticky footer.' },
  { id: 'hero', name: 'Hero',
    detail: 'Full-width, large artwork behind a blurred wash. For a station\'s own landing page.' },
  // THE PLAYER SDK'S SKINS (docs/PLAYER_SDK.md): themeable (logo, corner
  // radius, font, which controls show) and the same on every platform.
  { id: 'audio_square', name: 'Square', sdk: true,
    detail: 'A square tile: artwork, track, play. Fits a grid of stations.' },
  { id: 'audio_wave', name: 'Waveform', sdk: true,
    detail: 'A strip with artwork, the track and a live waveform.' },
  { id: 'audio_nowplaying', name: 'Now playing', sdk: true,
    detail: 'Big artwork and track details, the last five tracks and what is coming up.' },
  { id: 'audio_radio', name: 'Radio', sdk: true,
    detail: 'A station player: logo and name, the programme on air and how far through it is, a waveform, and a Coming up banner before the next programme.' },
  { id: 'video', name: 'Video', sdk: true,
    detail: 'The full video player: quality and subtitles, schedule, start over, up next, Chromecast and AirPlay.' },
];
