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
} from '../services/social';
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

socialRouter.get('/platforms', asyncHandler(async (req, res) => { res.json(platformStatus(seesServerSetup(req))); }));

socialRouter.get('/accounts', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT t.id, t.platform, t.name, t.external_account, t.enabled, t.mode, t.account_label, t.avatar_url, t.link_status, t.link_detail,
            t.token_expires_at, t.linked_at, u.email AS linked_by_email,
            (SELECT count(*)::int FROM publications p WHERE p.target_id = t.id AND p.status = 'published') AS published,
            (SELECT max(p.published_at) FROM publications p WHERE p.target_id = t.id) AS last_published_at
       FROM publish_targets t LEFT JOIN users u ON u.id = t.linked_by
      WHERE t.account_id = $1 ORDER BY t.platform, t.mode, lower(coalesce(t.account_label, t.name))`, [accountId(req)]);
  res.json(rows);
}));

socialRouter.post('/connect/:platform', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const platform = platformParam(req.params.platform);
  try { res.json({ url: await startConnect(platform, accountId(req), req.auth?.sub && UUID.test(req.auth.sub) ? req.auth.sub : null) }); }
  catch (e: any) { if (e instanceof SocialError) throw badRequest(e.message); throw e; }
}));

socialRouter.post('/sandbox/:platform', asyncHandler(async (req, res) => {
  requireAdmin(req);
  const platform = platformParam(req.params.platform);
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
  for (const t of b.targets) {
    const row = targets.find((x) => x.id === t.targetId)!;
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
