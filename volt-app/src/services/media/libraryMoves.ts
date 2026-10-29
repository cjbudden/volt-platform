// ============================================================================
//  MOVING IMAGES BETWEEN FOLDERS, AND REMOVING EMPTY FOLDERS (docs/IMAGES.md
//  section 18).
//
//  An image's store key IS its folder path (library/<account>/<folder>/<name>),
//  and everything that uses an image holds that key in some form: an asset's
//  main image and typed images, a channel's slate, watermark, brand or guide
//  icon, an account logo, image fields in metadata, publications, URLs pasted
//  into pages and feeds, signed image-service URLs already handed out. Moving
//  the bytes alone would break all of them. So a move does three things:
//
//    1. moves the object in the store and the media_files row (one transaction
//       per file; a name already taken in the target folder is skipped and said);
//    2. rewrites every reference held in the database: every text, varchar,
//       JSON and text-array column of every table, read from the schema, so a
//       column added later is covered too whatever it is called (a JSON list of
//       candidate frames, a song lookup's chosen cover, a field in a
//       template). Only history is left as it was: audit, logs, events, play
//       and ad sessions, the restore bin's snapshots (HISTORY_TABLES); what they
//       hold still opens through the forwarding in 3;
//    3. records the move (media_file_moves), and the image store FORWARDS reads
//       of the old key to the new one (imageStore.ts), for everything outside
//       the database: links in web pages, partner feeds, signed URLs.
//
//  A folder can be removed only when it holds no images, in it or in any
//  folder below it. Its empty subfolders go with it.
// ============================================================================
import { one, query, tx } from '../../db';
import { imageStore, safeKey } from '../imageStore';

// '' is the top level. path.normalize('') is '.', which would make a folder called '.'.
const cleanPath = (p: string) => { const k = safeKey(p || '').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''); return k === '.' ? '' : k.replace(/^\.\//, ''); };
const storeKeyFor = (acc: string, path: string) => `library/${acc}/${path}`;

// ---------------------------------------------------------------- forwarding

const fwdCache = new Map<string, { to: string | null; at: number }>();
const FWD_TTL_MS = 60_000;

/** Where a moved library key lives now (following a chain), or null. Cached a minute. */
export async function resolveMoved(key: string): Promise<string | null> {
  if (!key.startsWith('library/')) return null;
  const c = fwdCache.get(key);
  if (c && Date.now() - c.at < FWD_TTL_MS) return c.to;
  let to: string | null = null;
  try {
    let cur = key;
    for (let i = 0; i < 8; i++) {
      const r = await one<any>(`SELECT new_key FROM media_file_moves WHERE old_key = $1`, [cur]);
      if (!r) break;
      cur = r.new_key; to = cur;
    }
  } catch { to = null; /* table not there yet: nothing moved */ }
  if (fwdCache.size > 5000) fwdCache.clear();
  fwdCache.set(key, { to, at: Date.now() });
  return to;
}

/** Drop cached forwarding for these keys (a restore put them back). */
export function forgetForwarding(keys: string[]) { for (const k of keys) fwdCache.delete(k); }

async function recordMove(acc: string, oldKey: string, newKey: string) {
  // Moved back where it was: no forwarding needed for that key any more.
  await query(`DELETE FROM media_file_moves WHERE old_key = $1`, [newKey]);
  // Earlier moves now point straight at the newest place.
  await query(`UPDATE media_file_moves SET new_key = $2, moved_at = now() WHERE new_key = $1`, [oldKey, newKey]);
  await query(`INSERT INTO media_file_moves (old_key, new_key, account_id) VALUES ($1,$2,$3)
               ON CONFLICT (old_key) DO UPDATE SET new_key = EXCLUDED.new_key, moved_at = now()`, [oldKey, newKey, acc]);
  fwdCache.delete(oldKey); fwdCache.delete(newKey);
}

// ---------------------------------------------------------------- references

type ColType = 'text' | 'jsonb' | 'json' | 'array';
interface RefColumn { table: string; column: string; type: ColType; json: boolean }
let refColumns: RefColumn[] | null = null;
/** The library's own bookkeeping (moved by the move itself). */
const SKIP_TABLES = new Set(['media_files', 'media_file_moves', 'media_folders', 'schema_migrations', 'vod_asset_files', 'sprite_sheets']);
/** History and high-volume logs: what happened stays as it was recorded (and still opens through forwarding). */
export const HISTORY_TABLES = new Set(['audit_log', 'audit_events', 'jobs', 'job_logs', 'trash_items', 'ad_beacons', 'ad_decisions',
  'addon_runs', 'addon_run_events', 'air_sessions', 'analytics_rollups', 'epg_import_runs', 'gfx_snapshots', 'gfx_state_log',
  'listener_sessions', 'media_events', 'notification_deliveries', 'notifications', 'play_sessions', 'player_events', 'qc_events',
  'run_stops', 'stream_events', 'stream_status', 'upload_sessions', 'usage_accruals', 'usage_records', 'vod_ad_events',
  'vod_ad_sessions', 'workflow_events']);

/** Every column that can hold a library reference: text, varchar, JSON, text arrays, in every table but history. Read once per process. */
export async function referenceColumns(): Promise<RefColumn[]> {
  if (refColumns) return refColumns;
  const rows = await query<any>(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema()
       AND (c.data_type IN ('text', 'character varying', 'jsonb', 'json') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))`);
  refColumns = rows.filter((r) => !SKIP_TABLES.has(r.table_name) && !HISTORY_TABLES.has(r.table_name) && !/audit/.test(r.table_name))
    .map((r) => {
      const type: ColType = r.data_type === 'jsonb' ? 'jsonb' : r.data_type === 'json' ? 'json' : r.data_type === 'ARRAY' ? 'array' : 'text';
      return { table: r.table_name, column: r.column_name, type, json: type === 'jsonb' || type === 'json' };
    });
  return refColumns;
}
/** For tests: read the schema again (a column was added). */
export function forgetReferenceColumns() { refColumns = null; }

const encodeKey = (k: string) => k.split('/').map((s) => encodeURIComponent(s)).join('/');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const qi = (id: string) => `"${id.replace(/"/g, '""')}"`;

