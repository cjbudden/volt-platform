// ============================================================================
//  MIRROR AND ARCHIVE (build queue H3-2, HYBRID_SITES.md "Add-on: Mirror and
//  Archive to external storage"). Licensed add-on `mirror_archive`, off by
//  default.
//
//  An account names STORAGE TARGETS at its sites (a folder on the site's
//  server or a mounted NAS share, or an on-prem S3-compatible store such as
//  MinIO, H3-4) and asks for a file to be copied there.
//  The copy is a job in the site's pool (H3's lease): an approved host of the
//  site leases it, downloads through a URL scoped to that one object, writes
//  the file beside its final name, renames it in, READS IT BACK from the
//  target and reports what the target holds.
//
//  NOTHING IS ARCHIVED UNTIL VERIFIED. The cloud matches the checksum read
//  back from the target against the source's own (the one the upload was
//  checked against) before the copy counts; a mismatch fails the attempt,
//  which is retried with the queue's backoff, and the copy never shows as
//  verified. A re-check job reads the copy again later: a copy that changed
//  is `corrupt`, one that is gone is `missing`.
//
//  The cloud never reaches into the site and the site never names a path of
//  its own in the cloud: the target's folder travels in the job, the bytes
//  through the transfer the job lists.
// ============================================================================
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { one, query } from '../../db';
import { ApiError, badRequest, notFound, conflict } from '../../util/http';
import { enqueue, sitePool, type JobRow } from '../jobs/queue';
import { isS3Uri } from '../media/s3Driver';
import { safeFileName } from './naming';

export const ARCHIVE_COPY = 'archive.copy';
export const ARCHIVE_VERIFY = 'archive.verify';
/** The job types the Mirror and Archive licence covers at a site. */
export const ARCHIVE_JOB_TYPES = [ARCHIVE_COPY, ARCHIVE_VERIFY];
export const isArchiveJob = (type: string) => ARCHIVE_JOB_TYPES.includes(type);

/** path: a folder on the site's server or NAS. s3: an on-prem S3-compatible store (H3-4). */
export const TARGET_KINDS = ['path', 's3'] as const;
export const COPY_STATES = ['queued', 'copying', 'verified', 'failed', 'corrupt', 'missing'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const err = (status: number, message: string, code: string) => Object.assign(new ApiError(status, message), { code });

// ---- targets ---------------------------------------------------------------------

/**
 * A folder on the site's server. Absolute (POSIX `/mnt/nas`, a Windows drive
 * `D:\Archive` or a share `\\nas\archive`), with no `..` in it: the agent
 * writes only inside it, and a path that walks out of itself is refused here
 * before it is ever sent.
 */
export function cleanTargetPath(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p || p.length > 1024 || p.includes('\0')) throw badRequest('path must be a folder on the site\'s server, up to 1024 characters');
  const absolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
  if (!absolute) throw badRequest('path must be absolute (for example /mnt/nas/archive, D:\\Archive or \\\\nas\\archive)');
  if (p.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) throw badRequest('path must not contain . or .. segments');
  return p;
}

// ---- S3-compatible stores (H3-4) -------------------------------------------------------

export interface StoreTarget { endpoint: string; bucket: string; prefix: string; region: string; pathStyle: boolean; credentialRef: string }

const KEY_FIELDS = ['accessKeyId', 'secretAccessKey', 'secretKey', 'accessKey', 'sessionToken', 'password', 'secret'];

/**
 * Where an S3-compatible store is, as the site agent will reach it. Keys are
 * REFUSED here: they stay on the agent host under `credentialRef`, so a
 * leaked database or console session never hands out the customer's store.
 * The endpoint is the site's view (it may be a LAN address the cloud cannot
 * reach, which is the point); only its shape is checked.
 */
