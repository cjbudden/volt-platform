// ============================================================================
//  SITE JOBS: the job lease for Hybrid Sites (build queue H3, HYBRID_SITES.md).
//
//  A job whose pool is `site:<id>` waits for that site. An approved host of
//  the site leases it over HTTPS, reports progress (which extends the lease),
//  and completes or fails it. It never touches the database, so a fault at a
//  site cannot corrupt cloud state.
//
//  Each lease has its own id, written as the job's `claimed_by`. Every call
//  after the lease names it, and only the current holder is heard: a worker
//  whose lease the reaper took back (it went quiet) is told `lease_lost` and
//  cannot finish, extend or fail a job that another host now runs.
//
//  The bytes a job moves cross through TRANSFERS the job itself lists in its
//  payload (`transfers: [{ name, direction, uri }]`), written by the cloud
//  when it queued the job. A host asks for a URL for one named transfer of a
//  job it holds and gets one URL for that one object, for a short time:
//    - an object in S3: a presigned GET or PUT straight to the bucket, so the
//      bytes never pass through the control plane (cost: no proxy traffic);
//    - a file on the control plane's own disk (the single Mac server): a URL
//      on this API signed for that job, lease, transfer and expiry, checked
//      again against the lease when it is used.
//  A host cannot name a path or key of its own, so it reaches nothing a job
//  of its own site did not hand it.
// ============================================================================
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Request, Response } from 'express';
import { one } from '../../db';
import { config } from '../../config';
import { ApiError, badRequest, notFound } from '../../util/http';
import { claimInPool, fail, heartbeat, sitePool, succeed, LEASE_SECONDS, type JobRow } from '../jobs/queue';
import { isS3Uri, mediaS3Client, parseS3Uri } from '../media/s3Driver';
import type { SitePrincipal } from './sites';
import { requireApprovedHost } from './siteWatchfolders';
import { licenceRequired } from './licences';
import { ARCHIVE_JOB_TYPES, attemptFailed, isArchiveJob, judge } from '../archive/archive';
import { declareOutputs, isSiteEncodeJob, judgeSiteEncode, siteEncodeAttemptFailed } from './siteEncode';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_PREFIX = 'site-host:';
/** A transfer URL is good for this long: enough to start a large copy, short enough to be worthless if leaked. */
export const TRANSFER_URL_SECONDS = Number(process.env.SITE_TRANSFER_URL_SECONDS ?? 900);

export type TransferDirection = 'download' | 'upload';
export interface JobTransfer { name: string; direction: TransferDirection; uri: string; bytes?: number | null; sha256?: string | null }

const err = (status: number, message: string, code: string) => Object.assign(new ApiError(status, message), { code });
const leaseLost = (why: string) => err(409, `This host no longer holds the job: ${why}`, 'lease_lost');

/** The transfers a job lists, cleaned: a job without them moves no bytes. */
export function transfersOf(job: Pick<JobRow, 'payload'>): JobTransfer[] {
  const raw = Array.isArray(job.payload?.transfers) ? job.payload.transfers : [];
  return raw
    .filter((t: any) => t && typeof t.name === 'string' && (t.direction === 'download' || t.direction === 'upload') && typeof t.uri === 'string' && t.uri)
    .map((t: any) => ({ name: t.name, direction: t.direction, uri: t.uri, bytes: Number.isFinite(t.bytes) ? t.bytes : null, sha256: typeof t.sha256 === 'string' ? t.sha256 : null }));
}

/** What a host is told about a job it holds. The URIs stay in the cloud: a host only ever sees names. */
function leaseView(job: JobRow) {
  const { transfers: _t, ...payload } = job.payload ?? {};
  return {
    id: job.id, type: job.type, payload, attempt: job.attempts, maxAttempts: job.max_attempts,
    leaseId: job.claimed_by, leaseSeconds: LEASE_SECONDS, leaseUntil: job.lease_until,
    transfers: transfersOf(job).map((t) => ({ name: t.name, direction: t.direction, bytes: t.bytes, sha256: t.sha256 })),
  };
}

