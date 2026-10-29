// ============================================================================
//  CONTENT LINKS AND READ FROM FILE NAME: the asset routes.
//  Mounted at /api/vod before vodRouter (its /:id would take /link-candidates).
//  The Media library permission covers them (auth/roles.ts prefix /api/vod):
//  reading needs view, changing needs edit.
//
//    GET    /api/vod/link-candidates?q=&for=&field=   records a link field can point at
//    GET    /api/vod/:id/links                       both directions, with reasons and suggestions
//    PUT    /api/vod/:id/links/:field                {assetId} links, {name} keeps a name
//    DELETE /api/vod/:id/links/:field                removes the relationship
//    GET    /api/vod/:id/from-filename               what the file name says, for a person to tick
//    POST   /api/vod/:id/from-filename               apply what was ticked
//    POST   /api/vod/from-filename                   a selection: apply only what is safe without asking
//
//  The asset itself carries linked content with GET /api/vod/:id?include=linkedContent.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { actor } from '../services/audit';
import { actorLabel } from '../util/actor';
import { resolveEffectiveFields } from './metadataSchemas';
import { contentFields, readLinks, writeLink, searchCandidates, linkValue } from '../services/contentLinks';
import { preview, applyReading } from '../services/ingest/filenameApply';

export const contentLinksRouter = Router();
contentLinksRouter.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function ownedAsset(id: string, acct: string): Promise<any | null> {
  if (!UUID.test(id)) return null;
  return one<any>(
    `SELECT v.* FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);
}
async function fieldsOf(a: any, acct: string) {
  return a.schema_id ? (await resolveEffectiveFields(a.schema_id, acct))?.fields ?? [] : [];
}

contentLinksRouter.get('/link-candidates', asyncHandler(async (req, res) => {
  const q = z.object({ q: z.string().max(200).default(''), for: z.string().uuid().optional(), field: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(30).default(12) }).parse(req.query);
  const acct = accountId(req);
  const a = q.for ? await ownedAsset(q.for, acct) : null;
  if (q.for && !a) throw notFound('VOD asset not found');
  const field = a && q.field ? contentFields(await fieldsOf(a, acct)).find((f) => f.key === q.field) ?? null : null;
  if (q.field && a && !field) throw badRequest(`${q.field} is not a content-link field of this asset's type`);
  if (!q.q.trim()) {
    // No text: the suggestions already recorded for this field, if any.
    const links = a ? await readLinks(acct, a.id, await fieldsOf(a, acct)) : { links: [] as any[] };
    const l = links.links.find((x: any) => x.field === q.field);
    res.json({ items: (l?.candidates ?? []).map((c: any) => ({ id: c.assetId, title: c.title, score: c.score, reasons: c.reasons, asset: c.asset })) });
    return;
  }
  const items = await searchCandidates(acct, a?.id ?? null, field, q.q, q.limit);
  res.json({ items: items.map((c) => ({ id: c.assetId, title: c.title, score: c.score, reasons: c.reasons, asset: c.asset })) });
}));

contentLinksRouter.post('/from-filename', asyncHandler(async (req, res) => {
  const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
  const acct = accountId(req);
  const who = { userId: actor(req).userId, label: await actorLabel(req) };
  const results = [];
  for (const id of b.ids) {
    const a = await ownedAsset(id, acct);
    if (!a) { results.push({ assetId: id, error: 'not found' }); continue; }
    if (!a.original_filename && !a.title) { results.push({ assetId: id, error: 'no file name' }); continue; }
    results.push(await applyReading(acct, id, { link: 'auto' }, who, 'safe'));
  }
  const changed = results.filter((r: any) => r.typeChanged || r.titleChanged || r.applied?.length || r.link?.action === 'linked').length;
  res.json({ results, changed, unchanged: results.length - changed });
}));

contentLinksRouter.get('/:id/links', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await ownedAsset(req.params.id, acct);
  if (!a) throw notFound('VOD asset not found');
  res.json(await readLinks(acct, a.id, await fieldsOf(a, acct)));
}));

