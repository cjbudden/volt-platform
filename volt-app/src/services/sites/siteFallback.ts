// ============================================================================
//  HYBRID SITES 5a: FALL BACK TO CLOUD ENCODING (build queue H5,
//  HYBRID_SITES.md "When the site is offline" and "Failures").
//
//  An Encode at site folder keeps its originals on the customer's storage and
//  waits for a server of the site to encode them. When no server takes the
//  encode (the encoders are switched off, the encoder image is missing, every
//  host is busy for hours), the folder's FALLBACK TIME decides what happens:
//
//    - no fallback time (the default): the asset waits for the site. The
//      original never leaves the customer's network unless a policy says so
//      (HYBRID_SITES.md), so sending it to the cloud is something a person
//      switches on for the folder, never something Volt does by itself;
//    - a fallback time (5 minutes to 7 days): once the asset's encode has
//      waited that long in the site's pool without a server taking it, the
//      job is cancelled there and the asset asks the site to SEND THE
//      ORIGINAL instead. The agent uploads it on the same resumable upload
//      as an Upload and encode in the cloud folder (siteTus.ts, opened for
//      the item), the cloud checks it is the file that was registered (its
//      SHA-256), keeps it as the asset's original and encodes it here with
//      the normal vod.encode. The asset records that it was encoded in the
//      cloud and why (`ingest.siteFallback`), and the audit log says so.
//
//  "Waited" is measured on the job that is waiting now: since it was queued,
//  or since its lease was last reaped (a host that went quiet), so an encode
//  that a server is working on never falls back, however long it takes.
//
//  A SITE THAT IS WHOLLY OFFLINE cannot send the original either: the request
//  stays on the asset, and the agent sends the file when it is back. Either
//  way the asset never reads Processing for ever without a reason.
//
//  Only the asset's own encode falls back. A FAST ladder variant made at a
//  site (H4-6) waits for the site: the asset already plays its own encode.
//
//  The sweep runs next to the job reaper on every worker (worker.ts); the
//  cancel is conditional (only a job still queued), so two workers sweeping
//  at once fall back once.
// ============================================================================
import { mkdir, rename, copyFile, unlink, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { one, query } from '../../db';
import { badRequest, conflict, notFound } from '../../util/http';
import { cancel } from '../jobs/queue';
import { writeAudit } from '../audit';
import { SITE_ENCODE_JOB_TYPES } from './siteEncode';
import { requireApprovedHost, siteFolder, mediaTypeOf } from './siteWatchfolders';
import { vodSourceRoot, landVodSource } from '../media/vodSource';
import type { SitePrincipal } from './sites';

/** The fallback times a folder may have, in minutes: five minutes to a week. Null is "wait for the site". */
export const FALLBACK_MIN_MINUTES = 5;
export const FALLBACK_MAX_MINUTES = 7 * 24 * 60;

/** A folder's fallback time as the API takes it: null (wait) or whole minutes in range. */
export function fallbackMinutesOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < FALLBACK_MIN_MINUTES || n > FALLBACK_MAX_MINUTES) {
    throw badRequest(`fallbackMinutes must be null (wait for the site) or whole minutes from ${FALLBACK_MIN_MINUTES} to ${FALLBACK_MAX_MINUTES}`);
  }
  return n;
}

/** States of `ingest.siteFallback.state`. */
export type FallbackState = 'requested' | 'uploading' | 'encoding' | 'failed';
const WAITING_FOR_FILE = ['requested', 'uploading'];

