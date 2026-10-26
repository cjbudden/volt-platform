// ============================================================================
//  ON-DEMAND ADS API (services/vodAds, SSAI.md section 5).
//
//  The console, under the Media library's permission (feature vod):
//   GET    /api/vod/ads/rules                 the account default and one rule per content type
//   PUT    /api/vod/ads/rules/default         {mode, policy, adServerId, houseAds}
//   PUT    /api/vod/ads/rules/content-type/:id   the same, for one content type
//   DELETE /api/vod/ads/rules/content-type/:id   back to the account default
//   GET    /api/vod/ads/assets/:id/plan       where an asset's breaks would go, and under which rule
//   GET    /api/vod/ads/report?days=&assetId= fill, house share, impressions, completion, clicks
//   GET    /api/vod/ads/ad-servers            the account's ad servers (shared with FAST channels)
//   POST   /api/vod/ads/ad-servers            add one {name, vendor, tagTemplate, timeoutMs, maxWrappers}
//   GET    /api/vod/ads/house-candidates      library items short enough to be a house spot (2 minutes at most)
//
//  Public, the viewer's session (the session id is the capability):
//   GET  /vod-ads/s/:sid/master.m3u8 | :track.m3u8   stitched playlists
//   GET  /vod-ads/s/:sid/seg/:b/:p/:track/:n         an ad segment: 302 to the CDN, beacons sent
//   GET  /vod-ads/s/:sid/ad/:b/:p/master.m3u8 | :track.m3u8   one ad as a stream (guided)
//   GET  /vod-ads/s/:sid/timeline.json               the ad timeline: breaks, ads, both clocks
//   POST /vod-ads/s/:sid/events                      player events (pause, mute, skip...)
//   GET  /vod-ads/s/:sid/click/:b/:p                 a click: trackers sent, 302 to the advertiser
//   GET  /vod-ads/g/:assetId/:ver/master.m3u8 | :track.m3u8   guided (interstitial) playlists, shared
//   GET  /vod-ads/g/:assetId/:ver/list/:b.json       one break's asset list, decided for this playback
//   GET  /vod-ads/blank.vtt                          the empty subtitles an ad plays with
// ============================================================================
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { resolveVodAdPolicy } from '../services/vodAds/plan';
import {
  ruleForAsset, assetFor, breaksFor, replacedView, sessionRow, readySession, sessionMaster, sessionMedia, sessionMpd, sessionText, segmentRedirect, adMaster, adMedia,
  timelineOf, playerEvents, clickThrough, guidedVersion, guidedMaster, guidedPlaylist, guidedAssetList, vodAdReport, PLAYER_EVENTS, validSid,
  type SessionCtx,
} from '../services/vodAds';

export const vodAdsRouter = Router();
vodAdsRouter.use(requireAuth);

const UUID = /^[0-9a-f-]{36}$/i;
const ruleBody = z.object({
  mode: z.enum(['off', 'on']),
  policy: z.record(z.any()).default({}),
  adServerId: z.string().uuid().nullable().optional(),
  houseAds: z.array(z.object({ assetId: z.string().uuid(), weight: z.number().min(0).max(10).optional() })).max(50).default([]),
});
const view = (r: any) => r && ({
  id: r.id, contentTypeId: r.schema_id, contentTypeName: r.schema_name ?? null, mode: r.mode, policy: resolveVodAdPolicy(r.policy),
  adServerId: r.ad_server_id, houseAds: r.house_ads ?? [], updatedAt: r.updated_at,
});

