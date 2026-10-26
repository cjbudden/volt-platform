// ============================================================================
//  SOCIAL PUBLISHING API. See services/social.
//
//   GET    /api/social/platforms              which platforms are set up, limits, callback URLs
//   GET    /api/social/accounts               linked accounts (publish targets) with status
//   POST   /api/social/connect/:platform      -> { url } to send the browser to
//   GET    /api/social/callback/:platform     PUBLIC: the platform sends the browser back here
//   POST   /api/social/sandbox/:platform      add a sandbox account
//   POST   /api/social/publish/:assetId       publish to accounts, one post each
//   GET    /api/social/publications?assetId=  where an asset went, with progress
//   POST   /api/social/publications/:id/retry retry (optionally with an edited post)
//   POST   /api/social/publications/:id/remove take it down on the platform
//   POST   /api/social/sync-views             pull view counts now
//   GET    /social-sandbox/:id                PUBLIC: what a sandbox post "looks like"
//   GET    /api/social/x                      whether X is on for the account, and how
//   PATCH  /api/social/x                      {enabled}: the platform switch (system administrators)
//   PUT    /api/social/x/app                  {clientId, clientSecret}: the account's own X app
//   DELETE /api/social/x/app                  forget the account's own X app
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound, conflict, forbidden } from '../util/http';
import { can } from '../auth/roles';
import { actorLabel } from '../util/actor';
import {
  PLATFORMS, PLATFORM_IDS, SocialError, platformStatus, startConnect, finishConnect, addSandbox,
  fitPost, defaultPost, queueSocialPublication, syncViews, removeFromPlatform, type PlatformId,
  xAccess, setOwnXApp, callbackUrl, X_OFF,
} from '../services/social';
import { planEditor } from '../services/plan';
import { actor, writeAudit } from '../services/audit';
import { publish, NotPublishable } from '../services/availability';
import { seesServerSetup } from '../services/serverSetup';

export const socialRouter = Router();
export const socialPublicRouter = Router();

const platformParam = (p: string): PlatformId => {
  if (!(PLATFORM_IDS as string[]).includes(p)) throw notFound('Unknown platform');
  return p as PlatformId;
};
const UUID = /^[0-9a-f-]{36}$/i;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---------------------------------------------------------------- public: OAuth return + sandbox page

socialPublicRouter.get('/api/social/callback/:platform', asyncHandler(async (req, res) => {
  const platform = platformParam(req.params.platform);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const error = typeof req.query.error_description === 'string' ? req.query.error_description : typeof req.query.error === 'string' ? req.query.error : null;
  const r = state ? await finishConnect(platform, state, code, error) : { accountId: null, linked: [], error: 'The platform returned without a state.' };
  const q = new URLSearchParams({ platform });
  if (r.linked.length) q.set('linked', r.linked.join(', '));
  if (r.error) q.set('error', r.error);
  // Back to the console's Social accounts page, which reads these and says what happened.
  res.redirect(302, `/social?${q}`);
}));

