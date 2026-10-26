/**
 * Apps & API keys. Register an app (→ a publishable key shown once), manage keys,
 * and the public /availability gate that a player calls with its publishable key
 * to obtain a short-lived playback token.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole } from '../auth/roles';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { generateKey, verifyKey, checkRestrictions, mintPlaybackToken, appForKey } from '../services/apiKeys';
import { evaluateAccess } from '../services/rights';
import { assetKindFor, currentProgrammeWindow } from '../services/viewerPath';
import { resolveLiveManifest, resolveEventManifest } from './publicLive';
import { viewerGeo, edgeCache, noStore } from '../scale/edge';
import { scaleConfig } from '../scale/config';
import { optionalViewer } from './publicApi';
import { entitlementsFromClaims } from '../auth/viewerTokens';
import { cachedEntitlements } from '../services/viewerPath';
import { viewerEntitlements } from '../services/entitlements';
import type { ViewerCtx } from '../services/accessRules';
import { cached } from '../scale/cache';
import { config } from '../config';
import { manifestUrls } from '../services/shareLinks';
import { publicMp3Url } from '../services/radio/jobConfig';
import { classifyGate, recordGate, type GateNote } from '../services/qoe/gateLog';

// ---- management (JWT-auth) --------------------------------------------------
export const appsRouter = Router();
appsRouter.use(requireAuth);
// Belt and braces, the way /api/users and /api/user-groups already do it. The
// central matrix lists /api/apps as admin-only, but this router mints
// management-scoped account keys — a credential that IS tenant admin — so it
// must not depend on a single prefix comparison being the only thing standing
// between an operator and full control of the account.
// Apps and publishable keys: the central gate (feature `apps`) decides.
// Account SECRET keys below carry full tenant admin, so minting one needs the
// admin tier: holding apps:manage must not be a way to become an admin.

const appSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['web', 'ios', 'android', 'tv', 'roku', 'server']),
  restrictions: z.record(z.any()).default({}),
});

async function issueKey(accountId: string, appId: string | null, kind: 'secret' | 'publishable', scopes: string[]) {
  const k = generateKey(kind);
  const row = await one<any>(
    `INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes)
     VALUES ($1,$2,$3::api_key_kind,$4,$5,$6) RETURNING id, key_prefix, kind, scopes, created_at`,
    [accountId, appId, kind, k.prefix, k.hash, scopes]
  );
  return { ...row, key: k.raw }; // raw shown ONCE
}

/** Register an app → returns the app + a publishable key (shown once). */
appsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = appSchema.parse(req.body);
    const app = await one<any>(
      `INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,$2,$3::app_type,$4::jsonb) RETURNING *`,
      [accountId(req), b.name, b.type, JSON.stringify(b.restrictions)]
    );
    const key = await issueKey(accountId(req), app.id, 'publishable', ['playback']);
    res.status(201).json({ ...app, publishableKey: key });
  })
);

