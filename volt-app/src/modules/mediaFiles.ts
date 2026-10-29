import express, { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict, badRequest } from '../util/http';
import { actor, writeAudit, VersionConflict } from '../services/audit';
import { imageStore, safeKey } from '../services/imageStore';
import { probeImage } from '../services/imageDims';
import { readImageFacts } from '../services/images/metadata';
import { insertMediaRow, refreshMediaFacts, rowsNeedingFacts } from '../services/mediaLibrary';
import { buildFileSearch, childFolders, matchFolders, type FileFilters } from '../services/mediaSearch';

export const mediaFilesRouter = Router();
mediaFilesRouter.use(requireAuth);

// 'storyboard' (sprite sheets) is gone: they live in the sprite store (thumbnails/spriteStore.ts), not the library.
const KIND = z.enum(['watermark', 'slate', 'poster', 'cover', 'brand', 'bug', 'keyframe', 'motion', 'other', 'imported']);

// A BUG's advertising metadata (migration 0084): who it is for, who made it, which campaign,
// and the ad's industry code. Kept small on purpose.
const AD = z.object({
  advertiser: z.string().trim().max(200).optional().nullable(),
  agency: z.string().trim().max(200).optional().nullable(),
  campaign: z.string().trim().max(200).optional().nullable(),
  adCode: z.string().trim().max(80).optional().nullable(),
});
type Ad = z.infer<typeof AD>;
const cleanAd = (a: Ad | undefined | null) => {
  const out: Record<string, string> = {};
  for (const k of ['advertiser', 'agency', 'campaign', 'adCode'] as const) if (a?.[k]) out[k] = String(a[k]);
  return out;
};
/** schema.org for a bug (JSON-LD). schema.org has no advertisement type: the closest fit is the
 *  creative work itself with sponsor (the advertiser), producer (the agency), isPartOf (the
 *  campaign, as a CreativeWorkSeries) and identifier (Ad-ID or key number). */
function adJsonLd(row: any) {
  const ad = row.metadata?.ad; if (!ad) return null;
  const video = !!row.metadata?.motion?.video;
  return {
    '@context': 'https://schema.org', '@type': video ? 'VideoObject' : 'ImageObject', name: row.name, genre: 'Advertising',
    contentUrl: '/' + (video ? row.metadata.motion.video : row.store_key), ...(video ? { thumbnailUrl: '/' + row.store_key } : {}),
    ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
    ...(ad.advertiser ? { sponsor: { '@type': 'Organization', name: ad.advertiser } } : {}),
    ...(ad.agency ? { producer: { '@type': 'Organization', name: ad.agency } } : {}),
    ...(ad.campaign ? { isPartOf: { '@type': 'CreativeWorkSeries', name: ad.campaign } } : {}),
    ...(ad.adCode ? { identifier: { '@type': 'PropertyValue', propertyID: 'Ad-ID', value: ad.adCode } } : {}),
  };
}

