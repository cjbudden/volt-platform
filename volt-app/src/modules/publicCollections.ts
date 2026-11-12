/**
 * THE PUBLIC COLLECTIONS API: /api/public/collections/*. Read only. (build
 * queue C3-2, PUBLISHING_POLICIES.md "Collections, packages and apps" and
 * "Scale and caching", point 3)
 *
 * What a viewer app calls to draw a row or a rail from a collection: the
 * collection's titles in its own order (its sub-collections after it), each
 * with what an anonymous viewer of that app in that country gets.
 *
 *   GET /api/public/collections/:id      ?appKey=pk_...[&geo=XX][&deep=false]
 *
 * KEY. The app's publishable key, as `?appKey=` or `X-Volt-App-Key`, checked
 * against the app's restrictions like every viewer route. A collection of
 * another account is answered as one that does not exist.
 *
 * WHAT IS LISTED. A title is in the answer when it is public and listed
 * (services/publicStatus.ts publiclyListed: available, or a Scheduled teaser
 * past its Listed from date, and not unlisted), its publishing rule lists it
 * (Sitemap and schema.org, deliveryPolicy.sitemapListedOf), and the play gate's
 * own evaluation (services/rights.ts evaluateAccess, for this app and country,
 * no viewer) either lets it play (`access: "free"`) or asks for a sign-in
 * (`"members"`) or a purchase (`"premium"`). A title the rights or a geo rule
 * keep from this app or country is left out. The packages that unlock a
 * premium title and each app's upsell or hide are build queue C2-4.
 *
 * CACHING BY TERRITORY GROUP. Countries that get the same answer share one
 * cached answer: the answer for a country is worked out once, and its content
 * names the group (`territoryGroup`, also the ETag), so FR and DE with the
 * same titles and access share an entry, and an app polling the row from any
 * of them answers 304. A warm request reads nothing from the database. Every
 * entry is tagged with the collection, its sub-collections and each title, so
 * a membership change (database triggers, migration 0174), a rights or
 * publishing change drops it at once; its lifetime ends at the next status
 * change of any title in it, so a title scheduled for 20:00 appears at 20:00.
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { query } from '../db';
import { asyncHandler, ApiError, notFound, badRequest } from '../util/http';
import { verifyKey, appForKey, checkRestrictions } from '../services/apiKeys';
import { cached } from '../scale/cache';
import { viewerGeo } from '../scale/edge';
import { ORDERS } from '../services/collectionRules';
import { publicDecision, publiclyListed } from '../services/publicStatus';
import { vodAvailabilityRow } from '../services/viewerPath';
import { sitemapListedOf } from '../services/deliveryPolicy';
import { evaluateAccess } from '../services/rights';
import { appTypeOf } from '../services/rightsProfiles';
import { classifyGate } from '../services/qoe/gateLog';
import { metaFor } from './apps';

export const publicCollectionsRouter = Router();

/** Longest an answer is kept when nothing in it is due to change. */
const MAX_AGE_SEC = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** For the checks: how many answers were worked out (a warm or shared request adds none). */
export const publicCollectionStats = { computed: 0 };

export type PublicAccess = 'free' | 'members' | 'premium';
export interface PublicItem {
  id: string; title: string | null; description: string | null; artworkUrl: string | null; durationMs: number | null;
  series: string | null; season: number | null; episode: number | null;
  access: PublicAccess;
  /** 'scheduled': a teaser, listed before it can be played (availableFrom). */
  status: 'available' | 'scheduled';
  availableFrom: string | null;
}
export interface PublicCollection {
  collection: { id: string; name: string; description: string | null; children: { id: string; name: string }[] };
  items: PublicItem[];
  /** The territory group: every country with this exact answer shares it. */
  territoryGroup: string;
  /** When an item in it changes status on its own (a window opening or closing), or null. */
  nextChangeAt: string | null;
}

/** The app behind the presented publishable key, its restrictions checked. */
async function appOf(req: Request) {
  const raw = String(req.get('x-volt-app-key') ?? req.query.appKey ?? '').trim();
  if (!raw) throw new ApiError(401, 'appKey required: ?appKey=pk_... or the X-Volt-App-Key header');
  const key = await verifyKey(raw);
  if (!key || key.kind !== 'publishable' || !key.app_id) throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
  if (reason) throw new ApiError(403, reason);
  return { accountId: String(key.account_id), appId: String(app.id), appType: appTypeOf(app.type, app.surface) };
}

