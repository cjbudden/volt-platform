// ============================================================================
//  WHERE SLATES AND LOOPS LIVE (build queue 2.1a, decided 27 Oct: option B, S3).
//
//  Loops & Fillers keeps each asset's bytes under its source key,
//  `filler/<account>/<asset id><ext>`. On the Mac that key is a file under
//  FILLER_DIR, as it always was. On AWS the control plane is several Fargate
//  tasks that come and go, so a file on one task's disk is lost when the task
//  is replaced and was never on the others. There the key is an object in the
//  origin bucket (FILLER_STORE_DRIVER=s3), and every task reads the same bytes.
//
//  What uses the bytes, and how each one reaches them:
//    - the browser preview and the encoder's failover slate and loop fetch
//      `/filler/<account>/<file>` from whichever task answers (serveFiller);
//    - the FAST render needs a real file for ffmpeg, so it takes a local copy
//      (localCopy), which on S3 is in-flight scratch on the task's disk;
//    - uploads and watch folders assemble the file on disk first, then hand it
//      over (landFile): a no-op locally, an upload and a cleanup on S3.
// ============================================================================
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config';

export type FillerDriver = 'local' | 's3';

export function fillerDriver(): FillerDriver {
  return (process.env.FILLER_STORE_DRIVER ?? 'local') === 's3' ? 's3' : 'local';
}

/** The source key of an asset's file, as filler_assets.source_key holds it. */
export function fillerKey(accountId: string, assetId: string, ext: string): string {
  return `filler/${accountId}/${assetId}${ext}`;
}

/** Keys come from the database and from request paths: only `filler/...`
 *  with plain segments is accepted, so nothing can reach outside the store. */
function cleanKey(key: string): string | null {
  const k = String(key ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!k.startsWith('filler/')) return null;
  const parts = k.split('/');
  if (parts.length < 3 || parts.some((p) => !p || p === '.' || p === '..')) return null;
  return k;
}

/** Where a key lives on this machine's disk with the local driver. */
export function localPathOf(key: string): string | null {
  const k = cleanKey(key);
  if (!k) return null;
  const root = resolve(config.uploads.fillerDir);
  const p = resolve(root, k.slice('filler/'.length));
  return p.startsWith(root + sep) ? p : null;
}