vodAdsRouter.get('/rules', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*, s.name AS schema_name FROM vod_ad_rules r LEFT JOIN metadata_schemas s ON s.id = r.schema_id
      WHERE r.account_id = $1 ORDER BY (r.schema_id IS NOT NULL), lower(s.name)`, [accountId(req)]);
  const def = rows.find((r) => !r.schema_id);
  res.json({ default: view(def) ?? { id: null, contentTypeId: null, mode: 'off', policy: resolveVodAdPolicy({}), adServerId: null, houseAds: [], updatedAt: null },
    contentTypes: rows.filter((r) => r.schema_id).map(view) });
}));

async function checkRefs(acct: string, b: z.infer<typeof ruleBody>) {
  if (b.adServerId && !(await one(`SELECT 1 FROM ad_servers WHERE id = $1 AND account_id = $2`, [b.adServerId, acct]))) throw badRequest('That ad server is not one of this account\'s');
  if (b.houseAds.length) {
    const ok = await query<any>(
      `SELECT v.id FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
         LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        WHERE v.id = ANY($1::uuid[]) AND COALESCE(g.account_id, v.account_id) = $2`, [b.houseAds.map((h) => h.assetId), acct]);
    if (ok.length !== new Set(b.houseAds.map((h) => h.assetId)).size) throw badRequest('A house ad is not an item in this account\'s Media Library');
  }
}

async function saveRule(req: Request, res: Response, schemaId: string | null) {
  const acct = accountId(req);
  const b = ruleBody.parse(req.body ?? {});
  if (schemaId && !(await one(`SELECT 1 FROM metadata_schemas WHERE id = $1 AND account_id = $2`, [schemaId, acct]))) throw notFound('Content type not found');
  await checkRefs(acct, b);
  const policy = resolveVodAdPolicy(b.policy);
  const before = await one<any>(`SELECT * FROM vod_ad_rules WHERE account_id = $1 AND schema_id IS NOT DISTINCT FROM $2`, [acct, schemaId]);
  const row = before
    ? await one<any>(`UPDATE vod_ad_rules SET mode = $2, policy = $3::jsonb, ad_server_id = $4, house_ads = $5::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [before.id, b.mode, JSON.stringify(policy), b.adServerId ?? null, JSON.stringify(b.houseAds)])
    : await one<any>(`INSERT INTO vod_ad_rules (account_id, schema_id, mode, policy, ad_server_id, house_ads) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb) RETURNING *`,
      [acct, schemaId, b.mode, JSON.stringify(policy), b.adServerId ?? null, JSON.stringify(b.houseAds)]);
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: before ? 'update' : 'create', entityType: 'vod_ad_rule', entityId: row.id,
    changes: { mode: { from: before?.mode ?? null, to: b.mode } } });
  res.json(view(row));
}

vodAdsRouter.put('/rules/default', asyncHandler(async (req, res) => saveRule(req, res, null)));
vodAdsRouter.put('/rules/content-type/:id', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.id)) throw notFound('Content type not found');
  return saveRule(req, res, req.params.id);
}));
vodAdsRouter.delete('/rules/content-type/:id', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.id)) throw notFound('Content type not found');
  const r = await one<any>(`DELETE FROM vod_ad_rules WHERE account_id = $1 AND schema_id = $2 RETURNING id`, [accountId(req), req.params.id]);
  if (!r) throw notFound('No rule for that content type');
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'delete', entityType: 'vod_ad_rule', entityId: r.id });
  res.status(204).end();
}));

/** Where an asset's breaks would go, under which rule: what an editor checks before publishing. */
vodAdsRouter.get('/assets/:id/plan', asyncHandler(async (req, res) => {
  if (!UUID.test(req.params.id)) throw notFound('Asset not found');
  const asset = await assetFor(req.params.id, accountId(req));
  if (!asset) throw notFound('Asset not found');
  const rule = await ruleForAsset(accountId(req), asset.schema_id);
  if (!rule) return res.json({ assetId: asset.id, rule: null, breaks: [], why: 'No on-demand ad rule is on for this item\'s content type or the account.' });
  if (!asset.master_key) return res.json({ assetId: asset.id, rule: view(rule), breaks: [], why: 'This item has no playlist yet.' });
  const { contentSec, breaks, cuts } = await breaksFor(asset, rule.resolved);
  res.json({ assetId: asset.id, rule: view(rule), contentSec, breaks, replaced: replacedView(cuts),
    why: breaks.length ? null : asset.metadata?.adRule === 'none' || asset.metadata?.ads === false ? 'This item is marked ad-free.' : 'No break fits this item under the rule.' });
}));

