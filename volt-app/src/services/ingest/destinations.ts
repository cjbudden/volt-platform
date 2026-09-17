// ============================================================================
//  DESTINATIONS — where an ingested object and its sidecar end up.
//
//  The pipeline names the object (naming.ts) and hands the bytes to one of
//  these. Local keeps them under a root. S3 streams them as a multipart
//  upload with several parts in flight, which is what turns a 60 GB file
//  into minutes rather than an hour, and is the same code the cloud to
//  cloud worker uses for the far end of a Dropbox or Drive fetch.
// ============================================================================
import { createReadStream, statSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { open } from 'node:fs/promises';
import type { S3Api } from './s3';

export interface Destination {
  readonly kind: 'local' | 's3';
  /** Human-readable store label for the payload ('local', 's3://bucket'). */
  readonly store: string;
  /** Copy a local file to `key`. Returns the uri the library records. */
  put(localPath: string, key: string, contentType?: string): Promise<{ uri: string; bytes: number }>;
  putText(key: string, text: string, contentType?: string): Promise<{ uri: string }>;
  exists(key: string): Promise<boolean>;
}

export class LocalDestination implements Destination {
  readonly kind = 'local' as const;
  readonly store = 'local';
  constructor(private root: string) {}
  async put(localPath: string, key: string) {
    const to = join(this.root, key);
    mkdirSync(dirname(to), { recursive: true });
    if (to !== localPath) copyFileSync(localPath, to);
    return { uri: to, bytes: statSync(to).size };
  }
  async putText(key: string, text: string) { const to = join(this.root, key); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, text); return { uri: to }; }
  async exists(key: string) { return existsSync(join(this.root, key)); }
}

export interface S3DestinationOptions {
  bucket: string;
  prefix?: string;           // 'accounts/acc_1/media'
  partBytes?: number;        // default 64 MB
  parallel?: number;         // parts in flight, default 6
}

export class S3Destination implements Destination {
  readonly kind = 's3' as const;
  readonly store: string;
  constructor(private s3: S3Api, private o: S3DestinationOptions) { this.store = `s3://${o.bucket}${o.prefix ? '/' + o.prefix.replace(/^\/+|\/+$/g, '') : ''}`; }
  key(k: string) { const p = (this.o.prefix ?? '').replace(/^\/+|\/+$/g, ''); return p ? `${p}/${k}` : k; }
  uri(k: string) { return `s3://${this.o.bucket}/${this.key(k)}`; }

  async put(localPath: string, key: string, contentType = 'application/octet-stream') {
    const bytes = statSync(localPath).size;
    const K = this.key(key);
    const partBytes = this.o.partBytes ?? 64 * 1024 * 1024;
    if (bytes <= partBytes) {
      const fh = await open(localPath, 'r'); try { const buf = Buffer.alloc(bytes); await fh.read(buf, 0, bytes, 0); await this.s3.put(this.o.bucket, K, buf, contentType); } finally { await fh.close(); }
      return { uri: this.uri(key), bytes };
    }
    const uploadId = await this.s3.createMultipart(this.o.bucket, K, contentType);
    const partCount = Math.ceil(bytes / partBytes);
    const parts: { partNumber: number; etag: string }[] = [];
    let next = 1; let failed: any = null;
    const fh = await open(localPath, 'r');
    const worker = async () => {
      for (;;) {
        const n = next++; if (n > partCount || failed) return;
        const start = (n - 1) * partBytes; const len = Math.min(partBytes, bytes - start);
        const buf = Buffer.alloc(len);
        try { await fh.read(buf, 0, len, start); const r = await this.s3.uploadPart(this.o.bucket, K, uploadId, n, buf); parts.push({ partNumber: n, etag: r.etag }); }
        catch (e) { failed = e; return; }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.o.parallel ?? 6, partCount) }, worker));
      if (failed) throw failed;
      await this.s3.completeMultipart(this.o.bucket, K, uploadId, parts);
    } catch (e) {
      await this.s3.abortMultipart(this.o.bucket, K, uploadId).catch(() => {});
      throw e;
    } finally { await fh.close(); }
    return { uri: this.uri(key), bytes };
  }
  async putText(key: string, text: string, contentType = 'application/json') { await this.s3.put(this.o.bucket, this.key(key), text, contentType); return { uri: this.uri(key) }; }
  async exists(key: string) { return !!(await this.s3.head(this.o.bucket, this.key(key))); }
}

/** Stream helper for callers that want the bytes rather than a path. */
export function fileStream(path: string) { return createReadStream(path); }
