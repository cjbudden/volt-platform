// ============================================================================
//  S3 STORAGE DRIVER: the retention ladder on S3 (or MinIO, LocalStack, moto).
//
//  Until 20 Oct 2026 `storageDriver()` always returned the local driver, even
//  on a deployment configured with MEDIA_STORE_DRIVER=s3. capabilities() then
//  offered cold and archive tiers that `transition()` refused, and the sweep's
//  delete called rmSync on an s3:// URI, which "succeeded" by doing nothing:
//  the row said deleted and the bytes stayed in the bucket and on the bill.
//
//  A location URI is one of
//    s3://bucket/key           one object (a progressive clip.mp4)
//    s3://bucket/prefix/       everything under the prefix (a clip's HLS tree,
//                              a run rendition). The trailing slash is what
//                              says "prefix", so a key can never be widened by
//                              accident: s3://b/clips/abc does NOT reach
//                              s3://b/clips/abcdef/...
//  Anything else (a local path) is handed to the local driver, so one
//  deployment can hold both, which an S3 deployment does: clip outputs are
//  built on local disk before they are uploaded.
//
//  The SDK is reached through a tiny `S3Api` (one `send`), so the same code is
//  driven by the real client against an S3 API in test/s3Retention.check.ts.
// ============================================================================
import type { RestoreSpeed, RestoreStatus, StorageDriver, StorageTier, StoredObject } from './storage';

export interface S3Api { send(command: any): Promise<any> }

/** S3 storage class for each Volt tier (local has none). */
export const STORAGE_CLASS: Record<Exclude<StorageTier, 'local'>, string> = {
  s3_standard: 'STANDARD',
  s3_ia: 'STANDARD_IA',
  s3_glacier_ir: 'GLACIER_IR',
  s3_glacier_flexible: 'GLACIER',
  s3_deep_archive: 'DEEP_ARCHIVE',
};
const RESTORE_TIER: Record<RestoreSpeed, string> = { expedited: 'Expedited', standard: 'Standard', bulk: 'Bulk' };
/** How long a restored copy stays readable before it lapses back to archive. */
export const RESTORE_DAYS = Number(process.env.MEDIA_RESTORE_DAYS ?? 7);

export interface S3Location { bucket: string; key: string; prefix: boolean }

export function parseS3Uri(uri: string): S3Location | null {
  const m = /^s3:\/\/([^/]+)\/(.*)$/.exec(uri);
  if (!m || !m[2]) return null;   // never the whole bucket
  return { bucket: m[1], key: m[2], prefix: m[2].endsWith('/') };
}

export const isS3Uri = (uri: string) => uri.startsWith('s3://');

/** Parse the `x-amz-restore` value: ongoing-request="false", expiry-date="Fri, 23 Oct 2026 00:00:00 GMT". */
export function parseRestoreHeader(h: string | undefined | null): { ongoing: boolean; expiresAt: Date | null } | null {
  if (!h) return null;
  const ongoing = /ongoing-request="true"/.test(h);
  const exp = /expiry-date="([^"]+)"/.exec(h);
  return { ongoing, expiresAt: exp ? new Date(exp[1]) : null };
}

/** Archive classes need a restore before a byte can be read. Glacier IR does not. */
const needsRestore = (cls: string | undefined) => cls === 'GLACIER' || cls === 'DEEP_ARCHIVE';

export class S3Driver implements StorageDriver {
  readonly kind = 's3' as const;
  constructor(private api: () => Promise<S3Api>) {}

  private async sdk() { return import('@aws-sdk/client-s3'); }

