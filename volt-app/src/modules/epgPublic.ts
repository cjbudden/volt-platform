/**
 * THE PUBLIC GUIDE API: /api/public/epg/*. Read only. (EPG_PUBLIC_API.md)
 *
 * What a viewer app calls to draw its guide: the channel list, what is on now
 * and next (and what was just on), a channel's day, a multi-channel grid, and
 * one programme with its neighbours. The same programmes the console and a
 * FAST lineup write, through a whitelisted public shape (services/epgPublic.ts).
 *
 *   GET /api/public/epg/channels                       guide channels
 *   GET /api/public/epg/now?channels=&previous=&next=  on now across channels (the guide's "On now" row)
 *   GET /api/public/epg/channels/:ref/now              previous / now / next for one channel
 *   GET /api/public/epg/channels/:ref/schedule         a channel's programmes in a window or local day
 *   GET /api/public/epg/grid?from=&to=&channels=       several channels over a window (the EPG grid)
 *   GET /api/public/epg/programmes/:id                 one programme, with previous / next on its channel
 *
 * `:ref` is the channel's Volt id or its XMLTV id.
 *
 * KEY. The app's publishable key (pk_...) as `?appKey=` or `X-Volt-App-Key`,
 * checked against the app's restrictions like every viewer route; a secret
 * account key (sk_...) is also accepted for server-side rendering. The key
 * names the account; nothing outside it is visible.
 *
 * TIME. Every answer is computed for `at` (default: now; any ISO instant is
 * accepted, so an app can ask what was on at 20:00 yesterday). Times out are
 * UTC ISO strings; the channel's IANA zone is in the channel object.
 *
 * CACHING. Reads come from a per-channel slab the database triggers invalidate
 * on every write (services/epgPublic.ts). Responses carry an ETag (304 on
 * If-None-Match) and a Cache-Control max-age that never runs past the next
 * programme change, so a CDN in front can hold them without serving a stale
 * "now".
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { asyncHandler, ApiError, badRequest, notFound } from '../util/http';
import { verifyKey, appForKey, checkRestrictions } from '../services/apiKeys';
import { cached } from '../scale/cache';
import { isDate, isTimeZone, localDayBounds } from '../services/epgRepeat';
import { absoluteImage, windowOf } from './xmltv';
import { ownerBaseEntry } from './epg';
import {
  guideChannels, guideChannel, aroundFor, programmesIn, programmeWithNeighbours, answer,
  MAX_AROUND, MAX_SCHEDULE_DAYS, MAX_GRID_HOURS, MAX_GRID_CHANNELS, HOUR, DAY, API_BASE,
  type GuideChannel, type PublicProgramme, type Around,
} from '../services/epgPublic';

export const epgPublicRouter = Router();

const resolveImage = (r: string) => absoluteImage(r, 640, 360);
const resolveIcon = (r: string) => absoluteImage(r, 256, 256);

/** The account behind the presented key. Publishable keys are held to their app's restrictions. */
async function accountOf(req: Request): Promise<string> {
  const raw = String(req.get('x-volt-app-key') ?? req.query.appKey ?? '').trim();
  if (!raw) throw new ApiError(401, 'appKey required: ?appKey=pk_... or the X-Volt-App-Key header');
  const key = await verifyKey(raw);
  if (!key) throw new ApiError(401, 'invalid key');
  if (key.kind === 'publishable') {
    const app = key.app_id ? await appForKey(key) : null;
    if (!app) throw new ApiError(401, 'app not found for key');
    const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
    if (reason) throw new ApiError(403, reason);
  }
  return key.account_id;
}

function atOf(q: any): number {
  if (q.at == null || q.at === '') return Date.now();
  const t = Date.parse(String(q.at));
  if (!Number.isFinite(t)) throw badRequest('at must be an ISO timestamp');
  return t;
}
function countOf(v: unknown, def: number, name: string): number {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AROUND) throw badRequest(`${name} must be a whole number from 0 to ${MAX_AROUND}`);
  return n;
}
function refsOf(v: unknown): string[] | null {
  if (v == null || v === '') return null;
  const refs = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  if (refs.length > MAX_GRID_CHANNELS) throw badRequest(`at most ${MAX_GRID_CHANNELS} channels per request`);
  return refs.length ? refs : null;
}

async function channelOr404(account: string, ref: string): Promise<GuideChannel> {
  const c = await guideChannel(account, ref, resolveIcon);
  if (!c) throw notFound('Channel not found');
  return c;
}
async function channelsFor(account: string, refs: string[] | null): Promise<GuideChannel[]> {
  if (!refs) return guideChannels(account, resolveIcon);
  const out: GuideChannel[] = [];
  for (const r of refs) { const c = await guideChannel(account, r, resolveIcon); if (c && !out.some((x) => x.id === c.id)) out.push(c); }
  return out;
}