interface Shape { id: string; accountId: string; name: string; description: string | null; children: { id: string; name: string }[]; subtree: string[]; members: string[] }

/** A collection's shape and members in order, cached until it or a sub-collection changes. */
function shapeOf(id: string, deep: boolean): Promise<Shape | null> {
  return cached<Shape | null>(`pubcol:shape:${id}:${deep ? 1 : 0}`, {
    ttlSec: MAX_AGE_SEC, l2: true,
    tags: (s) => s ? [...s.subtree.map((c) => `collection:${c}`), `acct:${s.accountId}`] : [`collection:${id}`],
  }, async () => {
    const c = (await query<any>(`SELECT id, account_id, name, description, order_by FROM collections WHERE id = $1`, [id]))[0];
    if (!c) return null;
    const order = (ORDERS[c.order_by ?? 'manual'] ?? ORDERS.manual).sql.replace('i.position', 'r.position');
    const tree = await query<any>(
      `WITH RECURSIVE t AS (SELECT id, ARRAY[sort_order] AS path FROM collections WHERE id = $1
          UNION ALL SELECT c.id, t.path || c.sort_order FROM collections c JOIN t ON c.parent_id = t.id WHERE $2)
       SELECT id FROM t`, [id, deep]);
    const rows = await query<{ id: string }>(
      `WITH RECURSIVE t AS (SELECT id, ARRAY[sort_order] AS path FROM collections WHERE id = $1
          UNION ALL SELECT c.id, t.path || c.sort_order FROM collections c JOIN t ON c.parent_id = t.id WHERE $2),
        ranked AS (
          SELECT i.vod_asset_id, i.position, i.added_at, t.path,
                 row_number() OVER (PARTITION BY i.vod_asset_id ORDER BY t.path, i.position) AS rn
            FROM t JOIN collection_items i ON i.collection_id = t.id)
       SELECT v.id FROM ranked r JOIN vod_assets v ON v.id = r.vod_asset_id
        WHERE r.rn = 1 ORDER BY r.path, ${order}, r.position, r.added_at LIMIT 2000`, [id, deep]);
    const children = await query<any>(`SELECT id, name FROM collections WHERE parent_id = $1 ORDER BY sort_order, name`, [id]);
    return { id: String(c.id), accountId: String(c.account_id), name: String(c.name), description: c.description ?? null,
      children: children.map((x) => ({ id: String(x.id), name: String(x.name) })),
      subtree: tree.map((x) => String(x.id)), members: rows.map((r) => String(r.id)) };
  });
}

/** Pure: a gate evaluation for an anonymous viewer as a catalogue access, or null when it is kept from them. */
export function accessOf(rights: any): PublicAccess | null {
  if (rights.allowed) return 'free';
  if (rights.replacementAssetId) return null;
  const why = classifyGate(451, null, { rights } as any).reason;
  if (why === 'payment') return 'premium';
  if (why === 'sign_in' || why === 'group') return 'members';
  return null;
}

