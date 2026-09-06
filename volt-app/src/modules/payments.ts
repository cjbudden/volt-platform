/**
 * Payments and entitlements.
 *
 *   MANAGEMENT (JWT, admin)
 *     GET/PUT  /api/payments/providers[/:provider]   the client's connected providers
 *     GET      /api/payments/products                 the products behind premium terms
 *     PATCH    /api/payments/products/:id             provider ids (Stripe price, App Store id, Play SKU), enabled
 *     GET      /api/payments/viewers/:externalId      a viewer's purchases and entitlements
 *     POST     /api/payments/grants                   grant by hand (a comp, a fix)
 *     POST     /api/payments/manual                   record a payment taken elsewhere
 *
 *   APP (publishable key)
 *     POST     /api/payments/verify                   the app hands over a receipt / token / session
 *
 *   PROVIDER (unauthenticated; verified by signature)
 *     POST     /api/payments/webhooks/:provider/:accountId
 *
 *  Nothing is granted on an unverified event: it is recorded as pending and
 *  becomes an entitlement only when a verified event for the same transaction
 *  arrives. See services/payments/providers.ts for what is verified today.
 */
import { Router, raw as rawBody } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole } from '../auth/roles';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { verifyKey } from '../services/apiKeys';
import { PROVIDERS, type ProviderName } from '../services/payments/providers';
import { recordPurchase, grantManually, upsertViewer, viewerEntitlements } from '../services/entitlements';

const PROVIDER_NAMES = ['stripe', 'appstore', 'googleplay', 'manual'] as const;

async function providerConfig(account: string, provider: ProviderName) {
  const row = await one<any>(`SELECT * FROM payment_providers WHERE account_id = $1 AND provider = $2`, [account, provider]);
  // The secret lives in the secrets store under secret_ref; the environment is
  // the local stand-in (PAYMENTS_<PROVIDER>_SECRET_<accountid-without-dashes>).
  const envKey = `PAYMENTS_${provider.toUpperCase()}_SECRET_${account.replace(/-/g, '')}`;
  return { row, cfg: { config: row?.config ?? {}, secret: process.env[envKey] ?? process.env[`PAYMENTS_${provider.toUpperCase()}_SECRET`] ?? null } };
}

async function applyEvents(account: string, parsed: { events: any[]; verified: boolean; note?: string }) {
  const out: any[] = [];
  for (const ev of parsed.events) {
    // Unverified paid events are recorded pending: the money is not trusted yet.
    const e = parsed.verified || ev.provider === 'manual' ? ev : { ...ev, status: ev.status === 'paid' ? 'pending' : ev.status };
    try { out.push(await recordPurchase(account, e)); }
    catch (err: any) { out.push({ error: err.message, event: { provider: ev.provider, txn: ev.providerTxnId, product: ev.providerProductId } }); }
  }
  return out;
}

// ---- management ------------------------------------------------------------------
export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);
paymentsRouter.use(requireMinRole('admin'));

paymentsRouter.get('/providers', asyncHandler(async (req, res) => {
  const rows = await query<any>(`SELECT id, provider, config, enabled, secret_ref IS NOT NULL AS has_secret, updated_at FROM payment_providers WHERE account_id = $1 ORDER BY provider`, [accountId(req)]);
  res.json({ providers: rows, available: PROVIDER_NAMES, webhookBase: `/api/payments/webhooks/{provider}/${accountId(req)}` });
}));

paymentsRouter.put('/providers/:provider', asyncHandler(async (req, res) => {
  const provider = req.params.provider as ProviderName;
  if (!PROVIDER_NAMES.includes(provider)) throw badRequest('unknown provider');
  const b = z.object({ config: z.record(z.any()).default({}), secretRef: z.string().nullable().optional(), enabled: z.boolean().default(true) }).parse(req.body ?? {});
  const row = await one<any>(
    `INSERT INTO payment_providers(account_id, provider, config, secret_ref, enabled)
     VALUES ($1,$2,$3::jsonb,$4,$5)
     ON CONFLICT (account_id, provider) DO UPDATE SET config = EXCLUDED.config, secret_ref = COALESCE(EXCLUDED.secret_ref, payment_providers.secret_ref), enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING id, provider, config, enabled, secret_ref IS NOT NULL AS has_secret`,
    [accountId(req), provider, JSON.stringify(b.config), b.secretRef ?? null, b.enabled]);
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'payment_provider', entityId: row.id, snapshot: { provider, enabled: b.enabled } }).catch(() => {});
  res.json(row);
}));

paymentsRouter.get('/products', asyncHandler(async (req, res) => {
  res.json(await query(`SELECT * FROM products WHERE account_id = $1 ORDER BY name`, [accountId(req)]));
}));

paymentsRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  const b = z.object({ providerIds: z.record(z.string()).optional(), enabled: z.boolean().optional(), name: z.string().min(1).optional() }).parse(req.body ?? {});
  const row = await one<any>(
    `UPDATE products SET provider_ids = COALESCE($3::jsonb, provider_ids), enabled = COALESCE($4, enabled), name = COALESCE($5, name), updated_at = now()
      WHERE id = $1 AND account_id = $2 RETURNING *`,
    [req.params.id, accountId(req), b.providerIds ? JSON.stringify(b.providerIds) : null, b.enabled ?? null, b.name ?? null]);
  if (!row) throw notFound('Product not found');
  res.json(row);
}));

paymentsRouter.get('/viewers/:externalId', asyncHandler(async (req, res) => {
  const v = await one<any>(`SELECT * FROM viewers WHERE account_id = $1 AND external_id = $2`, [accountId(req), req.params.externalId]);
  if (!v) throw notFound('Viewer not found');
  const purchases = await query(`SELECT p.*, pr.name AS product_name, pr.key AS product_key FROM purchases p JOIN products pr ON pr.id = p.product_id WHERE p.viewer_id = $1 ORDER BY p.purchased_at DESC`, [v.id]);
  const ents = await query(`SELECT e.*, pr.name AS product_name FROM entitlements e LEFT JOIN products pr ON pr.id = e.product_id WHERE e.viewer_id = $1 ORDER BY e.valid_from DESC`, [v.id]);
  res.json({ viewer: v, purchases, entitlements: ents, active: await viewerEntitlements(v.id) });
}));

paymentsRouter.post('/grants', asyncHandler(async (req, res) => {
  const b = z.object({ viewerExternalId: z.string().min(1), productKey: z.string().min(1), validUntil: z.string().datetime().nullable().optional() }).parse(req.body ?? {});
  const who = actor(req);
  const e = await grantManually(accountId(req), b.viewerExternalId, b.productKey, who.label, b.validUntil ? new Date(b.validUntil) : null);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'create', entityType: 'entitlement', entityId: e.id, snapshot: b }).catch(() => {});
  res.status(201).json(e);
}));

paymentsRouter.post('/manual', asyncHandler(async (req, res) => {
  const parsed = await PROVIDERS.manual.verifyReceipt({ ...req.body, reference: req.body?.reference }, { config: {} });
  if (!parsed.events.length) throw badRequest('viewerExternalId and productKey are required');
  const who = actor(req);
  const out = await applyEvents(accountId(req), parsed);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'create', entityType: 'purchase', entityId: out[0]?.purchase?.id ?? 'n/a', snapshot: req.body }).catch(() => {});
  res.status(201).json(out[0]);
}));

// ---- the app: verify what it holds ---------------------------------------------------
export const paymentsAppRouter = Router();
paymentsAppRouter.post('/verify', asyncHandler(async (req, res) => {
  const b = z.object({ appKey: z.string().min(8), provider: z.enum(['stripe', 'appstore', 'googleplay']), payload: z.record(z.any()) }).parse(req.body ?? {});
  const key = await verifyKey(b.appKey);
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
  const { cfg } = await providerConfig(key.account_id, b.provider);
  const parsed = await PROVIDERS[b.provider].verifyReceipt(b.payload, cfg);
  const out = await applyEvents(key.account_id, parsed);
  const viewerId = b.payload.viewerExternalId ? (await upsertViewer(key.account_id, String(b.payload.viewerExternalId))).id : null;
  res.json({ verified: parsed.verified, note: parsed.note, results: out.map((r) => r.error ? { error: r.error } : { purchase: r.purchase?.status, entitlement: !!r.entitlement }),
    entitlements: viewerId ? await viewerEntitlements(viewerId) : [] });
}));

// ---- providers calling us -------------------------------------------------------------
export const paymentsWebhookRouter = Router();
// Raw body: signatures are computed over the exact bytes.
paymentsWebhookRouter.post('/:provider/:accountId', rawBody({ type: '*/*', limit: '1mb' }), asyncHandler(async (req, res) => {
  const provider = req.params.provider as ProviderName;
  if (!PROVIDER_NAMES.includes(provider) || provider === 'manual') throw notFound('unknown provider');
  const account = req.params.accountId;
  const { row, cfg } = await providerConfig(account, provider);
  if (!row || !row.enabled) throw notFound('provider not connected for this account');
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  let parsed;
  try { parsed = PROVIDERS[provider].parseWebhook(req.body as Buffer, headers, cfg); }
  catch (e: any) { throw badRequest(`could not parse ${provider} webhook: ${e.message}`); }
  const out = await applyEvents(account, parsed);
  console.log(`[payments] ${provider} webhook for ${account}: ${parsed.events.length} event(s), verified=${parsed.verified}${parsed.note ? ` (${parsed.note})` : ''}`);
  // Providers retry on non-2xx: answer 200 once the message was understood,
  // whatever it did to our state.
  res.json({ received: parsed.events.length, verified: parsed.verified, note: parsed.note, results: out.map((r) => r.error ? { error: r.error } : { status: r.purchase?.status }) });
}));