socialPublicRouter.get('/social-sandbox/:id', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.id)) throw notFound('Not found');
  const r = await one<any>(
    `SELECT p.post, p.views, p.published_at, p.platform, t.account_label, t.mode, v.title, v.export_mp4_key, v.master_key, v.progressive_key
       FROM publications p JOIN publish_targets t ON t.id = p.target_id JOIN vod_assets v ON v.id = p.vod_asset_id
      WHERE p.id = $1 AND t.mode = 'sandbox' AND p.status = 'published'`, [req.params.id]);
  if (!r) throw notFound('Not found');
  const label = PLATFORMS[r.platform as PlatformId]?.label ?? r.platform;
  const src = r.export_mp4_key ?? r.progressive_key ?? null;
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox post · ${esc(label)}</title><style>body{margin:0;background:#0f1218;color:#e9ecf4;font:15px/1.5 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px}
.tag{display:inline-block;border:1px solid rgba(255,255,255,.2);border-radius:20px;padding:1px 10px;font-size:12px;color:#98a1b6}h1{font-size:20px;margin:12px 0 4px}
p{white-space:pre-wrap;color:#c8cede}video{width:100%;border-radius:8px;background:#000;margin-top:12px}small{color:#6a7387}</style></head><body><main>
<span class="tag">Sandbox ${esc(label)} post: nothing was sent to ${esc(label)}</span>
<h1>${esc(r.post?.title || r.title)}</h1><small>${esc(r.account_label)} · ${esc(new Date(r.published_at).toUTCString())} · ${esc(r.views)} views · ${esc(r.post?.privacy ?? 'public')}</small>
${src ? `<video controls src="${esc(src)}"></video>` : ''}
<p>${esc(r.post?.description ?? '')}</p>${(r.post?.tags ?? []).length ? `<small>Tags: ${esc(r.post.tags.join(', '))}</small>` : ''}
</main></body></html>`);
}));

// ---------------------------------------------------------------- authed

socialRouter.use(requireAuth);

/** Linking and unlinking accounts is an admin's job, as publish targets always were. */
function requireAdmin(req: any) {
  // Linking accounts holds publishing credentials: account settings, manage.
  if (!can(req, 'settings', 'manage')) throw forbidden('Linking social accounts needs manage on account settings');
}

socialRouter.get('/platforms', asyncHandler(async (req, res) => { res.json(platformStatus(seesServerSetup(req), await xAccess(accountId(req)))); }));

/** Refuse X outright for an account it is off for: 403, with how it gets switched on. */
async function assertX(platform: PlatformId, acct: string) {
  if (platform === 'x' && !(await xAccess(acct)).allowed) throw forbidden(X_OFF);
}

// ---------------------------------------------------------------- X access (build queue 1.14h)

async function xView(req: any) {
  const x = await xAccess(accountId(req));
  const ed = await planEditor(req);
  return {
    enabled: x.switchOn, allowed: x.allowed,
    // Never the secret: only that one is held.
    ownApp: x.ownApp ? { clientId: x.ownApp.clientId, hasSecret: true, updatedAt: x.ownApp.updatedAt } : null,
    canSwitch: ed.ok, switchReason: ed.ok ? null : 'X is switched on by your Volt provider. Or add your own X developer app below, and X bills you directly.',
    callbackUrl: callbackUrl('x'),
  };
}

socialRouter.get('/x', asyncHandler(async (req, res) => { res.json(await xView(req)); }));

socialRouter.patch('/x', asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
  const ed = await planEditor(req);
  if (!ed.ok) throw forbidden('Only a system administrator switches X on or off for an account');
  const acct = accountId(req);
  const before = await xAccess(acct);
  await query(`UPDATE accounts SET x_enabled = $2, updated_at = now() WHERE id = $1`, [acct, b.enabled]);
  if (before.switchOn !== b.enabled) {
    const who = actor(req);
    await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'social_x', entityId: acct,
      changes: { x_enabled: { from: before.switchOn, to: b.enabled } } });
  }
  res.json(await xView(req));
}));

socialRouter.put('/x/app', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const b = z.object({ clientId: z.string().trim().min(4).max(200), clientSecret: z.string().trim().min(4).max(400) }).parse(req.body ?? {});
  const acct = accountId(req);
  const before = await xAccess(acct);
  await setOwnXApp(acct, b);
  const who = actor(req);
  // The audit names the client id, never the secret.
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: before.ownApp ? 'update' : 'create', entityType: 'social_x_app', entityId: acct,
    changes: { client_id: { from: before.ownApp?.clientId ?? null, to: b.clientId } } });
  res.json(await xView(req));
}));

socialRouter.delete('/x/app', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const acct = accountId(req);
  const before = await xAccess(acct);
  if (before.ownApp) {
    await setOwnXApp(acct, null);
    const who = actor(req);
    await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'delete', entityType: 'social_x_app', entityId: acct,
      changes: { client_id: { from: before.ownApp.clientId, to: null } } });
  }
  res.json(await xView(req));
}));

socialRouter.get('/accounts', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT t.id, t.platform, t.name, t.external_account, t.enabled, t.mode, t.account_label, t.avatar_url, t.link_status, t.link_detail,
            t.token_expires_at, t.linked_at, u.email AS linked_by_email,
            (SELECT count(*)::int FROM publications p WHERE p.target_id = t.id AND p.status = 'published') AS published,
            (SELECT max(p.published_at) FROM publications p WHERE p.target_id = t.id) AS last_published_at
       FROM publish_targets t LEFT JOIN users u ON u.id = t.linked_by
      WHERE t.account_id = $1 ORDER BY t.platform, t.mode, lower(coalesce(t.account_label, t.name))`, [accountId(req)]);
  // Linked X accounts are kept while X is off, and listed as off.
  const xOn = rows.some((r) => r.platform === 'x') ? (await xAccess(accountId(req))).allowed : true;
  res.json(rows.map((r) => ({ ...r, off: r.platform === 'x' && !xOn })));
}));

