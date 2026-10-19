// ============================================================================
//  XMLTV EXPORT: the account's guide as XMLTV, three ways in.
//
//   GET /api/epg/xmltv            console download / server-to-server pull,
//                                 session or secret account key, scope in the
//                                 query string.
//   GET /xmltv/<token>.xml[.gz]   a PARTNER FEED: public, read-only, polled by
//                                 a PVR / IPTV middleware / guide aggregator.
//                                 The token carries the scope; no headers
//                                 needed, because most of those consumers can
//                                 be given a URL and nothing else.
//   GET /api/epg/channels         the same channel list as JSON (id, xmltv id,
//                                 name, icon, description, medium, tz) for
//                                 guide clients that do not want XML.
//
//  Plus the management surface the console uses: the per-channel XMLTV id,
//  and feeds (create, rescope, disable, rotate, revoke).
//
//  WHY IT STREAMS. A 200-channel, two-week guide is tens of thousands of
//  programmes. The document is written channel by channel straight to the
//  socket (optionally through gzip), so memory is one channel's window, not
//  the whole guide, and the first byte leaves before the last row is read.
//
//  WHY ETAG. Feeds are polled, typically every 15 to 60 minutes, by every
//  consumer, forever. Almost every poll finds nothing changed. The ETag is a
//  digest of exactly what would be emitted (programme ids + updated_at in the
//  window, channel identity, scope) so an unchanged guide answers 304 for the
//  cost of one aggregate query instead of re-rendering megabytes.
// ============================================================================
import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { createGzip, Gzip } from 'node:zlib';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, conflict } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { signedImageUrl } from './images';
import { ownerBaseEntry } from './epg';
import { pickGuideIcon, feedIconsFor } from '../services/guideIcon';
import {
  channelXml, programmeXml, documentHead, DOCUMENT_TAIL, XMLTV_ID_RX,
  type XmltvChannel, type TimeBasis, type TzMode, type BuildOptions,
} from '../services/xmltv';

const DAY = 86_400_000;
const MAX_WINDOW_DAYS = 93;

export interface GuideScope {
  account: string;
  channelIds: string[] | null; // null = every guide-enabled channel
  includeEvents: boolean;
  from: Date;
  to: Date;
  timeBasis: TimeBasis;
  tzMode: TzMode;
  lang: string | null;
}

// --------------------------------------------------------------- helpers

const publicBase = () => config.publicBaseUrl.replace(/\/$/, '');
/** Signed image URLs point at the image CDN when one is configured. */
const publicImageBase = () => config.images.publicBaseUrl;

