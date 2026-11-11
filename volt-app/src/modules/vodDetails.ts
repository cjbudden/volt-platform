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
//    POST /api/vod/:id/details/use { source, itemId | link, values }
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

vodDetailsRouter.get('/:id/finder', asyncHandler(async (req, res) => {
  const a = await owned(String(req.params.id), accountId(req));
  if (!a) throw notFound('VOD asset not found');
  const finder = finderFor(a.schema_key);
  res.json({
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

const useSchema = z.object({
  source: z.enum(['wikidata', 'page']),
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
  if (b.source === 'page' && !(b.link && /^https?:\/\//i.test(b.link))) throw new ApiError(422, 'link: the page address is needed');
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
  const site = b.source === 'page' ? (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return null; } })() : null;
  const whence = b.source === 'page' ? { site } : { item: b.itemId };
  const pv = Object.fromEntries(Object.keys(fill).map((k) => [k, { source: b.source, ...whence, chosen: true, approvedBy: by, link, at, was: a.metadata?.[k] ?? null }]));
  await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1`,
    [a.id, JSON.stringify(fill), JSON.stringify(pv)]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes: { found_details: { from: Object.fromEntries(Object.keys(fill).map((k) => [k, a.metadata?.[k] ?? null])), to: fill }, found_in: { from: null, to: { source: b.source, ...whence, link } } } });
  const after = await one<any>(`SELECT metadata, metadata_provenance, updated_at FROM vod_assets WHERE id = $1`, [a.id]);
  res.json({ changed: Object.keys(fill), metadata: after?.metadata ?? {}, provenance: after?.metadata_provenance ?? {}, updatedAt: after?.updated_at ?? null });
}));