socialRouter.post('/connect/:platform', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const platform = platformParam(req.params.platform);
  await assertX(platform, accountId(req));
  try { res.json({ url: await startConnect(platform, accountId(req), req.auth?.sub && UUID.test(req.auth.sub) ? req.auth.sub : null) }); }
  catch (e: any) { if (e instanceof SocialError) throw badRequest(e.message); throw e; }
}));

socialRouter.post('/sandbox/:platform', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const platform = platformParam(req.params.platform);
  await assertX(platform, accountId(req));
  const b = z.object({ label: z.string().max(80).optional() }).parse(req.body ?? {});
  const row = await addSandbox(accountId(req), req.auth?.sub && UUID.test(req.auth.sub) ? req.auth.sub : null, platform, b.label);
  res.status(201).json({ id: row.id, platform: row.platform, name: row.name, mode: row.mode, account_label: row.account_label });
}));

async function ownedAsset(assetId: string, acct: string) {
  return one<any>(
    `SELECT v.* FROM vod_assets v LEFT JOIN channels c ON c.id=v.channel_id LEFT JOIN events e ON e.id=v.event_id
       LEFT JOIN groups g ON g.id=COALESCE(c.group_id,e.group_id) WHERE v.id=$1 AND COALESCE(g.account_id, v.account_id)=$2`, [assetId, acct]);
}

const postSchema = z.object({
  title: z.string().max(5000).optional(),
  description: z.string().max(10000).optional(),
  tags: z.array(z.string().max(100)).max(60).optional(),
  privacy: z.enum(['public', 'unlisted', 'private']).optional(),
});

/** The posts an asset would get, per linked account, for the composer to start from. */
socialRouter.get('/publish/:assetId/defaults', asyncHandler(async (req, res) => {
  const asset = await ownedAsset(req.params.assetId, accountId(req));
  if (!asset) throw notFound('Asset not found');
  const out: Record<string, any> = {};
  for (const id of PLATFORM_IDS) out[id] = defaultPost(asset, id);
  res.json(out);
}));

