// ============================================================================
//  An asset's images by type (services/media/assetImageSet.ts,
//  docs/ASSET_IMAGES.md section 13). Mounted inside vodImageRouter, so under
//  /api/vod and before vodRouter's /:id.
//
//    GET    /api/vod/image-types                    the account's image types
//    POST   /api/vod/image-types                    add one { key, label, aspect, ... }
//    PATCH  /api/vod/image-types/:key               rename, resize, switch on or off
//    DELETE /api/vod/image-types/:key[?force=1]     remove an account's own type
//
//    GET    /api/vod/:id/images[?fallback=0]        every type the asset offers:
//                                                   its image, or the derived fallback
//    PUT    /api/vod/:id/images/:type { ref, focus? }   choose an image for a type
//    PATCH  /api/vod/:id/images/:type { focus }     move the crop focus point
//    DELETE /api/vod/:id/images/:type               remove it (falls back again;
//                                                   the primary type is picked again)
//
//  Feature `vod` (auth/roles.ts prefix /api/vod): reading needs view, changes need manage.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { actorLabel } from '../util/actor';
import { writeAudit, actor } from '../services/audit';
import {
  listImageTypes, saveImageType, deleteImageType, assetImages, setTypeImage, setTypeFocus, clearTypeImage,
} from '../services/media/assetImageSet';
import { aspectLabel } from '../services/media/assetImageRules';

export const assetImagesRouter = Router();

/** Errors from the service carry a status; plain ones are the caller's mistake. */
const fail = (e: any): never => {
  if (e instanceof ApiError) throw e;
  throw new ApiError(Number(e?.status) || 400, String(e?.message ?? e));
};

const focusSchema = z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) });
const typeSchema = z.object({
  key: z.string().trim().max(40).optional(),
  label: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(400).optional(),
  purpose: z.enum(['content', 'publishing']).optional(),
  aspect: z.string().trim().max(20).nullable().optional(),
  minWidth: z.number().int().min(0).max(8192).optional(),
  minHeight: z.number().int().min(0).max(8192).optional(),
  appliesTo: z.array(z.enum(['video', 'audio'])).min(1).max(2).optional(),
  fallback: z.array(z.string().trim().max(40)).max(5).optional(),
  transparent: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
});

const typeOut = (t: any) => ({ ...t, aspect: aspectLabel(t) });

// ---------------------------------------------------------------- types

assetImagesRouter.get('/image-types', asyncHandler(async (req, res) => {
  res.json((await listImageTypes(accountId(req))).map(typeOut));
}));

assetImagesRouter.post('/image-types', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = typeSchema.parse(req.body ?? {});
  if (!b.key) throw badRequest('give the type a key, for example "partner-tile"');
  const t = await saveImageType(acct, null, b).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'create', entityType: 'asset_image_type', entityId: t.key, changes: { type: { from: null, to: t } } });
  res.status(201).json(typeOut(t));
}));

assetImagesRouter.patch('/image-types/:key', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = typeSchema.omit({ key: true }).parse(req.body ?? {});
  const key = String(req.params.key);
  const before = (await listImageTypes(acct)).find((t) => t.key === key) ?? null;
  const t = await saveImageType(acct, key, b).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'asset_image_type', entityId: key, changes: { type: { from: before, to: t } } });
  res.json(typeOut(t));
}));

assetImagesRouter.delete('/image-types/:key', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const key = String(req.params.key);
  const r = await deleteImageType(acct, key, req.query.force === '1' || req.query.force === 'true').catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'delete', entityType: 'asset_image_type', entityId: key, changes: { images_removed: { from: null, to: r.images } } });
  res.json(r);
}));

// ---------------------------------------------------------------- an asset's images

async function answer(id: string, acct: string, fallback = true) {
  const v = await assetImages(id, acct, { fallback });
  if (!v) throw notFound('VOD asset not found');
  return v;
}

