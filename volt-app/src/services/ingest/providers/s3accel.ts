// S3 Transfer Acceleration for a client uploading straight to S3: presigned
// PUT URLs on the accelerate endpoint, one per file (single part, up to 5 GB
// each; the multipart variant is the tus route for anything larger). Volt
// learns the file landed from an S3 event or from the client's finish call.
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac } from 'node:crypto';

/** Node's own SHA-256 in the shape SignatureV4 wants, so no extra crypto package is needed. */
class NodeSha256 {
  private h: any;
  constructor(secret?: string | Uint8Array) { this.h = secret ? createHmac('sha256', Buffer.from(secret as any)) : createHash('sha256'); }
  update(d: string | Uint8Array) { this.h.update(Buffer.from(d as any)); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.h.digest()); }
  reset() { /* one-shot use */ }
}
import { type TransferProvider, type TransferFile, type TransferDestination, type ProviderCredentials, type CreatedTransfer, type TransferEvent, ProviderError } from './types';

export interface S3AccelOptions { bucket: string; region: string; accelerate: boolean; credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>; expiresSec?: number; now?: () => Date }

export class S3AccelProvider implements TransferProvider {
  readonly key = 's3accel' as const;
  constructor(private o: S3AccelOptions) {}
  async createTransfer(files: TransferFile[], dest: TransferDestination, _creds: ProviderCredentials, _ctx: { transferId: string }): Promise<CreatedTransfer> {
    if (files.some((f) => (f.bytes ?? 0) > 5 * 1024 * 1024 * 1024)) throw new ProviderError('files over 5 GB need the resumable (tus) route rather than a single presigned PUT', 400);
    const signer = new SignatureV4({ service: 's3', region: this.o.region, credentials: await this.o.credentials(), sha256: NodeSha256 as any, uriEscapePath: false });
    const host = this.o.accelerate ? `${this.o.bucket}.s3-accelerate.amazonaws.com` : `${this.o.bucket}.s3.${this.o.region}.amazonaws.com`;
    const uploads = [];
    for (const f of files) {
      const key = `${dest.root.replace(/^\/+|\/+$/g, '')}/${dest.folder}/${f.relativePath || f.name}`.replace(/\/+/g, '/');
      const req = { method: 'PUT', protocol: 'https:', hostname: host, path: '/' + key.split('/').map(encodeURIComponent).join('/'), headers: { host }, query: {} as Record<string, string> };
      const signed: any = await signer.presign(req as any, { expiresIn: this.o.expiresSec ?? 3600, signingDate: this.o.now?.() ?? new Date(), unsignableHeaders: new Set(['content-type']) });
      const qs = new URLSearchParams(signed.query as Record<string, string>).toString();
      uploads.push({ name: f.name, url: `https://${host}${signed.path}?${qs}`, method: 'PUT' as const });
    }
    return { externalId: null, destination: dest, launch: { kind: 'presigned', uploads, note: this.o.accelerate ? 'PUT each file to its URL; the accelerate endpoint routes through the nearest edge.' : 'PUT each file to its URL.' } };
  }
  parseEvent(body: any): TransferEvent | null {
    // S3 event notification (ObjectCreated) or the client's own finish call { landed: [...] }.
    const recs = body?.Records;
    // S3 event keys are form-encoded: '+' is a space.
    const dec = (k: string) => decodeURIComponent(String(k).replace(/\+/g, ' '));
    if (Array.isArray(recs)) return { externalId: null, state: 'landed', files: recs.filter((r: any) => /ObjectCreated/.test(r.eventName ?? '')).map((r: any) => ({ name: dec(r.s3?.object?.key ?? '').split('/').pop() ?? '', path: dec(r.s3?.object?.key ?? ''), bytes: Number(r.s3?.object?.size ?? 0) || null })) };
    if (Array.isArray(body?.landed)) return { externalId: null, state: 'landed', files: body.landed };
    return null;
  }
}