export function cleanStore(raw: any, prev?: StoreTarget | null): StoreTarget {
  const b = raw && typeof raw === 'object' ? raw : {};
  if (KEY_FIELDS.some((k) => b[k] !== undefined)) {
    throw err(400, 'Keys for the store stay on the site\'s agent host and are never sent to Volt: name them with credentialRef', 'keys_stay_at_site');
  }
  const pick = <T>(k: string, d: T) => (b[k] === undefined ? (prev ? (prev as any)[k] : d) : b[k]);
  let ep: URL;
  try { ep = new URL(String(pick('endpoint', '') ?? '').trim()); } catch { throw badRequest('s3.endpoint must be the store\'s address, for example http://minio.local:9000'); }
  if (!/^https?:$/.test(ep.protocol) || ep.username || ep.password || (ep.pathname !== '/' && ep.pathname !== '') || ep.search || ep.hash) {
    throw badRequest('s3.endpoint must be http(s)://host[:port] with no path, user or query');
  }
  const bucket = String(pick('bucket', '') ?? '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) throw badRequest('s3.bucket must be a bucket name (3 to 63 lower-case letters, digits, dots and hyphens)');
  const prefix = String(pick('prefix', '') ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (prefix.length > 512 || (prefix && prefix.split('/').some((seg) => !/^[A-Za-z0-9._-]+$/.test(seg) || seg === '.' || seg === '..'))) {
    throw badRequest('s3.prefix must be a folder in the bucket: letters, digits, . _ - between slashes, no . or .. (up to 512 characters)');
  }
  const region = String(pick('region', 'us-east-1') || 'us-east-1').trim();
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw badRequest('s3.region must be a region name such as us-east-1 (most on-prem stores accept any)');
  const pathStyle = pick('pathStyle', true);
  if (typeof pathStyle !== 'boolean') throw badRequest('s3.pathStyle must be true or false');
  const credentialRef = String(pick('credentialRef', 'default') || 'default').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(credentialRef)) throw badRequest('s3.credentialRef must be the name of the keys on the agent host (letters, digits, . _ -, up to 64)');
  return { endpoint: ep.origin, bucket, prefix, region, pathStyle, credentialRef };
}

/** The place a store target shows as its path. */
export const storePath = (s: StoreTarget) => `s3://${s.bucket}${s.prefix ? '/' + s.prefix : ''}`;
/** Where copies land: the store, the bucket and the folder. Moving it would make every copy look missing. */
const storeLocation = (s: StoreTarget | null | undefined) => (s ? `${s.endpoint}|${s.bucket}|${s.prefix}` : '');

/** What the agent is told about a target: where, never how to sign in. */
export function targetForAgent(t: any) {
  return { id: t.id, kind: t.kind, path: t.path, bandwidthMbps: t.bandwidth_mbps ?? null, ...(t.kind === 's3' && t.s3 ? { s3: t.s3 } : {}) };
}

export function targetView(t: any) {
  return {
    id: t.id, name: t.name, siteId: t.site_id, siteName: t.site_name ?? undefined, kind: t.kind, path: t.path,
    s3: t.kind === 's3' ? (t.s3 ?? null) : undefined,
    bandwidthMbps: t.bandwidth_mbps ?? null, recheckDays: t.recheck_days ?? null,
    status: t.status, createdAt: t.created_at, updatedAt: t.updated_at,
  };
}

export async function ownedTarget(accountId: string, id: string) {
  if (!UUID.test(String(id))) throw notFound('storage target not found');
  const t = await one<any>(
    `SELECT t.*, s.name AS site_name, s.status AS site_status FROM archive_targets t JOIN sites s ON s.id = t.site_id
      WHERE t.id = $1 AND t.account_id = $2`, [id, accountId]);
  if (!t) throw notFound('storage target not found');
  return t;
}

function cleanBandwidth(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw badRequest('bandwidthMbps must be a whole number of megabits per second, 1 to 100000, or null for no cap');
  return n;
}

/** How often verified copies are read back (H3-3). Null: only when asked. */
function cleanRecheckDays(v: unknown): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw badRequest('recheckDays must be a whole number of days, 1 to 3650, or null for no scheduled re-checks');
  return n;
}