/**
 * Replace every reference to the old keys (as a key, a /library/ path or a URL,
 * plain or percent-encoded) in every reference column. Answers how many values
 * changed, by table.column.
 */
export async function rewriteReferences(acc: string, pairs: { oldKey: string; newKey: string; oldPath: string; newPath: string }[]): Promise<Record<string, number>> {
  const changed: Record<string, number> = {};
  if (!pairs.length) return changed;
  const forms = pairs.flatMap((p) => [[p.oldKey, p.newKey], [encodeKey(p.oldKey), encodeKey(p.newKey)]]).filter(([a, b], i, all) => a !== b && all.findIndex((x) => x[0] === a) === i);
  // A key followed by another name character is a different file (x.png vs x.png.bak).
  const rx = new RegExp(`(${forms.map(([a]) => esc(a)).join('|')})(?![\\w.%-])`, 'g');
  const to = new Map(forms.map(([a, b]) => [a, b]));
  const likes = forms.map(([a]) => `%${a.replace(/[\\%_]/g, '\\$&')}%`);
  for (const c of await referenceColumns()) {
    const sel = c.type === 'text' ? qi(c.column) : `${qi(c.column)}::text`;
    const cast = c.type === 'jsonb' ? '::jsonb' : c.type === 'json' ? '::json' : c.type === 'array' ? '::text[]' : '';
    let rows: any[];
    try { rows = await query<any>(`SELECT ctid::text AS ctid, ${sel} AS v FROM ${qi(c.table)} WHERE ${sel} LIKE ANY($1)`, [likes]); }
    catch { continue; }    // a column that went away
    for (const r of rows) {
      const nv = String(r.v).replace(rx, (m) => to.get(m) ?? m);
      if (nv === r.v) continue;
      await query(`UPDATE ${qi(c.table)} SET ${qi(c.column)} = $1${cast} WHERE ctid = $2::tid`, [nv, r.ctid]);
      changed[`${c.table}.${c.column}`] = (changed[`${c.table}.${c.column}`] ?? 0) + 1;
    }
  }
  // Channels and events may also hold a bare library path (no account in it): scoped to the account.
  for (const table of ['channels', 'events']) {
    for (const c of (await referenceColumns()).filter((x) => x.table === table && x.type === 'text' && x.column.endsWith('_ref'))) {
      for (const p of pairs) {
        const r = await query(`UPDATE ${qi(table)} x SET ${qi(c.column)} = $3 FROM groups g
                                WHERE g.id = x.group_id AND g.account_id = $1 AND x.${qi(c.column)} = $2 RETURNING x.id`, [acc, p.oldPath, p.newPath]).catch(() => []);
        if (r.length) changed[`${table}.${c.column}`] = (changed[`${table}.${c.column}`] ?? 0) + r.length;
      }
    }
  }
  try { (await import('../../scale/cache')).invalidateTag(`acct:${acc}`); } catch { /* no cache */ }
  return changed;
}

// ---------------------------------------------------------------- moving

export interface MoveResult {
  moved: { id: string; from: string; to: string }[];
  skipped: { id: string; name: string; reason: string }[];
  references: Record<string, number>;
}

/** Move library images into `folder` ('' = the top level), keeping their names. */
export async function moveFiles(acc: string, ids: string[], folderIn: string, who: { userId: string | null }): Promise<MoveResult> {
  return relocate(acc, ids.map((id) => ({ id, folder: folderIn ?? '' })), who);
}

/**
 * Move and/or rename images: each to `folder`, as `name` when given (else its own
 * name). References are rewritten and old addresses forward, as for any move.
 */
// ---------------------------------------------------------------- items made of several files
//
// A video item (alpha video for graphics, motionGraphics.ts) is ONE library row and THREE objects:
//   <folder>/<base>.webm          what templates play            metadata.motion.video
//   <folder>/<base>.png           its first frame: the store_key metadata.motion.poster
//   <folder>/<base>.source.<ext>  the file as uploaded           metadata.motion.source
// Everything that moves, renames, replaces or deletes an item does it to all of its files,
// so they always sit together under the item's path.

export type PartRole = 'main' | 'poster' | 'video' | 'source';
export interface ItemPart { role: PartRole; key: string }