function cleanPath(p: string): string {
  // '' is the top level: path.normalize('') is '.', which made a folder called '.'.
  const k = safeKey(p || '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return k === '.' ? '' : k.replace(/^\.\//, '');
}
function folderOf(path: string): string { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
function storeKeyFor(account: string, path: string): string { return `library/${account}/${path}`; }
function urlFor(storeKey: string): string { return '/' + storeKey; }

/** Query string -> search filters (shared by the list and the combined search). */
function filtersFrom(qs: Record<string, string>): FileFilters {
  const num = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  let near: FileFilters['near'];
  if (qs.near) {
    const [lat, lng, km] = qs.near.split(',').map(Number);
    if (![lat, lng].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('near must be lat,lng[,km]');
    near = { lat, lng, km: Number.isFinite(km) && km > 0 ? Math.min(km, 20000) : 25 };
  }
  const iso = (v?: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw badRequest(`not a date: ${v}`);
    return d.toISOString();
  };
  const sort = qs.sort as FileFilters['sort'];
  if (sort && !['name', 'newest', 'oldest', 'taken', 'relevance'].includes(sort)) throw badRequest('sort must be name, newest, oldest, taken or relevance');
  return {
    q: qs.q, folder: qs.folder, recursive: qs.recursive === '1', kind: qs.kind, tag: qs.tag,
    source: qs.source, channel: qs.channel, from: iso(qs.from), to: iso(qs.to),
    hasLocation: qs.hasLocation === '1', near, sort, limit: num(qs.limit), offset: num(qs.offset),
  };
}

async function searchFiles(acc: string, f: FileFilters) {
  const b = buildFileSearch(acc, f);
  const rows = await query(
    `SELECT *, count(*) OVER() AS _total FROM media_files WHERE ${b.where} ORDER BY ${b.order} LIMIT ${b.limit} OFFSET ${b.offset}`,
    b.params);
  const total = rows.length ? Number((rows[0] as any)._total) : 0;
  return { total, items: rows.map((r: any) => { const { _total, search, ...rest } = r; return { ...rest, url: urlFor(r.store_key) }; }) };
}

/** List / browse / search the account's images.
 *  folder, recursive=1, kind, tag, q, source (upload|watchfolder|encoder), channel,
 *  from/to (captured or taken), hasLocation=1, near=lat,lng,km, sort, limit, offset.
 *  Answers an array (X-Total-Count says how many matched). */
mediaFilesRouter.get('/', asyncHandler(async (req, res) => {
  const r = await searchFiles(accountId(req), filtersFrom(req.query as Record<string, string>));
  res.set('X-Total-Count', String(r.total));
  res.json(r.items);
}));

/** Which images a count covers, as the grid's source filter does: 'library' = everything but
 *  encoder thumbnails, 'encoder' = only those, anything else = all. */
function sourceSql(source?: string): string {
  return source === 'library' ? ` AND COALESCE(source, '') <> 'encoder'` : source === 'encoder' ? ` AND source = 'encoder'` : '';
}

/** All folder paths for an account: explicit folders plus every folder a file implies.
 *  COUNTS FOLLOW THE GRID. They used to count every image whatever the grid showed, so with
 *  "Uploaded" selected a folder of encoder stills read 1,440 and opened empty. With a source,
 *  only matching images count, and folders that hold none of them are not listed (a folder a
 *  person created is, at 0). */
async function allFolderPaths(acc: string, source?: string): Promise<{ paths: string[]; counts: Map<string, number>; top: number }> {
  const explicit = await query('SELECT path FROM media_folders WHERE account_id = $1', [acc]);
  const counts = await query(
    `SELECT folder, count(*)::int AS n FROM media_files WHERE account_id = $1${sourceSql(source)} GROUP BY folder`, [acc]);
  const top = Number(counts.find((c: any) => c.folder === '')?.n ?? 0);
  counts.splice(0, counts.length, ...counts.filter((c: any) => c.folder !== ''));
  const set = new Set<string>();
  for (const r of [...explicit.map((e: any) => e.path), ...counts.map((c: any) => c.folder)] as string[]) {
    const parts = r.split('/');
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return { paths: [...set].sort(), counts: new Map(counts.map((c: any) => [c.folder, c.n])), top };
}

/** Files AND folders for one search box: { folders, files, total }. */
mediaFilesRouter.get('/search', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const qs = req.query as Record<string, string>;
  const f = filtersFrom(qs);
  const [files, tree] = await Promise.all([searchFiles(acc, { ...f, limit: f.limit ?? 200 }), f.q ? allFolderPaths(acc, (f as any).source) : null]);
  const folders = tree ? matchFolders(tree.paths, f.q!).map((path) => ({
    path, name: path.split('/').pop(), count: tree.counts.get(path) ?? 0,
  })) : [];
  res.json({ folders, files: files.items, total: files.total });
}));

/** Re-read metadata from the stored bytes: one file. */
mediaFilesRouter.post('/:id/metadata/refresh', asyncHandler(async (req, res) => {
  const row = await one<any>('SELECT * FROM media_files WHERE id=$1 AND account_id=$2', [req.params.id, accountId(req)]);
  if (!row) throw notFound('Image not found');
  const body = await imageStore().get(row.store_key);
  if (!body) throw notFound('Image bytes are missing from the store');
  const updated = await refreshMediaFacts(row.id, await readImageFacts(body));
  const { search, ...rest } = updated;
  res.json({ ...rest, url: urlFor(updated.store_key) });
}));

/** Backfill metadata for files uploaded before it was captured. Batches of up to 200. */
mediaFilesRouter.post('/metadata/backfill', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const mine = await rowsNeedingFacts(acc, 200);
  let done = 0, missing = 0;
  for (const r of mine) {
    const body = await imageStore().get(r.store_key);
    if (!body) { missing++; continue; }
    await refreshMediaFacts(r.id, await readImageFacts(body));
    done++;
  }
  const left = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM media_files WHERE account_id = $1 AND checksum IS NULL AND source <> 'encoder'`, [acc]);
  res.json({ refreshed: done, missing, remaining: left?.n ?? 0 });
}));

/** Folder tree: explicit folders + every folder implied by a file path.
 *  ?parent=<path> answers only that folder's children (lazy tree);
 *  ?q=<words> answers folders whose path contains every word. */
mediaFilesRouter.get('/folders', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const { q, parent, source } = req.query as Record<string, string>;
  const { paths, counts, top } = await allFolderPaths(acc, source);
  const deep = (p: string) => {
    let n = 0;
    for (const [f, c] of counts) if (f === p || f.startsWith(p + '/')) n += c;
    return n;
  };
  const shape = (path: string) => ({
    path, name: path.split('/').pop(), count: counts.get(path) ?? 0, total: deep(path),
    hasChildren: paths.some((x) => x.startsWith(path + '/')),
  });
  if (q && q.trim()) return res.json({ folders: matchFolders(paths, q).map(shape) });
  // `total`: every matching image in the library, top level included (the tree's "All images").
  if (parent !== undefined) return res.json({ folders: childFolders(paths, parent).map(shape), total: top + [...counts.values()].reduce((a, b) => a + b, 0), top });
  res.json({ folders: paths.map((path) => ({ path, name: path.split('/').pop(), count: counts.get(path) ?? 0 })) });
}));

/** Images with the same bytes, grouped: which copy stays (a person's upload first, then the
 *  oldest) and which go. Nothing changes. */
mediaFilesRouter.get('/duplicates', asyncHandler(async (req, res) => {
  const groups = await (await import('../services/media/libraryMoves')).findDuplicates(accountId(req));
  res.json({ groups: groups.map((g) => ({ ...g, keep: { ...g.keep, url: urlFor(g.keep.storeKey) }, drop: g.drop.map((d) => ({ ...d, url: urlFor(d.storeKey) })) })),
    copies: groups.reduce((n, g) => n + g.drop.length, 0), bytes: groups.reduce((n, g) => n + g.drop.reduce((m, d) => m + d.size, 0), 0) });
}));

/** Merge duplicates: whatever used a copy uses the one that stays, old addresses forward, copies go.
 *  { keepers?: {checksum: fileId}, checksums?: [...] } limits or steers it. */
mediaFilesRouter.post('/duplicates/merge', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = z.object({ keepers: z.record(z.string().uuid()).optional(), checksums: z.array(z.string().max(128)).max(5000).optional() }).parse(req.body ?? {});
  const who = actor(req);
  const r = await (await import('../services/media/libraryMoves')).mergeDuplicates(acc, { ...b, userId: who.userId });
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'delete', entityType: 'media_file', entityId: 'duplicates',
    snapshot: { groups: r.groups, removed: r.removed, bytes: r.bytes, references: r.references } });
  res.json(r);
}));

/** Where images are used: every place a move would rewrite (assets, typed images, channels,
 *  metadata, song details, social posts, links...). GET /api/files/uses?ids=a,b */
mediaFilesRouter.get('/uses', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const ids = String(req.query.ids ?? '').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 50);
  if (!ids.length) throw badRequest('ids: one or more image ids, comma separated');
  const rows = await query<any>(`SELECT id, store_key, path, metadata FROM media_files WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acc, ids]);
  const { findUses, partsOf } = await import('../services/media/libraryMoves');
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ uses: await findUses(acc, rows.map((r) => ({ id: r.id, storeKey: r.store_key, path: r.path, keys: partsOf(r).map((x) => x.key) }))) });
}));