export async function createTarget(accountId: string, userId: string | null, b: any) {
  const name = typeof b?.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 120) throw badRequest('name is required (up to 120 characters)');
  const kind = b?.kind ?? 'path';
  if (!TARGET_KINDS.includes(kind)) throw err(422, 'A storage target is a folder (kind "path") or an S3-compatible store (kind "s3")', 'kind_not_available');
  const store = kind === 's3' ? cleanStore(b?.s3) : null;
  if (kind !== 's3' && b?.s3 !== undefined) throw badRequest('s3 is only for targets of kind "s3"');
  const path = store ? storePath(store) : cleanTargetPath(b?.path);
  const bandwidth = cleanBandwidth(b?.bandwidthMbps);
  const recheck = b?.recheckDays === undefined ? 30 : cleanRecheckDays(b.recheckDays);
  if (!UUID.test(String(b?.siteId))) throw badRequest('siteId is required');
  const site = await one<any>(`SELECT id, status FROM sites WHERE id = $1 AND account_id = $2`, [b.siteId, accountId]);
  if (!site) throw notFound('site not found');
  if (await one(`SELECT 1 FROM archive_targets WHERE account_id = $1 AND lower(name) = lower($2)`, [accountId, name])) {
    throw conflict('A storage target with this name already exists');
  }
  const row = await one<any>(
    `INSERT INTO archive_targets (account_id, site_id, name, kind, path, bandwidth_mbps, recheck_days, s3, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT id FROM users WHERE id = $9)) RETURNING *`,
    [accountId, site.id, name, kind, path, bandwidth, recheck, store ? JSON.stringify(store) : null, userId]);
  return ownedTarget(accountId, row.id);
}