/** Lease the next ready job of this host's site. `types` narrows it to what the host can run. */
export async function lease(p: SitePrincipal, rawTypes: unknown) {
  requireApprovedHost(p);
  let types: string[] | null = null;
  if (rawTypes !== undefined && rawTypes !== null) {
    if (!Array.isArray(rawTypes) || rawTypes.some((t) => typeof t !== 'string' || !t || t.length > 80) || rawTypes.length > 50) {
      throw badRequest('types must be a list of job type names');
    }
    types = rawTypes as string[];
  }
  // One lease id per claim, naming the host so the jobs page shows who runs it.
  const leaseId = `${LEASE_PREFIX}${p.hostId}:${randomBytes(9).toString('base64url')}`;
  // Each add-on's work only for an account that holds it (H3-2): archive
  // jobs need Mirror and Archive, everything else Hybrid Sites.
  const archive = p.licences.includes('mirror_archive');
  const hybrid = p.licences.includes('hybrid_sites');
  let exclude: string[] = [];
  if (!hybrid) types = (types ?? ARCHIVE_JOB_TYPES).filter(isArchiveJob);
  if (!archive) exclude = ARCHIVE_JOB_TYPES;
  // GPU jobs only to GPU hosts (H4-2): a host that reported no NVIDIA GPU
  // in its heartbeat is never handed an encode planned for NVENC.
  const host = await one<{ gpus: any }>(`SELECT gpus FROM site_hosts WHERE id = $1`, [p.hostId]);
  const gpu = Array.isArray(host?.gpus) && host!.gpus.some((g: any) => String(g?.vendor ?? '').toLowerCase() === 'nvidia');
  const job = await claimInPool(sitePool(p.siteId), types, leaseId, exclude, { gpu });
  if (!job) return null;
  await one(`UPDATE site_hosts SET last_heartbeat_at = now() WHERE id = $1 RETURNING id`, [p.hostId]);
  return leaseView(job);
}

/**
 * One of this site's jobs, held under this lease, or why not. A job of
 * another site or account answers 404, exactly like an unknown id, so a
 * credential learns nothing about work it cannot run.
 */
async function heldJob(p: SitePrincipal, jobId: string, leaseId: unknown): Promise<JobRow> {
  requireApprovedHost(p);
  if (!UUID.test(String(jobId))) throw notFound('job not found');
  const job = await one<JobRow>(`SELECT * FROM jobs WHERE id = $1 AND pool = $2`, [jobId, sitePool(p.siteId)]);
  if (!job) throw notFound('job not found');
  if (typeof leaseId !== 'string' || !leaseId) throw badRequest('leaseId is required');
  if (job.state !== 'running') throw leaseLost(job.state === 'cancelled' ? 'it was cancelled' : `it is ${job.state}`);
  if (job.claimed_by !== leaseId) throw leaseLost('its lease expired and it was handed out again');
  // The add-on was withdrawn while the host held the job: stop here.
  if (isArchiveJob(job.type) ? !p.licences.includes('mirror_archive') : !p.licences.includes('hybrid_sites')) {
    throw licenceRequired(isArchiveJob(job.type) ? 'mirror_archive' : 'hybrid_sites');
  }
  return job;
}

export async function progress(p: SitePrincipal, jobId: string, b: any) {
  const job = await heldJob(p, jobId, b?.leaseId);
  const pct = b?.pct === undefined || b?.pct === null ? undefined : Number(b.pct);
  if (pct !== undefined && !(Number.isFinite(pct) && pct >= 0 && pct <= 100)) throw badRequest('pct must be 0 to 100');
  const note = typeof b?.note === 'string' ? b.note.slice(0, 500) : undefined;
  if (!(await heartbeat(job.id, pct === undefined ? undefined : Math.round(pct), note, job.claimed_by!))) throw leaseLost('it changed hands');
  const now = await one<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [job.id]);
  return { ok: true, leaseUntil: now?.lease_until ?? null };
}

export async function complete(p: SitePrincipal, jobId: string, b: any) {
  const job = await heldJob(p, jobId, b?.leaseId);
  const result = b?.result && typeof b.result === 'object' && !Array.isArray(b.result) ? b.result : {};
  if (JSON.stringify(result).length > 64 * 1024) throw badRequest('result is limited to 64 KB');
  // ARCHIVE JOBS ARE JUDGED BEFORE THEY COUNT (H3-2): a copy whose checksum
  // at the target does not match is a failed attempt, retried, never done.
  // So are site encodes (H4): a probe the ladder cannot be fitted to, or a
  // package that does not verify, is a failed attempt.
  let apply: (() => Promise<void>) | null = null;
  const judged = isArchiveJob(job.type) || isSiteEncodeJob(job.type);
  if (judged) {
    const v = isArchiveJob(job.type) ? await judge(job, result) : await judgeSiteEncode(job, result);
    if (!v.ok) {
      if (v.status === 400) throw Object.assign(badRequest(v.message), { code: v.code });
      if (!(await fail(job.id, v.message, { code: v.code, permanent: v.permanent === true, workerId: job.claimed_by! }))) throw leaseLost('it changed hands');
      const now = await one<JobRow>(`SELECT state, run_after FROM jobs WHERE id = $1`, [job.id]);
      if (isArchiveJob(job.type)) await attemptFailed(job, v.message, v.code, now?.state === 'failed');
      else await siteEncodeAttemptFailed(job, v.message, v.code, now?.state === 'failed');
      throw Object.assign(new ApiError(v.status, v.message), { code: v.code, state: now?.state, retryAfter: now?.state === 'queued' ? now.run_after : null });
    }
    apply = v.apply;
  }
  if (!(await succeed(job.id, result, job.claimed_by!))) throw leaseLost('it changed hands');
  if (apply) await apply();
  return { ok: true, state: 'succeeded' };
}

