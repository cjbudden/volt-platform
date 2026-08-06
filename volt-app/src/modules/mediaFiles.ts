import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict } from '../util/http';
import { actor, writeAudit, VersionConflict } from '../services/audit';
import { imageStore, safeKey } from '../services/imageStore';
import { probeImage } from '../services/imageDims';

export const mediaFilesRouter = Router();
mediaFilesRouter.use(requireAuth);

const KIND = z.enum(['watermark', 'slate', 'poster', 'brand', 'keyframe', 'other']);

function cleanPath(p: string): string {
  return safeKey(p).replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
function folderOf(path: string): string { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
function storeKeyFor(account: string, path: string): string { return `library/${account}/${path}`; }
function urlFor(storeKey: string): string { return '/' + storeKey; }

/** List / browse / search the account's images. */
mediaFilesRouter.get('/', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const { folder, kind, q, tag, recursive } = req.query as Record<string, string>;
  const where: string[] = ['account_id = $1']; const params: any[] = [acc];
  if (folder !== undefined) {
    if (recursive === '1') { params.push(folder ? folder + '%' : '%'); where.push(`(folder LIKE $${params.length})`); }
    else { params.push(folder); where.push(`folder = $${params.length}`); }
  }
  if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR path ILIKE $${params.length})`); }
  if (tag) { params.push(tag); where.push(`$${params.length} = ANY(tags)`); }
  const rows = await query(`SELECT * FROM media_files WHERE ${where.join(' AND ')} ORDER BY folder, name`, params);
  res.json(rows.map((r: any) => ({ ...r, url: urlFor(r.store_key) })));
}));

/** Folder tree: explicit folders + every folder implied by a file path. */
mediaFilesRouter.get('/folders', asyncHandler(async (req, res) => {
  const acc = accountId(req);
  const explicit = await query('SELECT path FROM media_folders WHERE account_id = $1', [acc]);
  const fromFiles = await query('SELECT DISTINCT folder AS path FROM media_files WHERE account_id = $1 AND folder <> \'\'', [acc]);
  const set = new Set<string>();
  for (const r of [...explicit, ...fromFiles]) {
    const p = (r as any).path as string;
    // add every ancestor so the tree is complete
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  const counts = await query(
    `SELECT folder, count(*)::int AS n FROM media_files WHERE account_id = $1 GROUP BY folder`, [acc]);
  const countMap = new Map(counts.map((c: any) => [c.folder, c.n]));
  const folders = [...set].sort().map((path) => ({ path, name: path.split('/').pop(), count: countMap.get(path) ?? 0 }));
  res.json({ folders });
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
  const contentType = b.contentType || info.contentType || 'application/octet-stream';
  const storeKey = storeKeyFor(acc, path);
  await imageStore().put(storeKey, buf, contentType);
  const who = actor(req);
  const row = await one<any>(
    `INSERT INTO media_files(account_id, kind, path, folder, name, content_type, size_bytes, width, height, tags, store_key, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [acc, b.kind, path, folder, name, contentType, buf.length, info.width, info.height, b.tags ?? [], storeKey, who.userId]
  );
  await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label,
    action: 'create', entityType: 'media_file', entityId: row.id, snapshot: { path, kind: b.kind, bytes: buf.length } });
  res.status(201).json({ ...row, url: urlFor(row.store_key) });
}));

mediaFilesRouter.get('/:id', asyncHandler(async (req, res) => {
  const row = await one<any>('SELECT * FROM media_files WHERE id=$1 AND account_id=$2', [req.params.id, accountId(req)]);
  if (!row) throw notFound('Image not found');
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
