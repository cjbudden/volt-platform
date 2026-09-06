/**
 * Apps & API keys. Register an app (→ a publishable key shown once), manage keys,
 * and the public /availability gate that a player calls with its publishable key
 * to obtain a short-lived playback token.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole } from '../auth/roles';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { generateKey, verifyKey, checkRestrictions, mintPlaybackToken, type AppRow } from '../services/apiKeys';
import { evaluateAccess } from '../services/rights';

// ---- management (JWT-auth) --------------------------------------------------
export const appsRouter = Router();
appsRouter.use(requireAuth);
// Belt and braces, the way /api/users and /api/user-groups already do it. The
// central matrix lists /api/apps as admin-only, but this router mints
// management-scoped account keys — a credential that IS tenant admin — so it
// must not depend on a single prefix comparison being the only thing standing
// between an operator and full control of the account.
appsRouter.use(requireMinRole('admin'));

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

appsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query(`SELECT * FROM apps WHERE account_id=$1 ORDER BY created_at DESC`, [accountId(req)]);
  res.json(rows);
}));

/** ALL of the account's keys (client view): app keys + account secret keys.
 *  Registered BEFORE /:id so 'keys' is not captured as an app id. Only prefix
 *  and metadata are stored; raw keys are never retrievable. */
appsRouter.get('/keys', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT k.id, k.app_id, a.name AS app_name, k.kind, k.key_prefix, k.scopes, k.enabled,
            k.last_used_at, k.request_count, k.created_at
       FROM api_keys k LEFT JOIN apps a ON a.id=k.app_id
      WHERE k.account_id=$1 ORDER BY k.created_at DESC`,
    [accountId(req)]
  );
  res.json(rows);
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
appsRouter.post('/secret-keys', asyncHandler(async (req, res) => {
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
async function assetKindFor(acct: string, assetId: string): Promise<'channel' | 'event' | 'vod' | null> {
  const row = await one<any>(
    `SELECT 'channel' AS kind
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2
      UNION ALL
     SELECT 'event' FROM events e JOIN groups g2 ON g2.id = e.group_id
      WHERE e.id = $1 AND g2.account_id = $2
      UNION ALL
     SELECT 'vod' FROM vod_assets v
       LEFT JOIN channels c2 ON c2.id = v.channel_id
       LEFT JOIN events   e2 ON e2.id = v.event_id
       JOIN groups g3 ON g3.id = COALESCE(c2.group_id, e2.group_id)
      WHERE v.id = $1 AND g3.account_id = $2
      LIMIT 1`,
    [assetId, acct]
  );
  return (row?.kind as any) ?? null;
}

/** The asset id is a uuid column everywhere it is looked up. */
const ASSET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Player pre-flight. Validates the publishable key + the app's restriction, then
 * mints a short-lived playback token. (Geo/rights evaluation is a follow-up wired
 * to the EPG/rights model; the token carries the geo claim for the edge.)
 */
availabilityRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = availSchema.parse(req.body);
    const key = await verifyKey(b.appKey);
    if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
    const app = await one<AppRow>(`SELECT id, type, restrictions, enabled FROM apps WHERE id=$1`, [key.app_id]);
    if (!app) throw new ApiError(401, 'app not found for key');
    const reason = checkRestrictions(app, {
      referrer: req.get('referer') || undefined,
      origin: req.get('origin') || undefined,
      ip: req.ip,
    });
    if (reason) throw new ApiError(403, `blocked: ${reason}`);
    const kind = ASSET_UUID_RE.test(b.assetId) ? await assetKindFor(key.account_id, b.assetId) : null;
    if (!kind) throw new ApiError(404, 'unknown asset');
    // geo / rights (blackout → replacement)
    const rights = await evaluateAccess(b.assetId, b.geo, { appId: key.app_id, entitled: b.entitled === true, accountId: key.account_id, viewer: b.viewer ?? null });
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
          return res.status(451).json({ available: false, mode: 'blocked', reason: rights.reason });
        }
        const tok = mintPlaybackToken({ accountId: key.account_id, appId: key.app_id, assetId: rights.replacementAssetId, assetKind: rk, geo: b.geo });
        return res.json({ available: true, mode: 'replacement', assetId: rights.replacementAssetId, reason: rights.reason, playbackToken: tok.token, expiresIn: tok.expiresIn });
      }
      const r: any = rights;
      const paywall = r.rule?.reason === 'payment_required';
      return res.status(paywall ? 402 : r.rule?.reason === 'members_only' || r.rule?.reason === 'group' ? 403 : 451).json({
        available: false, mode: paywall ? 'paywall' : r.rule?.reason === 'members_only' ? 'sign_in' : 'blocked',
        reason: rights.reason, products: r.products ?? undefined, ruleId: r.rule?.ruleId ?? undefined,
      });
    }
    const tok = mintPlaybackToken({ accountId: key.account_id, appId: key.app_id, assetId: b.assetId, assetKind: kind, geo: b.geo });
    res.json({ available: true, mode: 'play', assetId: b.assetId, playbackToken: tok.token, expiresIn: tok.expiresIn });
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
    const app = await one<AppRow>(`SELECT id, type, restrictions, enabled FROM apps WHERE id=$1`, [key.app_id]);
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
    const rights = await evaluateAccess(b.assetId, b.geo, { appId: key.app_id, entitled: b.entitled === true, accountId: key.account_id, viewer: b.viewer ?? null });
    const reasons = [reason, rights.allowed ? null : rights.reason].filter(Boolean);
    const r: any = rights;
    res.json({ allowed: !reason && rights.allowed, assetId: b.assetId, reasons, replacementAssetId: rights.replacementAssetId ?? null,
      mode: rights.allowed ? 'play' : r.rule?.reason === 'payment_required' ? 'paywall' : r.rule?.reason === 'members_only' ? 'sign_in' : 'blocked',
      products: r.products ?? undefined });
  })
);