/** Replace images with one that stays (a duplicate, or the same picture in another file):
 *  everything that used them uses `keep`, their old addresses forward there, and they go to
 *  the restore bin. { keep: id, drop: [ids] } */
mediaFilesRouter.post('/replace', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = z.object({ keep: z.string().uuid(), drop: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body ?? {});
  const who = actor(req);
  const { replaceImages, ReplaceError } = await import('../services/media/libraryMoves');
  try {
    const r = await replaceImages(acc, b.keep, b.drop, { userId: who.userId });
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'delete', entityType: 'media_file', entityId: r.kept.id,
      snapshot: { replaced: r.removed, keptPath: r.kept.path, references: r.references, binId: r.binId } });
    res.json(r);
  } catch (e: any) {
    if (e instanceof ReplaceError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

/** Move images to a folder ('' = top level), keeping their names. References to them are
 *  rewritten and their old addresses forward (services/media/libraryMoves.ts). */
mediaFilesRouter.post('/move', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), folder: z.string().max(500) }).parse(req.body ?? {});
  const who = actor(req);
  const r = await (await import('../services/media/libraryMoves')).moveFiles(acc, b.ids, b.folder, who);
  for (const m of r.moved) await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'update', entityType: 'media_file', entityId: m.id, snapshot: { from: m.from, to: m.to } });
  res.json(r);
}));

