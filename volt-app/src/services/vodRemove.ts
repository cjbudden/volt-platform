// ============================================================================
//  REMOVING A VOD ASSET, into the restore bin (services/media/trash.ts).
//
//  The row and everything that cascades from it (markers, reviews, reframes, clip
//  provenance) are kept in a bin item with the links that pointed at it, its encode
//  output (clips/vod/<id>) and an uploaded source under clips/vod-src move into the bin,
//  and any encode still waiting is cancelled. Restoring puts all of it back; after
//  VOLT_TRASH_DAYS the bin purges it. A source elsewhere (an S3 key, a watchfolder path)
//  is never touched from here.
// ============================================================================
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from '../config';
import { one, query } from '../db';
import { BinItem, snapshotDelete } from './media/trash';

const inside = (p: string, dir: string) => { const r = resolve(p); const d = resolve(dir); return r.startsWith(d + sep); };

export async function removeVodAsset(assetId: string, opts: { keepPath?: string | null; reason?: string; by?: string | null } = {}): Promise<string | null> {
  const a = await one<any>(
    `SELECT v.id, v.title, v.source_key, v.encode_job_id, COALESCE(gc.account_id, ge.account_id, v.account_id) AS account_id
       FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups gc ON gc.id = c.group_id
       LEFT JOIN events e ON e.id = v.event_id LEFT JOIN groups ge ON ge.id = e.group_id WHERE v.id = $1`, [assetId]);
  if (!a) return null;
  const bin = await BinItem.open({ accountId: a.account_id, kind: 'vod_asset', subjectId: a.id, label: a.title ?? 'Untitled asset',
    reason: opts.reason ?? 'deleted from the Media Library', createdBy: opts.by ?? null });
  await snapshotDelete(bin, 'vod_assets', [a.id]);
  if (a.encode_job_id) {
    await query(`UPDATE jobs SET state = 'cancelled', finished_at = now(), lease_until = NULL WHERE id = $1 AND state = 'queued'`, [a.encode_job_id]).catch(() => {});
  }
  bin.file(join(config.clips.dir, 'vod', a.id), 'output');
  const src = a.source_key as string | null;
  if (src && !/^[a-z0-9]+:\/\//i.test(src) && src !== opts.keepPath && inside(src, join(config.clips.dir, 'vod-src')) && existsSync(src)) {
    bin.file(src, 'source');
  }
  // IMAGES AND FILES THAT WERE THE ASSET'S OWN go into the same bin item, so a restore puts
  // them back with it: frames Volt saved for it (picked or chosen, metadata.assetId), unless
  // something else still uses them, and its companion files (captions, sidecars). Uploaded
  // images and shared song covers are not the asset's to take. Its folder goes if empty.
  const owned = await query<any>(`SELECT * FROM media_files WHERE account_id = $1 AND source = 'auto' AND metadata->>'assetId' = $2`, [a.account_id, a.id]);
  const inUse = owned.length ? new Set((await query<any>(
    `SELECT poster_key AS k FROM vod_assets WHERE id <> $1 AND poster_key = ANY($2::text[])
     UNION SELECT image_key FROM vod_asset_images WHERE asset_id <> $1 AND image_key = ANY($2::text[])`, [a.id, owned.map((f) => f.store_key)]).catch(() => [])).map((r: any) => r.k)) : new Set();
  const mine = owned.filter((f) => !inUse.has(f.store_key));
  for (const f of mine) await bin.image(f.store_key, Number(f.size_bytes ?? 0));
  if (mine.length) {
    await snapshotDelete(bin, 'media_files', mine.map((f) => f.id));
    await query(`DELETE FROM media_files WHERE id = ANY($1::uuid[])`, [mine.map((f) => f.id)]);
  }
  // Its sprite sheets and thumbnail VTT (thumbnails/spriteStore.ts): the files go into the bin; their
  // sprite_sheets rows cascade from the asset row, so the snapshot above already holds them.
  for (const sp of await query<any>(`SELECT store_key, size_bytes FROM sprite_sheets WHERE vod_asset_id = $1`, [a.id]).catch(() => [])) {
    await bin.image(sp.store_key, Number(sp.size_bytes ?? 0));
  }
  for (const f of await query<any>(`SELECT store_key, vtt_key, bytes FROM vod_asset_files WHERE asset_id = $1`, [a.id]).catch(() => [])) {
    await bin.image(f.store_key, Number(f.bytes ?? 0));
    if (f.vtt_key) await bin.image(f.vtt_key);
  }
  await query(`DELETE FROM vod_assets WHERE id = $1`, [a.id]);
  const binId = await bin.save({ assetId: a.id });
  if (mine.length) await (await import('./media/libraryMoves')).pruneEmptyFolders(a.account_id, mine.map((f) => f.folder)).catch((e) => console.warn('[vod] empty folders not removed', e));
  return binId;
}