export const isVideoItem = (row: any) => !!row?.metadata?.motion?.video;

/** The objects an item is made of, where they are now. */
export function partsOf(row: any): ItemPart[] {
  if (!isVideoItem(row)) return [{ role: 'main', key: row.store_key }];
  const m = row.metadata.motion;
  const parts: ItemPart[] = [{ role: 'poster', key: row.store_key }, { role: 'video', key: m.video }];
  if (m.source) parts.push({ role: 'source', key: m.source });
  return parts;
}

/** Where each of an item's objects belongs when the item is at `path` (folder/name). */
export function partsAt(acc: string, row: any, path: string): ItemPart[] {
  if (!isVideoItem(row)) return [{ role: 'main', key: storeKeyFor(acc, path) }];
  const base = path.replace(/\.webm$/i, '');
  const ext = String(row.metadata.motion.source ?? '').match(/\.source\.([a-z0-9]+)$/i)?.[1] ?? 'mov';
  return partsOf(row).map((p) => ({ role: p.role, key: storeKeyFor(acc, p.role === 'poster' ? `${base}.png` : p.role === 'video' ? `${base}.webm` : `${base}.source.${ext}`) }));
}
const relOf = (acc: string, key: string) => key.startsWith(`library/${acc}/`) ? key.slice(`library/${acc}/`.length) : key;
const motionWith = (row: any, parts: ItemPart[]) => {
  if (!isVideoItem(row)) return row.metadata ?? {};
  const k = (r: PartRole) => parts.find((p) => p.role === r)?.key;
  return { ...row.metadata, motion: { ...row.metadata.motion, poster: k('poster'), video: k('video'), ...(k('source') ? { source: k('source') } : {}) } };
};

/**
 * Move an item's objects from `from` to `to` (same roles). Poster first: an item split by an
 * earlier move may have its first frame where its video belongs. Answers the pairs moved. A
 * target already taken by something else stops it before anything moves.
 */
async function moveParts(from: ItemPart[], to: ItemPart[]): Promise<{ oldKey: string; newKey: string }[]> {
  const store = imageStore();
  const order: PartRole[] = ['main', 'poster', 'video', 'source'];
  const plan = order.map((r) => ({ a: from.find((p) => p.role === r), b: to.find((p) => p.role === r) }))
    .filter((x): x is { a: ItemPart; b: ItemPart } => !!x.a && !!x.b && x.a.key !== x.b.key);
  const ownKeys = new Set(from.map((p) => p.key));
  for (const { b } of plan) {
    if (!ownKeys.has(b.key) && await store.exists(b.key)) throw Object.assign(new Error(`a file called ${b.key.split('/').pop()} is already there`), { skip: true });
  }
  const moved: { oldKey: string; newKey: string }[] = [];
  for (const { a, b } of plan) {
    if (await store.exists(a.key)) await store.move(a.key, b.key);
    moved.push({ oldKey: a.key, newKey: b.key });
  }
  return moved;
}