/** The answer for one app and country, worked out from the cached gate inputs. */
async function compute(shape: Shape, app: { accountId: string; appId: string; appType: any }, country: string | null): Promise<{ body: PublicCollection; ttlSec: number }> {
  publicCollectionStats.computed++;
  const now = new Date();
  const items: PublicItem[] = [];
  let next: number | null = null;
  for (const id of shape.members) {
    const ps = await publicDecision(id, now);
    if (ps?.until) next = Math.min(next ?? Infinity, ps.until.getTime());
    if (!ps || !publiclyListed(ps, now)) {
      // a title listed later (its Listed from date) joins the row then
      if (ps?.listedFrom && ps.listedFrom > now) next = Math.min(next ?? Infinity, ps.listedFrom.getTime());
      continue;
    }
    if (!sitemapListedOf((await vodAvailabilityRow(id))?.availability)) continue;
    const access = accessOf(await evaluateAccess(id, country ?? undefined, { appId: app.appId, appType: app.appType, accountId: app.accountId }));
    if (!access) continue;
    const m: any = await metaFor(app.accountId, 'vod', id);
    if (!m) continue;
    items.push({ id, title: m.title ?? null, description: m.description ?? null, artworkUrl: m.artworkUrl ?? null, durationMs: m.durationMs ?? null,
      series: null, season: null, episode: null,
      access, status: ps.status === 'scheduled' ? 'scheduled' : 'available',
      availableFrom: ps.status === 'scheduled' ? ps.effectiveFrom?.toISOString() ?? null : null });
  }
  // series, season and episode for the rows that group episodes (one read, on a miss only)
  if (items.length) {
    const md = new Map((await query<any>(`SELECT id, metadata FROM vod_assets WHERE id = ANY($1::uuid[])`, [items.map((i) => i.id)])).map((r) => [String(r.id), r.metadata ?? {}]));
    const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    for (const it of items) {
      const m = md.get(it.id) ?? {};
      it.series = m.series ? String(m.series) : null; it.season = num(m.season); it.episode = num(m.episodeNumber ?? m.episode);
    }
  }
  const content = { collection: { id: shape.id, name: shape.name, description: shape.description, children: shape.children }, items };
  const territoryGroup = createHash('sha1').update(JSON.stringify(content)).digest('base64url').slice(0, 16);
  const ttlSec = Math.max(1, Math.min(MAX_AGE_SEC, next != null ? Math.floor((next - now.getTime()) / 1000) : MAX_AGE_SEC));
  return { body: { ...content, territoryGroup, nextChangeAt: next != null ? new Date(next).toISOString() : null }, ttlSec };
}

/**
 * The answer for a country: the country's pointer to its territory group,
 * then the group's shared answer. The first request from a country works the
 * answer out once and files it under its group; a second country with the
 * same answer finds the group's entry already there.
 */
async function answerFor(shape: Shape, app: { accountId: string; appId: string; appType: any }, country: string | null, deep: boolean): Promise<{ body: PublicCollection; ttlSec: number }> {
  const tags = [...shape.subtree.map((c) => `collection:${c}`), ...shape.members.map((a) => `asset:${a}`), `app:${app.appId}`, `acct:${app.accountId}`];
  const base = `pubcol:${shape.id}:${deep ? 1 : 0}:${app.appId}`;
  let fresh: { body: PublicCollection; ttlSec: number } | null = null;
  const group = await cached<{ g: string; ttlSec: number }>(`${base}:c:${country ?? '-'}`,
    { ttlSec: (v) => v.ttlSec, tags }, async () => {
      fresh = await compute(shape, app, country);
      const f = fresh;
      // file the answer under its group, so other countries with it share the entry
      await cached(`${base}:g:${f.body.territoryGroup}`, { ttlSec: f.ttlSec, tags }, async () => f);
      return { g: f.body.territoryGroup, ttlSec: f.ttlSec };
    });
  if (fresh) return fresh;
  // the group's entry, or (dropped since) worked out again for this country
  return cached(`${base}:g:${group.g}`, { ttlSec: (v: any) => v.ttlSec, tags }, () => compute(shape, app, country));
}

function send(req: Request, res: Response, a: { body: PublicCollection; ttlSec: number }) {
  const etag = `W/"pc-${a.body.territoryGroup}"`;
  res.setHeader('ETag', etag);
  // shared at the edge per app (the key is in the query) and country, never in the browser for long
  res.setHeader('Cache-Control', `public, max-age=${Math.min(60, a.ttlSec)}, s-maxage=${a.ttlSec}`);
  res.setHeader('Vary', 'Origin, X-Volt-App-Key, CloudFront-Viewer-Country');
  if (req.get('if-none-match') === etag) { res.status(304).end(); return; }
  res.json(a.body);
}

publicCollectionsRouter.get('/:id', asyncHandler(async (req, res) => {
  const app = await appOf(req);
  const id = String(req.params.id);
  if (!UUID.test(id)) throw notFound('Collection not found');
  const deepQ = String(req.query.deep ?? 'true');
  if (!['true', 'false', '1', '0'].includes(deepQ)) throw badRequest('deep must be true or false');
  const deep = deepQ === 'true' || deepQ === '1';
  const shape = await shapeOf(id, deep);
  if (!shape || shape.accountId !== app.accountId) throw notFound('Collection not found');
  const geo = typeof req.query.geo === 'string' ? req.query.geo : undefined;
  send(req, res, await answerFor(shape, app, viewerGeo(req, geo) ?? null, deep));
}));