export async function failJob(p: SitePrincipal, jobId: string, b: any) {
  const job = await heldJob(p, jobId, b?.leaseId);
  const message = typeof b?.error === 'string' && b.error ? b.error.slice(0, 2000) : 'the site worker reported a failure';
  const code = typeof b?.code === 'string' && /^[a-z0-9_]{1,40}$/.test(b.code) ? b.code : 'site_error';
  if (!(await fail(job.id, message, { code, permanent: b?.permanent === true, workerId: job.claimed_by! }))) throw leaseLost('it changed hands');
  const now = await one<JobRow>(`SELECT state, run_after FROM jobs WHERE id = $1`, [job.id]);
  if (isArchiveJob(job.type)) await attemptFailed(job, message, code, now?.state === 'failed');
  if (isSiteEncodeJob(job.type)) await siteEncodeAttemptFailed(job, message, code, now?.state === 'failed');
  return { ok: true, state: now?.state, retryAfter: now?.state === 'queued' ? now.run_after : null };
}

/**
 * A site encode says what it produced (H4): each file becomes one upload
 * transfer of this job, into a staging folder of this attempt, held to the
 * declared checksum. The host still names no path of its own on this side.
 */
export async function outputs(p: SitePrincipal, jobId: string, b: any) {
  const job = await heldJob(p, jobId, b?.leaseId);
  const { declared, transfers, staging } = declareOutputs(job, b?.files, b?.append === true);
  const kept = transfersOf(job).filter((t) => !t.name.startsWith('out/'));
  const r = await one<any>(
    `UPDATE jobs SET payload = payload || jsonb_build_object('declared', $2::jsonb, 'transfers', $3::jsonb, 'staging', $5::text)
      WHERE id = $1 AND state = 'running' AND claimed_by = $4 RETURNING id`,
    [job.id, JSON.stringify(declared), JSON.stringify([...kept, ...transfers]), job.claimed_by, staging]);
  if (!r) throw leaseLost('it changed hands');
  // An earlier attempt's upload (its lease was reaped mid-upload) is not kept.
  const before = job.payload?.staging;
  if (typeof before === 'string' && before !== staging) await rm(before, { recursive: true, force: true }).catch(() => {});
  return { ok: true, files: declared.length, bytes: declared.reduce((a, d) => a + d.bytes, 0), transfers: transfers.map((t) => ({ name: t.name, direction: t.direction, bytes: t.bytes, sha256: t.sha256 })) };
}

// ---- transfer URLs -------------------------------------------------------------

/** One URL for one named transfer of a job this host holds. */
export async function transferUrl(p: SitePrincipal, jobId: string, b: any) {
  const job = await heldJob(p, jobId, b?.leaseId);
  const t = transfersOf(job).find((x) => x.name === b?.name);
  if (!t) throw notFound('this job has no transfer by that name');
  const expiresAt = new Date(Date.now() + TRANSFER_URL_SECONDS * 1000);
  const method = t.direction === 'download' ? 'GET' : 'PUT';
  if (isS3Uri(t.uri)) {
    const url = await presignS3(t.uri, method, TRANSFER_URL_SECONDS);
    return { name: t.name, direction: t.direction, method, url, expiresAt, via: 's3' };
  }
  const token = signTransfer({ j: job.id, l: job.claimed_by!, n: t.name, e: Math.floor(expiresAt.getTime() / 1000) });
  return { name: t.name, direction: t.direction, method, url: `/api/site-agent/transfers/${token}`, expiresAt, via: 'api' };
}

interface TransferClaim { j: string; l: string; n: string; e: number }

/** The key for transfer URLs, derived from the API's own secret so nothing new has to be configured. */
function transferKey(): Buffer {
  return createHmac('sha256', config.jwt.accessSecret).update('volt-site-transfer-v1').digest();
}

export function signTransfer(c: TransferClaim): string {
  const body = Buffer.from(JSON.stringify(c)).toString('base64url');
  const sig = createHmac('sha256', transferKey()).update(body).digest().subarray(0, 24).toString('base64url');
  return `${body}.${sig}`;
}

