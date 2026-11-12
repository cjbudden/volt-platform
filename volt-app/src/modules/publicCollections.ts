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
 * keep from this app or country is left out.
 *
 * LOCKED TITLES (build queue C2-4). A premium title carries `packages`, the
 * collections whose purchase unlocks it there (any one of them does), and
 * `products`, what this app can sell for it: the play gate's own answer, so
 * the row and the 402 the player gets name the same packages. Each app
 * chooses (apps.locked_titles): `upsell`, the default, lists them locked;
 * `hide` leaves every premium title out of its rows. A members-only title is
 * not locked (a sign-in, not a sale) and is listed either way.
 *
 * A RULE COLLECTION DOES NOT LIST ANOTHER COLLECTION'S PACKAGE. When only
 * this collection's rules (or its sub-collections') put a title here and
 * another collection sells it as a package in this app and country while
 * this one asks none (services/collectionAccess.ts lockedElsewhere, as View
 * as leaves it out), the title is left out for this app and country: its
 * rules did not choose a paid title. A title a person added stays, locked
 * with the governing package.
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
import { lockedElsewhere } from '../services/collectionAccess';
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
  /** A premium title: the collections whose package unlocks it here (any one of them does). */
  packages?: { id: string; name: string }[];
  /** A premium title: what this app can sell to unlock it (the gate's sellable terms). */
  products?: any[];
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
  /** This app's choice for locked titles: listed with their packages (upsell) or left out (hide). */
  lockedTitles: LockedTitles;
}
export type LockedTitles = 'upsell' | 'hide';
interface AppCtx { accountId: string; appId: string; appType: any; lockedTitles: LockedTitles }

/** The app behind the presented publishable key, its restrictions checked. */
async function appOf(req: Request): Promise<AppCtx> {
  const raw = String(req.get('x-volt-app-key') ?? req.query.appKey ?? '').trim();
  if (!raw) throw new ApiError(401, 'appKey required: ?appKey=pk_... or the X-Volt-App-Key header');
  const key = await verifyKey(raw);
  if (!key || key.kind !== 'publishable' || !key.app_id) throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
  if (reason) throw new ApiError(403, reason);
  return { accountId: String(key.account_id), appId: String(app.id), appType: appTypeOf(app.type, app.surface),
    lockedTitles: app.locked_titles === 'hide' ? 'hide' : 'upsell' };
}

interface Shape {
  id: string; accountId: string; name: string; description: string | null; children: { id: string; name: string }[];
  subtree: string[]; members: string[];
  /** The collection and every sub-collection, whatever `deep` is: what View as counts as this collection's own. */
  family: string[];
  /** Members only rules put here (no person added them anywhere in the family). */
  byRule: string[];
}

/** A collection's shape and members in order, cached until it or a sub-collection changes. */
function shapeOf(id: string, deep: boolean): Promise<Shape | null> {
  return cached<Shape | null>(`pubcol:shape2:${id}:${deep ? 1 : 0}`, {
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
    const family = deep ? tree : await query<any>(
      `WITH RECURSIVE t AS (SELECT id FROM collections WHERE id = $1 UNION ALL SELECT c.id FROM collections c JOIN t ON c.parent_id = t.id)
       SELECT id FROM t`, [id]);
    const rows = await query<{ id: string; by_rule: boolean }>(
      `WITH RECURSIVE t AS (SELECT id, ARRAY[sort_order] AS path FROM collections WHERE id = $1
          UNION ALL SELECT c.id, t.path || c.sort_order FROM collections c JOIN t ON c.parent_id = t.id WHERE $2),
        ranked AS (
          SELECT i.vod_asset_id, i.position, i.added_at, t.path,
                 row_number() OVER (PARTITION BY i.vod_asset_id ORDER BY t.path, i.position) AS rn,
                 bool_and(coalesce(i.source, 'manual') = 'rule') OVER (PARTITION BY i.vod_asset_id) AS by_rule
            FROM t JOIN collection_items i ON i.collection_id = t.id)
       SELECT v.id, r.by_rule FROM ranked r JOIN vod_assets v ON v.id = r.vod_asset_id
        WHERE r.rn = 1 ORDER BY r.path, ${order}, r.position, r.added_at LIMIT 2000`, [id, deep]);
    const children = await query<any>(`SELECT id, name FROM collections WHERE parent_id = $1 ORDER BY sort_order, name`, [id]);
    return { id: String(c.id), accountId: String(c.account_id), name: String(c.name), description: c.description ?? null,
      children: children.map((x) => ({ id: String(x.id), name: String(x.name) })),
      subtree: tree.map((x) => String(x.id)), members: rows.map((r) => String(r.id)),
      family: family.map((x: any) => String(x.id)), byRule: rows.filter((r) => r.by_rule).map((r) => String(r.id)) };
  });
}

