// ============================================================================
//  Find details on an asset (build queue F1). Mounted inside vodImageRouter,
//  so under /api/vod and before vodRouter's /:id.
//
//    GET  /api/vod/:id/finder           which finder this asset's content type
//                                       uses (song or general), the default
//                                       search term, and the song for the song one
//    POST /api/vod/:id/details/find { q? }
//                                       the general finder: search Wikidata, map
//                                       each result onto the type's fields by
//                                       their schema.org names, beside what the
//                                       asset has now. Writes nothing.
//    POST /api/vod/:id/details/page { url }
//                                       the same for ONE page a person pasted
//                                       (build queue F2): its JSON-LD and Open
//                                       Graph read by schema.org name and mapped
//                                       onto the type's fields. Writes nothing.
//    POST /api/vod/:id/details/ai { url }
//                                       the same page read by an AI model when
//                                       the account has the AI Find details
//                                       add-on (build queue F4): each value
//                                       with the sentence it came from; one
//                                       lookup counted. Writes no metadata.
//    POST /api/vod/:id/details/use { source, itemId | link, lookupId?, values }
//                                       write exactly the values the person
//                                       ticked; metadata_provenance records where
//                                       each came from and what it replaced
//
//  The song finder keeps its own routes (modules/vodImage.ts, /song/find and
//  /song/use). Feature `vod`: reading needs view, the finds and the write need
//  manage (auth/roles.ts, by method).
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db';
import { accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, ApiError } from '../util/http';
import { actorLabel } from '../util/actor';
import { writeAudit, actor } from '../services/audit';
import { validateMetadata, type SchemaField } from '../services/metadataValidator';
import { finderFor, titleTerm } from '../services/media/finders';
import { songIdentity } from '../services/media/musicLookup';
import { AI_ADDON, aiConfigured, askable, pageText, pageHash, buildRequest, askModel, proposalsFrom, lookupCost, AiUnavailable } from '../services/media/aiDetails';
import { accountAddons, allowanceLeft, useAllowance, releaseAllowance, AllowanceExceeded } from '../services/invoicing/addons';

