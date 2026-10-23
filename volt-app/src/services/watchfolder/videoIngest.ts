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
//
//  23 Oct 2026 (build queue 1.13), three faults found by running a real drop
//  end to end against Postgres:
//
//    A LOOP LANDED WITH NO SOURCE KEY. The filler row was written with
//    source_key '' and no filename, so Loops & Fillers listed a loop that no
//    channel could use: the orchestrator hands the encoder the source key as the
//    loop's address, and '' is no address. It is now written exactly as an
//    upload writes it (`filler/<account>/<id><ext>`, at `fillerPath()`).
//
//    EVERY DROP CAME BACK EVERY TEN MINUTES. The item was left at 'seen' once
//    the asset existed, and 'seen' plus a claim older than ten minutes is
//    exactly what the pending query picks up, so each pass made another asset
//    and another encode of the same file. The item now closes as 'ingested'
//    when the asset row exists: the Media Library row carries the encode's own
//    state, so "in library, encoding" is true and nothing is left to retry.
//
//    A VOD DROP SKIPPED THE INGEST RULES. Uploads run the ingest framework
//    (naming, real type, duplicate check, metadata, sidecar, webhooks) before
//    the encode; a watch folder drop went straight to the encoder. It now runs
//    the same `ingestLanded()` with the folder as its source, and only an
//    'ingested' outcome is encoded, as for an upload.
// ============================================================================
import { copyFile, link, mkdir, stat, unlink } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { fillerPath, safeExt as uploadExt } from '../uploads';
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
  /** In the Media Library, but the ingest rules held it (duplicate, rejected,
   *  waiting for metadata), so no encode was queued. Same as an upload. */
  | { result: 'held'; itemId: string | number; assetId: string; target: 'vod'; status: string }
  | { result: 'skipped'; itemId: string | number; why: string }
  | { result: 'deferred'; itemId: string | number; why: string }
  | { result: 'failed'; itemId: string | number; why: string };

/** What this needs from persistence. Same shape of contract as the image path. */
export interface VideoIngestStore {
  claim(itemId: string | number): Promise<boolean>;
  /** The asset exists: close the item so no later pass makes another. */
  markLanded(itemId: string | number, note: string): Promise<void>;
  markFailed(itemId: string | number, reason: string): Promise<void>;
  createVodAsset(a: {
    accountId: string; title: string; sourceKey: string; sourceBytes: number;
    ladderGroupId: string | null; sourceKind: 'watchfolder' | 'upload';
  }): Promise<{ id: string }>;
  createFillerAsset(a: {
    id: string; accountId: string; name: string; sourceKey: string; bytes: number;
    filename: string; contentType: string;
  }): Promise<{ id: string }>;
  /** The ingest framework over a landed VOD source, as an upload runs it.
   *  Returns the outcome and where the file is now (naming rules may move it). */
  runIngest(a: {
    accountId: string; assetId: string; path: string; originalName: string;
    relativePath: string; bytes: number; sha256: string; source: string;
  }): Promise<{ status: string; path: string }>;
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
      // Laid out exactly as an uploaded loop (same path, same source key), so
      // Loops & Fillers, filler prep and the orchestrator cannot tell them apart.
      const id = randomUUID();
      const ext = uploadExt(name);
      const dest = fillerPath(f.accountId, id, name);
      await preserveSource(abs, dest);
      let asset: { id: string };
      try {
        asset = await store.createFillerAsset({
          id, accountId: f.accountId, name: title, bytes,
          sourceKey: `filler/${f.accountId}/${id}${ext}`,
          filename: name, contentType: videoTypeOf(name),
        });
      } catch (e: any) {
        await unlink(dest).catch(() => { /* an orphan copy is the cheap failure */ });
        const why = `could not create the loop: ${String(e?.message ?? e)}`;
        await store.markFailed(item.id, why);
        return { result: 'failed', itemId: item.id, why };
      }
      await store.markLanded(item.id, `in Loops & Fillers as "${title}"`);
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

    // THE INGEST RULES, as for an upload. The folder id is the source, so a
    // source-rung rule written for this folder applies to its drops.
    const sha256 = item.checksum ?? await checksumFile(dest);
    const ing = await store.runIngest({
      accountId: f.accountId, assetId: asset.id, path: dest, originalName: name,
      relativePath: item.objectKey, bytes, sha256, source: f.id,
    });
    if (ing.status !== 'ingested') {
      // In the library with the reason on the asset; no encode, as an upload.
      await store.markLanded(item.id, `in the Media Library as "${title}", held by the ingest rules (${ing.status.replace(/_/g, ' ')})`);
      return { result: 'held', itemId: item.id, assetId: asset.id, target: 'vod', status: ing.status };
    }

    const job = await store.enqueueEncode({
      assetId: asset.id, accountId: f.accountId, sourcePath: ing.path,
      ladderGroupId: f.ladderGroupId ?? null,
      // KEYED ON THE ASSET, so a second scan that somehow reaches the same asset
      // joins the job in flight rather than starting a second encode of the same
      // file into the same directory.
      dedupeKey: `vod.encode:${asset.id}`,
    });
    await store.markLanded(item.id, `in the Media Library as "${title}", queued for encoding`);
    return { result: 'queued', itemId: item.id, assetId: asset.id, jobId: job.id, target: 'vod' };
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 500);
    await store.markFailed(item.id, why).catch(() => { /* nothing left to try */ });
    return { result: 'failed', itemId: item.id, why };
  }
}

/** A content type for a dropped video, from its extension. The upload path
 *  records the browser's type; a drop folder has only the name. */
export function videoTypeOf(filename: string): string {
  const e = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.ts': 'video/mp2t',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mxf': 'application/mxf',
  };
  return map[e] ?? 'application/octet-stream';
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
  async markLanded(itemId, note) {
    // 'ingested', NOT 'seen'. It used to stay 'seen' so the queue would not say
    // "in library" while the encode ran, but 'seen' is what the pending query
    // picks up again after ten minutes, so every drop became a new asset and a
    // new encode every ten minutes. The asset IS in the library now (its row
    // shows the encode's progress), and the note says it is still encoding.
    await query(
      `UPDATE watchfolder_items SET status = 'ingested', reason = $2, resolved_at = now()
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
    // The same columns an upload's finish writes, so the loop is usable at once.
    const row = await one<any>(
      `INSERT INTO filler_assets
         (id, account_id, kind, name, status, bytes, source_key, filename, content_type, uploaded_at)
       VALUES ($1,$2,'loop',$3,'ready',$4,$5,$6,$7,now()) RETURNING id`,
      [a.id, a.accountId, a.name, a.bytes, a.sourceKey, a.filename, a.contentType]
    );
    return { id: row.id };
  },
  async runIngest(a) {
    // Same contract as the upload path: a probe or rule that cannot run is
    // recorded, not a reason to lose the file; the asset encodes as before.
    try {
      const { ingestLanded } = await import('../ingest/pipeline');
      const out = await ingestLanded({
        accountId: a.accountId, assetId: a.assetId, path: a.path, originalName: a.originalName,
        relativePath: a.relativePath, bytes: a.bytes, sha256: a.sha256, source: a.source,
      });
      return { status: out.status, path: out.path };
    } catch (e: any) {
      console.warn('[watchfolder] ingest rules could not run for', a.assetId, e?.message ?? e);
      return { status: 'ingested', path: a.path };
    }
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