  /** Every object a location covers, with its size and storage class. */
  async objects(uri: string): Promise<{ key: string; bytes: number; storageClass: string }[]> {
    const loc = parseS3Uri(uri);
    if (!loc) throw new Error(`Not an S3 location: ${uri}`);
    const s3 = await this.api();
    const { HeadObjectCommand, ListObjectsV2Command } = await this.sdk();
    if (!loc.prefix) {
      try {
        const h = await s3.send(new HeadObjectCommand({ Bucket: loc.bucket, Key: loc.key }));
        return [{ key: loc.key, bytes: Number(h.ContentLength ?? 0), storageClass: h.StorageClass ?? 'STANDARD' }];
      } catch (e: any) {
        if (isNotFound(e)) return [];
        throw e;
      }
    }
    const out: { key: string; bytes: number; storageClass: string }[] = [];
    let token: string | undefined;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: loc.bucket, Prefix: loc.key, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push({ key: o.Key, bytes: Number(o.Size ?? 0), storageClass: o.StorageClass ?? 'STANDARD' });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async stat(uri: string) {
    const objs = await this.objects(uri);
    if (!objs.length) return null;
    return { bytes: objs.reduce((n, o) => n + o.bytes, 0) };
  }

  /**
   * Change the storage class in place (a copy onto itself, which is how S3
   * changes class). The URI does not change, so nothing that links to the
   * media has to. An object already in the class is left alone, so a retry
   * after a part-failure only redoes what is left.
   */
  async transition(uri: string, to: StorageTier): Promise<StoredObject> {
    if (to === 'local') throw new Error('S3 media cannot transition to local disk; restore it instead.');
    const loc = parseS3Uri(uri)!;
    const cls = STORAGE_CLASS[to];
    const s3 = await this.api();
    const { CopyObjectCommand } = await this.sdk();
    const objs = await this.objects(uri);
    if (!objs.length) throw new Error(`Nothing at ${uri} to move to ${to}`);
    let bytes = 0;
    for (const o of objs) {
      bytes += o.bytes;
      if (o.storageClass === cls) continue;
      if (needsRestore(o.storageClass)) {
        // S3 refuses to copy an archived object that has not been restored.
        // Say so rather than surface the SDK's InvalidObjectState.
        throw new Error(`${o.key} is in ${o.storageClass}; restore it before moving it to ${to}`);
      }
      await s3.send(new CopyObjectCommand({
        Bucket: loc.bucket, Key: o.key,
        CopySource: `${loc.bucket}/${o.key.split('/').map(encodeURIComponent).join('/')}`,
        StorageClass: cls as any, MetadataDirective: 'COPY',
      }));
    }
    return { uri, bytes, tier: to };
  }

  async requestRestore(uri: string, speed: RestoreSpeed): Promise<RestoreStatus> {
    const loc = parseS3Uri(uri)!;
    const s3 = await this.api();
    const { RestoreObjectCommand } = await this.sdk();
    for (const o of await this.objects(uri)) {
      if (!needsRestore(o.storageClass)) continue;
      try {
        await s3.send(new RestoreObjectCommand({
          Bucket: loc.bucket, Key: o.key,
          RestoreRequest: { Days: RESTORE_DAYS, GlacierJobParameters: { Tier: RESTORE_TIER[speed] as any } },
        }));
      } catch (e: any) {
        // Asking again while a restore is running is not an error for us.
        if (e?.name !== 'RestoreAlreadyInProgress' && e?.Code !== 'RestoreAlreadyInProgress') throw e;
      }
    }
    return this.restoreStatus(uri);
  }

  /** Ready when every archived object under the location has a finished restore. */
  async restoreStatus(uri: string): Promise<RestoreStatus> {
    const loc = parseS3Uri(uri)!;
    const s3 = await this.api();
    const { HeadObjectCommand } = await this.sdk();
    let ready = true;
    let expiresAt: Date | null = null;
    for (const o of await this.objects(uri)) {
      if (!needsRestore(o.storageClass)) continue;
      const h = await s3.send(new HeadObjectCommand({ Bucket: loc.bucket, Key: o.key }));
      const r = parseRestoreHeader(h.Restore);
      if (!r || r.ongoing) { ready = false; continue; }
      if (r.expiresAt && (!expiresAt || r.expiresAt < expiresAt)) expiresAt = r.expiresAt;
    }
    return { ready, expectedBy: null, expiresAt };
  }

  /** Remove every object the location covers. Idempotent: nothing there is success. */
  async remove(uri: string): Promise<void> {
    const loc = parseS3Uri(uri);
    if (!loc) throw new Error(`Not an S3 location: ${uri}`);
    const s3 = await this.api();
    const { DeleteObjectsCommand } = await this.sdk();
    const keys = (await this.objects(uri)).map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) {
      const r = await s3.send(new DeleteObjectsCommand({
        Bucket: loc.bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }));
      if (r.Errors?.length) {
        const e = r.Errors[0];
        throw new Error(`S3 refused to delete ${r.Errors.length} object(s) under ${uri}, first ${e.Key}: ${e.Code} ${e.Message ?? ''}`.trim());
      }
    }
  }
}

function isNotFound(e: any) {
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Routes by URI: s3:// to S3, anything else to the local driver. The kind it
 * reports is the deployment's, which is what capabilities() describes.
 */
export class RoutingDriver implements StorageDriver {
  readonly kind = 's3' as const;
  constructor(private s3: StorageDriver, private local: StorageDriver) {}
  private pick(uri: string) { return isS3Uri(uri) ? this.s3 : this.local; }
  stat(uri: string) { return this.pick(uri).stat(uri); }
  transition(uri: string, to: StorageTier) { return this.pick(uri).transition(uri, to); }
  requestRestore(uri: string, speed: RestoreSpeed) { return this.pick(uri).requestRestore(uri, speed); }
  restoreStatus(uri: string) { return this.pick(uri).restoreStatus(uri); }
  remove(uri: string) { return this.pick(uri).remove(uri); }
}

/** The SDK client for media storage, built once. AWS_ENDPOINT_URL(_S3) + S3_FORCE_PATH_STYLE=1 for MinIO, LocalStack or moto. */
let client: S3Api | null = null;
export async function mediaS3Client(region: string): Promise<S3Api> {
  if (!client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    client = new S3Client({
      region,
      endpoint: process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
//  Upload a built output tree (a clip, an extract) so the ladder can own it.
// ---------------------------------------------------------------------------
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join, relative } from 'node:path';

const CONTENT_TYPE: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.vtt': 'text/vtt', '.json': 'application/json', '.jpg': 'image/jpeg',
};
const typeOf = (f: string) => CONTENT_TYPE[f.slice(f.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
/** Manifests can be re-cut (re-trim), so they are never cached; media is immutable. */
const cacheOf = (f: string) => (/\.(m3u8|mpd)$/i.test(f) ? 'no-cache' : 'public, max-age=31536000, immutable');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Upload every file under `dir` to s3://bucket/prefix/ and return the prefix
 * location (with its trailing slash, so the ladder removes exactly this tree).
 */
export async function uploadTree(api: S3Api, dir: string, bucket: string, prefix: string): Promise<{ uri: string; bytes: number; files: number }> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const base = prefix.replace(/^\/+|\/+$/g, '');
  if (!base) throw new Error('Refusing to upload to the bucket root: give a prefix');
  let bytes = 0;
  const files = walk(dir);
  for (const f of files) {
    const key = `${base}/${relative(dir, f).split(/[\\/]/).join('/')}`;
    const size = statSync(f).size;
    await api.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: createReadStream(f), ContentLength: size,
      ContentType: typeOf(f), CacheControl: cacheOf(f),
    }));
    bytes += size;
  }
  return { uri: `s3://${bucket}/${base}/`, bytes, files: files.length };
}
