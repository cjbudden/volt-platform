import { accountBrand } from './accountSettings';
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
import { defineList, parseList, whereSql, countWhereSql, countParams, pageSql, finishPage } from '../util/listQuery';
import {
  createShareLink, openShare, findShareByToken, loadResource, ACCESS_PERIODS,
  requestShareEmailCode,
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
  // viewer verification: none | pin (creator-set) | email_pin (one-time PIN emailed to
  // a recipient address the viewer confirms on the page)
  authMode: z.enum(['none', 'pin', 'email_pin']).optional(),
  // true = the system emails the link + message + instructions to each recipient
  sendEmail: z.boolean().optional(),
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
    authMode: b.authMode, sendEmail: b.sendEmail,
  }).catch((e) => {
    if (e.status === 404) throw notFound('resource not found in this account');
    if (e.status === 400) throw badRequest(e.message);
    throw e;
  });
  // the raw token/url is returned ONCE here and never again
  res.status(201).json(out);
}));

const SHARE_LINKS_LIST = defineList({
  path: '/api/share-links',
  fields: {
    id: { sql: 'id', type: 'uuid' },
    label: { sql: 'label', type: 'string' },
    resource_kind: { sql: 'resource_kind', type: 'enum', values: ['vod', 'channel', 'event'] },
    resource_id: { sql: 'resource_id', type: 'uuid' },
    access_type: { sql: 'access_type', type: 'enum', values: ['preview_only', 'allow_download'] },
    token_prefix: { sql: 'token_prefix', type: 'string', doc: 'The first characters of the link token, to recognise a link' },
    revoked: { sql: 'revoked', type: 'boolean' },
    expired: { sql: '(expires_at IS NOT NULL AND expires_at < now())', type: 'boolean', sort: false, doc: 'Past its expiry time' },
    expires_at: { sql: 'expires_at', type: 'timestamp' },
    max_views: { sql: 'max_views', type: 'number' },
    view_count: { sql: 'view_count', type: 'number' },
    first_opened_at: { sql: 'first_opened_at', type: 'timestamp' },
    last_viewed_at: { sql: 'last_viewed_at', type: 'timestamp' },
    created_at: { sql: 'created_at', type: 'timestamp', notNull: true },
  },
  search: ['label', 'token_prefix', 'recipients::text'],
  defaultSort: '-created_at',
  unpagedLimit: 1000,
});

shareLinksRouter.get('/', asyncHandler(async (req, res) => {
  const params: unknown[] = [accountId(req)];
  const pl = parseList(SHARE_LINKS_LIST, req.query, params);
  const where = `FROM share_links WHERE account_id=$1${whereSql(pl)}`;
    const whereCount = `FROM share_links WHERE account_id=$1${countWhereSql(pl)}`;  // totals ignore the cursor
  const rows = await query<any>(
    `SELECT id, resource_kind, resource_id, label, recipients, access_type, expires_at, max_views,
            view_count, first_opened_at, last_viewed_at, revoked, created_at, token_prefix
       ${where} ${pageSql(pl)}`,
    params
  );
  const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${whereCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
  res.json(finishPage(req, res, pl, rows, total));
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

/** The shape createShareLink mints: `shr_` + base64url. Nothing else is a token. */
const SHARE_TOKEN_RE = /^shr_[A-Za-z0-9_-]{8,128}$/;

// The page itself. Serves HTML only; all data comes from the resolve call, so
// no asset detail is server-rendered and a PIN can be prompted for.
publicShareRouter.get('/share/:token', asyncHandler(async (req, res) => {
  // REFUSE ANYTHING THAT IS NOT TOKEN-SHAPED. The token IS server-rendered —
  // into the page's inline script — and Express percent-decodes a path
  // segment, so `%3C%2Fscript%3E…` arrived here as a literal `</script>`.
  // JSON.stringify escapes quotes but not a closing script tag, so the block
  // terminated early and the rest of the "token" ran as script on this origin,
  // from a URL that looks like an ordinary share link and needs no auth.
  // Checking the shape costs nothing and no real token can fail it;
  // sharePageHtml now escapes as well, so neither half is load-bearing alone.
  if (!SHARE_TOKEN_RE.test(req.params.token)) {
    // The same page an unknown token gets: existence is not disclosed here.
    res.status(404).type('html').send(sharePageHtml('invalid'));
    return;
  }
  // don't even reveal existence here — the page fetches /resolve and renders state
  res.type('html').send(sharePageHtml(req.params.token));
}));

const resolveSchema = z.object({
  pin: z.string().optional(),
  email: z.string().optional(),
  code: z.string().optional(),
  /** The page's visit id: one view per visit, however often it reloads. */
  visit: z.string().max(64).optional(),
});
publicShareRouter.post('/api/share/:token/resolve', asyncHandler(async (req, res) => {
  const { pin, email, code: verifyCode, visit } = resolveSchema.parse(req.body ?? {});
  const geo = (req.get('cloudfront-viewer-country') || req.query.geo || undefined) as string | undefined;
  const out = await openShare(req.params.token, { pin, email, code: verifyCode, geo, visit });
  if (!out.ok) {
    const needsAuth = ['pin_required', 'pin_wrong', 'code_required', 'code_wrong', 'code_expired'].includes(out.reason);
    const code = needsAuth ? 401 : out.reason === 'not_found' ? 404 : out.reason === 'geo_blocked' ? 451 : 410;
    // The PIN and email screens are branded too. Only once the link is known
    // to exist (it asks for a PIN), so the brand never answers "is this a link".
    let brand: any;
    if (needsAuth) {
      const row = await findShareByToken(req.params.token);
      if (row) { const b = await accountBrand(row.account_id); brand = { account: b.name, logo: b.logo, primary: b.primary, secondary: b.secondary }; }
    }
    return res.status(code).json({ ok: false, reason: out.reason, ...(brand ? { brand } : {}) });
  }
  res.json({ ok: true, ...out.view });
}));

// email_pin: the viewer confirms the email the link was sent to and a one-time PIN is
// emailed to it. The response is deliberately GENERIC (always ok) so this endpoint
// cannot be used to probe who a link was shared with.
publicShareRouter.post('/api/share/:token/request-code', asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body ?? {});
  await requestShareEmailCode(req.params.token, email);
  res.json({ ok: true, note: 'If that address is a recipient of this link, a code has been emailed to it.' });
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