socialRouter.post('/publish/:assetId', asyncHandler(async (req, res) => {
  const b = z.object({ targets: z.array(z.object({ targetId: z.string().uuid(), post: postSchema })).min(1).max(20) }).parse(req.body ?? {});
  const acct = accountId(req);
  const asset = await ownedAsset(req.params.assetId, acct);
  if (!asset) throw notFound('Asset not found');
  const targets = await query<any>(`SELECT id, platform, enabled, link_status, account_label, name FROM publish_targets WHERE account_id=$1 AND id = ANY($2::uuid[])`,
    [acct, b.targets.map((t) => t.targetId)]);
  if (targets.length !== new Set(b.targets.map((t) => t.targetId)).size) throw badRequest('One of the accounts is not linked to this Volt account');
  const problems: string[] = [];
  const posts: Record<string, any> = {};
  const xOn = targets.some((t) => t.platform === 'x') ? (await xAccess(acct)).allowed : true;
  for (const t of b.targets) {
    const row = targets.find((x) => x.id === t.targetId)!;
    if (row.platform === 'x' && !xOn) problems.push(`${row.account_label ?? row.name}: ${X_OFF}`);
    if (!row.enabled) problems.push(`${row.account_label ?? row.name} is disabled`);
    if (row.link_status === 'expired') problems.push(`${row.account_label ?? row.name}: access expired, connect it again`);
    const fit = fitPost(row.platform, t.post);
    problems.push(...fit.problems.map((p) => `${row.account_label ?? row.name}: ${p}`));
    posts[t.targetId] = fit.post;
  }
  if (problems.length) return res.status(422).json({ error: problems.join('. '), problems });
  try {
    const out = await publish(asset.id, await actorLabel(req), {
      targets: targets.map((t) => ({ kind: 'social' as const, targetId: t.id, platform: t.platform })), posts,
    });
    res.status(201).json({ publications: out.publications });
  } catch (e: any) {
    if (e instanceof NotPublishable) throw badRequest(e.message);
    throw e;
  }
}));

socialRouter.get('/publications', asyncHandler(async (req, res) => {
  const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : '';
  if (!assetId || !(await ownedAsset(assetId, accountId(req)))) throw notFound('Asset not found');
  res.json(await query(
    `SELECT p.id, p.platform, p.status, p.external_id, p.external_url, p.views, p.error, p.published_at, p.last_synced_at, p.created_at,
            p.post, p.progress, p.stage, p.attempts, p.stale, p.target_id, t.account_label,
            COALESCE(t.name, 'Disconnected account') AS target_name, COALESCE(t.mode, 'live') AS mode, t.avatar_url
       FROM publications p LEFT JOIN publish_targets t ON t.id = p.target_id
      WHERE p.vod_asset_id = $1 AND p.platform NOT IN ('portal', 'app') ORDER BY p.created_at DESC`, [assetId]));
}));

async function ownedPublication(id: string, acct: string) {
  return one<any>(`SELECT p.*, t.platform AS target_platform FROM publications p JOIN publish_targets t ON t.id = p.target_id WHERE p.id = $1 AND t.account_id = $2`, [id, acct]);
}

socialRouter.post('/publications/:id/retry', asyncHandler(async (req, res) => {
  const pub = await ownedPublication(req.params.id, accountId(req));
  if (!pub) throw notFound('Publication not found');
  await assertX(pub.target_platform, accountId(req));
  if (pub.status === 'published') throw conflict('This is already published');
  if (pub.status === 'pending' && pub.stage && pub.stage !== 'will retry') throw conflict('This is still being published');
  const b = z.object({ post: postSchema.optional() }).parse(req.body ?? {});
  if (b.post) {
    const fit = fitPost(pub.target_platform, { ...(pub.post ?? {}), ...b.post });
    if (fit.problems.length) return res.status(422).json({ error: fit.problems.join('. '), problems: fit.problems });
    await query(`UPDATE publications SET post = $2::jsonb WHERE id = $1`, [pub.id, JSON.stringify(fit.post)]);
  }
  await queueSocialPublication(pub.id);
  res.json(await one(`SELECT id, status, progress, stage, post FROM publications WHERE id = $1`, [pub.id]));
}));

socialRouter.post('/publications/:id/remove', asyncHandler(async (req, res) => {
  const pub = await ownedPublication(req.params.id, accountId(req));
  if (!pub) throw notFound('Publication not found');
  try { await removeFromPlatform(pub.id); } catch (e: any) { if (e instanceof SocialError) throw badRequest(e.message); throw e; }
  res.json({ removed: true });
}));

socialRouter.post('/sync-views', asyncHandler(async (req, res) => {
  res.json({ synced: await syncViews({ accountId: accountId(req), force: true }) });
}));

void config;
