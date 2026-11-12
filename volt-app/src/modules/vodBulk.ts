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
//    POST /api/vod/bulk/availability   { ids, action: 'apply' | 'clear', override? | presetKey?, confirm? }
//                                       ?dryRun=1: the titles' own publishing policy, many at once
// ============================================================================
import { Router, type Request } from 'express';
import { requireAuth, accountId } from '../auth/middleware';
import { rankOf } from '../auth/roles';
import { asyncHandler } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { badRequest } from '../util/http';
import { cleanSettings, policyRefusal } from './publishingRules';
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

// ---------------------------------------------------------------------------
//  THE ASSET RUNG IN BULK (build queue P3-2c). Apply one policy as the selected
//  titles' own override, or clear their overrides (back to the rules), with
//  the checks PATCH /api/vod/:id/availability makes for one title, made per
//  title: a title whose override would change a locked field, or bring a
//  conflict, is refused and named with why, and the rest are saved. The same
//  answer with ?dryRun=1 is the console's Before you save. DRM on published
//  titles asks to confirm (409), as a rule does. Published titles take the
//  change up through the restamp (services/availability.ts markPolicyStale,
//  restampFor): marked here, the first batch started at once, the sweep the
//  rest, so a few hundred titles never hold the response.
// ---------------------------------------------------------------------------
vodBulkRouter.post('/availability', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const ids = cleanIds(req.body?.ids);
  const action = req.body?.action;
  if (action !== 'apply' && action !== 'clear') throw badRequest("action must be 'apply' or 'clear'");
  let override = {};
  let presetKey: string | null = null;
  if (action === 'apply') {
    const { presetByKey } = await import('../services/publishingPolicies');
    if (req.body?.presetKey !== undefined && req.body?.presetKey !== null) {
      const p = presetByKey(String(req.body.presetKey));
      if (!p) throw badRequest('No such preset.');
      presetKey = p.key;
      override = await cleanSettings(acct, p.settings);
    } else {
      override = await cleanSettings(acct, req.body?.override ?? {});
    }
    if (!Object.keys(override).length) throw badRequest('Nothing to apply: choose a preset or set at least one field, or clear the overrides instead.');
  }
  const { assetBulkCheck } = await import('../services/publishingPolicies');
  const check = await assetBulkCheck(acct, ids, override);
  const summary = { action, presetKey, override, ok: check.ok.length, refused: check.refused, missing: check.missing, warnings: check.warnings, impact: check.impact };
  if (req.query.dryRun === '1' || req.query.dryRun === 'true') return res.json({ dryRun: true, saved: false, canSave: check.ok.length > 0, ...summary });
  if (!check.ok.length) {
    const first = check.refused[0]?.conflicts[0]?.message ?? 'None of these titles belong to this account.';
    throw policyRefusal(422, 'policy_conflict', `No title can take this. ${first}`, summary);
  }
  if (check.impact.repackage && req.body?.confirm !== true)
    throw policyRefusal(409, 'confirm_repackage', `This changes DRM on ${check.impact.repackage} published title${check.impact.repackage === 1 ? '' : 's'}: their files must be packaged again. Send again with confirm to go ahead; they keep their current protection until then.`, summary);
  const { query } = await import('../db');
  const okIds = check.ok.map((t) => t.id);
  const before = await query<{ id: string; availability_override: any }>(`SELECT id, availability_override FROM vod_assets WHERE id = ANY($1::uuid[])`, [okIds]);
  await query(`UPDATE vod_assets SET availability_override = $2::jsonb, updated_at = now() WHERE id = ANY($1::uuid[])`, [okIds, JSON.stringify(override)]);
  const { markPolicyStale, restampFor } = await import('../services/availability');
  const marked = await markPolicyStale(acct, { kind: 'assets', id: null, ids: okIds }).catch((e) => { console.warn('[vod-bulk] marking titles failed', e?.message ?? e); return 0; });
  if (marked) setImmediate(() => { restampFor(20_000).catch((e) => console.warn('[vod-bulk] restamp failed, left for the sweep', e?.message ?? e)); });
  const by = actor(req);
  for (const b of before)
    await writeAudit(null, { accountId: acct, userId: by.userId, label: by.label, action: 'update', entityType: 'vod_asset', entityId: b.id,
      changes: { availability_override: { from: b.availability_override ?? {}, to: override } }, snapshot: { bulk: true, action, presetKey } }).catch(() => {});
  res.json({ saved: true, ...summary, marked });
}));
