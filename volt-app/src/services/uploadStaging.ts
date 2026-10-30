// ============================================================================
//  WHERE AN UPLOAD WAITS WHILE IT IS IN FLIGHT (build queue 2.1a-2).
//
//  A resumable upload arrives as many requests: numbered chunks for the chunk
//  protocol (Background Fetch, the console), PATCH bodies at an offset for tus.
//  On the Mac every request reaches the one server, so the parts wait on its
//  disk under UPLOAD_STAGING_DIR/<session>/ as they always did.
//
//  On AWS the control plane is several Fargate tasks behind a load balancer
//  with no stickiness, so chunk 3 can reach one task and chunk 4 another, and
//  whichever task is asked to finish found only its own share on its disk. A
//  big upload failed as "chunk N is missing from disk" although every chunk had
//  been acknowledged. With UPLOAD_STAGING_DRIVER=s3 (Terraform sets it) each
//  part is an object in the origin bucket under upload-staging/<session>/, so
//  any task can take any part and any task can assemble. The assembled file is
//  in-flight scratch on the assembling task's disk, as decided for 2.1a
//  (Christian, 27 Oct, option B): files users reach live in the bucket, the
//  task's disk only for work a job reads and writes while it runs.
//
//  The database stays the authority for what has arrived (received[] for
//  chunks, received_bytes for tus), so a part object with no row behind it is
//  never used; the bucket's lifecycle rule (Terraform) removes forgotten ones.
// ============================================================================
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '../config';

export type StagingDriver = 'local' | 's3';

export function stagingDriver(): StagingDriver {
  return (process.env.UPLOAD_STAGING_DRIVER ?? 'local') === 's3' ? 's3' : 'local';
}

/** This task's own scratch folder for a session: the parts with the local
 *  driver, and on either driver the place a file is assembled before it lands. */
export function sessionDir(id: string): string {
  return join(config.uploads.dir, id);
}
function chunkName(index: number): string { return `${String(index).padStart(6, '0')}.part`; }
function chunkPath(id: string, index: number): string { return join(sessionDir(id), chunkName(index)); }

// ------------------------------------------------------------------ S3 side
function bucket(): string { return process.env.UPLOAD_STAGING_S3_BUCKET || config.aws.s3Bucket; }
function prefixFor(id: string): string {
  const root = (process.env.UPLOAD_STAGING_S3_PREFIX ?? 'upload-staging').replace(/^\/+|\/+$/g, '');
  // Session ids are uuids (or hex for a memory tus store); anything else is refused
  // so a crafted id can never reach outside the staging prefix.
  if (!/^[0-9A-Za-z-]{8,64}$/.test(id)) throw new Error(`not an upload session id: ${id}`);
  return `${root}/${id}/`;
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
/** Tests switch drivers and endpoints inside one process. */
export function resetStagingClient(): void { client = null; }

async function put(key: string, body: Buffer | Readable, length: number): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentLength: length, ContentType: 'application/octet-stream' }));
}
async function list(prefix: string): Promise<{ key: string; size: number }[]> {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r: any = await (await s3()).send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: String(o.Key), size: Number(o.Size ?? 0) });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
async function get(key: string): Promise<Readable | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const r: any = await (await s3()).send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return r.Body as Readable;
  } catch (e: any) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

// ------------------------------------------------------------------ chunks
/** Keep one chunk of a session. Writing the same index twice is harmless: a
 *  retried chunk is the same bytes (its length is checked before this). */
export async function putChunk(id: string, index: number, body: Buffer): Promise<void> {
  if (stagingDriver() === 'local') {
    mkdirSync(sessionDir(id), { recursive: true });
    writeFileSync(chunkPath(id, index), body);
    return;
  }
  await put(`${prefixFor(id)}c/${chunkName(index)}`, body, body.length);
}

/** The bytes of one chunk, from wherever any task left them. */
export async function openChunk(id: string, index: number): Promise<Readable> {
  if (stagingDriver() === 'local') {
    const p = chunkPath(id, index);
    if (!existsSync(p)) throw new Error(`chunk ${index} is missing from disk`);
    return createReadStream(p);
  }
  const body = await get(`${prefixFor(id)}c/${chunkName(index)}`);
  if (!body) throw new Error(`chunk ${index} is missing from the bucket`);
  return body;
}

// ------------------------------------------------------------------ tus parts
// Each PATCH body is its own object named by the byte range it covers,
// <start>-<end>.part. tus is sequential, so parts follow each other; but two
// tasks can both receive a retried PATCH at the same offset, and only the one
// whose database update wins counts (advanceTusOffset in modules/tus.ts). A
// loser may have left a part of another length at the same start, so the
// assembly walks the ranges from 0 to the length instead of trusting a listing.
const pad = (n: number) => String(n).padStart(15, '0');

export async function putTusPart(id: string, start: number, path: string, bytes: number): Promise<void> {
  await put(`${prefixFor(id)}t/${pad(start)}-${pad(start + bytes)}.part`, createReadStream(path), bytes);
}

/** The part keys that join into exactly [0, length), in order; null if a range is missing. */
export async function tusChain(id: string, length: number): Promise<string[] | null> {
  const byStart = new Map<number, { end: number; key: string }[]>();
  for (const o of await list(`${prefixFor(id)}t/`)) {
    const m = /\/(\d{15})-(\d{15})\.part$/.exec(o.key);
    if (!m) continue;
    const start = Number(m[1]), end = Number(m[2]);
    if (end <= start || end > length || o.size !== end - start) continue;
    if (!byStart.has(start)) byStart.set(start, []);
    byStart.get(start)!.push({ end, key: o.key });
  }
  // Longest first, so the usual case (one part per start) is a straight walk.
  for (const v of byStart.values()) v.sort((a, b) => b.end - a.end);
  const seen = new Set<number>();
  const walk = (at: number): string[] | null => {
    if (at === length) return [];
    if (seen.has(at)) return null;
    seen.add(at);
    for (const p of byStart.get(at) ?? []) {
      const rest = walk(p.end);
      if (rest) return [p.key, ...rest];
    }
    return null;
  };
  return walk(0);
}

export async function openKey(key: string): Promise<Readable> {
  const body = await get(key);
  if (!body) throw new Error(`a part of this upload is missing from the bucket (${key.split('/').pop()})`);
  return body;
}

// ------------------------------------------------------------------ cleanup
/** Remove everything a session left: this task's folder, and on S3 its objects.
 *  Returns the bytes freed. */
export async function removeStaged(id: string): Promise<number> {
  let bytes = dirBytes(sessionDir(id));
  try { rmSync(sessionDir(id), { recursive: true, force: true }); } catch { /* */ }
  if (stagingDriver() === 's3') {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    for (const o of await list(prefixFor(id))) {
      await (await s3()).send(new DeleteObjectCommand({ Bucket: bucket(), Key: o.key }));
      bytes += o.size;
    }
  }
  return bytes;
}

export function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      try { total += e.isDirectory() ? dirBytes(p) : statSync(p).size; } catch { /* */ }
    }
  } catch { /* */ }
  return total;
}