export function verifyTransfer(token: string, now = Date.now()): TransferClaim {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) throw err(403, 'This transfer URL is not valid', 'transfer_invalid');
  const want = createHmac('sha256', transferKey()).update(body).digest().subarray(0, 24);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw err(403, 'This transfer URL is not valid', 'transfer_invalid');
  let c: TransferClaim;
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw err(403, 'This transfer URL is not valid', 'transfer_invalid'); }
  if (!Number.isFinite(c?.e) || c.e * 1000 < now) throw err(403, 'This transfer URL has expired; ask for a new one', 'transfer_expired');
  return c;
}

/**
 * GET or PUT through a signed transfer URL (files on the control plane's
 * own disk). The signature is not enough on its own: the job must still be
 * running under the lease it was issued for, so a URL handed out before a
 * lease was reaped stops working with it.
 */
export async function serveTransfer(req: Request, res: Response) {
  const c = verifyTransfer(req.params.token);
  const job = await one<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [c.j]);
  if (!job || job.state !== 'running' || job.claimed_by !== c.l) throw leaseLost('the lease this URL was issued for has ended');
  const t = transfersOf(job).find((x) => x.name === c.n);
  if (!t || isS3Uri(t.uri)) throw notFound('transfer not found');
  if (t.direction === 'download') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw err(405, 'This URL downloads; use GET', 'method_not_allowed');
    let size: number;
    try { const s = statSync(t.uri); if (!s.isFile()) throw new Error('not a file'); size = s.size; } catch { throw notFound('the file for this transfer is not here'); }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(size));
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'HEAD') return res.end();
    await pipeline(createReadStream(t.uri), res);
    return;
  }
  if (req.method !== 'PUT') throw err(405, 'This URL uploads; use PUT', 'method_not_allowed');
  // Written beside the target and renamed into place only when complete, so a
  // cut upload never leaves a half file where the cloud expects a whole one.
  mkdirSync(dirname(t.uri), { recursive: true });
  const part = `${t.uri}.part-${randomBytes(6).toString('hex')}`;
  const hash = createHash('sha256');
  let bytes = 0;
  const count = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
  try {
    await pipeline(req, count, createWriteStream(part));
  } catch (e) {
    try { unlinkSync(part); } catch { /* never written */ }
    throw e;
  }
  const sha256 = hash.digest('hex');
  if (t.sha256 && t.sha256.toLowerCase() !== sha256) {
    try { unlinkSync(part); } catch { /* gone */ }
    throw err(422, 'The uploaded bytes do not match the checksum this job expects', 'checksum_mismatch');
  }
  renameSync(part, t.uri);
  res.status(201).json({ ok: true, bytes, sha256 });
}

// ---- S3 presigning ---------------------------------------------------------------

/** Node's own SHA-256 in the shape SignatureV4 wants (as in ingest/providers/s3accel.ts). */
class NodeSha256 {
  private h: any;
  constructor(secret?: string | Uint8Array) { this.h = secret ? createHmac('sha256', Buffer.from(secret as any)) : createHash('sha256'); }
  update(d: string | Uint8Array) { this.h.update(Buffer.from(d as any)); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.h.digest()); }
  reset() { /* one-shot use */ }
}

/**
 * A presigned URL for exactly one key. A prefix (a whole tree) is refused:
 * a job that moves a tree lists one transfer per file.
 */
export async function presignS3(uri: string, method: 'GET' | 'PUT', expiresSec: number): Promise<string> {
  const loc = parseS3Uri(uri);
  if (!loc || loc.prefix || !loc.key) throw badRequest('a transfer names one object, not a prefix');
  const region = config.aws.region;
  const client: any = await mediaS3Client(region);
  const credentials = await client.config.credentials();
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const signer = new SignatureV4({ service: 's3', region, credentials, sha256: NodeSha256 as any, uriEscapePath: false });
  const keyPath = '/' + loc.key.split('/').map(encodeURIComponent).join('/');
  // The same endpoint the media client uses: AWS, or MinIO, LocalStack or moto on the Mac.
  const ep = process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL;
  let protocol = 'https:', hostname = `${loc.bucket}.s3.${region}.amazonaws.com`, port = '', path = keyPath;
  if (ep) {
    const u = new URL(ep);
    protocol = u.protocol; port = u.port;
    if (process.env.S3_FORCE_PATH_STYLE === '1') { hostname = u.hostname; path = `/${loc.bucket}${keyPath}`; }
    else hostname = `${loc.bucket}.${u.hostname}`;
  }
  const host = port ? `${hostname}:${port}` : hostname;
  const signed: any = await signer.presign(
    { method, protocol, hostname, port: port ? Number(port) : undefined, path, headers: { host }, query: {} } as any,
    { expiresIn: expiresSec },
  );
  const qs = new URLSearchParams(signed.query as Record<string, string>).toString();
  return `${protocol}//${host}${signed.path}?${qs}`;
}