// The list standard (util/listQuery.ts).
const appList = defineList({
  path: '/api/apps',
  fields: {
    id: { sql: 'a.id', type: 'uuid' },
    name: { sql: 'a.name', type: 'string' },
    type: { sql: 'a.type', type: 'enum', values: ['web', 'ios', 'android', 'tv', 'roku', 'server'] },
    enabled: { sql: 'a.enabled', type: 'boolean' },
    created_at: { sql: 'a.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'a.updated_at', type: 'timestamp' },
  },
  search: ['name'],
  defaultSort: '-created_at',
  unpagedLimit: 1000,
  aliases: { createdAt: 'created_at' },
});

appsRouter.get('/', asyncHandler(async (req, res) => {
  const base: unknown[] = [accountId(req)];
  const params = [...base];
  const pl = parseList(appList, req.query, params);
  const from = `FROM apps a WHERE a.account_id=$1${whereSql(pl)}`;
  const rows = await query<any>(`SELECT a.* ${from} ${pageSql(pl)}`, params);
  const cParams = [...base];
  const cWhere = pl.count ? whereSql(parseList(appList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
  const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM apps a WHERE a.account_id=$1${cWhere}`, cParams))?.n : undefined;
  res.json(finishPage(req, res, pl, rows, total));
}));

const keyList = defineList({
  path: '/api/apps/keys',
  fields: {
    id: { sql: 'k.id', type: 'uuid' },
    app_id: { sql: 'k.app_id', type: 'uuid', doc: 'Empty for account secret keys' },
    app_name: { sql: 'a.name', type: 'string' },
    kind: { sql: 'k.kind', type: 'enum', values: ['secret', 'publishable'] },
    key_prefix: { sql: 'k.key_prefix', type: 'string' },
    enabled: { sql: 'k.enabled', type: 'boolean' },
    last_used_at: { sql: 'k.last_used_at', type: 'timestamp' },
    request_count: { sql: 'k.request_count', type: 'number' },
    created_at: { sql: 'k.created_at', type: 'timestamp', notNull: true },
  },
  search: ['app_name', 'key_prefix'],
  defaultSort: '-created_at',
  unpagedLimit: 1000,
  aliases: { appId: 'app_id', createdAt: 'created_at' },
});

/** ALL of the account's keys (client view): app keys + account secret keys.
 *  Registered BEFORE /:id so 'keys' is not captured as an app id. Only prefix
 *  and metadata are stored; raw keys are never retrievable. */
appsRouter.get('/keys', asyncHandler(async (req, res) => {
  const base: unknown[] = [accountId(req)];
  const params = [...base];
  const pl = parseList(keyList, req.query, params);
  const from = `FROM api_keys k LEFT JOIN apps a ON a.id=k.app_id WHERE k.account_id=$1${whereSql(pl)}`;
  const rows = await query<any>(
    `SELECT k.id, k.app_id, a.name AS app_name, k.kind, k.key_prefix, k.scopes, k.enabled,
            k.last_used_at, k.request_count, k.created_at
       ${from} ${pageSql(pl)}`,
    params
  );
  const cParams = [...base];
  const cWhere = pl.count ? whereSql(parseList(keyList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
  const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM api_keys k LEFT JOIN apps a ON a.id=k.app_id WHERE k.account_id=$1${cWhere}`, cParams))?.n : undefined;
  res.json(finishPage(req, res, pl, rows, total));
}));

appsRouter.get('/:id', asyncHandler(async (req, res) => {
  const app = await one(`SELECT * FROM apps WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!app) throw notFound('App not found');
  const keys = await query(`SELECT id, key_prefix, kind, scopes, enabled, last_used_at, request_count FROM api_keys WHERE app_id=$1`, [req.params.id]);
  res.json({ ...(app as any), keys });
}));

appsRouter.put('/:id', asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().optional(), restrictions: z.record(z.any()).optional(), enabled: z.boolean().optional() }).parse(req.body);
  const app = await one(
    `UPDATE apps SET name=COALESCE($3,name), restrictions=COALESCE($4::jsonb,restrictions), enabled=COALESCE($5,enabled), updated_at=now()
      WHERE id=$1 AND account_id=$2 RETURNING *`,
    [req.params.id, accountId(req), b.name ?? null, b.restrictions ? JSON.stringify(b.restrictions) : null, b.enabled ?? null]
  );
  if (!app) throw notFound('App not found');
  res.json(app);
}));

/** Rotate: issue a fresh publishable key for the app (old ones stay until revoked). */
appsRouter.post('/:id/keys', asyncHandler(async (req, res) => {
  const app = await one(`SELECT id FROM apps WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!app) throw notFound('App not found');
  res.status(201).json(await issueKey(accountId(req), req.params.id, 'publishable', ['playback']));
}));

appsRouter.delete('/keys/:keyId', asyncHandler(async (req, res) => {
  const row = await one(`DELETE FROM api_keys WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.keyId, accountId(req)]);
  if (!row) throw notFound('Key not found');
  res.status(204).end();
}));

/** Create an account/secret (management-scope) key — server-side use only. */
appsRouter.post('/secret-keys', requireMinRole('admin'), asyncHandler(async (req, res) => {
  res.status(201).json(await issueKey(accountId(req), null, 'secret', ['management']));
}));

// ---- public availability gate (publishable-key auth, NOT JWT) ---------------
export const availabilityRouter = Router();

const availSchema = z.object({
  appKey: z.string().min(8),
  assetId: z.string().min(1),
  geo: z.string().length(2).optional(),
  /** The app vouches that this viewer holds an entitlement (or has paid).
   *  A placeholder for the entitlement service: the paywall model is an
   *  open question in DESIGN_media_library.md. */
  entitled: z.boolean().optional(),
  /** Who is watching, as the client's app knows them. Anonymous when absent.
   *  Groups the app asserts (site users, members) feed the members-only rules. */
  viewer: z.object({ externalId: z.string().min(1), email: z.string().email().optional(), groups: z.array(z.string()).optional() }).optional(),
  /** The player's play attempt (its CMCD session id), carried into the playback token. */
  sid: z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/).optional(),
});

/**
 * DOES THIS ACCOUNT OWN THIS ASSET?
 *
 * The gate is public and the caller supplies the asset id, so without this the
 * only thing a publishable key proved was that the caller had SOME key. Any
 * tenant could mint a playback token for another tenant's channel, and the
 * 200 / 451 / mode:'replacement' split was a cross-tenant oracle over guessed
 * uuids: it disclosed whether a channel existed and whether it was currently
 * blacked out. Worse downstream, the analytics beacon trusts the token's asset
 * id and stream_concurrency is keyed without an account, so a token minted for
 * a victim's channel let one tenant claim or overwrite the victim's realtime
 * row — and their live viewer count then vanished from their own dashboard.
 *
 * An id that names nothing is answered the same way as one belonging to
 * somebody else, so the endpoint stops distinguishing the two.
 */
// Ownership lookup lives in services/viewerPath.ts now (cached, same query).

/** The asset id is a uuid column everywhere it is looked up. */
const ASSET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GateInput = z.infer<typeof availSchema>;

/**
 * The viewer facts the rights evaluation uses, from the most trustworthy
 * source available: a verified viewer session; else (only for apps marked
 * trustAssertedViewer) what the app asserted; else anonymous.
 */
async function viewerInputs(req: Request, b: GateInput, acct: string, app: any, geo: string | undefined) {
  const claims = optionalViewer(req);
  if (claims) {
    if (claims.acct !== acct) throw new ApiError(401, 'This session belongs to another account');
    const entitlements = claims.entx
      ? await cachedEntitlements(claims.sub, () => viewerEntitlements(claims.sub))
      : entitlementsFromClaims(claims);
    return {
      signedIn: true, claims, entitled: false, viewer: null,
      viewerCtx: { country: geo ?? null, viewerId: claims.sub, groups: claims.grp ?? [], entitlements } as ViewerCtx,
    };
  }
  const trusted = app?.restrictions?.trustAssertedViewer === true;
  return {
    signedIn: !!(req.headers.authorization), claims: null,
    entitled: trusted && b.entitled === true,
    viewer: trusted ? (b.viewer ?? null) : null,
    viewerCtx: null as ViewerCtx | null,
  };
}
interface GateAnswer { status: number; body: any; edgeSec: number }

/**
 * decide(), timed and noted for the playback reports (report 7): how long the
 * gate took and why it answered as it did, by the attempt's sid. The note is
 * buffered (services/qoe/gateLog.ts), never written on this path.
 */
async function timedDecide(req: Request, b: GateInput, opts: { cacheable: boolean }, method: 'GET' | 'POST'): Promise<GateAnswer> {
  const t0 = performance.now();
  const note: GateNote = {};
  const log = (status: number, body: any) => {
    if (!note.accountId) return; // a key we do not know: nobody's report
    const c = classifyGate(status, body, note);
    recordGate({ account_id: note.accountId, app_id: note.appId ?? null, sid: b.sid ?? null, at: Date.now(), method, status,
      mode: body?.mode ?? null, reason: c.reason, layer: c.layer, rule_id: c.ruleId, asset_id: b.assetId, asset_kind: note.kind ?? null,
      country: note.geo ?? null, ms: performance.now() - t0 });
  };
  try {
    const a = await decide(req, b, opts, note);
    log(a.status, a.body);
    return a;
  } catch (e) { log(500, null); throw e; }
}

/**
 * THE PLAY GATE'S DECISION, shared by POST (any viewer) and GET (anonymous,
 * edge-cacheable). Every lookup in here is cached (services/viewerPath.ts), so
 * a warm process answers an anonymous start without touching the database.
 *
 * `edgeSec` is how long this exact answer stays true for every anonymous
 * viewer with the same key, asset, origin and country: the edge cache time,
 * capped so a programme boundary (blackout on/off) is never served late.
 */
async function decide(req: Request, b: GateInput, opts: { cacheable: boolean }, note: GateNote = {}): Promise<GateAnswer> {
  const nope = (status: number, msg: string): GateAnswer => ({ status, body: { error: msg }, edgeSec: opts.cacheable ? 5 : 0 });
  const key = await verifyKey(b.appKey);
  if (!key || key.kind !== 'publishable') return nope(401, 'invalid publishable key');
  note.accountId = key.account_id; note.appId = key.app_id ?? null;
  const app = await appForKey(key);
  if (!app) return nope(401, 'app not found for key');
  // A cached answer may only depend on what is in the cache key: for a web app
  // that is the Origin header. A web allow-list checked against a Referer (no
  // Origin sent), and any server IP allow-list, are per caller: not cacheable.
  const origin = req.get('origin') || undefined;
  const referrer = req.get('referer') || undefined;
  const restrict = app.restrictions || {};
  const webAllowList = app.type === 'web' && ((restrict.referrers || restrict.origins || []).length > 0);
  let cacheable = opts.cacheable;
  if (app.type === 'server' && (restrict.ipAllowlist || []).length) cacheable = false;
  if (cacheable && webAllowList && !origin && referrer) cacheable = false;
  const reason = checkRestrictions(app, { referrer: cacheable ? undefined : referrer, origin, ip: req.ip });
  if (reason) return { status: 403, body: { error: `blocked: ${reason}` }, edgeSec: cacheable ? 5 : 0 };
  const kind = ASSET_UUID_RE.test(b.assetId) ? await assetKindFor(key.account_id, b.assetId) : null;
  if (!kind) return { status: 404, body: { error: 'unknown asset' }, edgeSec: cacheable ? 5 : 0 };

  const geo = viewerGeo(req, b.geo);
  note.kind = kind; note.geo = geo ?? null;
  let edgeSec = cacheable ? scaleConfig.edge.availabilityMaxAgeSec : 0;
  if (edgeSec > 0 && kind === 'channel') {
    const w = await currentProgrammeWindow(b.assetId);
    edgeSec = Math.min(edgeSec, Math.floor((w.until - Date.now()) / 1000));
  }

  // WHO IS WATCHING. A signed-in viewer proves it with their viewer session
  // (Authorization: Bearer <viewer token>), checked without a database
  // query. A viewer or entitlement merely ASSERTED in the body is ignored
  // unless the app is configured to be trusted (restrictions.trustAssertedViewer,
  // for server-side apps): from a browser or phone it is whatever the user
  // typed, and it used to unlock members-only and paid content.
  const vi = await viewerInputs(req, b, key.account_id, app, geo);
  if (vi.signedIn) { cacheable = false; edgeSec = 0; }
  let rights = await evaluateAccess(b.assetId, geo, { appId: key.app_id, entitled: vi.entitled, accountId: key.account_id, viewer: vi.viewer, viewerCtx: vi.viewerCtx });
  // Just bought it? The token's entitlement snapshot predates the purchase:
  // only when it says no, look at the (cached) live entitlements once.
  if (!rights.allowed && vi.claims && !rights.replacementAssetId) {
    const fresh = await cachedEntitlements(vi.claims.sub, () => viewerEntitlements(vi.claims!.sub));
    rights = await evaluateAccess(b.assetId, geo, { appId: key.app_id, accountId: key.account_id,
      viewerCtx: { ...vi.viewerCtx!, entitlements: fresh } });
  }
  note.rights = rights;
  if (!rights.allowed) {
    if (rights.replacementAssetId) {
      // The replacement is named by the PROGRAMME, so its kind is looked up
      // rather than assumed — and it must belong to the same account too.
      const rk = await assetKindFor(key.account_id, String(rights.replacementAssetId));
      if (!rk) {
        // The programme names a replacement that no longer exists, or never
        // did. Blocking is the safe answer, but silence is not: the operator
        // configured a blackout slate and viewers are getting a hard block.
        console.warn(
          `[availability] programme replacement ${rights.replacementAssetId} is not an asset of ` +
          `account ${key.account_id}; serving a hard block instead of the slate`
        );
        return { status: 451, body: { available: false, mode: 'blocked', reason: rights.reason }, edgeSec };
      }
      const tok = mintPlaybackToken({ accountId: key.account_id, appId: key.app_id, assetId: rights.replacementAssetId, assetKind: rk, geo, sid: b.sid });
      return {
        status: 200, edgeSec,
        body: { available: true, mode: 'replacement', assetId: rights.replacementAssetId, reason: rights.reason,
          playbackToken: tok.token, expiresIn: tok.expiresIn,
          delivery: await deliveryFor(rk, String(rights.replacementAssetId), key.account_id, b.sid),
          meta: await metaFor(key.account_id, rk, String(rights.replacementAssetId)) },
      };
    }
    const r: any = rights;
    const paywall = r.rule?.reason === 'payment_required';
    return {
      status: paywall ? 402 : r.rule?.reason === 'members_only' || r.rule?.reason === 'group' ? 403 : 451,
      body: { available: false, mode: paywall ? 'paywall' : r.rule?.reason === 'members_only' ? 'sign_in' : 'blocked',
        reason: rights.reason, products: r.products ?? undefined, ruleId: r.rule?.ruleId ?? undefined,
        // What it is, so the player can show the title and artwork behind a paywall or sign-in.
        meta: paywall || r.rule?.reason === 'members_only' ? await metaFor(key.account_id, kind, b.assetId) : undefined },
      edgeSec,
    };
  }
  const tok = mintPlaybackToken({ accountId: key.account_id, appId: key.app_id, assetId: b.assetId, assetKind: kind, geo, sid: b.sid });
  return {
    status: 200, edgeSec,
    body: { available: true, mode: 'play', assetId: b.assetId, playbackToken: tok.token, expiresIn: tok.expiresIn,
      delivery: await deliveryFor(kind, b.assetId, key.account_id, b.sid),
      meta: await metaFor(key.account_id, kind, b.assetId) },
  };
}

/**
 * The URLs to play, handed back with the token so the player goes straight to
 * the CDN instead of through the /live redirect (one less request per viewer
 * through the API).
 *
 *   channel  the live manifests (and the MP3 for a radio station); null while
 *            off air or while its output is not valid, and the player then
 *            shows "not on air" and offers a retry.
 *   vod      the asset's own manifests, in the formats it was built in.
 *   event    its live manifests while it is live in its public window.
 */
async function deliveryFor(kind: string, assetId: string, acct: string, sid?: string | null): Promise<{ hls: string | null; dash: string | null; mp3?: string | null } | null> {
  if (kind === 'channel') {
    // sid: a stitched FAST channel names the viewer's stitcher session after the
    // play attempt, so its server-side ad beacons join the player's reports (report 11).
    const [h, d] = await Promise.all([resolveLiveManifest(assetId, 'master.m3u8', sid), resolveLiveManifest(assetId, 'manifest.mpd')]);
    if (!(h.ok && d.ok)) return null;
    const m = await assetMeta(acct, 'channel', assetId);
    return { hls: h.url, dash: d.url, mp3: m?.radio ? publicMp3Url(assetId) : null };
  }
  if (kind === 'vod') {
    const m = await assetMeta(acct, 'vod', assetId);
    return m?.manifests ?? null;
  }
  if (kind === 'event') {
    const [h, d] = await Promise.all([resolveEventManifest(assetId, 'master.m3u8'), resolveEventManifest(assetId, 'manifest.mpd')]);
    return h.ok ? { hls: h.url, dash: d.ok ? d.url : null } : null;
  }
  return null;
}

interface AssetMeta {
  title: string | null; description: string | null; artworkUrl: string | null;
  durationMs: number | null; live: boolean; kind: string; radio?: boolean;
  manifests?: { hls: string | null; dash: string | null };
  /** On-demand only: the skippable stretches (intro, recap, credits), seconds into the asset. */
  skip?: Array<{ kind: string; from: number; to: number }>;
}

const imageUrl = (v: unknown): string | null => typeof v === 'string' && /^(https?:\/\/|\/(?!\/))/.test(v) ? v : null;

/**
 * What a player shows about an asset (title, artwork, length), cached with
 * the asset so a playlist of fifty ids costs the database nothing warm. Only
 * fields that are already public on a share page or in the guide.
 */
function assetMeta(acct: string, kind: string, id: string): Promise<AssetMeta | null> {
  return cached<AssetMeta | null>(`assetmeta:${acct}:${id}`,
    { ttlSec: scaleConfig.cache.rulesTtlSec, tags: [`asset:${id}`, `acct:${acct}`] },
    async () => {
      if (kind === 'vod') {
        const a = await one<any>(
          `SELECT v.id, v.title, v.metadata, v.duration_ms, v.poster_key, v.master_key, v.formats
             FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
             LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
            WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);  // uploads belong to the account directly (vod.ts OWNER_ACCOUNT)
        if (!a) return null;
        const m = manifestUrls('vod', a.id, a.master_key, a.formats ?? {});
        const cdn = config.aws.cdnBaseUrl.replace(/\/$/, '');
        return { title: a.title ?? null, description: a.metadata?.description ?? null,
          artworkUrl: a.poster_key ? `${cdn}/${String(a.poster_key).replace(/^\//, '')}` : imageUrl(a.metadata?.image),
          durationMs: a.duration_ms != null ? Number(a.duration_ms) : null, live: false, kind: 'vod', manifests: { hls: m.hls, dash: m.dash },
          // Skip markers, for apps that draw their own Skip button. The same ranges
          // are in the manifests (services/vodMarkers.ts); seconds into the asset.
          skip: (await (await import('../services/vodMarkers')).listMarkers(a.id))
            .filter((x) => x.status === 'active').map((x) => ({ kind: x.kind, from: x.startMs / 1000, to: x.endMs / 1000 })) };
      }
      const table = kind === 'event' ? 'events' : 'channels';
      const r = await one<any>(
        `SELECT x.name, x.metadata${kind === 'event' ? '' : ', x.kind AS ckind, x.brand_ref'} FROM ${table} x JOIN groups g ON g.id = x.group_id
          WHERE x.id = $1 AND g.account_id = $2`, [id, acct]);
      if (!r) return null;
      return { title: r.name ?? null, description: r.metadata?.description ?? null,
        artworkUrl: imageUrl(r.metadata?.artworkUrl) ?? imageUrl(r.metadata?.image) ?? imageUrl(r.metadata?.posterUrl) ?? imageUrl(r.brand_ref),
        durationMs: null, live: true, kind, radio: r.ckind === 'radio' };
    });
}