/**
 * The channel's own identity as a guide entry, for a gap with nothing
 * scheduled: an app never has to draw an empty "now". Same source as the
 * console's now/next fallback (modules/epg.ts ownerBaseEntry).
 */
function baseEntry(account: string, channelId: string) {
  return cached(`epgpub:base:${channelId}`, { ttlSec: 300, tags: [`asset:${channelId}`, `acct:${account}`], l2: true }, async () => {
    const b = await ownerBaseEntry('channel', channelId, account).catch(() => null);
    return b ? { title: b.title, subTitle: b.subTitle, description: b.description, categories: b.categories, image: b.icon ? resolveImage(b.icon) ?? (/^https?:\/\//.test(b.icon) ? b.icon : null) : null } : null;
  });
}

async function aroundAnswer(account: string, ch: GuideChannel, at: number, nPrev: number, nNext: number) {
  const a: Around = await aroundFor(ch.id, at, nPrev, nNext, resolveImage);
  const base = a.now ? null : await baseEntry(account, ch.id);
  return {
    channel: ch,
    previous: a.previous.map((p) => answer(p, at)),
    now: a.now ? answer(a.now, at) : null,
    next: a.next.map((p) => answer(p, at)),
    /** What to show when nothing is scheduled now: the channel itself. */
    base,
    nowIsBase: !a.now && !!base,
    nextChangeAt: a.nextChangeAt ? new Date(a.nextChangeAt).toISOString() : null,
    _change: a.nextChangeAt,
  };
}

/**
 * Send with an ETag and a max-age that ends at the next programme change.
 * `untilMs` null = nothing scheduled to change; the default ceiling applies.
 */
function send(req: Request, res: Response, body: any, untilMs: number | null, ceilingSec: number) {
  const now = Date.now();
  const left = untilMs != null ? Math.floor((untilMs - now) / 1000) : ceilingSec;
  const maxAge = Math.max(0, Math.min(ceilingSec, left));
  const json = JSON.stringify(body);
  // The tag ignores what moves with the clock (the echoed `at`, progress), so
  // a poll between programme changes answers 304. Progress is a convenience:
  // an app redraws its bar from start / end on its own clock.
  const stable = JSON.stringify(body, function (this: any, k, v) { return k === 'progress' || (this === body && k === 'at') ? undefined : v; });
  const etag = `W/"eg-${createHash('sha1').update(stable).digest('base64url').slice(0, 22)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', maxAge > 0 ? `public, max-age=${maxAge}, stale-while-revalidate=5` : 'public, max-age=0, must-revalidate');
  res.setHeader('Vary', 'Origin, X-Volt-App-Key');
  const inm = req.get('if-none-match');
  if (inm && inm.split(/\s*,\s*/).includes(etag)) { res.status(304).end(); return; }
  res.type('application/json').send(json);
}
const strip = <T extends { _change?: unknown }>(o: T) => { const { _change, ...rest } = o; return rest; };

// ------------------------------------------------------------------ routes

epgPublicRouter.get('/', (_req, res) => {
  res.json({
    usage: 'Read-only programme guide for viewer apps. Every route needs the app key (?appKey=pk_... or X-Volt-App-Key).',
    links: {
      channels: `${API_BASE}/channels`, now: `${API_BASE}/now`, grid: `${API_BASE}/grid`,
      channelNow: `${API_BASE}/channels/{channel}/now`, channelSchedule: `${API_BASE}/channels/{channel}/schedule`,
      programme: `${API_BASE}/programmes/{id}`,
    },
  });
});

epgPublicRouter.get('/channels', asyncHandler(async (req, res) => {
  const account = await accountOf(req);
  const channels = await guideChannels(account, resolveIcon);
  send(req, res, { channels, links: { self: `${API_BASE}/channels`, now: `${API_BASE}/now`, grid: `${API_BASE}/grid` } }, null, 60);
}));

epgPublicRouter.get('/now', asyncHandler(async (req, res) => {
  const account = await accountOf(req);
  const at = atOf(req.query);
  const nPrev = countOf(req.query.previous, 0, 'previous');
  const nNext = countOf(req.query.next, 1, 'next');
  const chans = await channelsFor(account, refsOf(req.query.channels));
  const rows = await Promise.all(chans.map((c) => aroundAnswer(account, c, at, nPrev, nNext)));
  const changes = rows.map((r) => r._change).filter((x): x is number => x != null);
  send(req, res, { at: new Date(at).toISOString(), channels: rows.map(strip) }, changes.length ? Math.min(...changes) : null, 30);
}));

epgPublicRouter.get('/channels/:ref/now', asyncHandler(async (req, res) => {
  const account = await accountOf(req);
  const ch = await channelOr404(account, String(req.params.ref));
  const at = atOf(req.query);
  const r = await aroundAnswer(account, ch, at, countOf(req.query.previous, 1, 'previous'), countOf(req.query.next, 3, 'next'));
  send(req, res, { at: new Date(at).toISOString(), ...strip(r) }, r._change, 30);
}));

/**
 * A channel's programmes in a window. Either `date=YYYY-MM-DD` (that local
 * day in `tz`, default the channel's zone, else UTC) or `from` / `to`, or
 * `pastDays` / `futureDays` around now. Default: today in the channel's zone.
 */
epgPublicRouter.get('/channels/:ref/schedule', asyncHandler(async (req, res) => {
  const account = await accountOf(req);
  const ch = await channelOr404(account, String(req.params.ref));
  const q = req.query as any;
  const tz = q.tz ? String(q.tz) : ch.timezone || 'UTC';
  if (!isTimeZone(tz)) throw badRequest('tz must be an IANA time zone, e.g. Australia/Brisbane');
  let from: number, to: number;
  if (q.date || !(q.from || q.to || q.pastDays != null || q.futureDays != null || q.days != null)) {
    const date = q.date ? String(q.date) : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (!isDate(date)) throw badRequest('date must be YYYY-MM-DD');
    const b = localDayBounds(date, tz);
    from = Date.parse(b.start); to = Date.parse(b.end);
  } else {
    const w = windowOf(q, 0, 1);
    from = w.from.getTime(); to = w.to.getTime();
  }
  if (to - from > MAX_SCHEDULE_DAYS * DAY) throw badRequest(`a schedule request covers at most ${MAX_SCHEDULE_DAYS} days`);
  const now = Date.now();
  const list = await programmesIn(ch.id, from, to, resolveImage);
  const boundary = nextBoundary(list, now);
  send(req, res, {
    channel: ch, timezone: tz, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    programmes: list.map((p) => answer(p, now)),
    links: {
      self: `${API_BASE}/channels/${ch.id}/schedule?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`,
      previous: `${API_BASE}/channels/${ch.id}/schedule?from=${new Date(from - (to - from)).toISOString()}&to=${new Date(from).toISOString()}`,
      next: `${API_BASE}/channels/${ch.id}/schedule?from=${new Date(to).toISOString()}&to=${new Date(to + (to - from)).toISOString()}`,
      now: `${API_BASE}/channels/${ch.id}/now`,
    },
  }, boundary, 60);
}));

/** The guide grid: several channels over a window (default the next 3 hours from the top of this hour). */
epgPublicRouter.get('/grid', asyncHandler(async (req, res) => {
  const account = await accountOf(req);
  const q = req.query as any;
  const now = Date.now();
  const top = Math.floor(now / HOUR) * HOUR;
  const from = q.from ? Date.parse(String(q.from)) : top;
  const to = q.to ? Date.parse(String(q.to)) : from + (q.hours ? Number(q.hours) : 3) * HOUR;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw badRequest('from/to must be ISO timestamps (or hours a number)');
  if (to <= from) throw badRequest('to must be after from');
  if (to - from > MAX_GRID_HOURS * HOUR) throw badRequest(`a grid covers at most ${MAX_GRID_HOURS} hours; page it with from/to`);
  const chans = await channelsFor(account, refsOf(q.channels));
  const rows = await Promise.all(chans.map(async (c) => ({ channel: c, programmes: (await programmesIn(c.id, from, to, resolveImage)).map((p) => answer(p, now)) })));
  const boundary = nextBoundary(rows.flatMap((r) => r.programmes), now);
  const span = to - from;
  const qs = (a: number, b: number) => `from=${new Date(a).toISOString()}&to=${new Date(b).toISOString()}${q.channels ? `&channels=${encodeURIComponent(String(q.channels))}` : ''}`;
  send(req, res, {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), channels: rows,
    links: { self: `${API_BASE}/grid?${qs(from, to)}`, previous: `${API_BASE}/grid?${qs(from - span, from)}`, next: `${API_BASE}/grid?${qs(to, to + span)}` },
  }, boundary, 60);
}));

epgPublicRouter.get('/programmes/:id', asyncHandler(async (req, res) => {
  const account = await accountOf(req);
  const r = await programmeWithNeighbours(account, String(req.params.id), resolveImage);
  if (!r) throw notFound('Programme not found');
  const now = Date.now();
  const ch = await channelOr404(account, r.programme.channelId);
  send(req, res, {
    programme: answer(r.programme, now), channel: ch,
    previous: r.previous ? answer(r.previous, now) : null,
    next: r.next ? answer(r.next, now) : null,
    links: {
      self: r.programme.links.self, channel: ch.links.self,
      previous: r.previous?.links.self ?? null, next: r.next?.links.self ?? null,
    },
  }, nextBoundary([r.programme], now), 60);
}));

/** The next instant after `now` at which any listed programme starts or ends (states change). */
function nextBoundary(list: PublicProgramme[], now: number): number | null {
  let best: number | null = null;
  for (const p of list) for (const t of [Date.parse(p.start), Date.parse(p.end)]) if (t > now && (best == null || t < best)) best = t;
  return best;
}
