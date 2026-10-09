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
import { verifyKey, checkRestrictions, type AppRow } from '../services/apiKeys';
import { cachedTrackMeta, buildCard } from '../services/radio/trackMeta';
import { publicMp3Url } from '../services/radio/jobConfig';
import { icyState } from '../services/radio/icyMeta';

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

  const app = await one<AppRow>(`SELECT id, type, restrictions, enabled FROM apps WHERE id=$1`, [key.app_id]);
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
  const ch = await one<any>(
    `SELECT c.id, c.name, c.kind, c.status, c.metadata, c.brand_ref, g.account_id
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2 AND c.kind = 'radio'`,
    [b.channelId, key.account_id]
  );
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
  const app = await one<AppRow>(`SELECT id, type, restrictions, enabled FROM apps WHERE id=$1`, [key.app_id]);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, {
    referrer: req.get('referer') || undefined,
    origin: req.get('origin') || undefined,
    ip: req.ip,
  });
  if (reason) throw new ApiError(403, reason);

  const ch = await one<any>(
    `SELECT c.id, c.name, c.status, c.metadata, c.brand_ref
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2 AND c.kind = 'radio'`,
    [b.channelId, key.account_id]
  );
  if (!ch) throw notFound('Station not found');

  const cfg = await configFor(key.account_id, ch.id);
  const icy = icyState(ch.id);
  const meta = await cachedTrackMeta(icy?.title ?? null);
  const card = buildCard(meta, {
    name: cfg.fallbackTitle ?? ch.name,
    description: cfg.fallbackText ?? ch.metadata?.description ?? null,
    artworkUrl: cfg.fallbackArtworkUrl ?? ch.brand_ref ?? null,
  });

  res.json({
    ...card,
    onAir: ch.status === 'live',
    // The raw ICY line, so an embedder debugging a bad parse can see what the
    // station actually sent rather than guessing from the parsed result.
    raw: icy?.title ?? null,
    since: icy?.since ?? null,
  });
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
  const app = await one<AppRow>(`SELECT id, type, restrictions, enabled FROM apps WHERE id=$1`, [key.app_id]);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, {
    referrer: req.get('referer') || undefined,
    origin: req.get('origin') || undefined,
    ip: req.ip,
  });
  if (reason) throw new ApiError(403, reason);

  // Scoped like everything else: events for a station that is not this
  // account's are dropped rather than recorded against the wrong tenant.
  const ch = await one<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id=$1 AND g.account_id=$2`,
    [b.channelId, key.account_id]
  );
  if (!ch) throw notFound('Station not found');

  const origin = req.get('origin') || req.get('referer') || null;
  for (const e of b.events) {
    await query(
      `INSERT INTO player_events (account_id, channel_id, app_id, session_id, event, origin, layout, detail, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, COALESCE(to_timestamp($9/1000.0), now()))`,
      [key.account_id, ch.id, app.id, b.sessionId, e.event, origin?.slice(0, 300) ?? null,
       e.layout ?? null, JSON.stringify(e.detail ?? {}), e.at ?? null]
    );
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
  layout: z.enum(['card', 'bar', 'hero']).optional(),
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
];
