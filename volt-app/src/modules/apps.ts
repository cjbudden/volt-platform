/**
 * Apps & API keys. Register an app (→ a publishable key shown once), manage keys,
 * and the public /availability gate that a player calls with its publishable key
 * to obtain a short-lived playback token.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { generateKey, verifyKey, checkRestrictions, mintPlaybackToken, type AppRow } from '../services/apiKeys';
import { evaluateAccess } from '../services/rights';

// ---- management (JWT-auth) --------------------------------------------------
export const appsRouter = Router();
appsRouter.use(requireAuth);

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
});

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
    // geo / rights (blackout → replacement)
    const rights = await evaluateAccess(b.assetId, b.geo);
    if (!rights.allowed) {
      if (rights.replacementAssetId) {
        const tok = mintPlaybackToken({ accountId: key.account_id, appId: key.app_id, assetId: rights.replacementAssetId, geo: b.geo });
        return res.json({ available: true, mode: 'replacement', assetId: rights.replacementAssetId, reason: rights.reason, playbackToken: tok.token, expiresIn: tok.expiresIn });
      }
      return res.status(451).json({ available: false, mode: 'blocked', reason: rights.reason });
    }
    const tok = mintPlaybackToken({ accountId: key.account_id, appId: key.app_id, assetId: b.assetId, geo: b.geo });
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
    const rights = await evaluateAccess(b.assetId, b.geo);
    const reasons = [reason, rights.allowed ? null : rights.reason].filter(Boolean);
    res.json({ allowed: !reason && rights.allowed, assetId: b.assetId, reasons, replacementAssetId: rights.replacementAssetId ?? null });
  })
);