export const vodDetailsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The asset, its content type and the type's fields, when it is this account's. */
async function owned(id: string, acct: string) {
  if (!UUID.test(id)) return null;
  return one<any>(`
    SELECT v.id, v.title, v.metadata, v.metadata_provenance, v.ingest, v.schema_id, v.music_lookup,
           s.standard_key AS schema_key, s.name AS schema_name, s.schema_org_type, s.fields AS schema_fields
      FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id
      LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      LEFT JOIN metadata_schemas s ON s.id = v.schema_id
     WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [id, acct]);
}

const fieldsOf = (a: any): SchemaField[] => (Array.isArray(a.schema_fields) ? a.schema_fields : []);
const fieldView = (f: SchemaField) => ({ key: f.key, label: f.label ?? f.key, type: f.type, options: f.options ?? null, multiple: !!f.multiple, schemaOrg: f.schemaOrg ?? null });

/**
 * AI Find details for the account (build queue F4): whether it is offered at
 * all (the model's key is set and the add-on is in the catalogue), whether the
 * account has it on, what is left this month, and the next bigger pack to
 * offer when it runs out. Read from the cached add-on state.
 */
async function aiState(acct: string) {
  if (!aiConfigured()) return { offered: false as const, on: false };
  const a = (await accountAddons(acct)).find((x) => x.key === AI_ADDON);
  if (!a || !(a.offered || a.on)) return { offered: false as const, on: false };
  const now = a.packs.find((p) => p.key === a.pack)?.extraQuantity ?? 0;
  const bigger = a.packs.filter((p) => p.active && p.extraQuantity > now).sort((x, y) => x.extraQuantity - y.extraQuantity)[0] ?? null;
  return {
    offered: true as const, on: a.on, name: a.name, unit: a.unit, monthlyUsd: a.monthlyUsd, includedQuantity: a.includedQuantity,
    allowance: a.allowance, pack: a.pack,
    biggerPack: bigger ? { key: bigger.key, name: bigger.name, extraQuantity: bigger.extraQuantity, monthlyUsd: bigger.monthlyUsd } : null,
  };
}

vodDetailsRouter.get('/:id/finder', asyncHandler(async (req, res) => {
  const a = await owned(String(req.params.id), accountId(req));
  if (!a) throw notFound('VOD asset not found');
  const finder = finderFor(a.schema_key);
  res.json({
    ai: finder === 'general' ? await aiState(accountId(req)) : { offered: false, on: false },
    finder,
    contentType: a.schema_id ? { id: a.schema_id, name: a.schema_name, standardKey: a.schema_key ?? null } : null,
    term: titleTerm(fieldsOf(a), a.metadata, a.title),
    song: finder === 'song' ? songIdentity({ title: a.title, metadata: a.metadata, ingest: a.ingest, override: a.music_lookup?.query }) : null,
  });
}));

const findSchema = z.object({ q: z.string().trim().max(250).optional() });

vodDetailsRouter.post('/:id/details/find', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  if (!a.schema_id) throw badRequest('Choose a content type first: the details are matched to its fields.');
  if (finderFor(a.schema_key) !== 'general') throw new ApiError(409, `${a.schema_name} uses Find song details.`);
  const b = findSchema.parse(req.body ?? {});
  const fields = fieldsOf(a);
  const term = b.q || titleTerm(fields, a.metadata, a.title);
  if (!term) throw badRequest('Type what to search for.');
  const wd = await import('../services/media/wikidataLookup');
  let items: Awaited<ReturnType<typeof wd.findOnWikidata>> = [];
  let error: string | null = null;
  try { items = await wd.findOnWikidata(term, a.schema_org_type ?? null); }
  catch (e: any) { error = e instanceof wd.WikidataUnavailable ? e.message : 'The search failed'; }
  res.json({
    source: 'wikidata', term, error,
    terms: 'Wikidata: free to use (CC0). Check the item before you use it.',
    current: { metadata: a.metadata ?? {}, provenance: a.metadata_provenance ?? {}, fields: fields.map(fieldView) },
    // Fields this finder can never fill (no schema.org name, or one Wikidata has no value for): said, not hidden.
    unmapped: fields.filter((f) => !f.schemaOrg || !wd.FILLABLE.has(f.schemaOrg)).map((f) => f.label ?? f.key),
    results: items.map((it) => ({
      id: it.id, label: it.label, description: it.description, kinds: it.kinds, link: it.link, imageUrl: it.imageUrl, likely: it.likely,
      proposed: wd.mapToFields(it.values, fields),
    })),
  });
}));

const pageSchema = z.object({ url: z.string().trim().min(1).max(2000) });

// One page a person pasted (build queue F2), shown in the same panel as a
// search result. Fetched once, on request, like a link preview: never a crawl.
vodDetailsRouter.post('/:id/details/page', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  if (!a.schema_id) throw badRequest('Choose a content type first: the details are matched to its fields.');
  if (finderFor(a.schema_key) !== 'general') throw new ApiError(409, `${a.schema_name} uses Find song details.`);
  const b = pageSchema.parse(req.body ?? {});
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(b.url) ? b.url : `https://${b.url}`;
  const fields = fieldsOf(a);
  const pm = await import('../services/media/pageMeta');
  const { mapToFields } = await import('../services/media/wikidataLookup');
  const base = {
    source: 'page' as const,
    current: { metadata: a.metadata ?? {}, provenance: a.metadata_provenance ?? {}, fields: fields.map(fieldView) },
    // A page can say anything schema.org names, so only a field with no schema.org name can never be filled.
    unmapped: fields.filter((f) => !f.schemaOrg).map((f) => f.label ?? f.key),
  };
  const host = (() => { try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return null; } })();
  let pg: Awaited<ReturnType<typeof pm.readDetailsPage>>;
  try { pg = await pm.readDetailsPage(raw, a.schema_org_type ?? null); }
  catch (e: any) {
    // A bad or private address is the person's to fix (400); a site that refuses or fails is said, not thrown.
    if (e instanceof ApiError) throw e;
    return res.json({ ...base, link: raw, site: host, blocked: e instanceof pm.PageBlocked, error: e instanceof pm.PageBlocked ? String(e.message) : `The page could not be read: ${String(e?.message ?? e).slice(0, 200)}`, result: null });
  }
  if (pm.pageSaysNothing(pg)) {
    return res.json({ ...base, link: pg.url, site: pg.site, blocked: false, error: `${pg.site} publishes no details on that page (no schema.org data or Open Graph tags), only its title. Try the title's own page, or Search.`, result: null });
  }
  const fromBy: Record<string, string> = {};
  const proposed = mapToFields(pg.values, fields);
  for (const k of Object.keys(proposed)) { const f = fields.find((x) => x.key === k); if (f?.schemaOrg && pg.from[f.schemaOrg]) fromBy[k] = pg.from[f.schemaOrg]; }
  res.json({ ...base, link: pg.url, site: pg.site, blocked: false, error: null, result: {
    id: pg.url, label: pg.label ?? (pg.imageOnly ? `An image from ${pg.site}` : pg.site), description: pg.description, kinds: pg.kind ? [pg.kind] : [],
    link: pg.url, site: pg.site, imageUrl: pg.values.image?.kind === 'image' ? String(pg.values.image.value) : null, likely: pg.likely, imageOnly: pg.imageOnly,
    proposed, from: fromBy,
  } });
}));