// ------------------------------------------------------------------ S3 side
function bucket(): string { return process.env.FILLER_S3_BUCKET || config.aws.s3Bucket; }
function objectKey(k: string): string {
  const prefix = (process.env.FILLER_S3_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${k}` : k;
}
let client: any = null;
async function s3(): Promise<any> {
  if (!client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    // S3_FORCE_PATH_STYLE=1 with AWS_ENDPOINT_URL points this at MinIO, LocalStack or moto.
    client = new S3Client({ region: config.aws.region, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  }
  return client;
}
/** Tests switch drivers inside one process. */
export function resetFillerStoreClient(): void { client = null; }

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.ts': 'video/mp2t', '.mxf': 'application/mxf',
};
export function fillerContentType(key: string): string {
  return TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream';
}

// ------------------------------------------------------------------ the store
/** Write bytes under a key. */
export async function putFiller(key: string, body: Buffer): Promise<void> {
  const k = cleanKey(key);
  if (!k) throw new Error(`not a filler key: ${key}`);
  if (fillerDriver() === 'local') {
    const p = localPathOf(k)!;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
    return;
  }
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new PutObjectCommand({ Bucket: bucket(), Key: objectKey(k), Body: body, ContentType: fillerContentType(k) }));
}

/**
 * A finished file assembled on this disk becomes the asset's bytes. Locally
 * the file is moved to the key's place (usually it is already there). On S3 it
 * is uploaded and the disk copy removed, so nothing is left that only one task
 * has.
 */
export async function landFile(path: string, key: string): Promise<void> {
  const k = cleanKey(key);
  if (!k) throw new Error(`not a filler key: ${key}`);
  if (fillerDriver() === 'local') {
    const p = localPathOf(k)!;
    if (resolve(path) !== p) { await mkdir(dirname(p), { recursive: true }); await rename(path, p); }
    return;
  }
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const size = (await stat(path)).size;
  await (await s3()).send(new PutObjectCommand({
    Bucket: bucket(), Key: objectKey(k), Body: createReadStream(path), ContentLength: size, ContentType: fillerContentType(k),
  }));
  await rm(path, { force: true });
}

/** Size of the file behind a key, or null when there is none. */
export async function statFiller(key: string): Promise<{ size: number } | null> {
  const k = cleanKey(key);
  if (!k) return null;
  if (fillerDriver() === 'local') {
    try { const st = await stat(localPathOf(k)!); return st.isFile() ? { size: st.size } : null; } catch { return null; }
  }
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r = await (await s3()).send(new HeadObjectCommand({ Bucket: bucket(), Key: objectKey(k) }));
    return { size: Number(r.ContentLength ?? 0) };
  } catch { return null; }
}

/** Remove the file behind a key (a missing one is not an error). */
export async function deleteFiller(key: string): Promise<void> {
  const k = cleanKey(key);
  if (!k) return;
  if (fillerDriver() === 'local') { await rm(localPathOf(k)!, { force: true }); return; }
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new DeleteObjectCommand({ Bucket: bucket(), Key: objectKey(k) })).catch(() => {});
}

/**
 * A file on this disk ffmpeg can open, or null when the key has no bytes.
 * Locally that is the file itself. On S3 it is a copy in this task's scratch
 * space (FILLER_CACHE_DIR), kept while its size still matches the object so a
 * second render does not fetch it again. Scratch only: losing it costs a fetch.
 */
export async function localCopy(key: string): Promise<string | null> {
  const k = cleanKey(key);
  if (!k) return null;
  if (fillerDriver() === 'local') { const p = localPathOf(k)!; return existsSync(p) ? p : null; }
  const head = await statFiller(k);
  if (!head) return null;
  const root = resolve(process.env.FILLER_CACHE_DIR || join(tmpdir(), 'volt-filler-cache'));
  const dest = resolve(root, k);
  if (!dest.startsWith(root + sep)) return null;
  try { if ((await stat(dest)).size === head.size) return dest; } catch { /* not cached */ }
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const r = await (await s3()).send(new GetObjectCommand({ Bucket: bucket(), Key: objectKey(k) }));
  await mkdir(dirname(dest), { recursive: true });
  // Written beside and renamed, so a render never opens half a file.
  const part = `${dest}.${process.pid}.part`;
  await pipeline(r.Body as Readable, createWriteStream(part));
  await rename(part, dest);
  return dest;
}

/**
 * GET and HEAD of `/filler/<account>/<file>`. Locally the files are served from
 * FILLER_DIR as before. On S3 the object is streamed through, byte ranges
 * included (a <video> preview and the encoder's loop fetch seek), so whichever
 * task the request reaches answers it. Immutable once written: the asset id is
 * the file name, so a new upload is a new URL.
 */
export function serveFiller() {
  let local: any = null;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (fillerDriver() === 'local') {
      if (!local) {
        const express = (await import('express')).default;
        local = express.static(config.uploads.fillerDir, {
          setHeaders: (r) => { r.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); },
        });
      }
      return local(req, res, next);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let path: string;
    try { path = decodeURIComponent(req.path); } catch { return next(); }
    const k = cleanKey('filler' + path);
    if (!k) return next();
    const { GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
    try {
      const cli = await s3();
      const r: any = req.method === 'HEAD'
        ? await cli.send(new HeadObjectCommand({ Bucket: bucket(), Key: objectKey(k) }))
        : await cli.send(new GetObjectCommand({ Bucket: bucket(), Key: objectKey(k), Range: range }));
      res.status(range && r.ContentRange && req.method !== 'HEAD' ? 206 : 200);
      res.setHeader('Content-Type', fillerContentType(k));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (r.ContentLength != null) res.setHeader('Content-Length', String(r.ContentLength));
      if (r.ContentRange && req.method !== 'HEAD') res.setHeader('Content-Range', r.ContentRange);
      if (r.ETag) res.setHeader('ETag', r.ETag);
      if (req.method === 'HEAD') return res.end();
      (r.Body as Readable).on('error', () => res.destroy()).pipe(res);
    } catch (e: any) {
      const code = e?.$metadata?.httpStatusCode;
      if (code === 404 || e?.name === 'NoSuchKey' || e?.name === 'NotFound') return next();
      if (code === 416 || e?.name === 'InvalidRange') { res.status(416).end(); return; }
      next(e);
    }
  };
}
