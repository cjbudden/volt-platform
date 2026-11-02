// ============================================================================
//  WHERE FRAME STILLS ARE KEPT, AND WHO CLEANS THEM UP (build queue 3.2,
//  Christian, 2 Nov: keep a record of the bucket and folder so the clean
//  function picks them up, and put them under the retention rules).
//
//  Every still made by store.ts sits in a FOLDER of the image store, one per
//  owner:
//
//      derived/<account>/frames/assets/<asset>/<index version>/<n>.jpg
//      derived/<account>/frames/streams/<stream>/<run>/<rendition>/<seq>-<k>.jpg
//
//  Two records are kept:
//
//    frame_stills   one row per still: its key, the BUCKET it went to (null on
//                   a local image store), its FOLDER and size, and the media
//                   object of that folder. The TTL prune (store.ts) reads it.
//
//    media_objects  one object per folder, kind 'frame_stills', with the
//                   folder's full address as its location
//                   (s3://<bucket>/<prefix>/derived/.../ with the trailing
//                   slash, or the directory on disk). That is what the clean
//                   functions already work from: the retention sweep removes
//                   a location's whole tree on a delete rung and reclaims
//                   ownerless objects (services/media/retention.ts), and the
//                   Storage page lists it. Nothing new to schedule, and no
//                   folder can be forgotten, because the address is written
//                   before the first still is.
//
//  RETENTION, in order of what usually fires first:
//    1. FRAME_STILL_TTL_DAYS (default 7) after a still was last made, it goes
//       (store.ts pruneFrameStills): stepping through a scene asks for the same
//       frames for a while, then never again.
//    2. The owner's retention rule: an asset's folder follows the asset's rule,
//       a run's folder the stream's recording rule, so stills never outlive the
//       media they were taken from. Only the DELETE rung applies: moving stills
//       to cold or archive storage costs more than making them again.
//    3. The owner going: an asset's folder is owned by the asset alone, so
//       deleting the asset leaves it ownerless and the sweep reclaims it; a
//       run's folder goes with the run (services/media/prune.ts); a re-built
//       asset index retires the folder of the old version at once.
// ============================================================================
import { resolve } from 'node:path';
import { config } from '../../config';
import { one, query } from '../../db';
import { registerObject, transition, locationsOf } from '../media/objects';
import { storageDriver, type StorageTier } from '../media/storage';

export const FRAME_STILLS_KIND = 'frame_stills';

export interface FrameFolder {
  /** Folder key inside the image store, no trailing slash. */
  key: string;
  /** Identity of the folder's media object within its owner. */
  logicalKey: string;
  vodAssetId?: string | null;
  channelId?: string | null;
  eventId?: string | null;
}

export interface FolderAddress { bucket: string | null; uri: string; tier: StorageTier }

/** Where a folder of the image store physically is: bucket and full address. */
export function folderAddress(folderKey: string): FolderAddress {
  const k = folderKey.replace(/^\/+|\/+$/g, '');
  const c = config.imageStore;
  if (c.driver === 's3') {
    const prefix = (c.s3Prefix ?? '').replace(/^\/+|\/+$/g, '');
    // The trailing slash makes it a prefix to the S3 driver: exactly this tree,
    // never a sibling whose name starts the same (services/media/s3Driver.ts).
    return { bucket: c.s3Bucket, uri: `s3://${c.s3Bucket}/${prefix ? prefix + '/' : ''}${k}/`, tier: 's3_standard' };
  }
  return { bucket: null, uri: resolve(c.localDir, k), tier: 'local' };
}

const registered = new Map<string, string>();

/** The folder's media object, registered on first use (once per process per folder). */
export async function frameFolderObject(f: FrameFolder): Promise<{ id: string; address: FolderAddress }> {
  const address = folderAddress(f.key);
  const hit = registered.get(address.uri);
  if (hit) return { id: hit, address };
  const obj = await registerObject({
    vodAssetId: f.vodAssetId ?? null, channelId: f.channelId ?? null, eventId: f.eventId ?? null,
    logicalKey: f.logicalKey, kind: FRAME_STILLS_KIND, rendition: null,
    tier: address.tier, uri: address.uri, actor: 'frames',
  });
  // A folder retention already removed stays removed: its owner's media went
  // with it, so a new still would be taken from media that is on its way out
  // and would sit outside every clean-up but the TTL.
  if (obj.state === 'deleted' || obj.state === 'deleting') {
    const { FrameError } = await import('./exactFrame');
    throw new FrameError(410, 'the stills of this media were removed under its retention rule');
  }
  registered.set(address.uri, obj.id);
  return { id: obj.id, address };
}

/** Keep the folder object's size current after a still is added or removed. */
export async function refreshFolderBytes(objectId: string): Promise<void> {
  await query(
    `UPDATE media_objects SET bytes = s.n, updated_at = now()
       FROM (SELECT COALESCE(sum(bytes), 0)::bigint AS n FROM frame_stills WHERE media_object_id = $1) s
      WHERE id = $1 AND state <> 'deleted' AND bytes IS DISTINCT FROM s.n`, [objectId]);
  await query(
    `UPDATE media_locations SET bytes = o.bytes FROM media_objects o
      WHERE media_locations.object_id = o.id AND o.id = $1 AND media_locations.present`, [objectId]);
}

/**
 * Remove whole frame folders now: their bytes from every location, their
 * frame_stills rows, and the objects marked deleted (kept as a record).
 * `logicalLike` matches media_objects.logical_key; owner columns narrow it.
 */
export async function retireFrameFolders(o: {
  vodAssetId?: string | null;
  /** A channel or event id: run ids are start times, so two streams can share one. */
  streamId?: string | null;
  logicalLike: string; exceptLogicalKey?: string | null; reason: string; actor?: string;
}): Promise<number> {
  const rows = await query<any>(
    `SELECT id, state FROM media_objects
      WHERE kind = $1 AND logical_key LIKE $2 AND state <> 'deleted'
        AND ($3::uuid IS NULL OR vod_asset_id = $3)
        AND ($4::uuid IS NULL OR channel_id = $4 OR event_id = $4)
        AND ($5::text IS NULL OR logical_key <> $5)`,
    [FRAME_STILLS_KIND, o.logicalLike, o.vodAssetId ?? null, o.streamId ?? null, o.exceptLogicalKey ?? null]);
  for (const r of rows) await retireFrameFolder(r.id, o.reason, o.actor ?? 'frames');
  return rows.length;
}

/** Remove one frame folder object's bytes and rows. Idempotent. */
export async function retireFrameFolder(objectId: string, reason: string, actor = 'frames'): Promise<void> {
  const obj = await one<any>(`SELECT state FROM media_objects WHERE id = $1`, [objectId]);
  if (!obj || obj.state === 'deleted') { await forgetStillsOf(objectId); return; }
  if (obj.state !== 'deleting') await transition(objectId, 'deleting', { action: 'delete', actor, detail: reason });
  for (const l of await locationsOf(objectId)) {
    await storageDriver().remove(l.uri);
    await query(`UPDATE media_locations SET present = false, removed_at = now() WHERE id = $1`, [l.id]);
    for (const [k, v] of registered) if (v === objectId) registered.delete(k);
  }
  await forgetStillsOf(objectId);
  await transition(objectId, 'deleted', { action: 'delete', actor, detail: reason });
}

/** The still rows of a folder whose bytes are gone (the retention sweep calls this after a delete). */
export async function forgetStillsOf(objectId: string): Promise<void> {
  await query(`DELETE FROM frame_stills WHERE media_object_id = $1`, [objectId]);
  for (const [k, v] of registered) if (v === objectId) registered.delete(k);
}
