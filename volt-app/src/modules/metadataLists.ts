// ============================================================================
//  METADATA LISTS (Admin > Genres): the account's own pick lists.
//
//    GET   /api/metadata-lists                 the lists, with counts
//    GET   /api/metadata-lists/:key            one list: items in order, how
//                                              many things carry each value,
//                                              which type fields use it
//    PUT   /api/metadata-lists/:key            save the whole list
//          { items: [{value, retired?}], renames?: [{from, to}], version? }
//    POST  /api/metadata-lists/:key/reset      back to the platform defaults
//                                              (values in use kept, retired)
//
//  Only 'genres' today. Rules are in services/metadataLists.ts: a value in use
//  is never silently dropped; it is retired, renamed or merged.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import {
  LIST_KEYS, STANDARD_LISTS, isListKey, getList, listUsage, listLinks, saveList, resetItems, defaultItems,
  type ListKey, type ListItem,
} from '../services/metadataLists';

export const metadataListsRouter = Router();
metadataListsRouter.use(requireAuth);

function keyOf(raw: string): ListKey {
  if (!isListKey(raw)) throw notFound(`There is no list "${raw}". Lists: ${LIST_KEYS.join(', ')}.`);
  return raw;
}

async function view(account: string, key: ListKey) {
  const [list, usage, links] = await Promise.all([getList(account, key), listUsage(account, key), listLinks(account, key)]);
  return {
    key, name: STANDARD_LISTS[key].name, description: STANDARD_LISTS[key].description,
    items: list.items.map((i) => ({ value: i.value, retired: !!i.retired, usage: usage[i.value] ?? 0 })),
    // Values something carries that the list no longer has (a type edited by
    // hand before it was linked, an import): shown so they can be added back.
    unlisted: Object.entries(usage).filter(([v]) => !list.items.some((i) => i.value === v)).map(([value, count]) => ({ value, usage: count })),
    isDefault: list.isDefault, version: list.version, updatedAt: list.updatedAt,
    defaults: STANDARD_LISTS[key].defaults,
    usedBy: links,
  };
}

metadataListsRouter.get('/', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const out = [];
  for (const key of LIST_KEYS) {
    const l = await getList(acct, key);
    out.push({ key, name: STANDARD_LISTS[key].name, description: STANDARD_LISTS[key].description,
      count: l.items.filter((i) => !i.retired).length, retired: l.items.filter((i) => i.retired).length, isDefault: l.isDefault });
  }
  res.json(out);
}));

metadataListsRouter.get('/:key', asyncHandler(async (req, res) => {
  res.json(await view(accountId(req), keyOf(req.params.key)));
}));

const putSchema = z.object({
  items: z.array(z.union([z.string(), z.object({ value: z.string(), retired: z.boolean().optional() })])),
  renames: z.array(z.object({ from: z.string(), to: z.string() })).max(500).optional(),
  version: z.number().int().optional(),
});

async function audit(req: any, id: string, key: ListKey, before: ListItem[], after: ListItem[], extra: Record<string, any> = {}) {
  const who = actor(req);
  await writeAudit(null, {
    accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'metadata_list', entityId: id,
    changes: { items: { from: before.map((i) => i.retired ? `${i.value} (retired)` : i.value), to: after.map((i) => i.retired ? `${i.value} (retired)` : i.value) }, ...extra },
    snapshot: { key },
  });
}

metadataListsRouter.put('/:key', asyncHandler(async (req, res) => {
  const key = keyOf(req.params.key);
  const acct = accountId(req);
  const body = putSchema.parse(req.body ?? {});
  const before = await getList(acct, key);
  const im = req.get('If-Match');
  const expected = im ? parseInt(im.replace(/"/g, ''), 10) : body.version ?? null;
  const r = await saveList(acct, key, body.items, body.renames ?? [], actor(req).userId, expected);
  await audit(req, r.list.id!, key, before.items, r.list.items,
    body.renames?.length ? { renames: { from: null, to: body.renames.map((x) => `${x.from} → ${x.to}`) } } : {});
  res.set('ETag', String(r.list.version));
  res.json({ ...(await view(acct, key)), saved: { renamed: r.renamed, typesUpdated: r.typesUpdated, removed: r.removed } });
}));

metadataListsRouter.post('/:key/reset', asyncHandler(async (req, res) => {
  const key = keyOf(req.params.key);
  const acct = accountId(req);
  const before = await getList(acct, key);
  const items = before.isDefault ? defaultItems(key) : resetItems(key, before.items, await listUsage(acct, key));
  const r = await saveList(acct, key, items, [], actor(req).userId, null);
  await audit(req, r.list.id!, key, before.items, r.list.items, { reset: { from: null, to: 'platform defaults' } });
  res.json({ ...(await view(acct, key)), saved: { renamed: 0, typesUpdated: r.typesUpdated, removed: r.removed } });
}));