/** A store reference or URL as an absolute URL a partner can fetch. */
export function absoluteImage(ref: string | null | undefined, w = 256, h = 256): string | null {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  const key = ref.replace(/^\//, '');
  if (key.startsWith('library/')) return signedImageUrl(key, { width: w, height: h, fit: 'inside' }, publicImageBase());
  return null;
}

interface OwnerRow {
  kind: 'tv' | 'radio' | 'event';
  id: string;
  name: string;
  xmltv_id: string | null;
  brand_ref: string | null;
  guide_icon_ref: string | null;
  /** Icon of a linked imported feed channel; only used when we have no image. */
  feed_icon?: string | null;
  tz: string | null;
  metadata: any;
  updated_at: string;
}

/** The channels (and optionally events) a scope covers, in a stable order. */
async function scopedOwners(s: GuideScope): Promise<OwnerRow[]> {
  const rows = await query<OwnerRow>(
    `SELECT c.kind, c.id, c.name, c.xmltv_id, c.brand_ref, c.guide_icon_ref, c.tz, c.metadata, c.updated_at
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND COALESCE(c.epg_enabled, true)
        AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))
      ORDER BY lower(c.name), c.id`,
    [s.account, s.channelIds],
  );
  if (s.includeEvents) {
    rows.push(...await query<OwnerRow>(
      `SELECT 'event' AS kind, e.id, e.name, e.xmltv_id, NULL::text AS brand_ref, NULL::text AS guide_icon_ref, NULL::text AS tz, e.metadata, e.updated_at
         FROM events e JOIN groups g ON g.id = e.group_id
        WHERE g.account_id = $1
          AND EXISTS (SELECT 1 FROM programmes p WHERE p.event_id = e.id AND p.span && tstzrange($2, $3, '[)'))
        ORDER BY e.scheduled_start, e.id`,
      [s.account, s.from.toISOString(), s.to.toISOString()],
    ));
  }
  return rows;
}

async function toXmltvChannel(o: OwnerRow, account: string): Promise<XmltvChannel> {
  const base = await ownerBaseEntry(o.kind === 'event' ? 'event' : 'channel', o.id, account).catch(() => null);
  const md = o.metadata ?? {};
  const names = [o.name];
  if (base?.title && base.title !== o.name) names.push(base.title);
  const num = md.channelNumber ?? md.broadcastChannelId;
  if (num) names.push(String(num));
  return {
    xmltvId: o.xmltv_id || o.id,
    displayNames: names,
    icon: absoluteImage(pickGuideIcon({ guideIconRef: o.guide_icon_ref, brandRef: o.brand_ref, feedIcon: o.feed_icon, metadataIcon: base?.icon ?? md.logo ?? null })?.ref),
    url: typeof md.website === 'string' && /^https?:\/\//.test(md.website) ? md.website : null,
    tz: o.tz,
    medium: o.kind === 'event' ? 'event' : o.kind,
    lang: base?.language ?? null,
  };
}

/** Exact fingerprint of what the document would contain. */
async function guideEtag(s: GuideScope, owners: OwnerRow[]): Promise<{ etag: string; lastModified: Date | null; programmes: number }> {
  const ch = owners.filter((o) => o.kind !== 'event').map((o) => o.id);
  const ev = owners.filter((o) => o.kind === 'event').map((o) => o.id);
  const agg = await one<any>(
    `SELECT count(*)::int AS n, max(updated_at) AS last,
            md5(COALESCE(string_agg(id::text || ':' || extract(epoch from updated_at)::text, ',' ORDER BY id), '')) AS digest
       FROM programmes
      WHERE (channel_id = ANY($1::uuid[]) OR event_id = ANY($2::uuid[]))
        AND status <> 'cancelled' AND span && tstzrange($3, $4, '[)')`,
    [ch, ev, s.from.toISOString(), s.to.toISOString()],
  );
  const h = createHash('sha256');
  h.update(JSON.stringify({
    v: 1, basis: s.timeBasis, tz: s.tzMode, lang: s.lang, base: publicBase(),
    owners: owners.map((o) => [o.id, o.xmltv_id, o.name, o.brand_ref, o.guide_icon_ref, o.feed_icon ?? null, o.tz, String(o.updated_at)]),
    p: agg?.digest, n: agg?.n,
  }));
  const ownerLast = owners.reduce<number>((m, o) => Math.max(m, Date.parse(String(o.updated_at)) || 0), 0);
  const progLast = agg?.last ? Date.parse(agg.last) : 0;
  const last = Math.max(ownerLast, progLast);
  return { etag: `"xt-${h.digest('base64url').slice(0, 27)}"`, lastModified: last ? new Date(last) : null, programmes: agg?.n ?? 0 };
}

type Sink = { write: (s: string) => Promise<void>; end: () => Promise<void> };

function sinkFor(res: Response, gz: Gzip | null): Sink {
  const target: NodeJS.WritableStream = gz ?? res;
  if (gz) gz.pipe(res);
  return {
    write: (s) => new Promise((resolve) => {
      if (target.write(s)) resolve();
      else target.once('drain', () => resolve());
    }),
    end: () => new Promise((resolve) => {
      if (gz) { res.once('finish', () => resolve()); gz.end(); } else { res.end(); resolve(); }
    }),
  };
}

/**
 * Answer one XMLTV request: conditional check, headers, then the streamed
 * document. `filename` set = a download; `forceGzipFile` = the .xml.gz form.
 */
export async function sendGuide(req: Request, res: Response, s: GuideScope, opt: { filename?: string; forceGzipFile?: boolean; cacheControl: string; note?: string }) {
  const owners = await scopedOwners(s);
  const tag = await guideEtag(s, owners);
  res.setHeader('ETag', tag.etag);
  if (tag.lastModified) res.setHeader('Last-Modified', tag.lastModified.toUTCString());
  res.setHeader('Cache-Control', opt.cacheControl);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('X-Volt-Time-Basis', s.timeBasis);
  res.setHeader('X-Volt-Guide-Window', `${s.from.toISOString()}/${s.to.toISOString()}`);
  res.setHeader('X-Volt-Guide-Counts', `channels=${owners.length}; programmes=${tag.programmes}`);

  const inm = req.get('if-none-match');
  const ims = req.get('if-modified-since');
  if ((inm && inm.split(/\s*,\s*/).includes(tag.etag)) || (!inm && ims && tag.lastModified && Date.parse(ims) >= Math.floor(tag.lastModified.getTime() / 1000) * 1000)) {
    res.status(304).end();
    return;
  }

  let gz: Gzip | null = null;
  if (opt.forceGzipFile) {
    res.setHeader('Content-Type', 'application/gzip');
    gz = createGzip();
  } else {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    if (/\bgzip\b/.test(req.get('accept-encoding') ?? '')) {
      res.setHeader('Content-Encoding', 'gzip');
      gz = createGzip();
    }
  }
  if (opt.filename) res.setHeader('Content-Disposition', `attachment; filename="${opt.filename}"`);
  if (req.method === 'HEAD') { res.status(200).end(); return; }

  const build: BuildOptions = {
    timeBasis: s.timeBasis, tzMode: s.tzMode, lang: s.lang ?? undefined,
    resolveIcon: (r) => absoluteImage(r, 640, 360),
    sourceName: 'Volt Stream', generatorUrl: publicBase(),
  };
  const sink = sinkFor(res, gz);
  await sink.write(documentHead(build, opt.note));
  const chans: { row: OwnerRow; ch: XmltvChannel }[] = [];
  for (const o of owners) {
    const ch = await toXmltvChannel(o, s.account);
    chans.push({ row: o, ch });
    await sink.write(channelXml(ch, build.lang));
  }
  for (const { row, ch } of chans) {
    const col = row.kind === 'event' ? 'event_id' : 'channel_id';
    const progs = await query<any>(
      `SELECT title, starts_at, ends_at, actual_start, actual_end, status, metadata
         FROM programmes
        WHERE ${col} = $1 AND status <> 'cancelled' AND span && tstzrange($2, $3, '[)')
        ORDER BY starts_at, id`,
      [row.id, s.from.toISOString(), s.to.toISOString()],
    );
    let buf = '';
    for (const p of progs) {
      buf += programmeXml(p, ch, build);
      if (buf.length > 64_000) { await sink.write(buf); buf = ''; }
    }
    if (buf) await sink.write(buf);
  }
  await sink.write(DOCUMENT_TAIL);
  await sink.end();
}

// --------------------------------------------------------------- scope parsing

const basisOf = (v: unknown): TimeBasis => {
  const s = String(v ?? 'scheduled').toLowerCase().replace(/[-_]/g, '');
  if (s === 'scheduled') return 'scheduled';
  if (s === 'asrun') return 'asrun';
  throw badRequest("times must be 'scheduled' or 'asrun'");
};
const tzOf = (v: unknown): TzMode => {
  const s = String(v ?? 'local').toLowerCase();
  if (s === 'local' || s === 'utc') return s;
  throw badRequest("tz must be 'local' or 'utc'");
};
const LANG_RX = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Window from explicit from/to, else pastDays/futureDays around now. */
export function windowOf(q: any, defPast = 1, defFuture = 7, now = Date.now()): { from: Date; to: Date } {
  let from: Date, to: Date;
  if (q.from || q.to) {
    from = q.from ? new Date(String(q.from)) : new Date(now - defPast * DAY);
    to = q.to ? new Date(String(q.to)) : new Date(from.getTime() + defFuture * DAY);
  } else {
    const past = q.pastDays != null ? Number(q.pastDays) : defPast;
    const fut = q.futureDays != null ? Number(q.futureDays) : q.days != null ? Number(q.days) : defFuture;
    if (!Number.isFinite(past) || past < 0 || !Number.isFinite(fut) || fut <= 0) throw badRequest('pastDays must be >= 0 and futureDays > 0');
    from = new Date(now - past * DAY);
    to = new Date(now + fut * DAY);
  }
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('from/to must be ISO timestamps');
  if (to <= from) throw badRequest('to must be after from');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY) throw badRequest(`window is limited to ${MAX_WINDOW_DAYS} days per request`);
  return { from, to };
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idList(v: unknown): string[] | null {
  if (v == null || v === '') return null;
  const ids = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  for (const id of ids) if (!UUID_RX.test(id)) throw badRequest(`not a channel id: ${id}`);
  return ids.length ? ids : null;
}

// --------------------------------------------------------------- admin router

export const xmltvAdminRouter = Router();

/** The console / API pull. */
xmltvAdminRouter.get(
  '/xmltv',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = req.query as any;
    const { from, to } = windowOf(q);
    const lang = q.lang ? String(q.lang) : null;
    if (lang && !LANG_RX.test(lang)) throw badRequest('lang must be a language code such as en or en-AU');
    const scope: GuideScope = {
      account: accountId(req),
      channelIds: idList(q.channelId ?? q.channelIds),
      includeEvents: q.includeEvents === 'true' || q.includeEvents === '1',
      from, to, timeBasis: basisOf(q.times), tzMode: tzOf(q.tz), lang,
    };
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await sendGuide(req, res, scope, {
      filename: q.download === '0' ? undefined : `volt-guide-${day}.xml`,
      cacheControl: 'private, no-cache',
    });
  }),
);