contentLinksRouter.put('/:id/links/:field', asyncHandler(async (req, res) => {
  const b = z.union([
    z.object({ assetId: z.string().uuid() }).strict(),
    z.object({ name: z.string().trim().min(1).max(300) }).strict(),
  ]).parse(req.body);
  const acct = accountId(req);
  const a = await ownedAsset(req.params.id, acct);
  if (!a) throw notFound('VOD asset not found');
  const f = contentFields(await fieldsOf(a, acct)).find((x) => x.key === req.params.field);
  if (!f) throw badRequest(`${req.params.field} is not a content-link field of this asset's type`);
  const by = await actorLabel(req);
  if ('assetId' in b) {
    const t = await ownedAsset(b.assetId, acct);
    if (!t) throw badRequest('No such record in this library');
    await writeLink({ account: acct, assetId: a.id, field: f, value: { id: t.id, name: t.title ?? t.metadata?.title ?? 'Untitled' }, source: 'person', by, reasons: ['Linked by a person.'] });
  } else {
    await writeLink({ account: acct, assetId: a.id, field: f, value: { name: b.name }, source: 'person', by, reasons: ['Name entered by a person; not linked to a record yet.'] });
  }
  const { writeAudit } = await import('../services/audit');
  await writeAudit(null, { accountId: acct, userId: actor(req).userId, label: by, action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes: { [`metadata.${f.key}`]: { from: a.metadata?.[f.key] ?? null, to: 'assetId' in b ? { id: b.assetId } : { name: b.name } } } }).catch(() => {});
  res.json(await readLinks(acct, a.id, await fieldsOf(a, acct)));
}));

contentLinksRouter.delete('/:id/links/:field', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await ownedAsset(req.params.id, acct);
  if (!a) throw notFound('VOD asset not found');
  const f = contentFields(await fieldsOf(a, acct)).find((x) => x.key === req.params.field);
  if (!f) throw badRequest(`${req.params.field} is not a content-link field of this asset's type`);
  const before = linkValue(a.metadata?.[f.key]);
  await writeLink({ account: acct, assetId: a.id, field: f, value: null, source: 'person', by: await actorLabel(req) });
  const { writeAudit } = await import('../services/audit');
  await writeAudit(null, { accountId: acct, userId: actor(req).userId, label: await actorLabel(req), action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes: { [`metadata.${f.key}`]: { from: before, to: null } } }).catch(() => {});
  res.json(await readLinks(acct, a.id, await fieldsOf(a, acct)));
}));

contentLinksRouter.get('/:id/from-filename', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await ownedAsset(req.params.id, acct);
  if (!a) throw notFound('VOD asset not found');
  if (!a.original_filename && !a.title) throw badRequest('This asset has no file name to read.');
  const p = await preview(acct, a);
  // The records the link would go to, so the dialog can offer them.
  let link: any = p.link;
  if (p.link?.query.title) {
    const { findRelated, RELATIONS } = await import('../services/contentLinks');
    const d = await findRelated(acct, a.id, p.link.query, RELATIONS.trailer_for);
    const { ownedSummaries } = await import('../services/contentLinks');
    const sums = await ownedSummaries(acct, d.candidates.map((c) => c.id));
    link = { ...p.link, decision: { action: d.action, reason: d.reason, candidates: d.candidates.map((c) => ({ id: c.id, title: c.title, score: c.score, reasons: c.reasons, asset: sums.get(c.id) ?? null })) } };
  }
  res.json({ ...p, link, analysis: a.filename_analysis ?? null });
}));

contentLinksRouter.post('/:id/from-filename', asyncHandler(async (req, res) => {
  const b = z.object({
    type: z.boolean().default(false), title: z.boolean().default(false),
    fields: z.array(z.string().max(80)).max(100).optional(), overwrite: z.array(z.string().max(80)).max(100).default([]),
    link: z.union([z.string().uuid(), z.literal('auto'), z.null()]).default(null),
  }).parse(req.body ?? {});
  const acct = accountId(req);
  const a = await ownedAsset(req.params.id, acct);
  if (!a) throw notFound('VOD asset not found');
  if (b.link && b.link !== 'auto' && !(await ownedAsset(b.link, acct))) throw badRequest('No such record in this library');
  const r = await applyReading(acct, a.id, b, { userId: actor(req).userId, label: await actorLabel(req) }, 'chosen');
  res.json(r);
}));