// AD SERVERS ARE THE ACCOUNT'S, shared with FAST channels (modules/fast.ts
// edits them too). Listed and added here as well, so an account with
// on-demand content and no FAST channel (or a role without TV channels) can
// set its ads up from this page.
const serverBody = z.object({
  name: z.string().trim().min(1).max(120),
  vendor: z.enum(['vast', 'gam', 'freewheel', 'springserve', 'magnite', 'publica', 'beachfront', 'other']).default('vast'),
  tagTemplate: z.string().url().max(4000),
  timeoutMs: z.number().int().min(200).max(5000).default(1500),
  maxWrappers: z.number().int().min(0).max(10).default(5),
});
vodAdsRouter.get('/ad-servers', asyncHandler(async (req, res) => {
  res.json({ items: await query<any>(`SELECT id, name, vendor, tag_template, timeout_ms, max_wrappers, enabled FROM ad_servers WHERE account_id = $1 ORDER BY lower(name)`, [accountId(req)]) });
}));
vodAdsRouter.post('/ad-servers', asyncHandler(async (req, res) => {
  const b = serverBody.parse(req.body ?? {});
  const r = await one<any>(
    `INSERT INTO ad_servers (account_id, name, vendor, tag_template, timeout_ms, max_wrappers) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, vendor, tag_template, timeout_ms, max_wrappers, enabled`,
    [accountId(req), b.name, b.vendor, b.tagTemplate, b.timeoutMs, b.maxWrappers]);
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'create', entityType: 'ad_server', entityId: r.id });
  res.status(201).json(r);
}));
vodAdsRouter.get('/house-candidates', asyncHandler(async (req, res) => {
  res.json({ items: (await query<any>(
    `SELECT v.id, v.title, v.duration_ms FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.master_key IS NOT NULL AND v.duration_ms BETWEEN 1000 AND 120000
      ORDER BY v.created_at DESC LIMIT 200`, [accountId(req)])).map((r) => ({ id: r.id, title: r.title, durationSec: Number(r.duration_ms) / 1000 })) });
}));

vodAdsRouter.get('/report', asyncHandler(async (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days ?? 7) || 7));
  const assetId = typeof req.query.assetId === 'string' && UUID.test(req.query.assetId) ? req.query.assetId : null;
  res.json({ days, ...(await vodAdReport(accountId(req), new Date(Date.now() - days * 86_400_000), assetId)) });
}));

// ---------------------------------------------------------------- public

export const vodAdsPublicRouter = Router();

const m3u8 = (res: Response) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store'); res.type('application/vnd.apple.mpegurl'); };
const TRACK = /^[a-z0-9-]{1,24}$/i;

vodAdsPublicRouter.get('/blank.vtt', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('text/vtt').send('WEBVTT\n\n');
});

async function session(req: Request, wait = false) {
  const sid = String(req.params.sid);
  if (!validSid(sid)) throw notFound();
  const row = wait ? await readySession(sid) : await sessionRow(sid);
  if (!row) throw notFound();
  return row;
}
const int = (v: string, max = 10_000) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw notFound(); return n; };

vodAdsPublicRouter.get('/s/:sid/timeline.json', asyncHandler(async (req, res) => {
  const row = await session(req, true);
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  res.json(timelineOf(row));
}));

vodAdsPublicRouter.get('/s/:sid/seg/:b/:p/:track/:n', asyncHandler(async (req, res) => {
  const row = await session(req);
  if (!TRACK.test(req.params.track)) throw notFound();
  const url = await segmentRedirect(row, int(req.params.b), int(req.params.p), req.params.track, int(req.params.n, 100_000));
  if (!url) throw notFound();
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, url);
}));

vodAdsPublicRouter.get('/s/:sid/ad/:b/:p/:file', asyncHandler(async (req, res) => {
  const row = await session(req);
  const file = String(req.params.file);
  const b = int(req.params.b), p = int(req.params.p);
  const text = file === 'master.m3u8' ? await adMaster(row, b, p)
    : /^[a-z0-9-]{1,24}\.m3u8$/i.test(file) ? await adMedia(row, b, p, file.slice(0, -5)) : null;
  if (!text) throw notFound();
  m3u8(res); res.send(text);
}));

vodAdsPublicRouter.post('/s/:sid/events', asyncHandler(async (req, res) => {
  const row = await session(req);
  const b = z.object({ events: z.array(z.object({ b: z.number().int().min(0), p: z.number().int().min(0), event: z.enum(PLAYER_EVENTS) })).max(50) }).parse(req.body ?? {});
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ accepted: await playerEvents(row, b.events) });
}));

