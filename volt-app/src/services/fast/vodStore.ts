// ============================================================================
//  WHERE PACKAGED LIBRARY MEDIA LIVES.
//
//    local  the control plane's clips dir (/clips/vod/<id>/), served by the API.
//           Right for a laptop. Wrong for production: on Fargate that disk is
//           the task's own and goes with it, and a FAST playout on another
//           server cannot read it.
//    s3     the origin bucket, vod/<id>/, served by the CDN beside the live
//           channels. master_key becomes 'vod/<id>/master.m3u8' (a key, no
//           leading slash), which every consumer already resolves against the
//           CDN (services/shareLinks.ts manifestUrls).
//
//  A repackage (DRM turned on or off for a published title) uploads into a
//  prefix of its own under vod/<id>/ and points master_key there (below).
//
//  VOD_STORE chooses; unset, ECS deployments use s3 and everything else local.
//  The local copy is kept after upload (the skip-marker annotator and clip
//  extraction read it while the task lives); the bucket is the record.
// ============================================================================
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { config } from '../../config';

export function vodStore(): 'local' | 's3' {
  const v = process.env.VOD_STORE;
  if (v === 'local' || v === 's3') return v;
  return config.orchestrator.launcher === 'ecs' ? 's3' : 'local';
}

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment', '.vtt': 'text/vtt', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json',
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'encode-job.json') continue; // .enc intermediates, the job file
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  A REPACKAGE'S OWN PREFIX (build queue P4-4). The CDN caches a title's
//  segments as immutable for a year under their names, so a repackage after a
//  DRM change (services/repackage.ts) cannot upload under the title's keys:
//  old and new files, clear and encrypted, would mix in viewers' players. Its
//  files go under vod/<id>/r-<job>-a<attempt>/ instead and master_key moves
//  there; the old package is removed once no viewer can still be reading it.
//  The pattern is narrow on purpose: `reframe/` and `ladders/` share the
//  asset's folder and must never be taken for a package.
// ---------------------------------------------------------------------------
export const REPACK_DIR = /^r-[0-9a-z]{4,32}-a\d{1,3}$/i;

/** PURE. The folder under vod/<id>/ that one attempt of a repackage job uploads into. */
export function repackSubdir(jobId: string | null | undefined, attempt: number | null | undefined): string {
  const j = String(jobId ?? '').replace(/[^0-9a-z]/gi, '').slice(0, 12).toLowerCase() || Date.now().toString(36);
  return `r-${j}-a${Math.max(1, Math.min(999, Number(attempt) || 1))}`;
}

