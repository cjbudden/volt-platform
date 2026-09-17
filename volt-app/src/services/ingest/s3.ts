// ============================================================================
//  S3, behind a narrow interface.
//
//  Everything the ingest framework needs from S3 fits in ten calls. They are
//  an interface so the destination and the watchfolder walker are tested
//  against an in-memory bucket, and so a customer's own bucket, MinIO, or
//  Wasabi are the same code with a different endpoint.
//
//  TRANSFER ACCELERATION is a flag on the client, nothing else. It swaps the
//  endpoint for the nearest CloudFront edge and is the single biggest win a
//  browser upload to S3 can get without client software (decision of 17 Sep:
//  on by default; the bucket must have it enabled or S3 refuses the call).
// ============================================================================
import type { Readable } from 'node:stream';

export interface S3Object { key: string; bytes: number; etag: string; lastModified: Date }

export interface S3Api {
  list(bucket: string, prefix: string, max?: number): Promise<S3Object[]>;
  head(bucket: string, key: string): Promise<{ bytes: number; etag: string } | null>;
  getStream(bucket: string, key: string, range?: string): Promise<Readable>;
  put(bucket: string, key: string, body: Buffer | string, contentType?: string): Promise<{ etag: string }>;
  createMultipart(bucket: string, key: string, contentType?: string): Promise<string>;
  uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Buffer): Promise<{ etag: string }>;
  completeMultipart(bucket: string, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
  copy(bucket: string, fromKey: string, toKey: string, fromBucket?: string): Promise<void>;
  del(bucket: string, key: string): Promise<void>;
}

export interface S3ClientOptions { region: string; accelerate?: boolean; endpoint?: string; forcePathStyle?: boolean }

/** The real thing, loaded lazily so the pure paths never import the SDK. */
export async function realS3(o: S3ClientOptions): Promise<S3Api> {
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({ region: o.region, useAccelerateEndpoint: !!o.accelerate, ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: o.forcePathStyle ?? true } : {}) });
  return {
    async list(Bucket, Prefix, max = 5000) {
      const out: S3Object[] = []; let ContinuationToken: string | undefined;
      do {
        const r: any = await client.send(new sdk.ListObjectsV2Command({ Bucket, Prefix, ContinuationToken, MaxKeys: 1000 }));
        for (const c of r.Contents ?? []) { if (c.Key && !c.Key.endsWith('/')) out.push({ key: c.Key, bytes: Number(c.Size ?? 0), etag: String(c.ETag ?? '').replace(/"/g, ''), lastModified: new Date(c.LastModified ?? 0) }); if (out.length >= max) return out; }
        ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },
    async head(Bucket, Key) { try { const r: any = await client.send(new sdk.HeadObjectCommand({ Bucket, Key })); return { bytes: Number(r.ContentLength ?? 0), etag: String(r.ETag ?? '').replace(/"/g, '') }; } catch (e: any) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null; throw e; } },
    async getStream(Bucket, Key, Range) { const r: any = await client.send(new sdk.GetObjectCommand({ Bucket, Key, ...(Range ? { Range } : {}) })); return r.Body as Readable; },
    async put(Bucket, Key, Body, ContentType) { const r: any = await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body, ContentType })); return { etag: String(r.ETag ?? '').replace(/"/g, '') }; },
    async createMultipart(Bucket, Key, ContentType) { const r: any = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key, ContentType })); return String(r.UploadId); },
    async uploadPart(Bucket, Key, UploadId, PartNumber, Body) { const r: any = await client.send(new sdk.UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body })); return { etag: String(r.ETag ?? '').replace(/"/g, '') }; },
    async completeMultipart(Bucket, Key, UploadId, parts) { await client.send(new sdk.CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) } })); },
    async abortMultipart(Bucket, Key, UploadId) { await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key, UploadId })); },
    async copy(Bucket, fromKey, Key, fromBucket) { await client.send(new sdk.CopyObjectCommand({ Bucket, Key, CopySource: `/${fromBucket ?? Bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}` })); },
    async del(Bucket, Key) { await client.send(new sdk.DeleteObjectCommand({ Bucket, Key })); },
  };
}

/** An in-memory bucket for tests. Behaves like S3 where it matters: keys, etags, multipart order. */
export class MemoryS3 implements S3Api {
  objects = new Map<string, { body: Buffer; contentType?: string; lastModified: Date }>();
  private mp = new Map<string, { key: string; parts: Map<number, Buffer>; contentType?: string }>();
  calls: string[] = [];
  constructor(public now: () => Date = () => new Date()) {}
  private k(b: string, k: string) { return `${b}/${k}`; }
  private etag(body: Buffer) { return require('node:crypto').createHash('md5').update(body).digest('hex'); }
  async list(b: string, prefix: string, max = 5000) {
    this.calls.push(`list ${prefix}`);
    return [...this.objects.entries()].filter(([kk]) => kk.startsWith(`${b}/${prefix}`)).map(([kk, v]) => ({ key: kk.slice(b.length + 1), bytes: v.body.length, etag: this.etag(v.body), lastModified: v.lastModified })).slice(0, max);
  }
  async head(b: string, k: string) { const o = this.objects.get(this.k(b, k)); return o ? { bytes: o.body.length, etag: this.etag(o.body) } : null; }
  async getStream(b: string, k: string, range?: string) {
    const o = this.objects.get(this.k(b, k)); if (!o) throw new Error('NoSuchKey');
    let body = o.body;
    if (range) { const m = /bytes=(\d+)-(\d*)/.exec(range)!; body = body.subarray(Number(m[1]), m[2] ? Number(m[2]) + 1 : undefined); }
    const { Readable } = require('node:stream'); return Readable.from([body]);
  }
  async put(b: string, k: string, body: Buffer | string, contentType?: string) { this.calls.push(`put ${k}`); const buf = Buffer.isBuffer(body) ? body : Buffer.from(body); this.objects.set(this.k(b, k), { body: buf, contentType, lastModified: this.now() }); return { etag: this.etag(buf) }; }
  async createMultipart(b: string, k: string, contentType?: string) { const id = `mp${this.mp.size + 1}`; this.mp.set(id, { key: this.k(b, k), parts: new Map(), contentType }); this.calls.push(`create ${k}`); return id; }
  async uploadPart(_b: string, _k: string, id: string, n: number, body: Buffer) { this.mp.get(id)!.parts.set(n, Buffer.from(body)); this.calls.push(`part ${n}`); return { etag: this.etag(body) }; }
  async completeMultipart(_b: string, _k: string, id: string, parts: { partNumber: number; etag: string }[]) {
    const m = this.mp.get(id)!; const bufs = parts.sort((a, c) => a.partNumber - c.partNumber).map((p) => { const part = m.parts.get(p.partNumber); if (!part || this.etag(part) !== p.etag) throw new Error('InvalidPart'); return part; });
    this.objects.set(m.key, { body: Buffer.concat(bufs), contentType: m.contentType, lastModified: this.now() }); this.mp.delete(id); this.calls.push('complete');
  }
  async abortMultipart(_b: string, _k: string, id: string) { this.mp.delete(id); this.calls.push('abort'); }
  async copy(b: string, from: string, to: string, fromBucket?: string) { const o = this.objects.get(this.k(fromBucket ?? b, from)); if (!o) throw new Error('NoSuchKey'); this.objects.set(this.k(b, to), { ...o, lastModified: this.now() }); this.calls.push(`copy ${from} -> ${to}`); }
  async del(b: string, k: string) { this.objects.delete(this.k(b, k)); this.calls.push(`del ${k}`); }
}
