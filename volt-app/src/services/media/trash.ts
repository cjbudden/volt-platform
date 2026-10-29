// ============================================================================
//  THE RESTORE BIN. docs/RETENTION.md.
//
//  Retention, the cleanup script and a library delete never destroy anything at
//  once. What they remove goes into a bin item:
//
//    files    whole trees (a run directory, an asset's encode output) or single files,
//             moved under VOLT_TRASH_DIR/<item>/ by rename, so it costs nothing and
//             restore is a rename back. Restore walks the tree in the bin and puts
//             every file back under where it came from, so a partial prune (some
//             segments of a run) and a whole-run removal restore the same way.
//    images   Image Library objects, moved inside the image store to trash/<item>/...
//    rows     the database rows the removal deleted, parents before children, and the
//             links it set to NULL, so a restore puts them back as they were.
//
//  An item is purged after VOLT_TRASH_DAYS (7 by default): that is the real deletion.
//  Restored media is put on hold, so the next retention sweep does not remove it again;
//  setting an expiry on it lets retention take it later.
// ============================================================================
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { one, query, tx } from '../../db';
import { imageStore } from '../imageStore';

export const TRASH_DAYS = Math.max(1, Number(process.env.VOLT_TRASH_DAYS ?? 7) || 7);
export function trashRoot(): string { return resolve(process.env.VOLT_TRASH_DIR ?? join(process.cwd(), 'trash')); }

export interface TrashFile { from: string; to: string }
export interface TrashImage { from: string; to: string }
export interface TrashRow { table: string; row: Record<string, any> }
export interface TrashRelink { table: string; column: string; ids: string[]; value: string }

/** Move a file or directory, across volumes if it must. */
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); return; } catch (e: any) { if (e?.code !== 'EXDEV') throw e; }
  const st = statSync(from);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const n of readdirSync(from)) move(join(from, n), join(to, n));
    rmSync(from, { recursive: true, force: true });
  } else { copyFileSync(from, to); unlinkSync(from); }
}

function treeStats(p: string): { bytes: number; files: number } {
  if (!existsSync(p)) return { bytes: 0, files: 0 };
  const st = statSync(p);
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0, files = 0;
  for (const n of readdirSync(p)) { const s = treeStats(join(p, n)); bytes += s.bytes; files += s.files; }
  return { bytes, files };
}

/**
 * A bin item being filled. Call file(), image() and rows() while removing, then save().
 * Files are moved as they are added, so a crash part-way leaves them in the bin, not lost.
 */
export class BinItem {
  readonly id: string;
  private files: TrashFile[] = [];
  private images: TrashImage[] = [];
  private rowsOut: TrashRow[] = [];
  private relinks: TrashRelink[] = [];
  private bytes = 0;
  private count = 0;
  constructor(id: string, readonly o: { accountId: string | null; kind: 'recording_media' | 'vod_asset' | 'media_file'; subjectId: string | null; label: string; reason: string; createdBy?: string | null }) {
    this.id = id;
  }
  static async open(o: BinItem['o']): Promise<BinItem> {
    const r = await one<any>(`SELECT gen_random_uuid() AS id`);
    return new BinItem(r!.id, o);
  }
  get dir(): string { return join(trashRoot(), this.id); }
  get isEmpty(): boolean { return !this.files.length && !this.images.length && !this.rowsOut.length; }

