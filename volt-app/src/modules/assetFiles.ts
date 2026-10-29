// ============================================================================
//  Companion files of an asset (services/companions/, docs/COMPANION_FILES.md).
//  Mounted inside vodImageRouter, so under /api/vod and before vodRouter's /:id.
//
//    GET    /api/vod/:id/files                       the asset's files, with each check
//    POST   /api/vod/:id/files?name=&kind=&language=&label=&default=&forced=&sdh=&offsetMs=
//                                                    upload: the raw bytes are the body
//                                                    (up to 25 MB). Captions are read and
//                                                    checked; a duplicate answers 200 with it
//    GET    /api/vod/:id/files/:fileId/content[?as=vtt]  download the original (or the WebVTT)
//    PATCH  /api/vod/:id/files/:fileId               language, label, default, forced, sdh,
//                                                    enabled (offered to viewers), offsetMs
//    DELETE /api/vod/:id/files/:fileId
//    GET    /api/vod/:id/files/:fileId/proposal      a metadata sidecar: what it would change
//    POST   /api/vod/:id/files/:fileId/apply { fields[], values? }   write the approved fields
//
//  Feature `vod` (auth/roles.ts prefix /api/vod): reading needs view, changes need manage.
// ============================================================================
import express, { Router } from 'express';
import { z } from 'zod';
import { accountId } from '../auth/middleware';
import { asyncHandler, ApiError, badRequest } from '../util/http';
import { actorLabel } from '../util/actor';
import { writeAudit, actor } from '../services/audit';
import { addFile, listFiles, fileContent, updateFile, deleteFile, proposeMetadata, applyMetadata, MAX_BYTES } from '../services/companions/store';

export const assetFilesRouter = Router();

const fail = (e: any): never => {
  if (e instanceof ApiError) throw e;
  throw new ApiError(Number(e?.status) || 400, String(e?.message ?? e));
};
const bool = (v: unknown) => (v === undefined ? undefined : v === '1' || v === 'true' || v === 'yes');

assetFilesRouter.get('/:id/files', asyncHandler(async (req, res) => {
  res.json(await listFiles(String(req.params.id), accountId(req)).catch(fail));
}));

assetFilesRouter.post('/:id/files', express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const id = String(req.params.id);
  const qy = req.query as Record<string, string | undefined>;
  const name = String(qy.name ?? req.get('x-file-name') ?? '').trim();
  if (!name) throw badRequest('say the file name: ?name=episode.en.srt');
  const kind = qy.kind && ['captions', 'metadata', 'other'].includes(qy.kind) ? (qy.kind as any) : null;
  const offsetMs = qy.offsetMs != null && qy.offsetMs !== '' ? Math.round(Number(qy.offsetMs)) : undefined;
  if (offsetMs !== undefined && !Number.isFinite(offsetMs)) throw badRequest('offsetMs must be a number of milliseconds');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
  const by = (await actorLabel(req)) ?? 'someone';
  const r = await addFile(id, acct, {
    name, buf, contentType: req.get('content-type') ?? null, kind, language: qy.language?.trim() || null, label: qy.label ?? null,
    isDefault: bool(qy.default), forced: bool(qy.forced), sdh: bool(qy.sdh), offsetMs, by, source: req.get('authorization')?.startsWith('Bearer sk_') ? 'api' : 'upload',
  }).catch(fail);
  if (!r.duplicate) {
    const { userId, label } = actor(req);
    await writeAudit(null, { accountId: acct, userId, label, action: 'create', entityType: 'vod_asset_file', entityId: r.file.id,
      changes: { file: { from: null, to: { asset: id, name: r.file.name, kind: r.file.kind, language: r.file.language } } } });
  }
  res.status(r.duplicate ? 200 : 201).json({ ...r.file, duplicate: r.duplicate });
}));

assetFilesRouter.get('/:id/files/:fileId/content', asyncHandler(async (req, res) => {
  const f = await fileContent(String(req.params.id), accountId(req), String(req.params.fileId), req.query.as === 'vtt').catch(fail);
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/"/g, '')}"`);
  res.end(f.buf);
}));

const patchSchema = z.object({
  language: z.string().trim().max(35).regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'a language code like en, fr or pt-BR').nullable().optional(),
  label: z.string().trim().min(1).max(80).optional(),
  isDefault: z.boolean().optional(), forced: z.boolean().optional(), sdh: z.boolean().optional(), enabled: z.boolean().optional(),
  offsetMs: z.number().int().min(-24 * 3600_000).max(24 * 3600_000).optional(),
});

assetFilesRouter.patch('/:id/files/:fileId', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = patchSchema.parse(req.body ?? {});
  const f = await updateFile(String(req.params.id), acct, String(req.params.fileId), b).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset_file', entityId: f.id, changes: { file: { from: null, to: b } } });
  res.json(f);
}));

assetFilesRouter.delete('/:id/files/:fileId', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const r = await deleteFile(String(req.params.id), acct, String(req.params.fileId)).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'delete', entityType: 'vod_asset_file', entityId: String(req.params.fileId), changes: { file: { from: r.name, to: null } } });
  res.json(r);
}));

assetFilesRouter.get('/:id/files/:fileId/proposal', asyncHandler(async (req, res) => {
  res.json(await proposeMetadata(String(req.params.id), accountId(req), String(req.params.fileId)).catch(fail));
}));

assetFilesRouter.post('/:id/files/:fileId/apply', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({ fields: z.array(z.string().max(60)).min(1).max(100), values: z.record(z.any()).optional() }).parse(req.body ?? {});
  const by = (await actorLabel(req)) ?? 'someone';
  const r = await applyMetadata(String(req.params.id), acct, String(req.params.fileId), b.fields, b.values ?? {}, by).catch(fail);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: String(req.params.id),
    changes: Object.fromEntries(r.applied.map((k) => [k, { from: r.was[k], to: 'sidecar' }])) });
  res.json(r);
}));