export async function relocate(acc: string, items: { id: string; folder: string; name?: string }[], who: { userId: string | null }): Promise<MoveResult> {
  const out: MoveResult = { moved: [], skipped: [], references: {} };
  const ids = items.map((i) => i.id);
  const rows = await query<any>(`SELECT * FROM media_files WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acc, ids]);
  for (const id of ids) if (!rows.some((r) => r.id === id)) out.skipped.push({ id, name: id, reason: 'not found' });
  const pairs: { oldKey: string; newKey: string; oldPath: string; newPath: string }[] = [];
  const made = new Set<string>();
  for (const cur of rows) {
    const it = items.find((i) => i.id === cur.id)!;
    const folder = cleanPath(it.folder ?? '');
    let name = (it.name ?? cur.name).replace(/[/\\]/g, '_');
    // A video item's name is its WebM's; its first frame and original follow it (partsAt).
    if (isVideoItem(cur) && !/\.webm$/i.test(name)) name = `${name.replace(/\.[^.]+$/, '')}.webm`;
    if (cur.source === 'encoder') { out.skipped.push({ id: cur.id, name: cur.name, reason: 'encoder thumbnails stay in their channel\'s dated folders' }); continue; }
    const path = folder ? `${folder}/${name}` : name;
    const from = partsOf(cur), to = partsAt(acc, cur, path);
    if (path === cur.path && from.every((p) => to.find((q) => q.role === p.role)?.key === p.key)) { out.skipped.push({ id: cur.id, name: cur.name, reason: 'already in that folder' }); continue; }
    let moved: { oldKey: string; newKey: string }[] = [];
    try {
      await tx(async (c) => {
        const clash = (await c.query('SELECT id FROM media_files WHERE account_id=$1 AND path=$2 AND id<>$3', [acc, path, cur.id])).rows[0];
        if (clash) throw Object.assign(new Error(`an image called ${name} is already in ${folder || 'the top level'}`), { skip: true });
        moved = await moveParts(from, to);
        const main = to.find((p) => p.role === 'main' || p.role === 'poster')!.key;
        await c.query(`UPDATE media_files SET folder=$1, name=$6, path=$2, store_key=$3, metadata=$7::jsonb, version=version+1, updated_by=$4, updated_at=now() WHERE id=$5`,
          [folder, path, main, who.userId, cur.id, name, JSON.stringify(motionWith(cur, to))]);
      });
    } catch (e: any) {
      // Whatever moved before the failure goes back, so the item's files stay together.
      for (const m of [...moved].reverse()) await imageStore().move(m.newKey, m.oldKey).catch(() => {});
      out.skipped.push({ id: cur.id, name: cur.name, reason: e?.skip ? e.message : `could not be moved: ${String(e?.message ?? e).slice(0, 160)}` });
      continue;
    }
    for (const m of moved) {
      await recordMove(acc, m.oldKey, m.newKey);
      pairs.push({ oldKey: m.oldKey, newKey: m.newKey, oldPath: relOf(acc, m.oldKey), newPath: relOf(acc, m.newKey) });
    }
    out.moved.push({ id: cur.id, from: cur.path, to: path });
    if (folder) made.add(folder);
  }
  // A move the person asked for keeps its target folder; a background rename does not need to.
  for (const f of made) if (items.length && !(items[0] as any).auto) await query('INSERT INTO media_folders(account_id, path) VALUES ($1,$2) ON CONFLICT DO NOTHING', [acc, f]);
  out.references = await rewriteReferences(acc, pairs);
  return out;
}

/**
 * NAMES THAT FOLLOW THE ASSET. Images Volt saved for an asset (metadata.assetId)
 * are named <asset>-<hash>.jpg (typed: <asset>-<type>-<hash>.jpg) in the asset's
 * folder. Earlier ones were poster.jpg / poster-<hash>.jpg, in folders that kept
 * a file extension in the name or were dated 1970-01-01; and an asset renamed
 * later should take its images with it. This moves up to `limit` of them to
 * where they belong (references rewritten, old addresses forward, emptied
 * folders removed). Run by the asset-image sweep until nothing is left.
 */
export async function tidyAssetImageNames(limit = 50): Promise<{ renamed: number; checked: number }> {
  const rows = await query<any>(`
    SELECT f.id, f.account_id, f.folder, f.name, f.checksum, f.metadata->>'imageType' AS type, v.id AS asset_id, v.title
      FROM media_files f JOIN vod_assets v ON v.id::text = f.metadata->>'assetId'
     WHERE f.source = 'auto' AND f.checksum IS NOT NULL AND f.content_type = 'image/jpeg'
       -- not yet named for the asset's current name (never checked, or the asset was renamed)
       AND COALESCE(f.metadata->>'namedFor', '') <> COALESCE(v.title, '')
     ORDER BY f.created_at LIMIT $1`, [limit]);
  const { assetPlaceFolder } = await import('./assetImage');
  const { assetImageName } = await import('./libraryPaths');
  let renamed = 0;
  const byAcct = new Map<string, { id: string; folder: string; name: string; auto: true }[]>();
  const emptied = new Map<string, string[]>();
  for (const r of rows) {
    const folder = await assetPlaceFolder(r.asset_id);
    if (!folder) continue;
    const name = assetImageName(r.title, r.checksum, r.type && r.type !== 'primary' ? r.type : null);
    if (folder === r.folder && name === r.name) continue;
    byAcct.set(r.account_id, [...(byAcct.get(r.account_id) ?? []), { id: r.id, folder, name, auto: true }]);
    emptied.set(r.account_id, [...(emptied.get(r.account_id) ?? []), r.folder]);
  }
  for (const [acc, items] of byAcct) {
    const res = await relocate(acc, items, { userId: null });
    renamed += res.moved.length;
    await pruneEmptyFolders(acc, emptied.get(acc) ?? []);
  }
  // Checked against this name: not looked at again until the asset is renamed.
  for (const r of rows) await query(`UPDATE media_files SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('namedFor', $2::text) WHERE id = $1`, [r.id, r.title ?? '']);
  return { renamed, checked: rows.length };
}

/**
 * After a single file was moved by PATCH /api/files/:id (rename or new folder):
 * the same forwarding and reference update as a bulk move.
 */
export async function afterSingleMove(acc: string, oldKey: string, newKey: string, oldPath: string, newPath: string): Promise<Record<string, number>> {
  if (oldKey === newKey) return {};
  await recordMove(acc, oldKey, newKey);
  return rewriteReferences(acc, [{ oldKey, newKey, oldPath, newPath }]);
}

// ---------------------------------------------------------------- folders

/** What a folder holds, counting everything below it. */
export async function folderContents(acc: string, pathIn: string): Promise<{ path: string; images: number; here: number; inSubfolders: number; subfolders: string[] }> {
  const path = cleanPath(pathIn);
  if (!path) throw Object.assign(new Error('say which folder'), { status: 400 });
  const like = `${path.replace(/[\\%_]/g, '\\$&')}/%`;
  const n = await one<any>(`SELECT count(*) FILTER (WHERE folder = $2)::int AS here, count(*) FILTER (WHERE folder LIKE $3)::int AS below
                              FROM media_files WHERE account_id = $1 AND (folder = $2 OR folder LIKE $3)`, [acc, path, like]);
  const subs = await query<any>(`SELECT DISTINCT path FROM (
                                   SELECT path FROM media_folders WHERE account_id = $1 AND path LIKE $2
                                   UNION SELECT folder AS path FROM media_files WHERE account_id = $1 AND folder LIKE $2) s ORDER BY path`, [acc, like]);
  const here = Number(n?.here ?? 0), below = Number(n?.below ?? 0);
  return { path, images: here + below, here, inSubfolders: below, subfolders: subs.map((s) => s.path) };
}

/** Remove a folder that holds no images (its empty subfolders go too). */
export async function deleteFolder(acc: string, pathIn: string): Promise<{ removed: string[] }> {
  const c = await folderContents(acc, pathIn);
  const known = await one<any>(`SELECT 1 FROM media_folders WHERE account_id = $1 AND (path = $2 OR path LIKE $3) LIMIT 1`, [acc, c.path, `${c.path.replace(/[\\%_]/g, '\\$&')}/%`]);
  if (!known && !c.images) throw Object.assign(new Error(`There is no folder "${c.path}"`), { status: 404 });
  if (c.images) {
    const where = [c.here ? `${c.here} here` : '', c.inSubfolders ? `${c.inSubfolders} in folders inside it` : ''].filter(Boolean).join(' and ');
    throw Object.assign(new Error(`"${c.path}" is not empty: it holds ${c.images} image${c.images === 1 ? '' : 's'} (${where}). Move or delete ${c.images === 1 ? 'it' : 'them'} first.`), { status: 409, contents: c });
  }
  const removed = await query<any>(`DELETE FROM media_folders WHERE account_id = $1 AND (path = $2 OR path LIKE $3) RETURNING path`, [acc, c.path, `${c.path.replace(/[\\%_]/g, '\\$&')}/%`]);
  return { removed: removed.map((r) => r.path).sort() };
}

// ---------------------------------------------------------------- after retention

/**
 * EMPTY FOLDERS GO WITH THEIR LAST IMAGE. After retention (or an asset's
 * removal) has taken images out of these folders, each one that no longer holds
 * any image, in it or below it, is removed, and so is each folder above it that
 * is now empty, stopping at the first that still holds something. That covers
 * folders a person created and retention then emptied. A local image store also
 * loses the empty directories. Folders that never held anything this pass
 * touched are left alone: an empty folder a person just made is not retention's.
 */
export async function pruneEmptyFolders(acc: string, folders: string[]): Promise<{ folders: string[]; dirs: number }> {
  const out = { folders: [] as string[], dirs: 0 };
  const seen = new Set<string>();
  for (const start of [...new Set(folders.map((f) => cleanPath(f)).filter(Boolean))]) {
    let p = start;
    while (p && !seen.has(p)) {
      seen.add(p);
      const like = `${p.replace(/[\\%_]/g, '\\$&')}/%`;
      const n = await one<any>(`SELECT 1 AS x FROM media_files WHERE account_id = $1 AND (folder = $2 OR folder LIKE $3) LIMIT 1`, [acc, p, like]);
      if (n) break;
      const gone = await query<any>(`DELETE FROM media_folders WHERE account_id = $1 AND (path = $2 OR path LIKE $3) RETURNING path`, [acc, p, like]);
      out.folders.push(...gone.map((g) => g.path));
      const st: any = imageStore();
      if (typeof st.pruneDirs === 'function') out.dirs += await st.pruneDirs(storeKeyFor(acc, p), `library/${acc}`).catch(() => 0);
      p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    }
  }
  return out;
}

let lastTidy = 0;
/** Once an hour at most: empty directories left anywhere in a local store's library (none in S3). */
export async function tidyEmptyDirs(force = false): Promise<number> {
  if (!force && Date.now() - lastTidy < 3600_000) return 0;
  lastTidy = Date.now();
  const st: any = imageStore();
  return typeof st.pruneTree === 'function' ? st.pruneTree('library') : 0;
}

// ---------------------------------------------------------------- duplicates

export interface DupFile { id: string; path: string; name: string; source: string | null; kind: string; size: number; createdAt: string; storeKey: string }
export interface DupGroup { checksum: string; keep: DupFile; drop: DupFile[] }

/**
 * Which copy of the same picture stays: one a person uploaded before one Volt
 * made, then one outside the encoder's thumbnails, then the oldest.
 */
export function chooseKeeper<T extends { source: string | null; path: string; createdAt: string }>(files: T[]): T {
  const rank = (f: T) => [f.source === 'upload' || f.source === 'watchfolder' ? 0 : 1, f.path.startsWith('thumbnails/') ? 1 : 0, Date.parse(f.createdAt) || 0];
  return [...files].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })[0];
}

/** Every set of library images with the same bytes (encoder stills and sprite sheets aside). */
export async function findDuplicates(acc: string, keepers: Record<string, string> = {}): Promise<DupGroup[]> {
  const rows = await query<any>(`
    SELECT id, path, name, source, kind, size_bytes, created_at, store_key, checksum FROM media_files
     WHERE account_id = $1 AND checksum IS NOT NULL AND COALESCE(source, '') <> 'encoder' AND kind NOT IN ('storyboard')
       -- A video item's checksum is its first frame's, and many videos open on the same empty
       -- (transparent) frame: they are not duplicates of each other. Videos are left out.
       AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'motion')
       AND checksum IN (SELECT checksum FROM media_files WHERE account_id = $1 AND checksum IS NOT NULL AND COALESCE(source, '') <> 'encoder'
                         AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'motion')
                         GROUP BY checksum HAVING count(*) > 1)
     ORDER BY checksum, created_at`, [acc]);
  const groups = new Map<string, DupFile[]>();
  for (const r of rows) {
    const f: DupFile = { id: r.id, path: r.path, name: r.name, source: r.source, kind: r.kind, size: Number(r.size_bytes) || 0, createdAt: new Date(r.created_at).toISOString(), storeKey: r.store_key };
    groups.set(r.checksum, [...(groups.get(r.checksum) ?? []), f]);
  }
  return [...groups.entries()].filter(([, fs]) => fs.length > 1).map(([checksum, fs]) => {
    const keep = fs.find((f) => f.id === keepers[checksum]) ?? chooseKeeper(fs);
    return { checksum, keep, drop: fs.filter((f) => f.id !== keep.id) };
  });
}

/**
 * Merge duplicates: everything that used a copy (assets, typed images,
 * channels, metadata, song details, links) is pointed at the one that stays,
 * the copies' old addresses forward to it, and the copies are removed. A
 * copy's folder goes too when it is left empty. `keepers` picks the copy to
 * keep per checksum; otherwise chooseKeeper decides.
 */
export async function mergeDuplicates(acc: string, opts: { keepers?: Record<string, string>; checksums?: string[]; userId?: string | null } = {}): Promise<{ groups: number; removed: number; bytes: number; references: Record<string, number>; binIds: string[] }> {
  let groups = await findDuplicates(acc, opts.keepers ?? {});
  if (opts.checksums?.length) groups = groups.filter((g) => opts.checksums!.includes(g.checksum));
  const out = { groups: groups.length, removed: 0, bytes: 0, references: {} as Record<string, number>, binIds: [] as string[] };
  for (const g of groups) {
    const r = await replaceImages(acc, g.keep.id, g.drop.map((d) => d.id), { userId: opts.userId ?? null, reason: 'a duplicate of the image that stays' });
    for (const [k, n] of Object.entries(r.references)) out.references[k] = (out.references[k] ?? 0) + n;
    out.removed += r.removed.length; out.bytes += r.bytes;
    if (r.binId) out.binIds.push(r.binId);
  }
  return out;
}

/** An image Volt saves that is already in the library, byte for byte: its key, so no copy is made. */
export async function existingCopy(acc: string, checksum: string): Promise<string | null> {
  const r = await one<any>(`SELECT store_key FROM media_files WHERE account_id = $1 AND checksum = $2 AND COALESCE(source, '') <> 'encoder' ORDER BY created_at LIMIT 1`, [acc, checksum]).catch(() => null);
  if (!r) return null;
  return (await imageStore().exists(r.store_key)) ? r.store_key : null;
}

/**
 * Replay every recorded move through the reference rewrite. Moves made before the rewrite read
 * every column (it used to go by column name) may have left a reference behind in a column it did
 * not read: it still opened through forwarding, but "is this image used?" checks compare keys.
 * Safe to run any number of times; a reference already rewritten is not found again.
 */
export async function repairMovedReferences(): Promise<{ moves: number; references: Record<string, number> }> {
  const out = { moves: 0, references: {} as Record<string, number> };
  let rows: any[];
  try { rows = await query<any>(`SELECT account_id, old_key, new_key FROM media_file_moves WHERE account_id IS NOT NULL ORDER BY account_id`); }
  catch { return out; }   // no moves table yet
  const byAcc = new Map<string, any[]>();
  for (const r of rows) byAcc.set(r.account_id, [...(byAcc.get(r.account_id) ?? []), r]);
  for (const [acc, list] of byAcc) {
    const pre = `library/${acc}/`;
    const pairs = list.filter((r) => r.old_key.startsWith(pre) && r.new_key.startsWith(pre))
      .map((r) => ({ oldKey: r.old_key, newKey: r.new_key, oldPath: r.old_key.slice(pre.length), newPath: r.new_key.slice(pre.length) }));
    for (let i = 0; i < pairs.length; i += 200) {
      const changed = await rewriteReferences(acc, pairs.slice(i, i + 200));
      for (const [k, n] of Object.entries(changed)) out.references[k] = (out.references[k] ?? 0) + n;
    }
    out.moves += pairs.length;
  }
  return out;
}

// ---------------------------------------------------------------- where an image is used

export interface ImageUse { table: string; column: string; id: string | null; label: string | null; what: string }

/** What a row in each table is, in words (anything else shows its table name). */
const WHAT: Record<string, string> = {
  channels: 'Channel', events: 'Event', vod_assets: 'Asset', vod_asset_images: 'Asset image', recordings: 'Recording',
  apps: 'App', accounts: 'Account', song_details: 'Song', publications: 'Social post', programmes: 'Programme',
  programme_series: 'Series', gfx_setups: 'Graphics setup', gfx_templates: 'Graphics template', player_configs: 'Player',
  channel_ads: 'Channel ads', vod_ad_rules: 'Ad rule', filler_assets: 'Filler', collections: 'Collection', products: 'Product',
};
let tableCols: Map<string, Set<string>> | null = null;
async function columnsOf(table: string): Promise<Set<string>> {
  if (!tableCols) {
    tableCols = new Map();
    for (const r of await query<any>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)) {
      if (!tableCols.has(r.table_name)) tableCols.set(r.table_name, new Set());
      tableCols.get(r.table_name)!.add(r.column_name);
    }
  }
  return tableCols.get(table) ?? new Set();
}

/**
 * Everything that uses each image: the same columns a move rewrites (every text, JSON and
 * array column but history), matched the same way (the key, a /library/ path or a URL,
 * plain or percent-encoded, never a longer name that starts the same; a bare path in a
 * channel or event *_ref, within the account). Answers uses per file id.
 */
export async function findUses(acc: string, files: { id: string; storeKey: string; path: string; keys?: string[] }[]): Promise<Record<string, ImageUse[]>> {
  const out: Record<string, ImageUse[]> = Object.fromEntries(files.map((f) => [f.id, [] as ImageUse[]]));
  if (!files.length) return out;
  const tests = files.map((f) => {
    // Every file of the item (a video item's WebM and original as well as its first frame).
    const keys = [...new Set([f.storeKey, ...(f.keys ?? [])])];
    const forms = [...new Set(keys.flatMap((k) => [k, encodeKey(k)]))];
    return { id: f.id, path: f.path, rx: new RegExp(`(${forms.map(esc).join('|')})(?![\\w.%-])`), likes: forms.map((a) => `%${a.replace(/[\\%_]/g, '\\$&')}%`) };
  });
  const likes = tests.flatMap((t) => t.likes);
  const seen = new Set<string>();
  const add = (fid: string, u: ImageUse) => { const k = `${fid}|${u.table}|${u.id}|${u.column}`; if (!seen.has(k)) { seen.add(k); out[fid].push(u); } };
  for (const c of await referenceColumns()) {
    const cols = await columnsOf(c.table);
    const sel = c.type === 'text' ? qi(c.column) : `${qi(c.column)}::text`;
    const idSel = cols.has('id') ? 'id::text' : 'NULL';
    const label = ['name', 'title', 'label'].filter((x) => cols.has(x)).map(qi);
    const labelSel = label.length ? `COALESCE(${label.map((l) => `${l}::text`).join(', ')})` : 'NULL';
    let rows: any[];
    try { rows = await query<any>(`SELECT ${idSel} AS id, ${labelSel} AS label, ${sel} AS v FROM ${qi(c.table)} WHERE ${sel} LIKE ANY($1) LIMIT 500`, [likes]); }
    catch { continue; }
    for (const r of rows) for (const t of tests) if (t.rx.test(String(r.v))) add(t.id, { table: c.table, column: c.column, id: r.id, label: r.label, what: WHAT[c.table] ?? c.table });
  }
  for (const table of ['channels', 'events']) {
    for (const c of (await referenceColumns()).filter((x) => x.table === table && x.type === 'text' && x.column.endsWith('_ref'))) {
      const rows = await query<any>(`SELECT x.id::text AS id, x.name AS label, x.${qi(c.column)} AS v FROM ${qi(table)} x JOIN groups g ON g.id = x.group_id
                                      WHERE g.account_id = $1 AND x.${qi(c.column)} = ANY($2::text[])`, [acc, tests.map((t) => t.path)]).catch(() => []);
      for (const r of rows) for (const t of tests) if (r.v === t.path) add(t.id, { table, column: c.column, id: r.id, label: r.label, what: WHAT[table] });
    }
  }
  // An asset's typed image says which asset.
  for (const fid of Object.keys(out)) {
    const ids = out[fid].filter((u) => u.table === 'vod_asset_images' && u.id).map((u) => u.id!);
    if (!ids.length) continue;
    const names = await query<any>(`SELECT i.id::text AS id, v.title FROM vod_asset_images i JOIN vod_assets v ON v.id = i.asset_id WHERE i.id::text = ANY($1)`, [ids]).catch(() => []);
    for (const u of out[fid]) if (u.table === 'vod_asset_images') u.label = names.find((n: any) => n.id === u.id)?.title ?? u.label;
  }
  return out;
}

// ---------------------------------------------------------------- replacing one image with another

export class ReplaceError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

/**
 * REPLACE IMAGES WITH ONE THAT STAYS: a duplicate found by its bytes, or one a person says is
 * the same picture (another export, another size). Everything that used a removed image uses
 * the one that stays (references rewritten as for a move), its old address forwards there, and
 * the removed images go to the restore bin with their library rows, so nothing is lost: a
 * restore puts the files and rows back (uses stay on the image that was kept).
 */
export async function replaceImages(acc: string, keepId: string, dropIds: string[], who: { userId: string | null; reason?: string }): Promise<{
  kept: { id: string; path: string }; removed: { id: string; path: string }[]; bytes: number; references: Record<string, number>; binId: string | null;
}> {
  const drop = [...new Set(dropIds)].filter((d) => d !== keepId);
  if (!drop.length) throw new ReplaceError('Choose at least one other image to replace.');
  const keep = await one<any>(`SELECT * FROM media_files WHERE id = $1 AND account_id = $2`, [keepId, acc]);
  if (!keep) throw new ReplaceError('The image to keep was not found.', 404);
  const rows = await query<any>(`SELECT * FROM media_files WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acc, drop]);
  if (rows.length !== drop.length) throw new ReplaceError('An image to replace was not found.', 404);
  if (rows.some((r) => r.source === 'encoder')) throw new ReplaceError('Encoder stills stay with their channel; they cannot be replaced.');
  if (rows.some((r) => r.store_key === keep.store_key)) throw new ReplaceError('That is the same file.');
  if (rows.some((r) => isVideoItem(r) !== isVideoItem(keep))) {
    throw new ReplaceError(isVideoItem(keep) ? 'An image can only be replaced with another image, not a video.' : 'A video can only be replaced with another video.');
  }

  // Every file of a replaced item points at the same part of the one that stays (a video's
  // WebM at its WebM, its first frame at its first frame, its original at its original).
  const keepParts = partsOf(keep);
  const partPairs = rows.flatMap((d) => partsOf(d).map((p) => ({ oldKey: p.key, newKey: (keepParts.find((k) => k.role === p.role) ?? keepParts[0]).key })));
  const pairs = partPairs.map((p) => ({ ...p, oldPath: relOf(acc, p.oldKey), newPath: relOf(acc, p.newKey) }));
  const references = await rewriteReferences(acc, pairs);
  const { BinItem, snapshotDelete } = await import('./trash');
  const bin = await BinItem.open({ accountId: acc, kind: 'media_file', subjectId: keep.id,
    label: rows.length === 1 ? `${rows[0].name} (replaced by ${keep.name})` : `${rows.length} images replaced by ${keep.name}`,
    reason: who.reason ?? 'replaced by another image', createdBy: who.userId });
  let bytes = 0;
  for (const d of rows) {
    for (const p of partsOf(d)) await bin.image(p.key, p.key === d.store_key ? Number(d.size_bytes ?? 0) : 0);
    bytes += Number(d.size_bytes ?? 0);
  }
  await snapshotDelete(bin, 'media_files', rows.map((d) => d.id));
  await query(`DELETE FROM media_files WHERE id = ANY($1::uuid[])`, [rows.map((d) => d.id)]);
  for (const p of partPairs) await recordMove(acc, p.oldKey, p.newKey);
  const binId = await bin.save({ replacedBy: keep.id, unforward: partPairs.map((p) => p.oldKey) });
  await pruneEmptyFolders(acc, rows.map((d) => d.folder).filter(Boolean)).catch(() => 0);
  return { kept: { id: keep.id, path: keep.path }, removed: rows.map((d) => ({ id: d.id, path: d.path })), bytes, references, binId };
}