/** The public part of the meta, for the gate's answer. */
async function metaFor(acct: string, kind: string, id: string) {
  const m = await assetMeta(acct, kind, id).catch(() => null);
  if (!m) return undefined;
  return { title: m.title, description: m.description, artworkUrl: m.artworkUrl, durationMs: m.durationMs, live: m.live, kind: m.kind };
}

function send(res: Response, a: GateAnswer): void {
  if (a.edgeSec > 0) edgeCache(res, a.edgeSec, true); else noStore(res);
  res.status(a.status).json(a.body);
}

/**
 * Player pre-flight. Validates the publishable key + the app's restriction, then
 * mints a short-lived playback token. Any viewer: signed-in viewers, entitlement
 * claims and per-caller restrictions go here. Never cached at the edge.
 */
availabilityRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = availSchema.parse(req.body);
    const a = await timedDecide(req, b, { cacheable: false }, 'POST');
    if (a.status === 401 || a.status === 403 || a.status === 404) throw new ApiError(a.status, a.body.error);
    send(res, a);
  })
);

/**
 * ANONYMOUS, EDGE-CACHEABLE PRE-FLIGHT.
 *
 *   GET /api/availability?appKey=pk_…&assetId=<uuid>[&geo=XX]
 *
 * The answer for an anonymous viewer depends only on the key, the asset, the
 * page's Origin and the viewer's country, so CloudFront (or the staging nginx)
 * keys its cache on exactly those and answers repeat requests itself. A big
 * free event's million starts then reach the API as a handful of requests per
 * edge location every few seconds. The token in a cached answer is shared by
 * the viewers who receive it: it carries no viewer identity, only "this app
 * may play this asset from this country", which is the same for all of them.
 *
 * `geo` in the query is honoured only when the edge geo header is not trusted
 * (dev/staging without an edge); behind CloudFront the country comes from
 * CloudFront-Viewer-Country, which is in the cache key.
 */
availabilityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const b = availSchema.parse({
      appKey: String(req.query.appKey ?? ''),
      assetId: String(req.query.assetId ?? ''),
      geo: typeof req.query.geo === 'string' && req.query.geo ? req.query.geo : undefined,
    });
    const a = await timedDecide(req, b, { cacheable: true }, 'GET');
    send(res, a);
  })
);

// ---- public check-access (publishable-key auth; NO token minted) ------------
// Lighter than /availability: answers "may this viewer access this asset?" as
// booleans (for UI gating / pre-checks) without issuing a playback token.
export const accessRouter = Router();
accessRouter.post(
  '/check',
  asyncHandler(async (req, res) => {
    const b = availSchema.parse(req.body);
    const key = await verifyKey(b.appKey);
    if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
    const app = await appForKey(key);
    if (!app) throw new ApiError(401, 'app not found for key');
    const reason = checkRestrictions(app, {
      referrer: req.get('referer') || undefined,
      origin: req.get('origin') || undefined,
      ip: req.ip,
    });
    // Same ownership rule as /availability. This endpoint mints no token, but
    // it answers the same question, so without the check it was the quieter
    // half of the same cross-tenant oracle.
    if (!ASSET_UUID_RE.test(b.assetId) || !(await assetKindFor(key.account_id, b.assetId))) {
      throw new ApiError(404, 'unknown asset');
    }
    const vi = await viewerInputs(req, b, key.account_id, app, viewerGeo(req, b.geo));
    const rights = await evaluateAccess(b.assetId, viewerGeo(req, b.geo), { appId: key.app_id, entitled: vi.entitled, accountId: key.account_id, viewer: vi.viewer, viewerCtx: vi.viewerCtx });
    const reasons = [reason, rights.allowed ? null : rights.reason].filter(Boolean);
    const r: any = rights;
    res.json({ allowed: !reason && rights.allowed, assetId: b.assetId, reasons, replacementAssetId: rights.replacementAssetId ?? null,
      mode: rights.allowed ? 'play' : r.rule?.reason === 'payment_required' ? 'paywall' : r.rule?.reason === 'members_only' ? 'sign_in' : 'blocked',
      products: r.products ?? undefined });
  })
);