export async function updateTarget(accountId: string, id: string, b: any) {
  const t = await ownedTarget(accountId, id);
  const sets: string[] = []; const args: unknown[] = [t.id];
  const changes: Record<string, { from: any; to: any }> = {};
  const set = (col: string, key: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); changes[key] = { from: t[col], to: v }; };
  if (b?.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 120) throw badRequest('name is required (up to 120 characters)');
    if (name.toLowerCase() !== t.name.toLowerCase()
      && await one(`SELECT 1 FROM archive_targets WHERE account_id = $1 AND lower(name) = lower($2) AND id <> $3`, [accountId, name, t.id])) {
      throw conflict('A storage target with this name already exists');
    }
    if (name !== t.name) set('name', 'name', name);
  }
  if (b?.kind !== undefined && b.kind !== t.kind) throw badRequest('A target keeps its kind; make a new target for another kind of storage');
  if (t.kind === 's3') {
    if (b?.path !== undefined) throw badRequest('A store target\'s path follows its bucket and prefix; change s3 instead');
    if (b?.s3 !== undefined) {
      const store = cleanStore(b.s3, t.s3);
      if (storeLocation(store) !== storeLocation(t.s3)
        && await one(`SELECT 1 FROM archive_copies WHERE target_id = $1 AND stored_path IS NOT NULL LIMIT 1`, [t.id])) {
        throw err(409, 'This target already holds copies; make a new target for another store, bucket or folder', 'target_in_use');
      }
      if (JSON.stringify(store) !== JSON.stringify(t.s3)) {
        args.push(JSON.stringify(store)); sets.push(`s3 = $${args.length}`); changes.s3 = { from: t.s3, to: store };
        if (storePath(store) !== t.path) set('path', 'path', storePath(store));
      }
    }
  } else if (b?.s3 !== undefined) throw badRequest('s3 is only for targets of kind "s3"');
  if (t.kind !== 's3' && b?.path !== undefined) {
    const path = cleanTargetPath(b.path);
    // Copies already made are recorded relative to the folder; moving the
    // folder under them would make every one of them look missing.
    if (path !== t.path && await one(`SELECT 1 FROM archive_copies WHERE target_id = $1 AND stored_path IS NOT NULL LIMIT 1`, [t.id])) {
      throw err(409, 'This target already holds copies; make a new target for another folder', 'target_in_use');
    }
    if (path !== t.path) set('path', 'path', path);
  }
  if (b?.bandwidthMbps !== undefined) { const v = cleanBandwidth(b.bandwidthMbps); if (v !== t.bandwidth_mbps) set('bandwidth_mbps', 'bandwidthMbps', v); }
  if (b?.recheckDays !== undefined) { const v = cleanRecheckDays(b.recheckDays); if (v !== t.recheck_days) set('recheck_days', 'recheckDays', v); }
  if (b?.status !== undefined) {
    if (b.status !== 'active' && b.status !== 'disabled') throw badRequest('status is active or disabled');
    if (b.status !== t.status) set('status', 'status', b.status);
  }
  if (sets.length) await query(`UPDATE archive_targets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, args);
  return { target: await ownedTarget(accountId, t.id), changes };
}

// ---- copies ------------------------------------------------------------------------

/** What a copy shows: its own state, and "copying" while a host holds the job. */
export function copyView(c: any) {
  const running = c.job_state === 'running' || c.verify_job_state === 'running';
  const state = c.state === 'queued' && c.job_state === 'running' ? 'copying' : c.state;
  return {
    id: c.id, targetId: c.target_id, targetName: c.target_name ?? undefined, vodAssetId: c.vod_asset_id, what: c.what,
    // A recording copy (H3-7) is of a stretch of a channel or event, not of an asset.
    streamId: c.stream_id ?? null, streamName: c.stream_name ?? null,
    rangeStart: c.range_start ?? null, rangeEnd: c.range_end ?? null, title: c.title ?? null,
    fileName: c.file_name, storedPath: c.stored_path, bytes: c.bytes === null || c.bytes === undefined ? null : Number(c.bytes),
    sha256: c.sha256, state, busy: running,
    checking: c.verify_job_state === 'queued' || c.verify_job_state === 'running',
    error: c.error, errorCode: c.error_code,
    attempts: c.job_attempts ?? null,
    copiedAt: c.copied_at, verifiedAt: c.verified_at, checkedAt: c.checked_at,
    createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

export const COPY_SELECT = `
  SELECT c.*, t.name AS target_name, j.state AS job_state, j.attempts AS job_attempts, vj.state AS verify_job_state,
         COALESCE(sch.name, sev.name) AS stream_name
    FROM archive_copies c
    JOIN archive_targets t ON t.id = c.target_id
    LEFT JOIN jobs j ON j.id = c.job_id
    LEFT JOIN jobs vj ON vj.id = c.verify_job_id
    LEFT JOIN channels sch ON sch.id = c.stream_id
    LEFT JOIN events sev ON sev.id = c.stream_id`;

export async function ownedCopy(accountId: string, id: string) {
  if (!UUID.test(String(id))) throw notFound('archive copy not found');
  const c = await one<any>(`${COPY_SELECT} WHERE c.id = $1 AND c.account_id = $2`, [id, accountId]);
  if (!c) throw notFound('archive copy not found');
  return c;
}

/** The asset's original, if this account owns the asset and the original is kept. */
async function assetSource(accountId: string, assetId: string) {
  if (!UUID.test(String(assetId))) throw badRequest('vodAssetId is required');
  const a = await one<any>(
    `SELECT v.id, v.title, v.source_key, v.sha256
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [assetId, accountId]);
  if (!a) throw notFound('asset not found');
  if (!a.source_key) throw err(422, 'This asset has no original file kept, so there is nothing to archive', 'no_source');
  return a;
}

/**
 * Copy an asset's original to a target. One copy of one thing per target:
 * asking again for a copy that is queued, running or verified returns it;
 * one that failed, changed or went missing is copied afresh.
 */