/** Delete every file of an item from the store (a video item's WebM, first frame and original). */
export async function deleteItemFiles(row: any): Promise<number> {
  let n = 0;
  for (const p of partsOf(row)) { await imageStore().delete(p.key).catch(() => {}); n++; }
  return n;
}

/**
 * VIDEO ITEMS SPLIT BY AN EARLIER MOVE. Before moves knew a video item is several files, a move
 * took only the first frame (and named it like the WebM) and left the WebM and the original in
 * the old folder. This puts each item's files back together under its path, records the
 * forwarding and rewrites references, as a move would. Safe to run again: a whole item is left alone.
 */
export async function repairVideoItems(acc?: string): Promise<{ checked: number; repaired: { id: string; path: string }[]; skipped: { id: string; path: string; reason: string }[] }> {
  const rows = await query<any>(`SELECT * FROM media_files WHERE COALESCE(metadata, '{}'::jsonb) ? 'motion' AND metadata->'motion' ? 'video'
                                   AND ($1::uuid IS NULL OR account_id = $1) ORDER BY account_id`, [acc ?? null]);
  const out = { checked: rows.length, repaired: [] as { id: string; path: string }[], skipped: [] as { id: string; path: string; reason: string }[] };
  for (const row of rows) {
    const a = row.account_id as string;
    const from = partsOf(row), to = partsAt(a, row, row.path);
    if (from.every((p) => to.find((q) => q.role === p.role)?.key === p.key)) continue;
    let moved: { oldKey: string; newKey: string }[] = [];
    try {
      moved = await moveParts(from, to);
      await query(`UPDATE media_files SET store_key = $2, metadata = $3::jsonb, version = version + 1, updated_at = now() WHERE id = $1`,
        [row.id, to.find((p) => p.role === 'poster')!.key, JSON.stringify(motionWith(row, to))]);
    } catch (e: any) {
      for (const m of [...moved].reverse()) await imageStore().move(m.newKey, m.oldKey).catch(() => {});
      out.skipped.push({ id: row.id, path: row.path, reason: String(e?.message ?? e).slice(0, 200) });
      continue;
    }
    for (const m of moved) await recordMove(a, m.oldKey, m.newKey);
    await rewriteReferences(a, moved.map((m) => ({ ...m, oldPath: relOf(a, m.oldKey), newPath: relOf(a, m.newKey) })));
    out.repaired.push({ id: row.id, path: row.path });
  }
  return out;
}