vodAdsPublicRouter.get('/s/:sid/click/:b/:p', asyncHandler(async (req, res) => {
  const row = await session(req);
  const to = await clickThrough(row, int(req.params.b), int(req.params.p));
  if (!to) throw notFound('This ad has no page to open');
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, to);
}));

// The session's stitched DASH (services/vodAds/dash.ts): content Periods cut at
// each break, a Period per ad. 404 when the asset or one of the ads decided
// for this viewer has no DASH-ready (fMP4) rendition: the player has HLS.
vodAdsPublicRouter.get('/s/:sid/manifest.mpd', asyncHandler(async (req, res) => {
  const row = await session(req, true);
  if (row.delivery !== 'stitched') throw notFound();
  const text = await sessionMpd(row);
  if (!text) throw notFound('This session is not available as DASH: play its HLS');
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  res.type('application/dash+xml').send(text);
}));

// A content Period's captions, cut from the asset's sidecar WebVTT (dash.ts cutVtt).
vodAdsPublicRouter.get('/s/:sid/text/:k/:rep', asyncHandler(async (req, res) => {
  const m = String(req.params.rep).match(/^([A-Za-z0-9_.-]{1,64})\.vtt$/);
  if (!m) throw notFound();
  const row = await session(req, true);
  if (row.delivery !== 'stitched') throw notFound();
  const text = await sessionText(row, int(req.params.k, 1000), m[1]);
  if (text == null) throw notFound();
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  res.type('text/vtt').send(text);
}));

vodAdsPublicRouter.get('/s/:sid/:file', asyncHandler(async (req, res) => {
  const file = String(req.params.file);
  if (!/^[a-z0-9-]{1,24}\.m3u8$/i.test(file)) throw notFound();
  const row = await session(req, true);
  if (row.delivery !== 'stitched') throw notFound();
  const text = file === 'master.m3u8' ? await sessionMaster(row) : await sessionMedia(row, file.slice(0, -5));
  if (!text) throw notFound();
  m3u8(res); res.send(text);
}));

// guided: shared per asset and rule version, so the CDN can cache them
async function guidedAsset(req: Request) {
  const id = String(req.params.assetId);
  if (!UUID.test(id)) throw notFound();
  const asset = await assetFor(id);
  if (!asset?.master_key) throw notFound();
  const rule = await ruleForAsset(asset.account_id, asset.schema_id);
  if (!rule) throw notFound();
  const ver = await guidedVersion(asset, rule);
  if (ver !== req.params.ver) throw notFound('This playlist has changed: ask the play gate again');
  return { asset, rule, ver };
}

vodAdsPublicRouter.get('/g/:assetId/:ver/list/:b', asyncHandler(async (req, res) => {
  const { asset, rule } = await guidedAsset(req);
  const m = String(req.params.b).match(/^(\d{1,4})\.json$/);
  if (!m) throw notFound();
  // The player names its playback (_HLS_primary_id, HLS Interstitials); our SDK sends its sid too.
  const primary = String(req.query._HLS_primary_id ?? req.query.sid ?? '').slice(0, 80);
  if (!/^[A-Za-z0-9._:-]{4,80}$/.test(primary)) throw badRequest('_HLS_primary_id is required');
  const ctx: SessionCtx = { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, country: req.header('cloudfront-viewer-country') ?? null };
  const out = await guidedAssetList(asset, rule, Number(m[1]), primary, ctx);
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 'no-store');
  res.json({ ASSETS: out.ASSETS, 'X-VOLT-SESSION': out.sessionId });
}));

vodAdsPublicRouter.get('/g/:assetId/:ver/:file', asyncHandler(async (req, res) => {
  const file = String(req.params.file);
  if (!/^[a-z0-9-]{1,24}\.m3u8$/i.test(file)) throw notFound();
  const { asset, rule, ver } = await guidedAsset(req);
  const text = file === 'master.m3u8' ? await guidedMaster(asset, ver) : await guidedPlaylist(asset, rule, ver, file.slice(0, -5));
  if (!text) throw notFound();
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Shared by every viewer of this asset under this rule version.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/vnd.apple.mpegurl').send(text);
}));
