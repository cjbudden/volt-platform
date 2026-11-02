// ============================================================================
//  CLIP AND ENCODE FILES FROM ANY TASK (build queue 2.1a-2b-2, first piece;
//  decided 27 Oct: option B, files users reach live in the bucket).
//
//  A clip is cut into CLIPS_DIR/<asset>/ and a VOD encode packaged into
//  CLIPS_DIR/vod/<asset>/ on the task that ran the job. On an S3 deployment both
//  are copied to the origin bucket as they finish (clips/<asset>/ by
//  clip.extract, vod/<asset>/ by services/fast/vodStore.ts), but the control
//  plane still answered /clips and downloads from its own disk. On AWS the load
//  balancer sends a viewer to any task, so a clip made on task A played only
//  when the request happened to reach A, every encode's MP4 download answered
//  "That file is no longer here" (its key is the bucket key vod/<id>/<file>,
//  which the download route did not know), and a replaced task took the only
//  servable copy with it.
//
//  This is the read side: when a file under /clips is not on this task's disk
//  and the deployment copies that kind of file to the bucket, it is read from
//  the bucket instead. The Mac is unchanged (nothing is copied there, so
//  nothing is looked up).
//
//  Only the two prefixes the jobs write are mapped, and only with plain path
//  segments under a uuid, so a request can never reach the originals
//  (vod-src/, private by 2.1a-2b), upload parts or anything else in the bucket.
// ============================================================================
import type { Readable } from 'node:stream';
import { config } from '../../config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clips go to the bucket when the media store is S3 (clip.extract; CLIPS_S3_UPLOAD=false opts out). */
export function clipsInBucket(): boolean {
  return config.mediaStore.driver === 's3' && process.env.CLIPS_S3_UPLOAD !== 'false';
}

/** Encodes go to the bucket when VOD_STORE resolves to s3 (services/fast/vodStore.ts). */
async function encodesInBucket(): Promise<boolean> {
  const { vodStore } = await import('../fast/vodStore');
  return vodStore() === 's3';
}

/**
 * Folders under CLIPS_DIR that are working space, never served: originals of
 * uploads and watch folder drops (vod-src, 2.1a-2b keeps them private on the
 * CDN too) and the encoder's probe scratch.
 */
export function isPrivateClipsPath(rel: string): boolean {
  const first = String(rel).replace(/^\/+/, '').split('/')[0];
  if (first === 'vod-src') return true;
  const parts = String(rel).replace(/^\/+/, '').split('/');
  return parts[0] === 'vod' && (parts[1] ?? '').startsWith('_');
}

/**
 * The bucket key behind a path under /clips, or null when there is none.
 *   /<asset>/<file...>      -> clips/<asset>/<file...>   (clip outputs)
 *   /vod/<asset>/<file...>  -> vod/<asset>/<file...>     (encode outputs)
 * Pure: says nothing about whether this deployment copies that kind of file.
 */
export function bucketKeyForClipsPath(rel: string): { key: string; kind: 'clip' | 'encode' } | null {
  const parts = String(rel ?? '').replace(/^\/+/, '').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) return null;
  if (parts[0] === 'vod') {
    if (parts.length < 3 || !UUID.test(parts[1])) return null;
    return { key: parts.join('/'), kind: 'encode' };
  }
  if (parts.length < 2 || !UUID.test(parts[0])) return null;
  return { key: ['clips', ...parts].join('/'), kind: 'clip' };
}

/** A stored key that is itself a bucket key of an encode (vod/<asset>/<file>, as vodEncode writes on S3). */
export function isEncodeBucketKey(key: string | null | undefined): boolean {
  const k = String(key ?? '');
  if (k.startsWith('/') || /^[a-z]+:\/\//i.test(k)) return false;
  const b = bucketKeyForClipsPath(k);
  return !!b && b.kind === 'encode';
}

/** The bucket key to read for a /clips path on this deployment, or null when that kind of file is not copied here. */
export async function readThroughKey(rel: string): Promise<string | null> {
  if (isPrivateClipsPath(rel)) return null;
  const b = bucketKeyForClipsPath(rel);
  if (!b) return null;
  if (b.kind === 'clip' ? !clipsInBucket() : !(await encodesInBucket())) return null;
  return b.key;
}

async function client(): Promise<any> {
  const { mediaS3Client } = await import('./s3Driver');
  return mediaS3Client(config.aws.region);
}

const missing = (e: any) => e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

export interface BucketObject {
  body: Readable; length: number | null; type: string | null; etag: string | null;
  /** Set when a Range was asked for and answered: "bytes a-b/total". */
  range: string | null;
}

/** Open an object for streaming (with an optional Range header), or null when it is not there. */
export async function openObject(key: string, range?: string): Promise<BucketObject | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r: any = await (await client()).send(new GetObjectCommand({
      Bucket: config.aws.s3Bucket, Key: key, ...(range && /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {}),
    }));
    return { body: r.Body as Readable, length: r.ContentLength ?? null, type: r.ContentType ?? null, etag: r.ETag ?? null, range: r.ContentRange ?? null };
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** A small object's bytes (a playlist, an init segment), or null when it is not there. */
export async function readObjectBuffer(key: string): Promise<Buffer | null> {
  const o = await openObject(key);
  if (!o) return null;
  const chunks: Buffer[] = [];
  for await (const c of o.body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** A small object as text (a playlist), or null when it is not there. */
export async function readObjectText(key: string): Promise<string | null> {
  const b = await readObjectBuffer(key);
  return b == null ? null : b.toString('utf8');
}

/** An object's size without reading it, or null when it is not there. */
export async function objectSize(key: string): Promise<number | null> {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r: any = await (await client()).send(new HeadObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
    return r.ContentLength ?? null;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