let s3: any = null;
async function client() {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3 = new S3Client({ region: config.aws.region, endpoint: process.env.AWS_ENDPOINT_URL || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  }
  return s3;
}

/**
 * Upload an asset's packaged folder to vod/<id>/. Segments and init segments
 * first, playlists last, so a playlist never lists a file that is not there.
 */
export async function uploadVodDir(dir: string, assetId: string, opts: { concurrency?: number; subdir?: string } = {}): Promise<{ master: string; mpd: string; files: number; bytes: number }> {
  // subdir: a FAST ladder variant (ladders/<group>/<seg>s), under the asset's own folder
  const base = `vod/${assetId}${opts.subdir ? `/${opts.subdir.replace(/^\/+|\/+$/g, '')}` : ''}`;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  const files = await walk(dir);
  const isList = (f: string) => /\.(m3u8|mpd)$/.test(f);
  const media = files.filter((f) => !isList(f)), lists = files.filter(isList);
  let bytes = 0;
  const put = async (f: string) => {
    const key = `${base}/${relative(dir, f).split('\\').join('/')}`;
    const body = await readFile(f);
    bytes += (await stat(f)).size;
    await c.send(new PutObjectCommand({
      Bucket: config.aws.s3Bucket, Key: key, Body: body,
      ContentType: TYPES[extname(f)] ?? 'application/octet-stream',
      // segments never change; playlists may be re-written by a re-encode
      CacheControl: isList(f) ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    }));
  };
  const n = Math.max(1, opts.concurrency ?? 8);
  for (let i = 0; i < media.length; i += n) await Promise.all(media.slice(i, i + n).map(put));
  for (const f of lists) await put(f);
  return { master: `${base}/master.m3u8`, mpd: `${base}/manifest.mpd`, files: files.length, bytes };
}

// ---------------------------------------------------------------------------
//  THE RESTORE BIN IN THE ORIGIN BUCKET (services/media/trash.ts objects).
//  A deleted asset's packaged media (HLS and DASH, ladder variants) is moved
//  from vod/<id>/ to trash/<bin item>/vod/<id>/ in the same bucket: off the
//  CDN's path at once, restorable by moving it back, deleted by the purge.
//  S3 has no rename, so a move is copy then delete, object by object.
// ---------------------------------------------------------------------------

/** Every key under a prefix. */
export async function listPrefix(prefix: string): Promise<{ key: string; size: number; storageClass?: string }[]> {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const c = await client();
  const out: { key: string; size: number; storageClass?: string }[] = [];
  let token: string | undefined;
  do {
    const r: any = await c.send(new ListObjectsV2Command({ Bucket: config.aws.s3Bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key, size: Number(o.Size ?? 0), storageClass: o.StorageClass ?? 'STANDARD' });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Move everything under `from` to `to` (both prefixes ending in '/'). Returns what moved. */
export async function movePrefix(from: string, to: string): Promise<{ files: number; bytes: number }> {
  const { CopyObjectCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  const keys = await listPrefix(from);
  let bytes = 0;
  for (let i = 0; i < keys.length; i += 8) {
    await Promise.all(keys.slice(i, i + 8).map((k) => c.send(new CopyObjectCommand({
      Bucket: config.aws.s3Bucket, Key: to + k.key.slice(from.length),
      CopySource: `${config.aws.s3Bucket}/${k.key.split('/').map(encodeURIComponent).join('/')}`,
    }))));
  }
  for (let i = 0; i < keys.length; i += 1000) {
    await c.send(new DeleteObjectsCommand({ Bucket: config.aws.s3Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((k) => ({ Key: k.key })), Quiet: true } }));
  }
  for (const k of keys) bytes += k.size;
  return { files: keys.length, bytes };
}

/** Delete everything under a prefix (the bin's purge). */
export async function deletePrefix(prefix: string): Promise<number> {
  const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  const keys = await listPrefix(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    await c.send(new DeleteObjectsCommand({ Bucket: config.aws.s3Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((k) => ({ Key: k.key })), Quiet: true } }));
  }
  return keys.length;
}

/**
 * Move one exact key (an original or its sidecar, build queue 2.1a-2c). Unlike
 * movePrefix this never takes a neighbour whose name merely starts the same.
 * Null when the key is not there. Archive storage cannot be copied, so a GLACIER
 * or DEEP_ARCHIVE key is reported and left where it is.
 */
export async function moveKey(from: string, to: string): Promise<{ bytes: number; inPlace: boolean } | null> {
  const hit = (await listPrefix(from)).find((k) => k.key === from);
  if (!hit) return null;
  if (hit.storageClass === 'GLACIER' || hit.storageClass === 'DEEP_ARCHIVE') return { bytes: hit.size, inPlace: true };
  const { CopyObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  await c.send(new CopyObjectCommand({ Bucket: config.aws.s3Bucket, Key: to, CopySource: `${config.aws.s3Bucket}/${from.split('/').map(encodeURIComponent).join('/')}` }));
  await c.send(new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: from }));
  return { bytes: hit.size, inPlace: false };
}

/** Upload one local file to a key of the origin bucket (the restore bin's files, 2.1a-2c). */
export async function putFileAt(key: string, path: string): Promise<number> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { createReadStream } = await import('node:fs');
  const size = (await stat(path)).size;
  await (await client()).send(new PutObjectCommand({ Bucket: config.aws.s3Bucket, Key: key, Body: createReadStream(path), ContentLength: size }));
  return size;
}

/** Download one key of the origin bucket to a local file (a restore from the bin, 2.1a-2c). */
export async function getKeyTo(key: string, path: string): Promise<void> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { createWriteStream } = await import('node:fs');
  const { mkdir, rename } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { pipeline } = await import('node:stream/promises');
  const r: any = await (await client()).send(new GetObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
  await mkdir(dirname(path), { recursive: true });
  // Written beside the target and renamed in, so a reader never sees half a file.
  const part = `${path}.restoring`;
  await pipeline(r.Body, createWriteStream(part));
  await rename(part, path);
}

/** Delete these keys (a repackage's old package, services/repackage.ts). */
export async function deleteKeys(keys: string[]): Promise<number> {
  const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  for (let i = 0; i < keys.length; i += 1000) {
    await c.send(new DeleteObjectsCommand({ Bucket: config.aws.s3Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
  }
  return keys.length;
}
