// ============================================================================
//  ON-PREM S3-COMPATIBLE STORAGE TARGETS (build queue H3-4, HYBRID_SITES.md
//  "Add-on: Mirror and Archive to external storage": MinIO, NetApp StorageGRID,
//  Dell ECS and similar, "written by the site agent through the target's S3
//  API").
//
//  WHY A SMALL CLIENT OF ITS OWN. The agent has no runtime dependencies and
//  is installed on customers' servers; the handful of S3 calls it needs
//  (PUT, multipart upload, GET, HEAD, DELETE of its own failed copy, LIST of
//  one name) are signed here with AWS Signature Version 4, which every
//  S3-compatible store accepts. The check suite compares the signature with
//  the AWS SDK's own signer and runs the calls against a real S3 server.
//
//  THE KEYS STAY AT THE SITE. The cloud knows only the store's address, the
//  bucket, the folder (prefix) and the NAME of a key (`credentialRef`). The
//  access key and secret live on the agent host, in a file readable by its
//  owner only (`archive-keys.json` beside the state file, or the file
//  `VOLT_ARCHIVE_KEYS` names), or in environment variables, and are read on
//  every job, so a rotated key takes effect at once:
//
//    { "nas-minio": { "accessKeyId": "...", "secretAccessKey": "..." } }
//
//    VOLT_ARCHIVE_KEY_NAS_MINIO_ID / VOLT_ARCHIVE_KEY_NAS_MINIO_SECRET
//
//  A key file that others can read is refused rather than used.
// ============================================================================
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export interface S3TargetConfig {
  /** http(s)://host[:port] of the store, no path. */
  endpoint: string;
  bucket: string;
  /** The folder inside the bucket ('' for the bucket's root), no leading or trailing slash. */
  prefix?: string;
  region?: string;
  /** Path-style addressing (http://host/bucket/key), which most on-prem stores want. */
  pathStyle?: boolean;
  credentialRef?: string;
}

export interface S3Keys { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

/** A refusal with a code the cloud records; `permanent` stops retries. */
export class S3Refused extends Error { constructor(message: string, public code: string, public permanent = false) { super(message); } }

// ---- signing (pure) --------------------------------------------------------------

const sha256hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
export const EMPTY_SHA256 = sha256hex('');

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
/** An object key in a URL path: each segment encoded, the slashes kept. */
export const encodeKey = (key: string) => key.split('/').map(rfc3986).join('/');

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  keys: S3Keys;
  region: string;
  now: Date;
  service?: string;
}

