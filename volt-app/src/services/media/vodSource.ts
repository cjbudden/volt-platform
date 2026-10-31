// ============================================================================
//  WHERE AN ON-DEMAND ASSET'S ORIGINAL LIVES (build queue 2.1a-2b, first piece;
//  decided 27 Oct: option B, S3).
//
//  An upload or a watch folder drop keeps its original file so the asset can
//  be encoded (and encoded again) without the operator sending it twice. On the
//  Mac that file is under CLIPS_DIR/vod-src/ and vod_assets.source_key is its
//  path, as it always was.
//
//  On AWS the control plane is several Fargate tasks sharing one job queue. The
//  task that finished an upload is rarely the one whose worker takes its encode,
//  so the encode failed with "the source file is not there", and a replaced task
//  took every original it held with it. With VOD_SOURCE_DRIVER=s3 (Terraform
//  sets it) the original is landed in the origin bucket under vod-src/ once the
//  ingest rules have named it, source_key becomes its s3:// address, and any
//  task that needs the bytes for ffmpeg takes a private scratch copy for the
//  length of the job and removes it afterwards (fetchVodSource). Files users
//  reach live in the bucket; the task's disk only holds work in flight.
//
//  Copies are per use, not shared: two jobs on one task each get their own, so
//  one finishing can never remove a file the other still has open. A fetch is
//  in-region traffic between S3 and the task, which costs nothing per byte.
// ============================================================================
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../../config';

export type VodSourceDriver = 'local' | 's3';

export function vodSourceDriver(): VodSourceDriver {
  return (process.env.VOD_SOURCE_DRIVER ?? 'local') === 's3' ? 's3' : 'local';
}

/** The folder originals are kept in on this machine (the local driver), and
 *  where they are assembled and named before they land (either driver). */
export function vodSourceRoot(): string {
  return resolve(config.clips.dir, 'vod-src');
}

function bucket(): string { return process.env.VOD_SOURCE_S3_BUCKET || config.aws.s3Bucket; }
function prefix(): string { return (process.env.VOD_SOURCE_S3_PREFIX ?? 'vod-src').replace(/^\/+|\/+$/g, ''); }

let client: any = null;
async function s3(): Promise<any> {
  if (!client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    // S3_FORCE_PATH_STYLE=1 with AWS_ENDPOINT_URL points this at MinIO, LocalStack or moto.
    client = new S3Client({ region: config.aws.region, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  }
  return client;
}
/** Tests switch drivers and endpoints inside one process. */
export function resetVodSourceClient(): void { client = null; }

/** The bucket and key of an s3:// source key this store wrote, or null. Only
 *  keys under the vod-src prefix with plain segments are accepted, so a
 *  crafted or foreign value can never be fetched or deleted through here. */
export function parseSourceUri(key: string | null | undefined): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(key ?? ''));
  if (!m) return null;
  const parts = m[2].split('/');
  if (m[2].endsWith('/') || parts.some((p) => !p || p === '.' || p === '..')) return null;
  const pre = prefix();
  if (pre && !m[2].startsWith(pre + '/')) return null;
  return { bucket: m[1], key: m[2] };
}

/** True when the source key is an original this store holds in the bucket. */
export function isBucketSource(key: string | null | undefined): boolean {
  return !!parseSourceUri(key);
}

/**
 * Whether an original can be read, without fetching it. A bucket original is
 * taken as present (the row was written after the upload succeeded; a fetch
 * says otherwise when it is not); a local one must be on this disk.
 */