/** What a folder holds (everything below it counted): whether it can be removed. */
mediaFilesRouter.get('/folders/contents', asyncHandler(async (req, res) => {
  const { folderContents } = await import('../services/media/libraryMoves');
  try { res.json(await folderContents(accountId(req), String(req.query.path ?? ''))); }
  catch (e: any) { if (e?.status) return res.status(e.status).json({ error: e.message }); throw e; }
}));

/** Remove a folder. Only when it holds no images, in it or below it; its empty subfolders go too. */
mediaFilesRouter.delete('/folders', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const path = String(req.query.path ?? (req.body && req.body.path) ?? '');
  const { deleteFolder } = await import('../services/media/libraryMoves');
  try {
    const r = await deleteFolder(acc, path);
    const who = actor(req);
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'delete', entityType: 'media_folder', entityId: path, snapshot: r });
    res.json(r);
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, ...(e.contents ? { contents: e.contents } : {}) });
    throw e;
  }
}));

/** Create an (empty) folder. */
mediaFilesRouter.post('/folders', asyncHandler(async (req, res) => {
  const path = cleanPath(z.object({ path: z.string().min(1) }).parse(req.body).path);
  await query('INSERT INTO media_folders(account_id, path) VALUES ($1,$2) ON CONFLICT DO NOTHING', [accountId(req), path]);
  res.status(201).json({ path });
}));

const uploadSchema = z.object({
  folder: z.string().default(''),
  name: z.string().min(1),
  kind: KIND.default('other'),
  contentType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  dataBase64: z.string().min(1),   // the image bytes, base64 (data URL prefix tolerated)
  ad: AD.optional(),               // bugs: advertiser, agency, campaign, ad code
});

/** Upload an image (base64 body → store + indexed row). Direct-to-S3 presign is the
 *  cloud-scale path; this proxied upload keeps local dev + smaller images simple. */