  /** Move a file or a whole directory into the bin. `group` names the subfolder it goes in. */
  file(path: string, group = 'files'): void {
    if (!existsSync(path)) return;
    const s = treeStats(path);
    const to = join(this.dir, group, String(this.files.length), path.split(/[\\/]/).pop() || 'x');
    move(path, to);
    this.files.push({ from: path, to });
    this.bytes += s.bytes; this.count += s.files;
  }
  /** Move single files that share a root (some segments of a run) into one mirrored tree. */
  filesUnder(root: string, paths: string[], group = 'files'): void {
    if (!paths.length) return;
    const to = join(this.dir, group, String(this.files.length));
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const sz = statSync(p).size;
      move(p, join(to, relative(root, p)));
      this.bytes += sz; this.count++;
    }
    this.files.push({ from: root, to });
  }
  async image(key: string, size = 0): Promise<void> {
    const to = `trash/${this.id}/${key}`;
    try { await imageStore().move(key, to); } catch { return; }
    this.images.push({ from: key, to }); this.bytes += size; this.count++;
  }
  rows(table: string, rows: Record<string, any>[]): void { for (const row of rows) this.rowsOut.push({ table, row }); }
  relink(table: string, column: string, ids: string[], value: string): void { if (ids.length) this.relinks.push({ table, column, ids, value }); }

  async save(hint: Record<string, any> = {}, c?: PoolClient): Promise<string> {
    const sql = `INSERT INTO trash_items(id, account_id, kind, subject_id, label, reason, bytes, file_count, files, images, rows, relinks, restore_hint, purge_after, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb, now() + make_interval(days => $14), $15)`;
    const params: any[] = [this.id, this.o.accountId, this.o.kind, this.o.subjectId, this.o.label.slice(0, 300), this.o.reason.slice(0, 500), this.bytes, this.count,
       JSON.stringify(this.files), JSON.stringify(this.images), JSON.stringify(this.rowsOut), JSON.stringify(this.relinks), JSON.stringify(hint),
       TRASH_DAYS, this.o.createdBy ?? null];
    if (c) await c.query(sql, params); else await query(sql, params);
    return this.id;
  }
}

// ---- rows: snapshot what a DELETE will take with it -------------------------------

interface FkEdge { child: string; column: string; rule: 'c' | 'n' }
const edgeCache = new Map<string, FkEdge[]>();
async function edgesInto(table: string): Promise<FkEdge[]> {
  if (edgeCache.has(table)) return edgeCache.get(table)!;
  const rows = await query<any>(
    `SELECT c.conrelid::regclass::text AS child, a.attname AS column, c.confdeltype AS rule
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND array_length(c.conkey, 1) = 1 AND c.confdeltype IN ('c', 'n')`, [table]);
  const out = rows.map((r: any) => ({ child: r.child, column: r.column, rule: r.rule }));
  edgeCache.set(table, out);
  return out;
}

/**
 * Snapshot the rows `DELETE FROM table WHERE id = ANY(ids)` would remove (cascades, three
 * levels) and the links it would set to NULL, into the bin item. Call before the delete.
 */
export async function snapshotDelete(item: BinItem, table: string, ids: string[], depth = 0): Promise<void> {
  if (!ids.length || depth > 3) return;
  // Ids compare as TEXT: a cascade reaches tables keyed by bigserial (review
  // notes, QC runs, ad rows...) as well as uuid, and `bigint = uuid` failed the
  // whole delete ("operator does not exist: bigint = uuid").
  const rows = await query<any>(`SELECT * FROM ${table} WHERE id::text = ANY($1::text[])`, [ids.map(String)]);
  item.rows(table, rows);
  for (const e of await edgesInto(table)) {
    const childHasId = await hasIdColumn(e.child);
    if (e.rule === 'n') {
      if (!childHasId) continue;
      for (const id of ids) {
        const hit = await query<any>(`SELECT id FROM ${e.child} WHERE ${e.column}::text = $1`, [String(id)]).catch(() => []);
        item.relink(e.child, e.column, hit.map((h: any) => String(h.id)), id);
      }
    } else if (childHasId) {
      const kids = await query<any>(`SELECT id FROM ${e.child} WHERE ${e.column}::text = ANY($1::text[])`, [ids.map(String)]).catch(() => null);
      if (kids) await snapshotDelete(item, e.child, kids.map((k: any) => String(k.id)), depth + 1);
    } else {
      // a link table with no id of its own (asset <-> collection, say): keep its rows as they are
      const kept = await query<any>(`SELECT * FROM ${e.child} WHERE ${e.column}::text = ANY($1::text[])`, [ids.map(String)]).catch(() => []);
      item.rows(e.child, kept);
    }
  }
}

