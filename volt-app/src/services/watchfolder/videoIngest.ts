// ============================================================================
//  WATCHFOLDER INGEST — THE VIDEO TARGETS.
//
//  `ingest.ts` handles the image library and deliberately DEFERS `vod` and
//  `loop`, because they are different assets with different stores and a
//  different cost. This is those two.
//
//  THEY ARE NOT THE SAME THING AND ARE NOT TREATED AS ONE:
//
//    `vod` becomes a VOD asset and is ENCODED to a ladder, because it will be
//    played by a browser over ABR and has to exist at several bitrates.
//
//    `loop` becomes a filler asset and is NOT encoded, because its consumer is
//    the live encoder's failover path, which reads the file directly and
//    re-encodes it into whatever ladder the channel is already producing.
//    Putting a filler loop through the ABR ladder would produce four renditions
//    nothing will ever request.
//
//  THE SOURCE IS COPIED OUT OF THE DROP FOLDER BEFORE THE JOB IS QUEUED, and
//  that is the difference that matters between this and the image path. An image
//  is read synchronously: the bytes are in the store before the function
//  returns. An encode is a job that runs later, and in the minutes it waits an
//  operator can tidy the drop folder, replace the file, or unmount the share.
//  Handing the queue a path into somebody else's working directory is handing it
//  a path that may not resolve. So the file is copied to a durable location
//  first, keyed by the asset, and the job is pointed at THAT.
//
//  A hardlink is tried first because it costs nothing when the drop folder and
//  the media directory are on one filesystem, which is the common local case;
//  the copy is the fallback for the mount that they usually are not.
// ============================================================================
import { copyFile, link, mkdir, stat, unlink } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { one, query } from '../../db';
import { enqueue } from '../jobs/queue';
import { VOD_ENCODE } from '../jobs/handlers/vodEncode';
import { checksumFile } from './scanner';
import type { PendingItem } from './ingest';

/** Rule targets this handles. Everything else is somebody else's. */
const VOD_KINDS = new Set(['vod', 'video', 'programme', 'program', 'episode']);
const LOOP_KINDS = new Set(['loop', 'filler']);

export function videoTargetFor(targetKind?: string | null): 'vod' | 'loop' | null {
  if (!targetKind) return null;
  const k = String(targetKind).toLowerCase().trim();
  if (VOD_KINDS.has(k)) return 'vod';
  if (LOOP_KINDS.has(k)) return 'loop';
  return null;
}

export function videoTargetKinds(): string[] {
  return [...VOD_KINDS, ...LOOP_KINDS];
}

export interface VideoIngestFolder {
  id: string;
  accountId: string;
  path: string;
  /** The ladder every VOD asset from this folder is encoded to. */
  ladderGroupId?: string | null;
  userId?: string | null;
}

export type VideoOutcome =
  | { result: 'queued'; itemId: string | number; assetId: string; jobId: string; target: 'vod' }
  | { result: 'registered'; itemId: string | number; assetId: string; target: 'loop' }
  | { result: 'skipped'; itemId: string | number; why: string }
  | { result: 'deferred'; itemId: string | number; why: string }
  | { result: 'failed'; itemId: string | number; why: string };

/** What this needs from persistence. Same shape of contract as the image path. */
export interface VideoIngestStore {
  claim(itemId: string | number): Promise<boolean>;
  markQueued(itemId: string | number, note: string): Promise<void>;
  markFailed(itemId: string | number, reason: string): Promise<void>;
  createVodAsset(a: {
    accountId: string; title: string; sourceKey: string; sourceBytes: number;
    ladderGroupId: string | null; sourceKind: 'watchfolder' | 'upload';
  }): Promise<{ id: string }>;
  createFillerAsset(a: {
    accountId: string; name: string; sourceKey: string; bytes: number;
  }): Promise<{ id: string }>;
  enqueueEncode(a: {
    assetId: string; accountId: string; sourcePath: string;
    ladderGroupId: string | null; dedupeKey: string;
  }): Promise<{ id: string }>;
}

/** Where a file-sourced asset's ORIGINAL lives, so a re-encode never needs the
 *  drop folder to still exist. */
export function sourcePathFor(assetId: string, filename: string): string {
  return join(config.clips.dir, 'vod-src', assetId + safeExt(filename));
}

function safeExt(filename: string): string {
  const e = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(e) ? e : '.bin';
}

/** Hardlink if we can, copy if we cannot. Never move: the operator's file stays
 *  where they put it until they decide otherwise. */