const minutesWords = (m: number) => m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`;

async function setFallback(assetId: string, patch: Record<string, unknown>) {
  await query(
    `UPDATE vod_assets
        SET ingest = jsonb_set(COALESCE(ingest, '{}'::jsonb), '{siteFallback}', COALESCE(ingest->'siteFallback', '{}'::jsonb) || $2::jsonb),
            updated_at = now()
      WHERE id = $1`, [assetId, JSON.stringify(patch)]);
}

/**
 * THE SWEEP. Every asset's own site encode that has waited longer than its
 * folder's fallback time without a server taking it is cancelled at the site,
 * and the asset asks the site's agent for the original. Returns how many fell
 * back on this pass.
 */
export async function sweepSiteFallbacks(): Promise<number> {
  const due = await query<any>(
    `SELECT j.id AS job_id, j.type, v.id AS asset_id, v.account_id, v.title, w.id AS folder_id, w.fallback_minutes,
            s.name AS site_name,
            floor(extract(epoch FROM now() - GREATEST(j.created_at, j.run_after)) / 60)::int AS waited
       FROM jobs j
       JOIN vod_assets v ON v.id::text = j.payload->>'vodAssetId' AND v.encode_job_id = j.id
       JOIN watchfolders w ON w.id::text = v.ingest->'siteSource'->>'folderId'
       LEFT JOIN sites s ON s.id = w.site_id
      WHERE j.type = ANY($1::text[]) AND j.state = 'queued'
        AND COALESCE(j.payload->'variant', 'null'::jsonb) = 'null'::jsonb
        AND v.source_key IS NULL
        AND w.kind = 'site' AND w.placement = 'encode_site' AND w.fallback_minutes IS NOT NULL
        AND GREATEST(j.created_at, j.run_after) < now() - make_interval(mins => w.fallback_minutes)
      ORDER BY j.created_at LIMIT 100`, [SITE_ENCODE_JOB_TYPES]);
  let n = 0;
  for (const d of due) {
    // Conditional: a server that took the job a moment ago keeps it.
    if (!(await cancel(d.job_id))) continue;
    const reason = `no server of the site${d.site_name ? ` "${d.site_name}"` : ''} took the encode within ${minutesWords(Number(d.fallback_minutes))} (the folder's fallback time)`;
    const record = { state: 'requested' as FallbackState, reason, requestedAt: new Date().toISOString(), waitedMinutes: Number(d.waited), cancelledJobId: d.job_id, cancelledJobType: d.type };
    await setFallback(d.asset_id, record);
    await query(`UPDATE jobs SET last_error = $2, error_code = 'site_fallback' WHERE id = $1`, [d.job_id, `fell back to cloud encoding: ${reason}`.slice(0, 2000)]);
    await writeAudit(null, {
      accountId: d.account_id, userId: null, label: 'Volt (cloud fallback)', action: 'update', entityType: 'vod_asset', entityId: d.asset_id,
      snapshot: { title: d.title, siteFallback: record },
    }).catch((e) => console.warn('[site fallback] audit not written', d.asset_id, e?.message ?? e));
    n++;
  }
  if (n) console.log(`[site fallback] ${n} site encode(s) fell back to the cloud; their originals are asked for`);
  return n;
}

/**
 * Originals this folder's agent is asked to send, with the upload already
 * opened for each (and how far it got), so a restarted agent resumes.
 */
export async function pendingFallbacks(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const rows = await query<any>(
    `SELECT i.id, i.object_key, i.checksum, i.size_bytes, u.id AS upload_id, u.state AS upload_state, u.received_bytes
       FROM watchfolder_items i
       JOIN vod_assets v ON v.id = i.vod_asset_id
       LEFT JOIN upload_sessions u ON u.id = i.upload_session_id
      WHERE i.watchfolder_id = $1 AND v.ingest->'siteFallback'->>'state' = ANY($2::text[])
        AND (u.id IS NULL OR u.state <> 'complete')
      ORDER BY i.seen_at LIMIT 20`, [f.id, WAITING_FOR_FILE]);
  return rows.map((r) => ({
    itemId: Number(r.id), objectKey: r.object_key, checksum: r.checksum, sizeBytes: Number(r.size_bytes),
    upload: r.upload_id && r.upload_state === 'open'
      ? { id: r.upload_id, offset: Number(r.received_bytes ?? 0), url: `/api/site-agent/tus/${r.upload_id}` }
      : null,
  }));
}

/**
 * The item a fallback upload is opened for, checked: this site's folder, its
 * asset asking for the original, and the size it was registered with.
 */