/**
 * WHAT CHANGED SINCE, for the library grid to update cards in place without a
 * reload (a newly chosen or picked image, a title, availability).
 *   GET /api/vod/changes?since=<the `now` of the last answer>
 * Answers { now, changes: [...], more }. The first call (no since) answers only
 * `now`. A few seconds of overlap catch rows whose transaction committed after
 * the last answer was read; merging a row twice is harmless. `more` (over 200)
 * means reload the page instead. One index range scan (migration 0094); answers
 * are shared for two seconds between viewers of the same account asking the
 * same thing.
 */
assetImagesRouter.get('/changes', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const since = typeof req.query.since === 'string' && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : null;
  res.setHeader('Cache-Control', 'no-store');
  const { one: q1, query: qn } = await import('../db');
  if (!since) return res.json({ now: (await q1<any>(`SELECT now() AS now`))!.now, changes: [], more: false });
  const { cached } = await import('../scale/cache');
  const key = `vodchanges:${acct}:${Math.floor(since.getTime() / 1000)}`;
  const out = await cached(key, { ttlSec: 2, tags: [`acct:${acct}`] }, async () => {
    const now = (await q1<any>(`SELECT now() AS now`))!.now;
    const rows = await qn<any>(`
      SELECT v.id, v.title, v.poster_key, v.poster_shape, v.poster_source, v.poster_picked_at, v.updated_at,
             v.availability_state, v.schema_id, v.duration_ms, j.state AS encode_state, j.progress_pct AS encode_pct
        FROM vod_assets v
        LEFT JOIN channels c ON c.id = v.channel_id
        LEFT JOIN events e ON e.id = v.event_id
        LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
        LEFT JOIN jobs j ON j.id = v.encode_job_id
       WHERE v.updated_at > $2::timestamptz - interval '3 seconds' AND COALESCE(g.account_id, v.account_id) = $1
       ORDER BY v.updated_at LIMIT 201`, [acct, since]);
    return { now, changes: rows.slice(0, 200), more: rows.length > 200 };
  });
  res.json(out);
}));

/**
 * The images that belong to an asset, for pickers to open on: what was made or
 * uploaded for it (its library folder, frames saved for it), its song's cover,
 * and the encoder stills taken while it was live. Each group says what it is.
 */
assetImagesRouter.get('/:id/images/related', asyncHandler(async (req, res) => {
  const r = await (await import('../services/media/assetImageSet')).relatedImages(String(req.params.id), accountId(req));
  if (!r) throw notFound('VOD asset not found');
  res.json(r);
}));

assetImagesRouter.get('/:id/images', asyncHandler(async (req, res) => {
  res.json(await answer(String(req.params.id), accountId(req), req.query.fallback !== '0'));
}));

assetImagesRouter.put('/:id/images/:type', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const id = String(req.params.id), type = String(req.params.type);
  const b = z.object({ ref: z.string().min(1).max(600), focus: focusSchema.nullable().optional() }).parse(req.body ?? {});
  const before = await answer(id, acct, false);
  const by = (await actorLabel(req)) ?? 'someone';
  await setTypeImage(id, acct, type, b.ref, by, b.focus ?? null).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: id,
    changes: { [`image:${type}`]: { from: before.slots.find((s) => s.type.key === type)?.image?.key ?? null, to: b.ref } } });
  res.json(await answer(id, acct));
}));

assetImagesRouter.patch('/:id/images/:type', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const id = String(req.params.id), type = String(req.params.type);
  const b = z.object({ focus: focusSchema.nullable() }).parse(req.body ?? {});
  if (!(await setTypeFocus(id, acct, type, b.focus))) throw notFound(`This asset has no ${type} image of its own to move the focus of.`);
  res.json(await answer(id, acct));
}));

assetImagesRouter.delete('/:id/images/:type', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const id = String(req.params.id), type = String(req.params.type);
  const by = (await actorLabel(req)) ?? undefined;
  const r = await clearTypeImage(id, acct, type, by).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: id, changes: { [`image:${type}`]: { from: r.was, to: null } } });
  res.json(await answer(id, acct));
}));