export async function preserveSource(from: string, to: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

export async function ingestVideoItem(
  f: VideoIngestFolder,
  item: PendingItem,
  store: VideoIngestStore
): Promise<VideoOutcome> {
  const target = videoTargetFor(item.targetKind);
  if (!target) {
    return {
      result: 'deferred', itemId: item.id,
      why: `target kind '${item.targetKind ?? 'none'}' is not a video asset`,
    };
  }

  if (!(await store.claim(item.id))) {
    return { result: 'skipped', itemId: item.id, why: 'another pass is already handling this item' };
  }

  const abs = join(f.path, item.objectKey.split('/').join(sep));
  const name = item.objectKey.split('/').pop() || item.objectKey;

  try {
    let bytes: number;
    try {
      bytes = (await stat(abs)).size;
    } catch {
      await store.markFailed(item.id, `file is no longer at ${item.objectKey}`);
      return { result: 'failed', itemId: item.id, why: 'source file is gone' };
    }

    // The same reasoning as the image path: the row's checksum describes the
    // file as it was when it was classified, and an operator can drop a
    // corrected version over the top in between.
    if (item.checksum) {
      const now = await checksumFile(abs);
      if (now !== item.checksum) {
        const why =
          `file changed on disk after it was scanned (was ${item.checksum.slice(0, 12)}, ` +
          `now ${now.slice(0, 12)}); the new content will be picked up as a new item`;
        await store.markFailed(item.id, why);
        return { result: 'failed', itemId: item.id, why };
      }
    }

    const title = name.replace(/\.[^.]+$/, '');

    if (target === 'loop') {
      // NOT ENCODED. See the header: its consumer re-encodes it anyway.
      const asset = await store.createFillerAsset({
        accountId: f.accountId, name: title, sourceKey: '', bytes,
      });
      const dest = join(config.uploads.fillerDir, f.accountId, asset.id + safeExt(name));
      await preserveSource(abs, dest);
      await store.markQueued(item.id, `registered as a filler loop (${title})`);
      return { result: 'registered', itemId: item.id, assetId: asset.id, target: 'loop' };
    }

    // A VOD asset. The row first, so the source can be keyed by its id, then the
    // copy, then the job — in that order, because a job pointing at a file that
    // has not been copied yet is a job that fails on a race with itself.
    const assetId = randomUUID();
    const dest = sourcePathFor(assetId, name);
    await preserveSource(abs, dest);

    let asset: { id: string };
    try {
      asset = await store.createVodAsset({
        accountId: f.accountId, title, sourceKey: dest, sourceBytes: bytes,
        ladderGroupId: f.ladderGroupId ?? null, sourceKind: 'watchfolder',
      });
    } catch (e: any) {
      await unlink(dest).catch(() => { /* an orphan copy is the cheap failure */ });
      const why = `could not create the VOD asset: ${String(e?.message ?? e)}`;
      await store.markFailed(item.id, why);
      return { result: 'failed', itemId: item.id, why };
    }

    const job = await store.enqueueEncode({
      assetId: asset.id, accountId: f.accountId, sourcePath: dest,
      ladderGroupId: f.ladderGroupId ?? null,
      // KEYED ON THE ASSET, so a second scan that somehow reaches the same asset
      // joins the job in flight rather than starting a second encode of the same
      // file into the same directory.
      dedupeKey: `vod.encode:${asset.id}`,
    });
    await store.markQueued(item.id, `queued for encoding as "${title}"`);
    return { result: 'queued', itemId: item.id, assetId: asset.id, jobId: job.id, target: 'vod' };
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    await store.markFailed(item.id, why).catch(() => { /* nothing left to try */ });
    return { result: 'failed', itemId: item.id, why };
  }
}

/* ------------------------------------------------------------- adapter ---- */

export const pgVideoIngestStore: VideoIngestStore = {
  async claim(itemId) {
    const r = await one<any>(
      `UPDATE watchfolder_items SET resolved_at = now()
        WHERE id = $1 AND status = 'seen'
          AND (resolved_at IS NULL OR resolved_at < now() - interval '10 minutes')
        RETURNING id`, [itemId]);
    return !!r;
  },
  async markQueued(itemId, note) {
    // NOT 'ingested'. The bytes are safe and the work is accepted, but the asset
    // is not playable until the encode finishes, and a queue that says "in
    // library" for a file that is still encoding is a queue that lies.
    await query(
      `UPDATE watchfolder_items SET status = 'seen', reason = $2, resolved_at = now()
        WHERE id = $1`, [itemId, note.slice(0, 500)]);
  },
  async markFailed(itemId, reason) {
    await query(
      `UPDATE watchfolder_items SET status = 'failed', reason = $2, resolved_at = now()
        WHERE id = $1 AND status = 'seen'`, [itemId, reason.slice(0, 500)]);
  },
  async createVodAsset(a) {
    const row = await one<any>(
      `INSERT INTO vod_assets
         (account_id, source_kind, kind, title, source_key, source_bytes, ladder_group_id,
          start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
       VALUES ($1,$2,'clip',$3,$4,$5,$6,0,0,0,'processing')
       RETURNING id`,
      [a.accountId, a.sourceKind, a.title, a.sourceKey, a.sourceBytes, a.ladderGroupId]
    );
    return { id: row.id };
  },
  async createFillerAsset(a) {
    const row = await one<any>(
      `INSERT INTO filler_assets (account_id, kind, name, status, bytes)
       VALUES ($1,'loop',$2,'ready',$3) RETURNING id`,
      [a.accountId, a.name, a.bytes]
    );
    return { id: row.id };
  },
  async enqueueEncode(a) {
    const job = await enqueue({
      type: VOD_ENCODE,
      payload: {
        vodAssetId: a.assetId, accountId: a.accountId,
        sourcePath: a.sourcePath, ladderGroupId: a.ladderGroupId,
      },
      dedupeKey: a.dedupeKey,
      // An encode is minutes, not seconds; three attempts of a permanent problem
      // just delays the operator finding out.
      maxAttempts: 2,
    });
    await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`, [a.assetId, job.id]);
    return { id: job.id };
  },
};
