// ============================================================================
//  SQS, behind a narrow interface (build queue 2.6).
//
//  S3 watch folders on AWS are told about a drop by a bucket notification on
//  an SQS queue instead of listing the bucket every minute. The control plane
//  needs two calls from SQS, receive and delete, so they are an interface:
//  the watch folder side is tested against an in-memory queue, and a local
//  stand-in (ElasticMQ, LocalStack) is the same code with another endpoint.
//
//  WHY NOT @aws-sdk/client-sqs. Two calls do not justify another SDK package
//  in the control-plane image, and SQS speaks a plain JSON protocol
//  (application/x-amz-json-1.0, one X-Amz-Target per action). The request is
//  signed here with Signature Version 4 (node:crypto, checked in the suite
//  against AWS's published test vector), and the credentials come from the
//  S3 client the control plane already carries, so the task role, its
//  rotation and a Mac's ~/.aws profile all work exactly as they do for S3.
// ============================================================================
import { createHash, createHmac } from 'node:crypto';

export interface SqsMessage { id: string; receipt: string; body: string; receiveCount?: number }

export interface SqsApi {
  /** Up to `max` messages, waiting up to `waitSec` for the first (long poll). */
  receive(queueUrl: string, max: number, waitSec: number): Promise<SqsMessage[]>;
  /** The message was handled: remove it so it is not delivered again. */
  delete(queueUrl: string, receipt: string): Promise<void>;
}

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export type CredentialSource = () => Promise<AwsCredentials>;

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();

/** 20150830T123600Z from a Date. */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Sign a request with AWS Signature Version 4 and return the headers to send
 * (the given ones plus x-amz-date, x-amz-security-token when there is one,
 * and authorization). Paths without a query string only: that is all SQS's
 * JSON protocol needs, and a narrow signer is one that cannot be subtly wrong
 * about query encoding.
 */
export function signV4(req: {
  method: string; url: string; headers: Record<string, string>; body: string;
  region: string; service: string; credentials: AwsCredentials; now?: Date;
}): Record<string, string> {
  const u = new URL(req.url);
  if (u.search) throw new Error('signV4: query strings are not supported');
  const date = amzDate(req.now ?? new Date());
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  headers.host = headers.host ?? u.host;
  headers['x-amz-date'] = date;
  if (req.credentials.sessionToken) headers['x-amz-security-token'] = req.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const canonical = [req.method.toUpperCase(), u.pathname || '/', '', canonicalHeaders, signed, sha256hex(req.body)].join('\n');
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + req.credentials.secretAccessKey, day), req.region), req.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}

/** The credentials the S3 client resolves (task role, environment, profile). Also used by the CDN log reader (qoe/cdnStream.ts). */
export async function s3Credentials(region: string): Promise<CredentialSource> {
  const { S3Client } = await import('@aws-sdk/client-s3');
  const c: any = new S3Client({ region });
  return async () => {
    const v = await c.config.credentials();
    return { accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey, sessionToken: v.sessionToken };
  };
}

export interface SqsClientOptions { region: string; endpoint?: string; credentials?: CredentialSource }

/** The real thing, over fetch. */
export async function realSqs(o: SqsClientOptions): Promise<SqsApi> {
  const creds = o.credentials ?? await s3Credentials(o.region);
  const endpoint = (o.endpoint || `https://sqs.${o.region}.amazonaws.com`).replace(/\/+$/, '') + '/';
  async function call(action: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const body = JSON.stringify(payload);
    const headers = signV4({
      method: 'POST', url: endpoint, body, region: o.region, service: 'sqs', credentials: await creds(),
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${action}` },
    });
    delete headers.host; // fetch sets it, and refuses to be told
    const r = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    const j = text ? JSON.parse(text) : {};
    if (!r.ok) throw new Error(`SQS ${action} ${r.status}: ${String(j.__type ?? '').split('#').pop() || 'error'}: ${j.message ?? j.Message ?? text.slice(0, 200)}`);
    return j;
  }
  return {
    async receive(QueueUrl, max, waitSec) {
      const j = await call('ReceiveMessage', {
        QueueUrl, MaxNumberOfMessages: Math.max(1, Math.min(10, max)), WaitTimeSeconds: Math.max(0, Math.min(20, waitSec)),
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }, (waitSec + 15) * 1000);
      return (j.Messages ?? []).map((m: any) => ({
        id: String(m.MessageId), receipt: String(m.ReceiptHandle), body: String(m.Body ?? ''),
        receiveCount: m.Attributes?.ApproximateReceiveCount ? Number(m.Attributes.ApproximateReceiveCount) : undefined,
      }));
    },
    async delete(QueueUrl, ReceiptHandle) { await call('DeleteMessage', { QueueUrl, ReceiptHandle }, 15000); },
  };
}

/**
 * An in-memory queue for tests. Behaves like SQS where it matters: a received
 * message is hidden until it is deleted or released (the visibility timeout
 * running out), and a released one comes back with a higher receive count.
 */
export class MemorySqs implements SqsApi {
  private n = 0;
  private msgs: { id: string; body: string; receipt: string | null; count: number }[] = [];
  calls: string[] = [];
  send(body: string): string { const id = `m${++this.n}`; this.msgs.push({ id, body, receipt: null, count: 0 }); return id; }
  async receive(_url: string, max: number, wait: number) {
    this.calls.push('receive');
    // A long poll on an empty queue waits (briefly here) instead of returning at once.
    if (wait > 0 && !this.visible) await new Promise((r) => setTimeout(r, 50));
    const out: SqsMessage[] = [];
    for (const m of this.msgs) {
      if (out.length >= max || m.receipt) continue;
      m.receipt = `r-${m.id}-${++m.count}`;
      out.push({ id: m.id, receipt: m.receipt, body: m.body, receiveCount: m.count });
    }
    return out;
  }
  async delete(_url: string, receipt: string) {
    this.calls.push('delete');
    this.msgs = this.msgs.filter((m) => m.receipt !== receipt);
  }
  /** The visibility timeout runs out: every received, undeleted message is visible again. */
  release() { for (const m of this.msgs) m.receipt = null; }
  get size() { return this.msgs.length; }
  get visible() { return this.msgs.filter((m) => !m.receipt).length; }
}