/** Guide channels as JSON: what XMLTV <channel> carries, for JSON clients. */
// The list standard (util/listQuery.ts). Field names are the response's; key
// is the column the cursor reads before the row is reshaped.
const guideChannelList = defineList({
  path: '/api/epg/channels',
  fields: {
    id: { sql: 'c.id', type: 'uuid' },
    name: { sql: 'c.name', type: 'string' },
    xmltvId: { sql: 'c.xmltv_id', type: 'string', key: 'xmltv_id', doc: 'The id set on the channel (unset channels use their Volt id)' },
    medium: { sql: "COALESCE(c.kind,'tv')", type: 'enum', values: ['tv', 'radio'], key: 'medium' },
    tz: { sql: 'c.tz', type: 'string' },
    epgEnabled: { sql: 'COALESCE(c.epg_enabled, true)', type: 'boolean', key: 'epg_enabled' },
    updatedAt: { sql: 'c.updated_at', type: 'timestamp', key: 'updated_at' },
  },
  search: ['name', 'xmltvId'],
  defaultSort: 'name',
  unpagedLimit: 1000,
});

xmltvAdminRouter.get(
  '/channels',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountId(req);
    const base: unknown[] = [account];
    const params = [...base];
    const pl = parseList(guideChannelList, req.query, params);
    const from = `FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1${whereSql(pl)}`;
    const fetched = await query<any>(
      `SELECT c.id, c.kind, COALESCE(c.kind,'tv') AS medium, c.name, c.xmltv_id, c.brand_ref, c.guide_icon_ref, c.tz, c.metadata, c.updated_at,
              COALESCE(c.epg_enabled, true) AS epg_enabled
         ${from} ${pageSql(pl)}`,
      params,
    );
    const cParams = [...base];
    const cWhere = pl.count ? whereSql(parseList(guideChannelList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
    const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1${cWhere}`, cParams))?.n : undefined;
    const rows = finishPage(req, res, pl, fetched, total);
    const feed = await feedIconsFor(rows.map((r) => r.id));
    const out = [];
    for (const r of rows) {
      const base = await ownerBaseEntry('channel', r.id, account).catch(() => null);
      const pick = pickGuideIcon({ guideIconRef: r.guide_icon_ref, brandRef: r.brand_ref, feedIcon: feed.get(r.id), metadataIcon: base?.icon ?? r.metadata?.logo ?? null });
      out.push({
        id: r.id,
        xmltvId: r.xmltv_id || r.id,
        xmltvIdSet: !!r.xmltv_id,
        name: r.name,
        medium: r.kind,
        icon: absoluteImage(pick?.ref),
        iconRef: pick?.ref ?? null,
        iconFrom: pick?.from ?? null,
        brandRef: r.brand_ref ?? null,
        guideIconRef: r.guide_icon_ref ?? null,
        feedIcon: feed.get(r.id) ?? null,
        description: base?.description ?? null,
        language: base?.language ?? null,
        tz: r.tz,
        epgEnabled: r.epg_enabled,
      });
    }
    res.json(out);
  }),
);

/** Set or clear a channel's XMLTV id. Unique within the account. */
xmltvAdminRouter.put(
  '/channels/:id/xmltv-id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountId(req);
    const b = z.object({ xmltvId: z.string().trim().nullable() }).parse(req.body ?? {});
    const v = b.xmltvId ? b.xmltvId : null;
    if (v && !XMLTV_ID_RX.test(v)) throw badRequest('XMLTV id: letters, digits, dot, dash, colon or underscore, up to 128 characters (e.g. news.example.com)');
    const ch = await one<any>(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, account],
    );
    if (!ch) throw notFound('Channel not found');
    if (v) {
      // Another channel, or a channel whose UUID is literally this value.
      const clash = await one<any>(
        `SELECT c.name FROM channels c JOIN groups g ON g.id = c.group_id
          WHERE g.account_id = $1 AND c.id <> $2 AND (c.xmltv_id = $3 OR c.id::text = lower($3))`,
        [account, ch.id, v],
      );
      if (clash) throw conflict(`"${v}" is already the XMLTV id of ${clash.name}`);
    }
    await query(`UPDATE channels SET xmltv_id = $2, updated_at = now() WHERE id = $1`, [ch.id, v]);
    res.json({ id: ch.id, xmltvId: v || ch.id, xmltvIdSet: !!v });
  }),
);

/** A guide icon reference: a library image or an http(s) URL. */
export const ICON_REF_RX = /^(\/library\/[^\s]+|https?:\/\/[^\s]+)$/i;

/**
 * Set or clear a channel's guide icon. Null (or blank) goes back to the
 * channel's own brand image, which is the normal case.
 */
xmltvAdminRouter.put(
  '/channels/:id/guide-icon',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountId(req);
    const b = z.object({ ref: z.string().trim().max(2048).nullable() }).parse(req.body ?? {});
    const v = b.ref ? b.ref : null;
    if (v && !ICON_REF_RX.test(v)) throw badRequest('Guide icon: choose a library image or paste an http(s) image URL');
    const ch = await one<any>(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, account],
    );
    if (!ch) throw notFound('Channel not found');
    const r = await one<any>(`UPDATE channels SET guide_icon_ref = $2, updated_at = now() WHERE id = $1 RETURNING brand_ref, guide_icon_ref`, [ch.id, v]);
    const feed = (await feedIconsFor([ch.id])).get(ch.id) ?? null;
    const pick = pickGuideIcon({ guideIconRef: r.guide_icon_ref, brandRef: r.brand_ref, feedIcon: feed });
    res.json({ id: ch.id, guideIconRef: r.guide_icon_ref, iconRef: pick?.ref ?? null, iconFrom: pick?.from ?? null, icon: absoluteImage(pick?.ref) });
  }),
);

// ---- feeds

const feedUrl = (raw: string) => `${publicBase()}/xmltv/${raw}.xml`;
function newToken() {
  const raw = `xf_${randomBytes(24).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, 10), hash: createHash('sha256').update(raw).digest('hex') };
}
const feedOut = (f: any) => ({
  id: f.id, name: f.name, tokenPrefix: f.token_prefix,
  channelIds: f.channel_ids, includeEvents: f.include_events,
  pastDays: f.past_days, futureDays: f.future_days,
  timeBasis: f.time_basis, tzMode: f.tz_mode, lang: f.lang, enabled: f.enabled,
  lastPolledAt: f.last_polled_at, pollCount: Number(f.poll_count ?? 0),
  createdAt: f.created_at, updatedAt: f.updated_at,
});

const feedFields = {
  name: z.string().trim().min(1).max(120),
  channelIds: z.array(z.string().uuid()).min(1).nullable(),
  includeEvents: z.boolean(),
  pastDays: z.number().int().min(0).max(31),
  futureDays: z.number().int().min(1).max(62),
  timeBasis: z.enum(['scheduled', 'asrun']),
  tzMode: z.enum(['local', 'utc']),
  lang: z.string().regex(LANG_RX).nullable(),
  enabled: z.boolean(),
};

async function assertOwnChannels(ids: string[] | null | undefined, account: string) {
  if (!ids || !ids.length) return;
  const got = await query<any>(
    `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND c.id = ANY($2::uuid[])`,
    [account, ids],
  );
  if (got.length !== new Set(ids).size) throw badRequest('channelIds includes a channel that is not in this account');
}

const feedList = defineList({
  path: '/api/epg/xmltv/feeds',
  fields: {
    id: { sql: 'f.id', type: 'uuid' },
    name: { sql: 'f.name', type: 'string' },
    enabled: { sql: 'f.enabled', type: 'boolean' },
    includeEvents: { sql: 'f.include_events', type: 'boolean', key: 'include_events' },
    timeBasis: { sql: 'f.time_basis', type: 'enum', values: ['scheduled', 'asrun'], key: 'time_basis' },
    tzMode: { sql: 'f.tz_mode', type: 'enum', values: ['local', 'utc'], key: 'tz_mode' },
    lang: { sql: 'f.lang', type: 'string' },
    pastDays: { sql: 'f.past_days', type: 'number', key: 'past_days' },
    futureDays: { sql: 'f.future_days', type: 'number', key: 'future_days' },
    pollCount: { sql: 'f.poll_count', type: 'number', key: 'poll_count' },
    lastPolledAt: { sql: 'f.last_polled_at', type: 'timestamp', key: 'last_polled_at' },
    createdAt: { sql: 'f.created_at', type: 'timestamp', key: 'created_at', notNull: true },
    updatedAt: { sql: 'f.updated_at', type: 'timestamp', key: 'updated_at' },
  },
  search: ['name'],
  defaultSort: '-createdAt',
  unpagedLimit: 1000,
});

xmltvAdminRouter.get(
  '/xmltv/feeds',
  requireAuth,
  asyncHandler(async (req, res) => {
    const base: unknown[] = [accountId(req)];
    const params = [...base];
    const pl = parseList(feedList, req.query, params);
    const from = `FROM epg_feeds f WHERE f.account_id = $1${whereSql(pl)}`;
    const rows = await query<any>(`SELECT f.* ${from} ${pageSql(pl)}`, params);
    const cParams = [...base];
    const cWhere = pl.count ? whereSql(parseList(feedList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
    const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM epg_feeds f WHERE f.account_id = $1${cWhere}`, cParams))?.n : undefined;
    res.json(finishPage(req, res, pl, rows, total).map(feedOut));
  }),
);

xmltvAdminRouter.post(
  '/xmltv/feeds',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountId(req);
    const b = z.object({
      ...feedFields,
      channelIds: feedFields.channelIds.optional(),
      includeEvents: feedFields.includeEvents.optional(),
      pastDays: feedFields.pastDays.optional(),
      futureDays: feedFields.futureDays.optional(),
      timeBasis: feedFields.timeBasis.optional(),
      tzMode: feedFields.tzMode.optional(),
      lang: feedFields.lang.optional(),
      enabled: feedFields.enabled.optional(),
    }).parse(req.body ?? {});
    await assertOwnChannels(b.channelIds, account);
    const t = newToken();
    const sub = req.auth?.sub && UUID_RX.test(req.auth.sub) ? req.auth.sub : null;
    const row = await one<any>(
      `INSERT INTO epg_feeds(account_id, name, token_prefix, token_hash, channel_ids, include_events,
                             past_days, future_days, time_basis, tz_mode, lang, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [account, b.name, t.prefix, t.hash, b.channelIds ?? null, b.includeEvents ?? false,
       b.pastDays ?? 1, b.futureDays ?? 7, b.timeBasis ?? 'scheduled', b.tzMode ?? 'local', b.lang ?? null,
       b.enabled ?? true, sub],
    );
    // The raw token exists in this response and nowhere else.
    res.status(201).json({ ...feedOut(row), url: feedUrl(t.raw), gzipUrl: `${feedUrl(t.raw)}.gz` });
  }),
);

xmltvAdminRouter.patch(
  '/xmltv/feeds/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = accountId(req);
    const b = z.object(feedFields).partial().parse(req.body ?? {});
    await assertOwnChannels(b.channelIds, account);
    const cur = await one<any>(`SELECT * FROM epg_feeds WHERE id = $1 AND account_id = $2`, [req.params.id, account]);
    if (!cur) throw notFound('Feed not found');
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const row = await one<any>(
      `UPDATE epg_feeds SET name=$2, channel_ids=$3, include_events=$4, past_days=$5, future_days=$6,
              time_basis=$7, tz_mode=$8, lang=$9, enabled=$10, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [cur.id, b.name ?? cur.name, has('channelIds') ? b.channelIds : cur.channel_ids,
       b.includeEvents ?? cur.include_events, b.pastDays ?? cur.past_days, b.futureDays ?? cur.future_days,
       b.timeBasis ?? cur.time_basis, b.tzMode ?? cur.tz_mode, has('lang') ? b.lang : cur.lang, b.enabled ?? cur.enabled],
    );
    res.json(feedOut(row));
  }),
);

/** New token, old one dead at once. For a URL that leaked. */
xmltvAdminRouter.post(
  '/xmltv/feeds/:id/rotate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const t = newToken();
    const row = await one<any>(
      `UPDATE epg_feeds SET token_prefix=$3, token_hash=$4, updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *`,
      [req.params.id, accountId(req), t.prefix, t.hash],
    );
    if (!row) throw notFound('Feed not found');
    res.json({ ...feedOut(row), url: feedUrl(t.raw), gzipUrl: `${feedUrl(t.raw)}.gz` });
  }),
);

xmltvAdminRouter.delete(
  '/xmltv/feeds/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query<any>(`DELETE FROM epg_feeds WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.id, accountId(req)]);
    if (!rows.length) throw notFound('Feed not found');
    res.status(204).end();
  }),
);