const idCols = new Map<string, boolean>();
async function hasIdColumn(table: string): Promise<boolean> {
  if (idCols.has(table)) return idCols.get(table)!;
  const r = await query<any>(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`, [table.replace(/^public\./, '').replace(/"/g, '')]).catch(() => []);
  idCols.set(table, r.length > 0);
  return r.length > 0;
}

async function insertRow(c: PoolClient, table: string, row: Record<string, any>): Promise<void> {
  const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`, [table.replace(/^public\./, '')])).rows
    .map((r: any) => r.column_name).filter((n: string) => n in row);
  if (!cols.length) return;
  const list = cols.map((n: string) => `"${n}"`).join(', ');
  await c.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(row)]);
}

// ---- restore, purge, list ------------------------------------------------------------

/** Put every file under `to` back under `from`. A file already there is left alone. */
function putBack(from: string, to: string): { restored: number; kept: number } {
  let restored = 0, kept = 0;
  if (!existsSync(to)) return { restored, kept };
  const st = statSync(to);
  if (!st.isDirectory()) {
    if (existsSync(from)) { kept++; } else { move(to, from); restored++; }
    return { restored, kept };
  }
  for (const n of readdirSync(to)) {
    const r = putBack(join(from, n), join(to, n)); restored += r.restored; kept += r.kept;
  }
  return { restored, kept };
}

export interface RestoreResult { id: string; files: number; skipped: number; images: number; rows: number }

export async function restoreItem(id: string, opts: { accountId?: string | null; by?: string | null } = {}): Promise<RestoreResult> {
  const it = await one<any>(`SELECT * FROM trash_items WHERE id = $1 AND ($2::uuid IS NULL OR account_id = $2)`, [id, opts.accountId ?? null]);
  if (!it) throw Object.assign(new Error('Nothing in the bin with that id'), { status: 404 });
  if (it.state !== 'held') throw Object.assign(new Error(`That item was already ${it.state}`), { status: 409 });
  const res: RestoreResult = { id, files: 0, skipped: 0, images: 0, rows: 0 };
  for (const f of it.files as TrashFile[]) {
    // A whole tree moved as one: put it back in one rename when the place is free.
    if (existsSync(f.to) && !existsSync(f.from) && !statSync(f.to).isDirectory()) { move(f.to, f.from); res.files++; continue; }
    if (existsSync(f.to) && !existsSync(f.from) && f.to.split(/[\\/]/).pop() === f.from.split(/[\\/]/).pop()) {
      const s = treeStats(f.to); move(f.to, f.from); res.files += s.files; continue;
    }
    const r = putBack(f.from, f.to); res.files += r.restored; res.skipped += r.kept;
  }
  for (const im of it.images as TrashImage[]) {
    try { await imageStore().move(im.to, im.from); res.images++; } catch { /* gone or already back */ }
  }
  await tx(async (c) => {
    for (const r of it.rows as TrashRow[]) { await insertRow(c, r.table, r.row); res.rows++; }
    for (const l of it.relinks as TrashRelink[]) {
      await c.query(`UPDATE ${l.table} SET ${l.column} = $2 WHERE id::text = ANY($1::text[]) AND ${l.column} IS NULL`, [l.ids.map(String), l.value]);
    }
    const h = it.restore_hint ?? {};
    // Media objects the removal marked deleted are readable again, and held so the next
    // sweep does not take them straight back; an expiry set on the recording lets it.
    if (Array.isArray(h.objects) && h.objects.length) {
      await c.query(`UPDATE media_objects SET state = 'available', hold = true, hold_reason = 'restored from the bin', updated_at = now() WHERE id = ANY($1::uuid[])`, [h.objects]);
      await c.query(`UPDATE media_locations SET present = true, removed_at = NULL WHERE object_id = ANY($1::uuid[]) AND tier = 'local'`, [h.objects]);
      for (const o of h.objects) {
        await c.query(`INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail) VALUES ($1, 'deleted', 'available', 'restore', $2, $3)`,
          [o, opts.by ?? 'bin', `restored from the bin (${id})`]).catch(() => {});
      }
    }
    // Library images that were replaced by another (libraryMoves.ts replaceImages) are back at their
    // own keys: their reads no longer forward to the image that replaced them.
    if (Array.isArray(h.unforward) && h.unforward.length) {
      await c.query(`DELETE FROM media_file_moves WHERE old_key = ANY($1::text[])`, [h.unforward]);
    }
    // Storyboard hours that lost only some sheets get their sheet list back.
    for (const sb of Array.isArray(h.storyboards) ? h.storyboards : []) {
      await c.query(`UPDATE storyboards SET sheets = $2::jsonb, updated_at = now() WHERE id = $1`, [sb.id, JSON.stringify(sb.sheets)]);
    }
    if (h.recordingId) {
      await c.query(`UPDATE recordings SET storage_state = 'available', delete_after = NULL, next_action = NULL, next_action_at = NULL WHERE id = $1`, [h.recordingId]);
    }
    await c.query(`UPDATE trash_items SET state = 'restored', restored_at = now(), restored_by = $2 WHERE id = $1`, [id, opts.by ?? null]);
  });
  if (Array.isArray(it.restore_hint?.unforward)) (await import('./libraryMoves')).forgetForwarding(it.restore_hint.unforward);
  if (it.restore_hint?.streamId) {
    const { invalidateRunScan } = await import('../localRecordingIndex');
    invalidateRunScan(it.restore_hint.streamId);
  }
  try { rmSync(join(trashRoot(), id), { recursive: true, force: true }); } catch { /* */ }
  return res;
}