/** Pure: a gate evaluation for an anonymous viewer as a catalogue access, or null when it is kept from them. */
export function accessOf(rights: any): PublicAccess | null {
  if (rights.allowed) return 'free';
  if (rights.replacementAssetId) return null;
  // A collection's package or sign-in (the collection layer answers in the
  // gate's own words, as the 402 route reads them): before the reading the
  // reports use, which took "Part of Sport. Buy it to watch." for an
  // availability refusal and left the title out of the row (found by C2-4).
  if (rights.rule?.reason === 'payment_required') return 'premium';
  if (rights.rule?.reason === 'members_only') return 'members';
  const why = classifyGate(451, null, { rights } as any).reason;
  if (why === 'payment') return 'premium';
  if (why === 'sign_in' || why === 'group') return 'members';
  return null;
}

/** The answer for one app and country, worked out from the cached gate inputs. */
async function compute(shape: Shape, app: AppCtx, country: string | null): Promise<{ body: PublicCollection; ttlSec: number }> {
  publicCollectionStats.computed++;
  const now = new Date();
  const own = new Set(shape.family ?? shape.subtree);
  const byRule = new Set(shape.byRule ?? []);
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
    const row = await vodAvailabilityRow(id);
    if (!sitemapListedOf(row?.availability)) continue;
    // Only rules put it here, and another collection sells it as a package
    // in this app and country while this one asks none: left out (C2-4).
    if (byRule.has(id) && lockedElsewhere(row?.collection_access, own, app.appId, country)) continue;
    const gate: any = await evaluateAccess(id, country ?? undefined, { appId: app.appId, appType: app.appType, accountId: app.accountId });
    const access = accessOf(gate);
    if (!access) continue;
    // The app hides what a viewer would have to buy (C2-4).
    if (access === 'premium' && app.lockedTitles === 'hide') continue;
    const m: any = await metaFor(app.accountId, 'vod', id);
    if (!m) continue;
    items.push({ id, title: m.title ?? null, description: m.description ?? null, artworkUrl: m.artworkUrl ?? null, durationMs: m.durationMs ?? null,
      series: null, season: null, episode: null,
      access,
      ...(access === 'premium' ? {
        packages: (gate.rule?.packages ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name) })),
        products: gate.products ?? gate.rule?.products ?? [],
      } : {}),
      status: ps.status === 'scheduled' ? 'scheduled' : 'available',
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
  return { body: { ...content, territoryGroup, nextChangeAt: next != null ? new Date(next).toISOString() : null, lockedTitles: app.lockedTitles }, ttlSec };
}

/**
 * The answer for a country: the country's pointer to its territory group,
 * then the group's shared answer. The first request from a country works the
 * answer out once and files it under its group; a second country with the
 * same answer finds the group's entry already there.
 */
async function answerFor(shape: Shape, app: AppCtx, country: string | null, deep: boolean): Promise<{ body: PublicCollection; ttlSec: number }> {
  const tags = [...shape.subtree.map((c) => `collection:${c}`), ...shape.members.map((a) => `asset:${a}`), `app:${app.appId}`, `acct:${app.accountId}`];
  const base = `pubcol:${shape.id}:${deep ? 1 : 0}:${app.appId}:${app.lockedTitles}`;
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