const aiSchema = z.object({ url: z.string().trim().min(1).max(2000) });

// The same pasted page, read by an AI model (build queue F4). Only for an
// account with the AI Find details add-on on, on a deployment with the
// model's key. The allowance is checked before the page is even fetched, and
// a lookup is counted before the model is called, so nothing is sent once the
// month's lookups are used up; a call the model never answers is given back.
vodDetailsRouter.post('/:id/details/ai', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  if (!a.schema_id) throw badRequest('Choose a content type first: the details are matched to its fields.');
  if (finderFor(a.schema_key) !== 'general') throw new ApiError(409, `${a.schema_name} uses Find song details.`);
  const b = aiSchema.parse(req.body ?? {});
  if (!aiConfigured()) throw Object.assign(new ApiError(409, 'AI Find details is not available on this deployment.'), { code: 'ai_not_offered' });
  const left = await allowanceLeft(acct, AI_ADDON);
  if (left === null) throw Object.assign(new ApiError(403, 'AI Find details is an add-on: an account administrator can turn it on in Admin, Billing.'), { code: 'addon_required' });
  const all = fieldsOf(a);
  const fields = askable(all);
  if (!fields.length) throw badRequest(`${a.schema_name} has no fields an AI reading can fill.`);
  const usedUp = async (msg?: string) => res.status(409).json({
    error: msg ?? 'This month\'s AI Find details lookups are used up. A bigger pack adds more at once; otherwise they start again on the 1st.',
    code: 'allowance_exceeded', ai: await aiState(acct),
  });
  // Used up: said before anything is fetched or sent.
  if (left < 1) return usedUp();

  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(b.url) ? b.url : `https://${b.url}`;
  const base = {
    source: 'ai' as const,
    current: { metadata: a.metadata ?? {}, provenance: a.metadata_provenance ?? {}, fields: all.map(fieldView) },
    // A model reads text: an image, a yes or no, or a link to a record is never filled this way.
    unmapped: all.filter((f) => !fields.includes(f)).map((f) => f.label ?? f.key),
  };
  const host = (() => { try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return null; } })();
  const pm = await import('../services/media/pageMeta');
  let pg: Awaited<ReturnType<typeof pm.fetchPage>>;
  try { pg = await pm.fetchPage(raw, 'Open the page in your browser and copy the details into the fields yourself.'); }
  catch (e: any) {
    if (e instanceof ApiError) throw e;
    return res.json({ ...base, link: raw, site: host, blocked: e instanceof pm.PageBlocked, reused: false, ai: await aiState(acct),
      error: e instanceof pm.PageBlocked ? String(e.message) : `The page could not be read: ${String(e?.message ?? e).slice(0, 200)}`, result: null });
  }
  const done = async (o: { error: string | null; result: any; reused: boolean }) => res.json({ ...base, link: pg.url, site: pg.site, blocked: false, ...o, ai: await aiState(acct) });
  if (pg.kind === 'image') return done({ error: 'That address is a picture, not a page to read. Use Read page to fill the image field with it.', result: null, reused: false });
  const { title, text } = pageText(pg.html);
  if (text.length < 80) return done({ error: `${pg.site} shows almost no text on that page, so there is nothing for the AI model to read.`, result: null, reused: false });

  // The same page, unchanged, for the same asset and type within a day: the
  // answer already paid for is shown again, and nothing is counted or sent.
  const hash = pageHash(pg.url, text);
  const prior = await one<any>(
    `SELECT id, result FROM ai_lookups WHERE account_id = $1 AND vod_asset_id = $2 AND schema_id = $3 AND page_hash = $4 AND status = 'ok'
        AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 1`, [acct, a.id, a.schema_id, hash]);
  if (prior?.result) return done({ error: null, result: { ...prior.result, lookupId: prior.id }, reused: true });

  try { await useAllowance(acct, AI_ADDON, 1); }
  catch (e) { if (e instanceof AllowanceExceeded) return usedUp(); throw e; }
  const req0 = buildRequest({ text, title, site: pg.site, typeName: a.schema_name, schemaOrgType: a.schema_org_type ?? null, fields });
  const record = (o: { status: 'ok' | 'failed'; counted: boolean; model: string; inTok?: number; outTok?: number; cost?: number | null; result?: any; error?: string }) =>
    one<any>(`INSERT INTO ai_lookups(account_id, vod_asset_id, schema_id, user_id, url, page_hash, model, status, counted, input_tokens, output_tokens, cost_usd, result, error)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING id`,
      [acct, a.id, a.schema_id, req.auth?.sub ?? null, pg.url, hash, o.model, o.status, o.counted, o.inTok ?? null, o.outTok ?? null, o.cost ?? null,
        o.result ? JSON.stringify(o.result) : null, o.error ?? null]);
  let ans: Awaited<ReturnType<typeof askModel>>;
  try { ans = await askModel(req0); }
  catch (e: any) {
    await releaseAllowance(acct, AI_ADDON, 1);
    const msg = e instanceof AiUnavailable ? e.message : 'The AI model could not be asked.';
    await record({ status: 'failed', counted: false, model: req0.model, error: msg });
    return done({ error: `${msg} This lookup was not counted.`, result: null, reused: false });
  }
  const p = proposalsFrom(ans, fields, text);
  const result = {
    id: pg.url, label: ans.label ?? title ?? pg.site, description: null, kinds: [] as string[], link: pg.url, site: pg.site, imageUrl: null, likely: false,
    proposed: p.proposed, from: p.from, dropped: p.dropped, model: ans.model,
  };
  const row = await record({ status: 'ok', counted: true, model: ans.model, inTok: ans.inputTokens, outTok: ans.outputTokens,
    cost: lookupCost(ans.model, ans.inputTokens, ans.outputTokens), result });
  return done({ error: null, result: { ...result, lookupId: row!.id }, reused: false });
}));