mediaFilesRouter.post('/', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = uploadSchema.parse(req.body);
  const raw = b.dataBase64.includes(',') ? b.dataBase64.slice(b.dataBase64.indexOf(',') + 1) : b.dataBase64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw conflict('Empty image data');
  const folder = b.folder ? cleanPath(b.folder) : '';
  const name = b.name.replace(/[/\\]/g, '_');
  const path = folder ? `${folder}/${name}` : name;
  const exists = await one('SELECT id FROM media_files WHERE account_id=$1 AND path=$2', [acc, path]);
  if (exists) throw conflict(`An image already exists at ${path}`);
  const info = probeImage(buf);
  // What the file says about itself: dimensions, EXIF/GPS/IPTC/XMP, checksum.
  const facts = await readImageFacts(buf);
  const contentType = b.contentType || facts.contentType || info.contentType || 'application/octet-stream';
  const storeKey = storeKeyFor(acc, path);
  await imageStore().put(storeKey, buf, contentType);
  const who = actor(req);
  const row = await insertMediaRow({
    accountId: acc, kind: b.kind, path, folder, name, storeKey, sizeBytes: buf.length, contentType,
    tags: b.tags ?? [], userId: who.userId, source: 'upload',
    facts: { ...facts, width: facts.width ?? info.width, height: facts.height ?? info.height, contentType },
    ...(b.ad && Object.keys(cleanAd(b.ad)).length ? { extra: { ad: cleanAd(b.ad) } } : {}),
  });
  // Same bytes already in the library? Say so (informational, never refused).
  const dupes = await query(
    `SELECT id, path FROM media_files WHERE account_id = $1 AND checksum = $2 AND id <> $3 LIMIT 5`,
    [acc, facts.checksum, row.id]);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'create', entityType: 'media_file', entityId: row.id, snapshot: { path, kind: b.kind, bytes: buf.length } });
  delete row.search;
  res.status(201).json({ ...row, url: urlFor(row.store_key), duplicateOf: dupes });
}));

/** Upload a VIDEO, raw body: an animated bug or sting, ideally with transparency (ProRes
 *  4444, QuickTime Animation, WebM with alpha). Stored as VP9-with-alpha WebM plus a
 *  transparent first-frame PNG and the original (services/motionGraphics.ts).
 *  POST /api/files/motion?folder=&name=   body: the file */
mediaFilesRouter.post('/motion', express.raw({ type: () => true, limit: '520mb' }), asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const name = String(req.query.name ?? '').replace(/[/\\]/g, '_');
  if (!name) throw badRequest('Give the file a name (?name=).');
  const folder = req.query.folder ? cleanPath(String(req.query.folder)) : '';
  const { ingestMotion, MotionError } = await import('../services/motionGraphics');
  try {
    const who = actor(req);
    const kind = KIND.safeParse(req.query.kind ?? 'bug');
    const ad = cleanAd(AD.parse({ advertiser: req.query.advertiser, agency: req.query.agency, campaign: req.query.campaign, adCode: req.query.adCode }));
    const out = await ingestMotion({ accountId: acc, folder, name, data: body, userId: who.userId, kind: kind.success ? kind.data : 'bug', ad });
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'create', entityType: 'media_file', entityId: out.row.id,
      snapshot: { path: out.row.path, kind: 'motion', bytes: body.length, alpha: out.alpha } });
    delete out.row.search;
    res.status(201).json({ ...out.row, url: urlFor(out.row.store_key), videoUrl: '/' + out.row.metadata.motion.video, warning: out.warning });
  } catch (e: any) {
    if (e instanceof MotionError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

mediaFilesRouter.get('/:id', asyncHandler(async (req, res) => {
  const row = await one<any>('SELECT * FROM media_files WHERE id=$1 AND account_id=$2', [req.params.id, accountId(req)]);
  if (!row) throw notFound('Image not found');
  delete row.search;
  res.json({ ...row, url: urlFor(row.store_key), jsonLd: adJsonLd(row) });
}));

/** A bug's advertising metadata. PUT /api/files/:id/ad { advertiser, agency, campaign, adCode } (empty clears a field). */
mediaFilesRouter.put('/:id/ad', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const ad = cleanAd(AD.parse(req.body ?? {}));
  const row = await one<any>(`UPDATE media_files SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ad}', $3::jsonb), version = version + 1, updated_at = now()
                               WHERE id = $1 AND account_id = $2 RETURNING *`, [req.params.id, acc, JSON.stringify(ad)]);
  if (!row) throw notFound('Image not found');
  const who = actor(req);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'media_file', entityId: row.id, snapshot: { ad } });
  delete row.search;
  res.json({ ...row, url: urlFor(row.store_key), jsonLd: adJsonLd(row) });
}));

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  folder: z.string().optional(),
  kind: KIND.optional(),
  tags: z.array(z.string()).optional(),
  version: z.number().int().optional(),
});
/** Rename / move / re-tag. Moving in the DB also moves the object in the store. */
mediaFilesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const b = patchSchema.parse(req.body);
  const cur = await one<any>('SELECT * FROM media_files WHERE id=$1 AND account_id=$2', [req.params.id, acc]);
  if (!cur) throw notFound('Image not found');
  const im = req.get('If-Match');
  const expected = im ? parseInt(im.replace(/"/g, ''), 10) : (b.version ?? null);
  if (expected != null && Number(cur.version) !== Number(expected)) throw new VersionConflict(cur.version);

  const name = (b.name ?? cur.name).replace(/[/\\]/g, '_');
  const folder = b.folder !== undefined ? cleanPath(b.folder) : cur.folder;
  const path = folder ? `${folder}/${name}` : name;
  const moved = path !== cur.path;
  const newKey = storeKeyFor(acc, path);
  const who = actor(req);
  try {
    const row = await tx(async (c) => {
      if (moved) {
        const clash = (await c.query('SELECT id FROM media_files WHERE account_id=$1 AND path=$2 AND id<>$3', [acc, path, cur.id])).rows[0];
        if (clash) throw conflict(`An image already exists at ${path}`);
        await imageStore().move(cur.store_key, newKey);
      }
      return (await c.query(
        `UPDATE media_files SET name=$1, folder=$2, path=$3, store_key=$4, kind=$5, tags=$6,
           version=version+1, updated_by=$7, updated_at=now() WHERE id=$8 RETURNING *`,
        [name, folder, path, newKey, b.kind ?? cur.kind, b.tags ?? cur.tags, who.userId, cur.id]
      )).rows[0];
    });
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
      action: 'update', entityType: 'media_file', entityId: cur.id,
      snapshot: { from: cur.path, to: path, kind: row.kind } });
    // A moved image keeps working wherever it is used: references rewritten, old key forwards.
    if (moved) await (await import('../services/media/libraryMoves')).afterSingleMove(acc, cur.store_key, newKey, cur.path, path)
      .catch((e) => console.warn(`[files] references after moving ${cur.path} not all updated:`, e));
    res.set('ETag', String(row.version));
    delete row.search;
    res.json({ ...row, url: urlFor(row.store_key) });
  } catch (e) { if ((e as any)?.status) throw e; throw e; }
}));