export async function fallbackItemForUpload(p: SitePrincipal, itemId: unknown, length: number) {
  requireApprovedHost(p);
  const id = Number(itemId);
  if (!Number.isSafeInteger(id)) throw badRequest('Upload-Metadata must carry the itemId of the original Volt asked for');
  const r = await one<any>(
    `SELECT i.*, w.ladder_group_id, u.state AS upload_state, v.ingest->'siteFallback'->>'state' AS fallback_state
       FROM watchfolder_items i
       JOIN watchfolders w ON w.id = i.watchfolder_id
       LEFT JOIN vod_assets v ON v.id = i.vod_asset_id
       LEFT JOIN upload_sessions u ON u.id = i.upload_session_id
      WHERE i.id = $1 AND w.account_id = $2 AND w.kind = 'site' AND w.site_id = $3`, [id, p.accountId, p.siteId]);
  if (!r) throw notFound('item not found');
  if (!WAITING_FOR_FILE.includes(String(r.fallback_state))) throw conflict('Volt has not asked for this original; it is encoded at the site');
  if (r.upload_state === 'complete') throw conflict('This original has been sent already');
  if (Number(r.size_bytes) !== length) throw conflict(`The file is ${length} bytes now and was ${r.size_bytes} when it was registered; it has changed`);
  return {
    item: r,
    existingUpload: r.upload_session_id && r.upload_state === 'open' ? String(r.upload_session_id) : null,
    contentType: mediaTypeOf(String(r.object_key)),
  };
}

/** The upload is open on the item: the asset reads as receiving the original. */
export async function fallbackUploadOpened(itemId: number) {
  const it = await one<any>(`SELECT vod_asset_id FROM watchfolder_items WHERE id = $1`, [itemId]);
  if (it?.vod_asset_id) {
    await query(
      `UPDATE vod_assets SET ingest = jsonb_set(ingest, '{siteFallback,state}', '"uploading"'), updated_at = now()
        WHERE id = $1 AND ingest->'siteFallback'->>'state' = 'requested'`, [it.vod_asset_id]);
  }
}

/** Is this upload an original sent for a cloud fallback (not an image or caption of the folder)? */
export async function isFallbackUpload(uploadId: string): Promise<boolean> {
  const r = await one<any>(
    `SELECT 1 AS x FROM watchfolder_items i JOIN vod_assets v ON v.id = i.vod_asset_id
      WHERE i.upload_session_id = $1 AND v.ingest->'siteFallback'->>'state' = ANY($2::text[])`, [uploadId, WAITING_FOR_FILE]);
  return !!r;
}

/** Where a fallback original is kept on this machine (local driver), or named before it lands in the bucket. */
export function fallbackSourcePath(assetId: string, objectKey: string): string {
  return join(vodSourceRoot(), 'site', assetId, basename(String(objectKey)) || 'original');
}

/**
 * THE ORIGINAL HAS ARRIVED. Check it is the file that was registered, keep it
 * as the asset's original (the bucket on AWS, vod-src on the Mac), and encode
 * it here. Never throws: the original is still at the site.
 */
