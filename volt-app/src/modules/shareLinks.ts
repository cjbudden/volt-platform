/**
 * Share links.
 *
 *  Admin (JWT / account key, account-scoped):
 *    POST   /api/share-links            create a link (returns the one-time URL)
 *    GET    /api/share-links            list this account's links
 *    GET    /api/share-links/:id        one link (with view stats)
 *    POST   /api/share-links/:id/revoke kill a link immediately
 *
 *  Public (NO auth, single resource only):
 *    GET    /share/:token               the standalone recipient page (HTML)
 *    POST   /api/share/:token/resolve   view model + playback token (+ optional PIN)
 *    GET    /api/share/:token/download/:element  a gated download (hi_res|metadata)
 *
 * The public surface never accepts an admin credential and never exposes any other
 * resource, so a leaked link reaches exactly one asset.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound } from '../util/http';
import {
  createShareLink, openShare, findShareByToken, loadResource, ACCESS_PERIODS,
  type ShareResourceKind,
} from '../services/shareLinks';
import { config } from '../config';
import { sharePageHtml } from './sharePage';

// ---------- admin (account-scoped) ------------------------------------------
export const shareLinksRouter = Router();
shareLinksRouter.use(requireAuth);

const createSchema = z.object({
  resourceKind: z.enum(['vod', 'channel', 'event']),
  resourceId: z.string().uuid(),
  // accept either a named period (matches the modal dropdown) or an explicit ttl
  accessPeriod: z.string().optional(),
  ttlSec: z.number().int().positive().max(90 * 86400).optional(),
  label: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
  recipients: z.array(z.string().email()).max(50).optional(),
  accessType: z.enum(['preview_only', 'allow_download']).default('preview_only'),
  allowHiRes: z.boolean().optional(),
  allowPlayer: z.boolean().optional(),
  allowMetadata: z.boolean().optional(),
  watermark: z.boolean().optional(),
  notifyOnOpen: z.boolean().optional(),
  pin: z.string().min(3).max(32).optional(),
  maxViews: z.number().int().positive().max(100000).nullable().optional(),
});

shareLinksRouter.post('/', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const ttlSec = b.ttlSec ?? (b.accessPeriod ? ACCESS_PERIODS[b.accessPeriod] : undefined) ?? ACCESS_PERIODS['7 days'];
  // session auth carries the user id in sub; account-key auth uses 'apikey:<id>' (no user)
  const sub = (req as any).auth?.sub as string | undefined;
  const createdBy = sub && !sub.startsWith('apikey:') ? sub : null;
  const out = await createShareLink({
    accountId: accountId(req), createdBy,
    resourceKind: b.resourceKind as ShareResourceKind, resourceId: b.resourceId,
    ttlSec, label: b.label, message: b.message, recipients: b.recipients,
    accessType: b.accessType, allowHiRes: b.allowHiRes, allowPlayer: b.allowPlayer, allowMetadata: b.allowMetadata,
    watermark: b.watermark, notifyOnOpen: b.notifyOnOpen, pin: b.pin, maxViews: b.maxViews ?? null,
  }).catch((e) => { if (e.status === 404) throw notFound('resource not found in this account'); throw e; });
  // the raw token/url is returned ONCE here and never again
  res.status(201).json(out);
}));

shareLinksRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT id, resource_kind, resource_id, label, recipients, access_type, expires_at, max_views,
            view_count, first_opened_at, last_viewed_at, revoked, created_at, token_prefix
       FROM share_links WHERE account_id=$1 ORDER BY created_at DESC`,
    [accountId(req)]
  );
  res.json(rows);
}));

shareLinksRouter.get('/:id', asyncHandler(async (req, res) => {
  const row = await one<any>(`SELECT * FROM share_links WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!row) throw notFound('share link');
  delete row.token_hash; delete row.pin_hash;
  res.json(row);
}));

shareLinksRouter.post('/:id/revoke', asyncHandler(async (req, res) => {
  const row = await one<any>(`UPDATE share_links SET revoked=true WHERE id=$1 AND account_id=$2 RETURNING id, revoked`, [req.params.id, accountId(req)]);
  if (!row) throw notFound('share link');
  res.json(row);
}));

// ---------- public standalone page + resolve (NO admin auth) ----------------
export const publicShareRouter = Router();

// The page itself. Serves HTML only; all data comes from the resolve call so the
// token is never embedded in server-rendered content and a PIN can be prompted.
publicShareRouter.get('/share/:token', asyncHandler(async (req, res) => {
  // don't even reveal existence here — the page fetches /resolve and renders state
  res.type('html').send(sharePageHtml(req.params.token));
}));

const resolveSchema = z.object({ pin: z.string().optional() });
publicShareRouter.post('/api/share/:token/resolve', asyncHandler(async (req, res) => {
  const { pin } = resolveSchema.parse(req.body ?? {});
  const geo = (req.get('cloudfront-viewer-country') || req.query.geo || undefined) as string | undefined;
  const out = await openShare(req.params.token, { pin, geo });
  if (!out.ok) {
    const code = out.reason === 'pin_required' || out.reason === 'pin_wrong' ? 401 : out.reason === 'not_found' ? 404 : 410;
    return res.status(code).json({ ok: false, reason: out.reason });
  }
  res.json({ ok: true, ...out.view });
}));

// Gated download. Only when the link allows it; returns a short-lived URL. Real S3
// presign is wired in the deployed env; locally we hand back the origin path so the
// contract + gating are exercised.
publicShareRouter.get('/api/share/:token/download/:element', asyncHandler(async (req, res) => {
  const el = req.params.element;
  if (el !== 'hi_res' && el !== 'metadata') throw badRequest('unknown element');
  const row = await findShareByToken(req.params.token);
  if (!row) throw notFound('share');
  const out = await openShare(req.params.token, { geo: undefined });
  if (!out.ok) return res.status(410).json({ ok: false, reason: out.reason });
  if (row.access_type !== 'allow_download') throw badRequest('download not permitted for this link');
  if (el === 'hi_res' && !row.allow_hi_res) throw badRequest('hi-res download not permitted');
  if (el === 'metadata' && !row.allow_metadata) throw badRequest('metadata download not permitted');
  const resource = await loadResource(row.resource_kind, row.resource_id, row.account_id);
  if (!resource) throw notFound('resource');
  if (el === 'metadata') {
    res.type('application/json').set('content-disposition', `attachment; filename="${resource.id}-metadata.json"`);
    return res.send(JSON.stringify({ title: resource.title, kind: resource.kind, durationMs: resource.durationMs, metadata: resource.metadata }, null, 2));
  }
  // hi_res: a presigned URL to the mezzanine/original in the deployed env
  const url = `${config.aws.cdnBaseUrl.replace(/\/$/, '')}/${(resource.masterKey ?? `${resource.kind}/${resource.id}`).replace(/^\//, '')}/hi-res.mp4`;
  res.json({ url, expiresIn: 300, note: 'presigned in deployed env' });
}));