export function vodSourceAvailable(key: string | null | undefined): boolean {
  if (!key) return false;
  if (isBucketSource(key)) return true;
  if (/^[a-z0-9]+:\/\//i.test(String(key))) return false;
  try { return existsSync(String(key)); } catch { return false; }
}

/**
 * The ingest has named and placed the original at `path` (under vod-src). With
 * the local driver that is where it stays: the path is returned unchanged. On
 * S3 the file and its sidecar (when one was written beside it) go to the
 * bucket under the same relative name, the disk copies are removed so nothing
 * is left that only this task has, and the s3:// address is returned.
 */
export async function landVodSource(path: string, sidecar?: string | null): Promise<string> {
  if (vodSourceDriver() === 'local') return path;
  const root = vodSourceRoot();
  const abs = resolve(path);
  // A file outside vod-src is kept by name only; it still has to reach every task.
  const rel = abs.startsWith(root + sep) ? relative(root, abs).split(sep).join('/') : basename(abs);
  const key = `${prefix() ? prefix() + '/' : ''}${rel}`;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const size = (await stat(abs)).size;
  await (await s3()).send(new PutObjectCommand({
    Bucket: bucket(), Key: key, Body: createReadStream(abs), ContentLength: size, ContentType: 'application/octet-stream',
  }));
  if (sidecar && existsSync(sidecar)) {
    const sk = `${dirname(key) === '.' ? '' : dirname(key) + '/'}${basename(sidecar)}`;
    const sz = (await stat(sidecar)).size;
    await (await s3()).send(new PutObjectCommand({ Bucket: bucket(), Key: sk, Body: createReadStream(sidecar), ContentLength: sz }))
      .catch((e: any) => console.warn('[vod-src] sidecar not landed', e?.message ?? e));
    await rm(sidecar, { force: true });
  }
  await rm(abs, { force: true });
  return `s3://${bucket()}/${key}`;
}

/** A local file ffmpeg can open, and how to give it back. */
export interface FetchedSource { path: string; fetched: boolean; release(): Promise<void> }

/**
 * A file on this disk for the original behind `key`, or null when it has no
 * bytes. A local key is the file itself (release does nothing). A bucket key is
 * fetched into a private scratch folder (VOD_SOURCE_CACHE_DIR), written beside
 * and renamed so a reader never opens half a file; release removes it.
 */
export async function fetchVodSource(key: string | null | undefined): Promise<FetchedSource | null> {
  if (!key) return null;
  const loc = parseSourceUri(key);
  if (!loc) {
    if (/^[a-z0-9]+:\/\//i.test(String(key)) || !existsSync(String(key))) return null;
    return { path: String(key), fetched: false, release: async () => {} };
  }
  const root = resolve(process.env.VOD_SOURCE_CACHE_DIR || join(tmpdir(), 'volt-vod-src'));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'use-'));
  const dest = join(dir, basename(loc.key));
  const release = async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); };
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const r = await (await s3()).send(new GetObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
    const part = `${dest}.part`;
    await pipeline(r.Body as Readable, createWriteStream(part));
    const { rename } = await import('node:fs/promises');
    await rename(part, dest);
    return { path: dest, fetched: true, release };
  } catch (e: any) {
    await release();
    const code = e?.$metadata?.httpStatusCode;
    if (code === 404 || e?.name === 'NoSuchKey' || e?.name === 'NotFound') return null;
    throw e;
  }
}

/** Run `fn` with a local copy of the original; the copy is removed afterwards. */
export async function withVodSource<T>(key: string | null | undefined, fn: (path: string) => Promise<T>): Promise<T | null> {
  const f = await fetchVodSource(key);
  if (!f) return null;
  try { return await fn(f.path); } finally { await f.release(); }
}

/** Remove an original (a missing one is not an error), and in the bucket its
 *  sidecar. Local paths are removed only when they are inside vod-src, as before. */
export async function deleteVodSource(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const loc = parseSourceUri(key);
  if (loc) {
    // The sidecar the ingest landed beside it (<file>.json or .xml) goes with it.
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    for (const k of [loc.key, `${loc.key}.json`, `${loc.key}.xml`]) {
      await (await s3()).send(new DeleteObjectCommand({ Bucket: loc.bucket, Key: k })).catch(() => {});
    }
    return;
  }
  if (/^[a-z0-9]+:\/\//i.test(String(key))) return;
  const abs = resolve(String(key));
  if (abs.startsWith(vodSourceRoot() + sep)) await rm(abs, { force: true }).catch(() => {});
}