/** Guarded delete: requires explicit confirmation and refuses while the image is in
 *  use (e.g. a channel slate) unless `force` is set. Every delete is audit-logged. */
mediaFilesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const confirm = req.query.confirm === 'true' || (req.body && req.body.confirm === true);
  const force = req.query.force === 'true' || (req.body && req.body.force === true);
  const row = await one<any>('SELECT * FROM media_files WHERE id=$1 AND account_id=$2', [req.params.id, acc]);
  if (!row) throw notFound('Image not found');

  // Everything that uses it (libraryMoves.ts findUses: assets, typed images, channels, metadata, links...).
  const { findUses, partsOf } = await import('../services/media/libraryMoves');
  const users = ((await findUses(acc, [{ id: row.id, storeKey: row.store_key, path: row.path, keys: partsOf(row).map((x) => x.key) }]))[row.id] ?? [])
    .map((u) => ({ ...u, name: u.label ? `${u.what}: ${u.label}` : u.what }));
  if (!confirm) {
    return res.status(428).json({ confirmationRequired: true,
      message: `Delete image "${row.path}"? This can't be undone. Re-send with confirm=true.`,
      inUseBy: users });
  }
  if (users.length && !force) {
    return res.status(409).json({ error: 'Image is in use', inUseBy: users,
      message: `Used in ${users.length} place(s). Replace it with another image (POST /api/files/replace), or re-send with force=true.` });
  }
  // Every file of the item: a video item's WebM, first frame and original go together.
  await (await import('../services/media/libraryMoves')).deleteItemFiles(row);
  await query('DELETE FROM media_files WHERE id=$1', [row.id]);
  const who = actor(req);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'delete', entityType: 'media_file', entityId: row.id,
    snapshot: { path: row.path, forced: !!users.length } });
  res.status(204).end();
}));