// --------------------------------------------------------------- public feed

export const xmltvPublicRouter = Router();
const FEED_FILE_RX = /^(xf_[A-Za-z0-9_-]{16,64})\.xml(\.gz)?$/;

/**
 * Every refusal is the same 404: an unknown token, a disabled feed and a
 * suspended account are indistinguishable, so the URL space is no oracle.
 */
xmltvPublicRouter.get(
  '/xmltv/:file',
  asyncHandler(async (req, res) => {
    const m = String(req.params.file).match(FEED_FILE_RX);
    if (!m) throw notFound('Not found');
    const hash = createHash('sha256').update(m[1]).digest('hex');
    const f = await one<any>(
      `SELECT f.* FROM epg_feeds f JOIN accounts a ON a.id = f.account_id
        WHERE f.token_hash = $1 AND f.enabled AND COALESCE(a.status, 'active') <> 'suspended'`,
      [hash],
    );
    if (!f) throw notFound('Not found');
    // Metering is best effort and never blocks the guide.
    query(`UPDATE epg_feeds SET last_polled_at = now(), poll_count = poll_count + 1 WHERE id = $1`, [f.id]).catch(() => {});
    const now = Date.now();
    const scope: GuideScope = {
      account: f.account_id,
      channelIds: f.channel_ids && f.channel_ids.length ? f.channel_ids : null,
      includeEvents: f.include_events,
      from: new Date(now - f.past_days * DAY),
      to: new Date(now + f.future_days * DAY),
      timeBasis: f.time_basis, tzMode: f.tz_mode, lang: f.lang,
    };
    // Snap the window to the hour so polls within the same hour share an ETag
    // when nothing changed, instead of every poll seeing a moved window.
    scope.from = new Date(Math.floor(scope.from.getTime() / 3_600_000) * 3_600_000);
    scope.to = new Date(Math.ceil(scope.to.getTime() / 3_600_000) * 3_600_000);
    await sendGuide(req, res, scope, {
      forceGzipFile: !!m[2],
      cacheControl: 'private, max-age=300, must-revalidate',
      note: `feed: ${String(f.name)}`,
    });
  }),
);