export async function purgeItem(id: string): Promise<void> {
  const it = await one<any>(`SELECT * FROM trash_items WHERE id = $1 AND state = 'held'`, [id]);
  if (!it) return;
  try { rmSync(join(trashRoot(), id), { recursive: true, force: true }); } catch { /* */ }
  for (const im of it.images as TrashImage[]) await imageStore().delete(im.to).catch(() => {});
  // The rows were already deleted; once purged there is nothing to restore them to.
  await query(`UPDATE trash_items SET state = 'purged', purged_at = now(), rows = '[]'::jsonb, relinks = '[]'::jsonb WHERE id = $1`, [id]);
}

/** Purge every item whose time in the bin is up. Run by the hourly retention sweep. */
export async function purgeExpired(): Promise<{ items: number; bytes: number }> {
  const due = await query<any>(`SELECT id, bytes FROM trash_items WHERE state = 'held' AND purge_after < now() ORDER BY purge_after LIMIT 200`);
  let bytes = 0;
  for (const d of due) { await purgeItem(d.id).catch((e) => console.error('[bin] purge failed', d.id, e)); bytes += Number(d.bytes); }
  if (due.length) console.log(`[bin] purged ${due.length} item(s), ${(bytes / 1e9).toFixed(2)} GB`);
  return { items: due.length, bytes };
}

export async function listBin(accountId: string, opts: { all?: boolean } = {}) {
  const rows = await query<any>(
    `SELECT id, kind, subject_id, label, reason, bytes, file_count, state, purge_after, created_at, created_by, restored_at, restored_by, purged_at,
            jsonb_array_length(rows) AS row_count, jsonb_array_length(images) AS image_count
       FROM trash_items WHERE account_id = $1 ${opts.all ? '' : `AND (state = 'held' OR created_at > now() - interval '14 days')`}
      ORDER BY created_at DESC LIMIT 300`, [accountId]);
  return rows.map((r: any) => ({
    id: r.id, kind: r.kind, subjectId: r.subject_id, label: r.label, reason: r.reason, bytes: Number(r.bytes), files: r.file_count,
    images: r.image_count, rows: r.row_count, state: r.state, purgeAfter: r.purge_after, createdAt: r.created_at, createdBy: r.created_by,
    restoredAt: r.restored_at, restoredBy: r.restored_by, purgedAt: r.purged_at,
  }));
}