export async function requestCopy(accountId: string, userId: string | null, b: any, opts: { runAfter?: Date | null } = {}) {
  const t = await ownedTarget(accountId, b?.targetId);
  if (t.status !== 'active') throw err(409, 'This storage target is disabled', 'target_disabled');
  if (t.site_status !== 'active') throw err(409, 'The site of this storage target is disabled', 'site_disabled');
  const a = await assetSource(accountId, b?.vodAssetId);

  const existing = await one<any>(`${COPY_SELECT} WHERE c.target_id = $1 AND c.vod_asset_id = $2 AND c.what = 'source'`, [t.id, a.id]);
  if (existing && (existing.state === 'verified' || (existing.state === 'queued' && ['queued', 'running'].includes(existing.job_state)))) {
    return { copy: existing, created: false };
  }

  const fileName = safeFileName(basename(String(a.source_key).replace(/^s3:\/\/[^/]+\//, '')), a.title || 'source');
  let bytes: number | null = null;
  if (!isS3Uri(a.source_key)) {
    try { bytes = statSync(a.source_key).size; } catch { throw err(422, 'The original file of this asset is not on this server', 'no_source'); }
  }
  const expected = typeof a.sha256 === 'string' && SHA.test(a.sha256.toLowerCase()) ? a.sha256.toLowerCase() : null;

  const row = existing
    ? await one<any>(
      `UPDATE archive_copies SET source_uri = $2, file_name = $3, expected_sha256 = $4, state = 'queued', stored_path = NULL,
              sha256 = NULL, bytes = NULL, error = NULL, error_code = NULL, copied_at = NULL, verified_at = NULL, checked_at = NULL,
              verify_job_id = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [existing.id, a.source_key, fileName, expected])
    : await one<any>(
      `INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, expected_sha256, created_by)
       VALUES ($1,$2,$3,'source',$4,$5,$6,(SELECT id FROM users WHERE id = $7)) RETURNING *`,
      [accountId, t.id, a.id, a.source_key, fileName, expected, userId]);

  await queueCopyJob(t, row.id, { fileName, uri: a.source_key, bytes, sha256: expected }, userId, opts.runAfter ?? null);
  return { copy: await ownedCopy(accountId, row.id), created: true };
}

/**
 * Hand one copy to the target's site: an `archive.copy` job in the site's
 * pool naming the one file to fetch. Shared by copies of originals and of
 * recordings (H3-7), so the agent sees one kind of copy job whatever the
 * file is.
 */
export async function queueCopyJob(t: any, copyId: string, src: { fileName: string; uri: string; bytes: number | null; sha256: string | null },
  userId: string | null, runAfter: Date | null): Promise<string> {
  const job = await enqueue({
    type: ARCHIVE_COPY, pool: sitePool(t.site_id), createdBy: userId, maxAttempts: 5,
    // A copy rule's off-peak window holds the job back until the window
    // opens (copyOnRule); a copy asked for by hand runs now.
    runAfter: runAfter ?? undefined,
    payload: {
      copyId, fileName: src.fileName,
      target: targetForAgent(t),
      transfers: [{ name: 'source', direction: 'download', uri: src.uri, bytes: src.bytes, sha256: src.sha256 }],
    },
  });
  await query(`UPDATE archive_copies SET job_id = $2 WHERE id = $1`, [copyId, job.id]);
  return job.id;
}

/** Read a copy back from its target now (also what the scheduled re-checks will queue). */
export async function requestVerify(accountId: string, userId: string | null, id: string) {
  const c = await ownedCopy(accountId, id);
  if (!c.stored_path || !c.sha256) throw err(409, 'This copy has not been made yet, so there is nothing to check', 'not_copied');
  if (c.verify_job_state === 'queued' || c.verify_job_state === 'running') return { copy: c, created: false };
  const t = await ownedTarget(accountId, c.target_id);
  const job = await enqueue({
    type: ARCHIVE_VERIFY, pool: sitePool(t.site_id), createdBy: userId, maxAttempts: 3,
    payload: { copyId: c.id, storedPath: c.stored_path, sha256: c.sha256, target: targetForAgent(t) },
  });
  await query(`UPDATE archive_copies SET verify_job_id = $2, updated_at = now() WHERE id = $1`, [c.id, job.id]);
  return { copy: await ownedCopy(accountId, c.id), created: true };
}

// ---- scheduled re-checks (H3-3) -----------------------------------------------------------

/**
 * Queue a re-check for every verified copy whose last check is older than its
 * target's `recheck_days`. Run by the scheduler (orchestrator/index.ts) every
 * half hour; bounded per pass so a target with a million copies spreads its
 * checks out instead of handing the site a million jobs at once.
 *
 * Only verified copies: one already found corrupt or missing stays that way
 * until it is copied again, and one still being copied has nothing to read.
 * Only where the account holds the licence and the target and its site are
 * active: withdrawing the add-on or disabling a target stops the checks too.
 */
export async function recheckDue(opts: { limit?: number; accountId?: string } = {}): Promise<{ queued: number }> {
  const rows = await query<any>(
    `SELECT c.id, c.account_id
       FROM archive_copies c
       JOIN archive_targets t ON t.id = c.target_id
       JOIN sites s ON s.id = t.site_id
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN jobs vj ON vj.id = c.verify_job_id
      WHERE c.state = 'verified' AND c.stored_path IS NOT NULL AND c.sha256 IS NOT NULL
        AND t.status = 'active' AND s.status = 'active' AND t.recheck_days IS NOT NULL
        AND 'mirror_archive' = ANY(COALESCE(a.licences, '{}'))
        AND COALESCE(c.checked_at, c.verified_at, c.updated_at) < now() - make_interval(days => t.recheck_days)
        AND (vj.id IS NULL OR vj.state NOT IN ('queued', 'running'))
        AND ($2::uuid IS NULL OR c.account_id = $2)
      ORDER BY COALESCE(c.checked_at, c.verified_at, c.updated_at)
      LIMIT $1`, [opts.limit ?? 200, opts.accountId ?? null]);
  let queued = 0;
  for (const r of rows) {
    try { if ((await requestVerify(r.account_id, null, r.id)).created) queued++; }
    catch (e: any) { console.warn(`[archive] scheduled re-check not queued for ${r.id}:`, e?.message ?? e); }
  }
  return { queued };
}

// ---- copy rules (H3-3) ---------------------------------------------------------------

export type CopyEvent = 'ingest' | 'publish';
/** When a copy rule fires: an asset event, or (H3-7) a stretch of recording closing. */
export type CopyMoment = CopyEvent | 'recording';
export interface OffPeak { from: string; to: string; timeZone?: string }
export interface ArchiveRule { copies: { targetId: string; on: CopyMoment[] }[]; offPeak?: OffPeak | null }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => { const m = HHMM.exec(hhmm)!; return Number(m[1]) * 60 + Number(m[2]); };
export const validTimeZone = (tz: string) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; } };

/** Minutes after midnight in a zone, for `at`. */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0), m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

/**
 * When a copy under an off-peak window may start: null when `now` is inside
 * the window (start now), otherwise the next time the window opens. The
 * window is in the given zone (UTC when none) and may run over midnight
 * (22:00 to 06:00). A window whose ends are equal is the whole day.
 *
 * Pure apart from Intl. Across a clock change the start can land up to an
 * hour off; a copy then starts an hour early or late, never outside the
 * day it was meant for.
 */
export function offPeakStart(now: Date, w: OffPeak | null | undefined): Date | null {
  if (!w || !HHMM.test(w.from) || !HHMM.test(w.to)) return null;
  const from = minutesOf(w.from), to = minutesOf(w.to);
  if (from === to) return null;
  const cur = localMinutes(now, w.timeZone && validTimeZone(w.timeZone) ? w.timeZone : 'UTC');
  const inside = from < to ? cur >= from && cur < to : cur >= from || cur < to;
  if (inside) return null;
  const wait = (from - cur + 1440) % 1440;
  const start = new Date(now.getTime() + wait * 60_000);
  start.setUTCSeconds(0, 0);
  return start;
}

/**
 * Copy an asset's original to the targets its publishing rule names for this
 * event (ingest: the original has landed; publish: the asset was published).
 * The rule is read through the publishing ladder (account, content type,
 * channel or event, the asset itself), so the most specific rung that says
 * anything about archive copies decides.
 *
 * Never throws: a copy that cannot be queued (no original kept, a disabled
 * target) is logged and skipped, and the ingest or publish that called this
 * goes on as if nothing had been asked. Without the licence nothing happens.
 */
export async function copyOnRule(accountId: string, assetId: string, event: CopyEvent, now = new Date()): Promise<{ queued: string[]; skipped: { targetId: string; why: string }[] }> {
  const out = { queued: [] as string[], skipped: [] as { targetId: string; why: string }[] };
  try {
    const { hasLicence } = await import('../sites/licences');
    if (!(await hasLicence(accountId, 'mirror_archive'))) return out;
    const { assetAccount } = await import('../availability');
    const { resolveForAsset } = await import('../publishingRules');
    const found = await assetAccount(assetId);
    if (!found || found.accountId !== accountId) return out;
    const rule = (await resolveForAsset(accountId, found.asset)).settings.archive as ArchiveRule | undefined;
    const wanted = (rule?.copies ?? []).filter((c) => ((c.on ?? []) as CopyMoment[]).includes(event));
    if (!wanted.length) return out;
    const runAfter = offPeakStart(now, rule?.offPeak ?? null);
    for (const c of wanted) {
      try {
        const r = await requestCopy(accountId, null, { targetId: c.targetId, vodAssetId: assetId }, { runAfter });
        if (r.created) out.queued.push(r.copy.id);
        else out.skipped.push({ targetId: c.targetId, why: 'already_copied_or_queued' });
      } catch (e: any) {
        out.skipped.push({ targetId: c.targetId, why: e?.code ?? e?.message ?? 'error' });
      }
    }
    if (out.queued.length) console.log(`[archive] ${event}: ${out.queued.length} copy rule(s) queued for asset ${assetId}${runAfter ? ` from ${runAfter.toISOString()}` : ''}`);
  } catch (e: any) {
    console.warn(`[archive] copy rules for asset ${assetId} (${event}) not applied:`, e?.message ?? e);
  }
  return out;
}

// ---- results from the site ------------------------------------------------------------

export type Verdict =
  | { ok: true; apply: () => Promise<void> }
  | { ok: false; status: number; code: string; message: string; permanent?: boolean };

/** A path the agent reports must stay inside the target: relative, no `..`. */
function cleanStoredPath(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 1024 || v.includes('\0')) return null;
  if (v.startsWith('/') || v.startsWith('\\') || /^[A-Za-z]:/.test(v)) return null;
  if (v.split(/[\\/]+/).some((s) => !s || s === '.' || s === '..')) return null;
  return v;
}

/**
 * Judge what a host reports for an archive job BEFORE the job is marked
 * done. A copy counts only when the checksum read back from the target
 * matches the source's, and the bytes the host downloaded match what it
 * wrote. Otherwise the attempt fails and is retried: never archived.
 */
export async function judge(job: JobRow, result: any): Promise<Verdict> {
  const copyId = job.payload?.copyId;
  const c = UUID.test(String(copyId)) ? await one<any>(`SELECT * FROM archive_copies WHERE id = $1`, [copyId]) : null;
  if (!c) return { ok: true, apply: async () => {} };   // the copy was removed meanwhile: nothing to record
  const sha = typeof result?.sha256 === 'string' ? result.sha256.toLowerCase() : '';
  const bytes = Number(result?.bytes);

  if (job.type === ARCHIVE_VERIFY) {
    if (result?.present === false) {
      return { ok: true, apply: async () => { await query(
        `UPDATE archive_copies SET state = 'missing', checked_at = now(), error = 'The copy is no longer at the target', error_code = 'missing', updated_at = now() WHERE id = $1`, [c.id]); } };
    }
    if (!SHA.test(sha) || !Number.isFinite(bytes)) return { ok: false, status: 400, code: 'bad_result', message: 'A check reports present, sha256 and bytes' };
    const same = sha === c.sha256 && (c.bytes === null || Number(c.bytes) === bytes);
    return { ok: true, apply: async () => { await query(same
      ? `UPDATE archive_copies SET state = 'verified', verified_at = now(), checked_at = now(), error = NULL, error_code = NULL, updated_at = now() WHERE id = $1`
      : `UPDATE archive_copies SET state = 'corrupt', checked_at = now(), error = $2, error_code = 'checksum_mismatch', updated_at = now() WHERE id = $1`,
      same ? [c.id] : [c.id, `The copy at the target no longer matches (SHA-256 ${sha.slice(0, 12)}…, ${bytes} bytes; expected ${String(c.sha256).slice(0, 12)}…)`]); } };
  }

  // archive.copy
  const stored = cleanStoredPath(result?.storedPath);
  if (!stored || !SHA.test(sha) || !Number.isInteger(bytes) || bytes < 0) {
    return { ok: false, status: 400, code: 'bad_result', message: 'A copy reports storedPath (inside the target), sha256 and bytes' };
  }
  const t = (Array.isArray(job.payload?.transfers) ? job.payload.transfers : []).find((x: any) => x?.name === 'source');
  const down = typeof result?.downloadSha256 === 'string' ? result.downloadSha256.toLowerCase() : null;
  if (down && down !== sha) {
    return { ok: false, status: 422, code: 'checksum_mismatch', message: 'The copy read back from the target does not match the bytes downloaded' };
  }
  if (c.expected_sha256 && sha !== c.expected_sha256) {
    return { ok: false, status: 422, code: 'checksum_mismatch', message: 'The copy at the target does not match the original\'s checksum' };
  }
  if (Number.isFinite(t?.bytes) && t.bytes !== null && t.bytes !== bytes) {
    return { ok: false, status: 422, code: 'size_mismatch', message: `The copy at the target is ${bytes} bytes; the original is ${t.bytes}` };
  }
  return { ok: true, apply: async () => {
    await query(
      `UPDATE archive_copies SET state = 'verified', stored_path = $2, bytes = $3, sha256 = $4,
              copied_at = now(), verified_at = now(), checked_at = now(), error = NULL, error_code = NULL, updated_at = now()
        WHERE id = $1`, [c.id, stored, bytes, sha]);
    // A recording file was made only to be copied (H3-7): once every target
    // holds a verified copy, the cloud's own file is not needed.
    if (c.stream_id) await (await import('./recordings')).releaseBuilt(c.source_uri).catch(() => {});
  } };
}

/**
 * An attempt failed (reported by the host, or refused by `judge`). The last
 * error is kept on the copy; when no attempts are left the copy is `failed`.
 * A failed re-check leaves the copy's own state alone: not being able to
 * look is not the same as finding it changed.
 */
export async function attemptFailed(job: JobRow, message: string, code: string | null, exhausted: boolean): Promise<void> {
  const copyId = job.payload?.copyId;
  if (!UUID.test(String(copyId))) return;
  if (job.type === ARCHIVE_COPY) {
    await query(
      `UPDATE archive_copies SET error = $2, error_code = $3, state = CASE WHEN $4 THEN 'failed' ELSE state END, updated_at = now()
        WHERE id = $1 AND job_id = $5`, [copyId, message.slice(0, 2000), code, exhausted, job.id]);
  } else if (job.type === ARCHIVE_VERIFY && exhausted) {
    await query(
      `UPDATE archive_copies SET error = $2, error_code = $3, updated_at = now() WHERE id = $1 AND verify_job_id = $4`,
      [copyId, `The last check could not run: ${message}`.slice(0, 2000), code, job.id]);
  }
}