/**
 * Sign a request with AWS Signature Version 4 (header form). Returns the
 * headers to send: the given ones plus host, x-amz-date,
 * x-amz-content-sha256, the session token if any, and authorization.
 * Every header given is signed.
 */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  h.host = i.url.host;
  h['x-amz-date'] = amzDate;
  h['x-amz-content-sha256'] = i.payloadHash;
  if (i.keys.sessionToken) h['x-amz-security-token'] = i.keys.sessionToken;
  const names = Object.keys(h).sort();
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [
    i.method.toUpperCase(),
    i.url.pathname || '/',
    query,
    names.map((n) => `${n}:${h[n]}\n`).join(''),
    names.join(';'),
    i.payloadHash,
  ].join('\n');
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac('AWS4' + i.keys.secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  const out: Record<string, string> = {};
  for (const n of names) if (n !== 'host') out[n] = h[n];
  out.authorization = `AWS4-HMAC-SHA256 Credential=${i.keys.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return out;
}

// ---- the keys, at the site ------------------------------------------------------------

const REF = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The keys named by `ref`, from the key file (owner-only) or the environment.
 * Missing keys are a retry, not a permanent failure: whoever runs the site
 * can add them and the next attempt picks them up.
 */
export function keysFor(ref: string | undefined, keysFile: string | undefined, env: NodeJS.ProcessEnv = process.env): S3Keys {
  const name = ref && REF.test(ref) ? ref : 'default';
  if (keysFile) {
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(keysFile); } catch { st = null; }
    if (st) {
      // Group or others can read it: refuse, as ssh does with a private key.
      if (process.platform !== 'win32' && (Number(st.mode) & 0o077)) {
        throw new S3Refused(`The key file ${keysFile} can be read by others; make it readable by its owner only (chmod 600)`, 'keys_unprotected');
      }
      let all: any;
      try { all = JSON.parse(readFileSync(keysFile, 'utf8')); } catch { throw new S3Refused(`The key file ${keysFile} is not valid JSON`, 'keys_unreadable'); }
      const k = all?.[name];
      if (k && typeof k.accessKeyId === 'string' && typeof k.secretAccessKey === 'string') {
        return { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, sessionToken: typeof k.sessionToken === 'string' ? k.sessionToken : undefined };
      }
    }
  }
  const envName = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const id = env[`VOLT_ARCHIVE_KEY_${envName}_ID`], secret = env[`VOLT_ARCHIVE_KEY_${envName}_SECRET`];
  if (id && secret) return { accessKeyId: id, secretAccessKey: secret, sessionToken: env[`VOLT_ARCHIVE_KEY_${envName}_TOKEN`] || undefined };
  throw new S3Refused(`No keys named "${name}" on this host: add them to ${keysFile ?? 'the key file'} or set VOLT_ARCHIVE_KEY_${envName}_ID and _SECRET`, 'keys_missing');
}

// ---- the client ---------------------------------------------------------------------

export interface S3Client {
  cfg: Required<Omit<S3TargetConfig, 'credentialRef'>> & { credentialRef: string };
  keys: S3Keys;
  fetch: typeof fetch;
}

/** Check the target the job carries and make a client for it. */
export function clientFor(raw: any, keys: S3Keys, f: typeof fetch = fetch): S3Client {
  let ep: URL;
  try { ep = new URL(String(raw?.endpoint ?? '')); } catch { throw new S3Refused('The target has no valid endpoint', 'target_not_supported', true); }
  if (!/^https?:$/.test(ep.protocol) || ep.username || ep.password || (ep.pathname !== '/' && ep.pathname !== '') || ep.search) {
    throw new S3Refused('The target endpoint must be http(s)://host[:port] with nothing else', 'target_not_supported', true);
  }
  const bucket = String(raw?.bucket ?? '');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new S3Refused('The target has no valid bucket', 'target_not_supported', true);
  const prefix = String(raw?.prefix ?? '').replace(/^\/+|\/+$/g, '');
  if (prefix.split('/').some((s) => s === '..' || s === '.')) throw new S3Refused('The target prefix may not contain . or ..', 'target_not_supported', true);
  return {
    cfg: { endpoint: ep.origin, bucket, prefix, region: String(raw?.region || 'us-east-1'), pathStyle: raw?.pathStyle !== false, credentialRef: String(raw?.credentialRef || 'default') },
    keys, fetch: f,
  };
}

/** The full object key of a name inside the target's folder. */
export const objectKey = (c: S3Client, name: string) => (c.cfg.prefix ? `${c.cfg.prefix}/${name}` : name);

function urlFor(c: S3Client, key: string, query: Record<string, string> = {}): URL {
  const ep = new URL(c.cfg.endpoint);
  const u = c.cfg.pathStyle
    ? new URL(`${ep.origin}/${c.cfg.bucket}${key ? '/' + encodeKey(key) : '/'}`)
    : new URL(`${ep.protocol}//${c.cfg.bucket}.${ep.host}/${key ? encodeKey(key) : ''}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

export interface S3Response { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null; text: () => Promise<string> }

/** One signed request. A store that cannot be reached is a retry. */
export async function s3(c: S3Client, method: string, key: string, o: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer } = {}): Promise<S3Response> {
  const url = urlFor(c, key, o.query);
  const payload = o.body ?? Buffer.alloc(0);
  const headers = signV4({ method, url, headers: o.headers ?? {}, payloadHash: sha256hex(payload), keys: c.keys, region: c.cfg.region, now: new Date() });
  let r: Response;
  try {
    // A Buffer is a valid body for Node's fetch; the DOM typings do not say so.
    const body = o.body && o.body.length ? o.body : (method === 'PUT' || method === 'POST' ? payload : undefined);
    r = await c.fetch(url, { method, headers, body: body as any });
  } catch (e: any) {
    throw new S3Refused(`The storage target ${c.cfg.endpoint} cannot be reached: ${e?.cause?.code ?? e?.message ?? e}`, 'target_unavailable');
  }
  return { status: r.status, headers: r.headers, body: r.body as any, text: () => r.text() };
}

/** The S3 error code and message of a failed answer, for the record. */
export async function refusal(r: S3Response, what: string): Promise<S3Refused> {
  const t = await r.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(t)?.[1] ?? `HTTP ${r.status}`;
  const msg = /<Message>([^<]+)<\/Message>/.exec(t)?.[1] ?? '';
  const permanent = code === 'NoSuchBucket';
  const ours = r.status === 403 || r.status === 401 ? 'target_refused' : code === 'NoSuchBucket' ? 'no_such_bucket' : 'target_error';
  return new S3Refused(`${what}: the store answered ${code}${msg ? ` (${msg})` : ''}`, ours, permanent);
}

