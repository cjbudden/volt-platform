import { Router } from 'express';
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

const KIND = z.enum(['watermark', 'slate', 'poster', 'brand', 'keyframe', 'storyboard', 'other']);

function cleanPath(p: string): string {
  return safeKey(p).replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
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

/** All folder paths for an account: explicit folders plus every folder a file implies. */
async function allFolderPaths(acc: string): Promise<{ paths: string[]; counts: Map<string, number> }> {
  const explicit = await query('SELECT path FROM media_folders WHERE account_id = $1', [acc]);
  const counts = await query(
    `SELECT folder, count(*)::int AS n FROM media_files WHERE account_id = $1 AND folder <> '' GROUP BY folder`, [acc]);
  const set = new Set<string>();
  for (const r of [...explicit.map((e: any) => e.path), ...counts.map((c: any) => c.folder)] as string[]) {
    const parts = r.split('/');
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return { paths: [...set].sort(), counts: new Map(counts.map((c: any) => [c.folder, c.n])) };
}

/** Files AND folders for one search box: { folders, files, total }. */
mediaFilesRouter.get('/search', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const qs = req.query as Record<string, string>;
  const f = filtersFrom(qs);
  const [files, tree] = await Promise.all([searchFiles(acc, { ...f, limit: f.limit ?? 200 }), f.q ? allFolderPaths(acc) : null]);
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
  const { q, parent } = req.query as Record<string, string>;
  const { paths, counts } = await allFolderPaths(acc);
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
  if (parent !== undefined) return res.json({ folders: childFolders(paths, parent).map(shape) });
  res.json({ folders: paths.map((path) => ({ path, name: path.split('/').pop(), count: counts.get(path) ?? 0 })) });
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

mediaFilesRouter.get('/:id', asyncHandler(async (req, res) => {
  const row = await one<any>('SELECT * FROM media_files WHERE id=$1 AND account_id=$2', [req.params.id, accountId(req)]);
  if (!row) throw notFound('Image not found');
  delete row.search;
  res.json({ ...row, url: urlFor(row.store_key) });
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

  const url = urlFor(row.store_key);
  const users = await query(
    `SELECT c.id, c.name FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE g.account_id=$1 AND (c.filler_slate_ref = $2 OR c.filler_slate_ref = $3)`,
    [acc, url, row.path]
  );
  if (!confirm) {
    return res.status(428).json({ confirmationRequired: true,
      message: `Delete image "${row.path}"? This can't be undone. Re-send with confirm=true.`,
      inUseBy: users });
  }
  if (users.length && !force) {
    return res.status(409).json({ error: 'Image is in use', inUseBy: users,
      message: `Used as a slate by ${users.length} channel(s). Reassign them or re-send with force=true.` });
  }
  await imageStore().delete(row.store_key);
  await query('DELETE FROM media_files WHERE id=$1', [row.id]);
  const who = actor(req);
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'delete', entityType: 'media_file', entityId: row.id,
    snapshot: { path: row.path, forced: !!users.length } });
  res.status(204).end();
}));