const useSchema = z.object({
  source: z.enum(['wikidata', 'page', 'ai']),
  /** For source 'ai': the lookup the values came from, so each keeps its sentence. */
  lookupId: z.string().regex(UUID).nullish(),
  itemId: z.string().regex(/^Q\d+$/).nullish(),
  link: z.string().trim().url().max(2000).nullish(),
  /** Exactly the fields the person ticked, with the values as they left them. */
  values: z.record(z.string().max(60), z.any()).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 40, 'Tick at least one field'),
});

vodDetailsRouter.post('/:id/details/use', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const a = await owned(String(req.params.id), acct);
  if (!a) throw notFound('VOD asset not found');
  if (!a.schema_id) throw badRequest('Choose a content type first: the details are matched to its fields.');
  const b = useSchema.parse(req.body ?? {});
  // A Wikidata item is named by its id; a page by its address.
  if (b.source === 'wikidata' && !b.itemId) throw new ApiError(422, 'itemId: a Wikidata item id (Q...) is needed');
  if (b.source !== 'wikidata' && !(b.link && /^https?:\/\//i.test(b.link))) throw new ApiError(422, 'link: the page address is needed');
  const lookup = b.source === 'ai'
    ? (b.lookupId ? await one<any>(`SELECT id, model, result FROM ai_lookups WHERE id = $1 AND account_id = $2 AND vod_asset_id = $3 AND status = 'ok'`, [b.lookupId, acct, a.id]) : null)
    : null;
  if (b.source === 'ai' && !lookup) throw new ApiError(422, 'lookupId: the AI lookup these values came from is needed');
  const fields = fieldsOf(a);
  // Only the type's fields, each checked as the metadata form's save checks it (422 on a bad value).
  const unknown = Object.keys(b.values).filter((k) => !fields.some((f) => f.key === k));
  if (unknown.length) throw new ApiError(422, `Not a field of ${a.schema_name}: ${unknown.join(', ')}`);
  let fill = validateMetadata(fields, b.values, 'reject');
  // An image found on the web goes into the Image Library first; the field holds the library reference.
  const { internaliseImages } = await import('../services/media/libraryImages');
  const { assetPlaceFolder } = await import('../services/media/assetImage');
  const folder = (await assetPlaceFolder(a.id)) ?? `assets/${a.id}`;
  fill = await internaliseImages(acct, fields, fill, folder);
  if (!Object.keys(fill).length) throw badRequest('Nothing to change: the ticked fields are empty.');
  const by = (await actorLabel(req)) ?? 'someone';
  const at = new Date().toISOString();
  const link = b.link || `https://www.wikidata.org/wiki/${b.itemId}`;
  const site = b.source !== 'wikidata' ? (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return null; } })() : null;
  const whence = b.source === 'page' ? { site } : b.source === 'ai' ? { site, model: lookup.model, lookup: lookup.id } : { item: b.itemId };
  // An AI value keeps the sentence of the page it came from, for whoever checks it later.
  const said = (k: string) => (b.source === 'ai' ? { sentence: lookup.result?.from?.[k] ?? null } : {});
  const pv = Object.fromEntries(Object.keys(fill).map((k) => [k, { source: b.source, ...whence, ...said(k), chosen: true, approvedBy: by, link, at, was: a.metadata?.[k] ?? null }]));
  await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1`,
    [a.id, JSON.stringify(fill), JSON.stringify(pv)]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes: { found_details: { from: Object.fromEntries(Object.keys(fill).map((k) => [k, a.metadata?.[k] ?? null])), to: fill }, found_in: { from: null, to: { source: b.source, ...whence, link } } } });
  const after = await one<any>(`SELECT metadata, metadata_provenance, updated_at FROM vod_assets WHERE id = $1`, [a.id]);
  res.json({ changed: Object.keys(fill), metadata: after?.metadata ?? {}, provenance: after?.metadata_provenance ?? {}, updatedAt: after?.updated_at ?? null });
}));
