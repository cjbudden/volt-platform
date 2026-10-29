// ============================================================================
//  Image store — storage-driver abstraction for the image library.
//  Local runs: a base directory on the local disk (IMAGE_STORE_DIR).
//  Cloud: an S3 bucket + prefix. Same interface either way; the DB (media_files)
//  is the searchable index, the store holds the bytes.
//
//  Layout (keys are relative to the store root):
//    library/<account>/<path>   curated, browsable images (watermarks/slates/…)
//    derived/<account>/<path>   machine-generated files people do not browse: sprites/ holds
//                               every sprite sheet and thumbnail VTT (thumbnails/spriteStore.ts)
//  The resize service is pointed at the store root; the browser defaults to library/.
// ============================================================================
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { config } from '../config';

export interface StoredObject { key: string; size: number; mtimeMs: number }

export interface ImageStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  getStream(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<StoredObject[]>;
  move(from: string, to: string): Promise<void>;
  /** Size of an object, or null when it does not exist (the image service's size guard). */
  stat(key: string): Promise<{ size: number } | null>;
}

/** Reject path traversal / absolute keys; normalise separators to '/'. */
export function safeKey(key: string): string {
  const k = normalize(key).replace(/\\/g, '/').replace(/^\/+/, '');
  if (k.split('/').some((p) => p === '..')) throw new Error(`unsafe key: ${key}`);
  return k;
}

// ---------------------------------------------------------------- local driver
class LocalImageStore implements ImageStore {
  constructor(private baseDir: string) {}
  private abs(key: string) {
    const p = resolve(this.baseDir, safeKey(key));
    if (!p.startsWith(resolve(this.baseDir) + sep) && p !== resolve(this.baseDir)) throw new Error('path escapes store');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.abs(key);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  }
  async get(key: string) {
    try { return await fs.readFile(this.abs(key)); } catch { return null; }
  }
  async getStream(key: string) {
    try { await fs.access(this.abs(key)); return createReadStream(this.abs(key)); } catch { return null; }
  }
  async delete(key: string) { try { await fs.unlink(this.abs(key)); } catch { /* already gone */ } }
  /** Remove the directory for `key` if it holds no files (empty subdirectories go too), then each
   *  parent that is left empty, up to but not including `stop`. Answers how many went. */
  async pruneDirs(key: string, stop: string): Promise<number> {
    const d = this.abs(key), s = this.abs(stop);
    let n = await this.emptyTree(d);
    for (let p = dirname(d); p.startsWith(s + sep); p = dirname(p)) {
      try { await fs.rmdir(p); n++; } catch { break; }
    }
    return n;
  }
  /** Every empty directory under `prefix` (the prefix itself is kept). */
  async pruneTree(prefix: string): Promise<number> {
    const root = this.abs(prefix);
    let n = 0;
    try { for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isDirectory()) n += await this.emptyTree(join(root, e.name)); } catch { /* no library yet */ }
    return n;
  }
  private async emptyTree(dir: string): Promise<number> {
    let n = 0, left = 0;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      if (e.isDirectory()) { n += await this.emptyTree(join(dir, e.name)); try { await fs.access(join(dir, e.name)); left++; } catch { /* removed */ } }
      else left++;
    }
    if (!left) { try { await fs.rmdir(dir); n++; } catch { /* in use */ } }
    return n;
  }
  async exists(key: string) { try { await fs.access(this.abs(key)); return true; } catch { return false; } }
  async stat(key: string) {
    try { const st = await fs.stat(this.abs(key)); return st.isFile() ? { size: st.size } : null; } catch { return null; }
  }
  async move(from: string, to: string) {
    const a = this.abs(from), b = this.abs(to);
    await fs.mkdir(dirname(b), { recursive: true });
    await fs.rename(a, b);
  }
  async list(prefix: string): Promise<StoredObject[]> {
    const root = this.abs(prefix || '.');
    const out: StoredObject[] = [];
    async function walk(dir: string, base: string) {
      let entries: any[] = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(abs, rel);
        else { const st = await fs.stat(abs); out.push({ key: rel, size: st.size, mtimeMs: st.mtimeMs }); }
      }
    }
    await walk(root, safeKey(prefix).replace(/\/$/, ''));
    return out;
  }
}

