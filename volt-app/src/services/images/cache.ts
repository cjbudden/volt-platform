// ============================================================================
//  DERIVATIVE CACHE + the small concurrency tools the service needs.
//
//  Three layers, fastest first:
//    1. CloudFront (cloud only): serves repeat requests at the edge and, on an
//       edge miss, reads the S3 cache below BEFORE asking the API (an origin
//       group: S3 first, the API on 403/404). See deploy/terraform/images.tf.
//    2. MemoryLru: a per-task byte-capped LRU for the hottest derivatives.
//    3. DerivativeCache: S3 in the cloud, a directory locally. Written once per
//       rendered URL, at exactly the request path (under a prefix), which is
//       what lets CloudFront find it without the API.
//
//  A cache write never fails a request: the image is already rendered.
// ============================================================================
import { promises as fs } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export interface CachedImage { body: Buffer; contentType: string }

export interface DerivativeCache {
  readonly driver: string;
  get(key: string): Promise<CachedImage | null>;
  put(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void>;
}

/** Content type from the request's format; local files carry no metadata. */
export type TypeOf = (key: string) => string;

export class LocalDerivativeCache implements DerivativeCache {
  readonly driver = 'local';
  constructor(private dir: string, private typeOf: TypeOf) {}
  private abs(key: string): string {
    const root = resolve(this.dir);
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error('cache key escapes the cache directory');
    return p;
  }
  async get(key: string): Promise<CachedImage | null> {
    try { return { body: await fs.readFile(this.abs(key)), contentType: this.typeOf(key) }; } catch { return null; }
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.abs(key);
    await fs.mkdir(dirname(p), { recursive: true });
    // write-then-rename: a concurrent reader never sees half a file
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, p);
  }
}

/** Minimal S3 surface, so tests can hand in a fake. */
export interface S3Like { send(cmd: any): Promise<any> }

export class S3DerivativeCache implements DerivativeCache {
  readonly driver = 's3';
  private client: S3Like | null;
  constructor(private bucket: string, private prefix: string, private region: string, client?: S3Like) {
    this.client = client ?? null;
  }
  private async cli(): Promise<S3Like> {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({ region: this.region, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
    }
    return this.client;
  }
  private full(key: string) { return this.prefix ? `${this.prefix}/${key}` : key; }
  async get(key: string): Promise<CachedImage | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await (await this.cli()).send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }));
      const chunks: Buffer[] = [];
      for await (const c of r.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      return { body: Buffer.concat(chunks), contentType: r.ContentType ?? 'application/octet-stream' };
    } catch (e: any) {
      const code = e?.name ?? e?.Code;
      if (code === 'NoSuchKey' || code === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
      // An unreachable cache is a slower request, not a failed one.
      console.warn(`[images] cache read failed for ${key}: ${code ?? e}`);
      return null;
    }
  }
  async put(key: string, body: Buffer, contentType: string, cacheControl: string): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.cli()).send(new PutObjectCommand({
      Bucket: this.bucket, Key: this.full(key), Body: body, ContentType: contentType, CacheControl: cacheControl,
    }));
  }
}

export class NoDerivativeCache implements DerivativeCache {
  readonly driver = 'none';
  async get() { return null; }
  async put() { /* disabled */ }
}

/** Byte-capped LRU. Entries larger than an eighth of the cap are not kept. */
export class MemoryLru<V extends { body: Buffer }> {
  private map = new Map<string, V>();
  private bytes = 0;
  constructor(private capBytes: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: V): void {
    if (this.capBytes <= 0 || v.body.length > this.capBytes / 8) return;
    const old = this.map.get(k);
    if (old) { this.bytes -= old.body.length; this.map.delete(k); }
    this.map.set(k, v);
    this.bytes += v.body.length;
    for (const [key, val] of this.map) {
      if (this.bytes <= this.capBytes) break;
      this.map.delete(key);
      this.bytes -= val.body.length;
    }
  }
  delete(k: string): void {
    const v = this.map.get(k);
    if (v) { this.bytes -= v.body.length; this.map.delete(k); }
  }
  get size() { return this.map.size; }
  get usedBytes() { return this.bytes; }
}

/** Collapse concurrent calls for the same key into one in-flight promise. */
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const cur = this.inflight.get(key);
    if (cur) return cur;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
  get pending() { return this.inflight.size; }
}

export class BusyError extends Error {}

/** At most `max` tasks run at once; at most `maxQueue` wait; beyond that, BusyError. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number, private maxQueue: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue) throw new BusyError('image renderer is busy');
      // the finishing task hands its slot straight to us (active stays counted)
      await new Promise<void>((r) => this.queue.push(r));
    } else {
      this.active++;
    }
    try { return await fn(); } finally {
      const next = this.queue.shift();
      if (next) next(); else this.active--;
    }
  }
  get running() { return this.active; }
  get waiting() { return this.queue.length; }
}
