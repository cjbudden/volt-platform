// ============================================================================
//  BULK ACTIONS ON THE MEDIA LIBRARY (services/bulkActions.ts).
//  Mounted at /api/vod/bulk BEFORE the vod router, whose /:id/restore would
//  otherwise take /bulk/restore. Same permission area as the library (vod).
//
//    POST /api/vod/bulk/remove/impact  { ids }            what would go, and what cannot
//    POST /api/vod/bulk/remove         { ids, confirm, note? }
//                                       runs it (200), or, when the account wants a
//                                       manager to confirm, files a request (202)
//    POST /api/vod/bulk/restore        { ids }            undo: back from the bin
//    GET  /api/vod/bulk/requests       ?pending=1
//    POST /api/vod/bulk/requests/:id/approve | reject     { note? }  admin or owner, not the asker
//    POST /api/vod/bulk/requests/:id/cancel
// ============================================================================
import { Router, type Request } from 'express';
import { requireAuth, accountId } from '../auth/middleware';
import { rankOf } from '../auth/roles';
import { asyncHandler } from '../util/http';
import { actor } from '../services/audit';
import { actorLabel } from '../util/actor';
import { cleanIds, impactOf, runOrRequest, listRequests, decide, cancel, restoreMany, type BulkActor } from '../services/bulkActions';

export const vodBulkRouter = Router();
vodBulkRouter.use(requireAuth);

async function who(req: Request): Promise<BulkActor> {
  return { userId: actor(req).userId, label: await actorLabel(req), rank: rankOf(String((req as any).auth?.role ?? 'viewer')) };
}
const noteOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);

vodBulkRouter.post('/remove/impact', asyncHandler(async (req, res) => {
  res.json(await impactOf(accountId(req), 'vod.remove', cleanIds(req.body?.ids), await who(req)));
}));

vodBulkRouter.post('/remove', asyncHandler(async (req, res) => {
  const ids = cleanIds(req.body?.ids);
  const r = await runOrRequest(accountId(req), 'vod.remove', ids, req.body?.confirm, await who(req), noteOf(req.body?.note));
  if (!r.ran) { res.status(202).json({ requested: true, request: r.request }); return; }
  const { LIBRARY_TRASH_DAYS } = await import('../services/media/trash');
  res.json({ requested: false, ...r.outcome, binDays: LIBRARY_TRASH_DAYS });
}));

vodBulkRouter.post('/restore', asyncHandler(async (req, res) => {
  res.json(await restoreMany(accountId(req), cleanIds(req.body?.ids), await who(req)));
}));

vodBulkRouter.get('/requests', asyncHandler(async (req, res) => {
  const by = await who(req);
  res.json({ requests: await listRequests(accountId(req), { pendingOnly: req.query.pending === '1' }), canDecide: by.rank >= 3, me: by.userId });
}));
vodBulkRouter.post('/requests/:id/approve', asyncHandler(async (req, res) => {
  res.json(await decide(accountId(req), String(req.params.id), true, await who(req), noteOf(req.body?.note)));
}));
vodBulkRouter.post('/requests/:id/reject', asyncHandler(async (req, res) => {
  res.json(await decide(accountId(req), String(req.params.id), false, await who(req), noteOf(req.body?.note)));
}));
vodBulkRouter.post('/requests/:id/cancel', asyncHandler(async (req, res) => {
  res.json(await cancel(accountId(req), String(req.params.id), await who(req)));
}));
