// ============================================================================
//  S3 WATCHFOLDERS — a bucket prefix as a drop folder.
//
//  The local scanner is the one with the tested behaviour (quiet time,
//  hygiene, quarantine, move before record). Rather than write a second one
//  for S3, this MIRRORS the prefix into a local staging root and lets the
//  local scanner and ingest run unchanged. Only what is new and quiet is
//  downloaded; a refused file is moved to the review prefix in the bucket as
//  well as locally, so an operator looking at either sees the same thing.
//
//  Event-driven S3 (ObjectCreated to SQS) is the fast path for later; this
//  sync is the backstop that never misses an object and is enough for a
//  drop that is polled every minute.
// ============================================================================
import { createWriteStream, mkdirSync, existsSync, statSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { S3Api, S3Object } from '../ingest/s3';
import { hygiene } from './rules';

export interface S3Folder {
  id: string;
  bucket: string;
  prefix: string;          // 'drops/sport/' (trailing slash optional)
  stagingRoot: string;     // local mirror root for this folder
  quarantinePath: string;  // '_review'
  minAgeMs: number;
  deleteAfterIngest?: boolean;
  maxObjects?: number;
}

export interface SyncResult { listed: number; downloaded: string[]; skippedTooNew: string[]; skippedKnown: number; junk: string[]; errors: { key: string; error: string }[] }

const norm = (p: string) => p.replace(/^\/+|\/+$/g, '');

/** Objects under the prefix, as keys relative to it, minus the review prefix and junk. */
export function relativeKeys(objs: S3Object[], prefix: string, quarantine: string): { rel: string; obj: S3Object }[] {
  const p = norm(prefix); const q = norm(quarantine);
  return objs.flatMap((o) => {
    const rel = p ? (o.key.startsWith(p + '/') ? o.key.slice(p.length + 1) : null) : o.key;
    if (!rel || rel.startsWith(q + '/') || rel === q) return [];
    return [{ rel, obj: o }];
  });
}

/**
 * Mirror new, quiet objects into the staging root. `known(rel, etag)` says
 * whether the scanner already recorded this exact object, so it is not
 * downloaded twice.
 */
export async function syncS3Folder(f: S3Folder, s3: S3Api, known: (rel: string, etag: string) => Promise<boolean>, now = Date.now()): Promise<SyncResult> {
  const res: SyncResult = { listed: 0, downloaded: [], skippedTooNew: [], skippedKnown: 0, junk: [], errors: [] };
  const objs = await s3.list(f.bucket, norm(f.prefix) ? norm(f.prefix) + '/' : '', f.maxObjects ?? 5000);
  for (const { rel, obj } of relativeKeys(objs, f.prefix, f.quarantinePath)) {
    res.listed++;
    try {
      const leaf = rel.split('/').pop()!;
      if (hygiene(leaf, obj.bytes)) { res.junk.push(rel); continue; }
      if (now - obj.lastModified.getTime() < f.minAgeMs) { res.skippedTooNew.push(rel); continue; }
      if (await known(rel, obj.etag)) { res.skippedKnown++; continue; }
      const local = join(f.stagingRoot, ...rel.split('/'));
      // Already mirrored and unchanged: the local scanner will handle it.
      if (existsSync(local) && statSync(local).size === obj.bytes) { res.skippedKnown++; continue; }
      mkdirSync(dirname(local), { recursive: true });
      const tmp = local + '.part';
      await pipeline(await s3.getStream(f.bucket, obj.key), createWriteStream(tmp));
      require('node:fs').renameSync(tmp, local);
      // Carry the object's own modified time so the local quiet-time check
      // does not make it wait a second time.
      utimesSync(local, obj.lastModified, obj.lastModified);
      res.downloaded.push(rel);
    } catch (e: any) { res.errors.push({ key: obj.key, error: String(e?.message ?? e) }); }
  }
  return res;
}

/** Mirror a local quarantine decision into the bucket: copy to the review prefix, delete the original. */
export async function quarantineInS3(f: S3Folder, s3: S3Api, rel: string, quarantineRel: string): Promise<void> {
  const p = norm(f.prefix);
  const from = p ? `${p}/${rel}` : rel; const to = p ? `${p}/${quarantineRel}` : quarantineRel;
  await s3.copy(f.bucket, from, to);
  await s3.del(f.bucket, from);
}

/** After a successful ingest, optionally remove the source object. */
export async function removeIngestedFromS3(f: S3Folder, s3: S3Api, rel: string): Promise<void> {
  if (!f.deleteAfterIngest) return;
  const p = norm(f.prefix);
  await s3.del(f.bucket, p ? `${p}/${rel}` : rel);
}