// ------------------------------------------------------------------ s3 driver
class S3ImageStore implements ImageStore {
  private client: any;
  constructor(private bucket: string, private prefix: string) {}
  private async cli() {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      // S3_FORCE_PATH_STYLE=1 + AWS_ENDPOINT_URL point this at MinIO / LocalStack locally.
      this.client = new S3Client({ region: config.aws.region, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
    }
    return this.client;
  }
  private full(key: string) { return (this.prefix ? this.prefix.replace(/\/$/, '') + '/' : '') + safeKey(key); }
  async put(key: string, body: Buffer, contentType?: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.cli()).send(new PutObjectCommand({ Bucket: this.bucket, Key: this.full(key), Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await (await this.cli()).send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      const chunks: Buffer[] = [];
      for await (const c of r.Body as any) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    } catch { return null; }
  }
  async getStream(key: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await (await this.cli()).send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      return r.Body as Readable;
    } catch { return null; }
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.cli()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
  }
  async exists(key: string) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try { await (await this.cli()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key) })); return true; } catch { return false; }
  }
  async stat(key: string) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await (await this.cli()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch { return null; }
  }
  async move(from: string, to: string) {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.cli()).send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${this.full(from)}`, Key: this.full(to) }));
    await this.delete(from);
  }
  async list(prefix: string): Promise<StoredObject[]> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const out: StoredObject[] = []; let token: string | undefined;
    do {
      const r: any = await (await this.cli()).send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.full(prefix), ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        const rel = o.Key.slice((this.prefix ? this.prefix.replace(/\/$/, '') + '/' : '').length);
        out.push({ key: rel, size: o.Size ?? 0, mtimeMs: o.LastModified ? +new Date(o.LastModified) : 0 });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

let store: ImageStore | null = null;
export function imageStore(): ImageStore {
  if (!store) {
    if (config.imageStore.driver === 's3') store = new S3ImageStore(config.imageStore.s3Bucket, config.imageStore.s3Prefix);
    else store = new LocalImageStore(config.imageStore.localDir);
    store = withForwarding(store);
  }
  return store;
}

/**
 * MOVED IMAGES FORWARD. A library image moved to another folder has a new key
 * (services/media/libraryMoves.ts). Reads of the old key that find nothing
 * follow media_file_moves to the new one, so links held outside the database
 * (web pages, feeds, signed image URLs) keep working. Writes, deletes and
 * existence checks are never forwarded.
 */
function withForwarding(s: ImageStore): ImageStore {
  const moved = async (key: string) => key.startsWith('library/') ? (await import('./media/libraryMoves')).resolveMoved(key) : null;
  return {
    ...((s as any).pruneDirs ? { pruneDirs: (k: string, stop: string) => (s as any).pruneDirs(k, stop), pruneTree: (p: string) => (s as any).pruneTree(p) } : {}),
    put: (k, b, ct) => s.put(k, b, ct),
    delete: (k) => s.delete(k),
    exists: (k) => s.exists(k),
    list: (p) => s.list(p),
    move: (a, b) => s.move(a, b),
    async get(k) { const b = await s.get(k); if (b) return b; const to = await moved(k); return to ? s.get(to) : null; },
    async getStream(k) { const b = await s.getStream(k); if (b) return b; const to = await moved(k); return to ? s.getStream(to) : null; },
    async stat(k) { const b = await s.stat(k); if (b) return b; const to = await moved(k); return to ? s.stat(to) : null; },
  };
}

export function storeDriver(): string { return config.imageStore.driver; }