/** Names already in the target folder that start like `stem` (to pick a free one). */
export async function namesLike(c: S3Client, stem: string): Promise<Set<string>> {
  const out = new Set<string>();
  const base = c.cfg.prefix ? `${c.cfg.prefix}/` : '';
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q: Record<string, string> = { 'list-type': '2', prefix: base + stem, 'max-keys': '1000' };
    if (token) q['continuation-token'] = token;
    const r = await s3(c, 'GET', '', { query: q });
    if (r.status !== 200) throw await refusal(r, 'Listing the target folder failed');
    const xml = await r.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const k = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      if (k.startsWith(base)) out.add(k.slice(base.length));
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    if (!token) break;
  }
  return out;
}

/**
 * Write one object without ever replacing one: `If-None-Match: *` on the PUT
 * (and on completing a multipart upload), so a name that was taken meanwhile
 * answers 412 instead of being overwritten. Returns false on 412.
 */
export async function putNew(c: S3Client, key: string, body: Buffer): Promise<boolean> {
  const r = await s3(c, 'PUT', key, { body, headers: { 'if-none-match': '*', 'content-type': 'application/octet-stream' } });
  if (r.status === 412) { await r.text().catch(() => {}); return false; }
  if (r.status !== 200) throw await refusal(r, 'Writing the copy failed');
  await r.text().catch(() => {});
  return true;
}

export async function startMultipart(c: S3Client, key: string): Promise<string> {
  const r = await s3(c, 'POST', key, { query: { uploads: '' }, headers: { 'content-type': 'application/octet-stream' } });
  if (r.status !== 200) throw await refusal(r, 'Starting the upload failed');
  const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await r.text())?.[1];
  if (!id) throw new S3Refused('The store did not return an upload id', 'target_error');
  return id;
}

export async function uploadPart(c: S3Client, key: string, uploadId: string, n: number, body: Buffer): Promise<string> {
  const r = await s3(c, 'PUT', key, { query: { partNumber: String(n), uploadId }, body });
  if (r.status !== 200) throw await refusal(r, `Writing part ${n} failed`);
  await r.text().catch(() => {});
  const etag = r.headers.get('etag');
  if (!etag) throw new S3Refused(`The store did not return an ETag for part ${n}`, 'target_error');
  return etag;
}

/** Returns false when the name was taken meanwhile (412). */
export async function completeMultipart(c: S3Client, key: string, uploadId: string, etags: string[]): Promise<boolean> {
  const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  const r = await s3(c, 'POST', key, { query: { uploadId }, body: Buffer.from(xml), headers: { 'if-none-match': '*', 'content-type': 'application/xml' } });
  const t = await r.text().catch(() => '');
  if (r.status === 412) return false;
  // A completion can fail inside a 200 answer: the body carries the error.
  if (r.status !== 200 || /<Error>/.test(t)) {
    const code = /<Code>([^<]+)<\/Code>/.exec(t)?.[1] ?? `HTTP ${r.status}`;
    if (code === 'PreconditionFailed') return false;
    throw new S3Refused(`Finishing the upload failed: the store answered ${code}`, r.status === 403 ? 'target_refused' : 'target_error');
  }
  return true;
}

export async function abortMultipart(c: S3Client, key: string, uploadId: string): Promise<void> {
  await s3(c, 'DELETE', key, { query: { uploadId } }).then((r) => r.text()).catch(() => {});
}

/**
 * Read an object back and hash it: what the target holds, not what was sent.
 * null when it is not there.
 */
export async function readBack(c: S3Client, key: string): Promise<{ sha256: string; bytes: number } | null> {
  const r = await s3(c, 'GET', key);
  if (r.status === 404) { await r.text().catch(() => {}); return null; }
  if (r.status !== 200 || !r.body) throw await refusal(r, 'Reading the copy back failed');
  const h = createHash('sha256'); let bytes = 0;
  const reader = (r.body as any).getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; h.update(value); bytes += value.length; }
  return { sha256: h.digest('hex'), bytes };
}

/** Remove an object THIS AGENT wrote and that did not check out. Never anything else. */
export async function removeOwn(c: S3Client, key: string): Promise<void> {
  await s3(c, 'DELETE', key).then((r) => r.text()).catch(() => {});
}

/**
 * The part size for a multipart upload: at least 8 MiB, and big enough that
 * a file of `total` bytes fits in the store's 10 000 parts (with room).
 * Each part is held in memory once while it is hashed and sent.
 */
export function partSizeFor(total: number | null | undefined): number {
  const MiB = 1024 * 1024;
  const min = 8 * MiB;
  if (!total || !Number.isFinite(total) || total <= 0) return 64 * MiB;
  const need = Math.ceil(total / 9000);
  return Math.max(min, Math.ceil(need / MiB) * MiB);
}