export async function landFallbackSource(uploadId: string, dataPath: string, sha: string): Promise<void> {
  const { removeStaged } = await import('../uploadStaging');
  const close = async () => {
    await query(`UPDATE upload_sessions SET state = 'complete', error = NULL, updated_at = now() WHERE id = $1`, [uploadId]);
    await removeStaged(uploadId).catch(() => 0);
  };
  const it = await one<any>(
    `SELECT i.id, i.object_key, i.checksum, i.size_bytes, i.vod_asset_id, v.account_id, v.title
       FROM watchfolder_items i JOIN vod_assets v ON v.id = i.vod_asset_id WHERE i.upload_session_id = $1`, [uploadId]);
  if (!it) { await close(); return; }
  const assetId = String(it.vod_asset_id);
  try {
    if (String(it.checksum).toLowerCase() !== String(sha).toLowerCase()) {
      // Not the file that was registered (it was replaced at the site): the
      // asset must not be encoded from other content. It says why.
      const msg = `the original sent from the site is not the file that was registered (was ${String(it.checksum).slice(0, 12)}, arrived ${String(sha).slice(0, 12)}); the folder takes the new content in as a new item`;
      await setFallback(assetId, { state: 'failed', error: msg, failedAt: new Date().toISOString() });
      await query(`UPDATE vod_assets SET media_state = 'failed', media_error = $2, media_error_code = 'site_fallback_changed', media_state_at = now(), updated_at = now() WHERE id = $1`, [assetId, msg]);
      await unlink(dataPath).catch(() => {});
      await close();
      return;
    }
    const dest = fallbackSourcePath(assetId, String(it.object_key));
    await mkdir(dirname(dest), { recursive: true });
    try { await rename(dataPath, dest); }
    catch { await copyFile(dataPath, dest); await unlink(dataPath).catch(() => {}); }
    const bytes = (await stat(dest)).size;
    // On AWS the original goes to the bucket like every other original, so
    // whichever task takes the encode can read it.
    const sourceKey = await landVodSource(dest, null);
    await query(`UPDATE vod_assets SET source_key = $2, source_bytes = $3, updated_at = now() WHERE id = $1`, [assetId, sourceKey, bytes]);
    await setFallback(assetId, { state: 'encoding', uploadedAt: new Date().toISOString() });
    await close();
    const { queueEncodeFor } = await import('../ingest/pipeline');
    const jobId = await queueEncodeFor(assetId);
    await setFallback(assetId, { cloudJobId: jobId });
    await query(
      `UPDATE vod_assets SET media_state = 'processing', media_error = NULL, media_error_code = NULL, media_state_at = now(), updated_at = now() WHERE id = $1`, [assetId]);
    await query(
      `UPDATE watchfolder_items SET reason = left(COALESCE(reason, '') || '; the site did not encode it in time, so its original was sent and it is encoded in the cloud', 500) WHERE id = $1`, [it.id]);
    await writeAudit(null, {
      accountId: it.account_id, userId: null, label: 'Volt (cloud fallback)', action: 'update', entityType: 'vod_asset', entityId: assetId,
      snapshot: { title: it.title, siteFallback: { state: 'encoding', sourceKey, bytes, cloudJobId: jobId } },
    }).catch(() => {});
  } catch (e: any) {
    console.error('[site fallback] the original from the site could not be kept', assetId, e);
    const msg = `the original from the site could not be kept for the cloud encode: ${String(e?.message ?? e)}`.slice(0, 500);
    await setFallback(assetId, { state: 'failed', error: msg, failedAt: new Date().toISOString() }).catch(() => {});
    await query(`UPDATE vod_assets SET media_state = 'failed', media_error = $2, media_error_code = 'site_fallback_failed', media_state_at = now(), updated_at = now() WHERE id = $1`, [assetId, msg]).catch(() => {});
    await close().catch(() => {});
  }
}

/**
 * The agent could not send the original (it is no longer in the folder, or
 * cannot be read). The asset fails with the agent's reason; a person can
 * drop the file in again.
 */
export async function fallbackFailed(p: SitePrincipal, folderId: string, itemId: unknown, error: unknown) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const it = await one<any>(`SELECT id, vod_asset_id FROM watchfolder_items WHERE id = $1 AND watchfolder_id = $2`, [Number(itemId) || 0, f.id]);
  if (!it?.vod_asset_id) throw notFound('item not found');
  const msg = `the site could not send the original for the cloud encode: ${String(error ?? 'no reason given')}`.slice(0, 500);
  const done = await one<any>(
    `UPDATE vod_assets SET media_state = 'failed', media_error = $2, media_error_code = 'site_fallback_failed', media_state_at = now(),
            ingest = jsonb_set(ingest, '{siteFallback}', (ingest->'siteFallback') || jsonb_build_object('state', 'failed', 'error', $2::text, 'failedAt', now())),
            updated_at = now()
      WHERE id = $1 AND ingest->'siteFallback'->>'state' = ANY($3::text[]) RETURNING id`, [it.vod_asset_id, msg, WAITING_FOR_FILE]);
  if (!done) throw conflict('Volt is not waiting for this original');
  return { itemId: Number(it.id), vodAssetId: it.vod_asset_id, state: 'failed', error: msg };
}

/** While the original is asked for, nothing else may queue an encode for the asset (pipeline.ts queueEncodeFor). */
export function waitingForOriginal(ingest: any): boolean {
  return WAITING_FOR_FILE.includes(String(ingest?.siteFallback?.state ?? ''));
}
