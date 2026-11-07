// ============================================================================
//  MIRROR AND ARCHIVE: CLIPS AS A COPY SOURCE (build queue H3-9 (a),
//  HYBRID_SITES.md "Copy rules": "clips, optionally packaged outputs").
//
//  A copy rule can ask for `what: ['clips']`. For an asset cut from a
//  recording (a clip, a full-event replay, an export) each target then gets
//  the clip's file AS MADE (the MP4, or the M4A or MP3 of an audio clip,
//  byte for byte what clip.extract wrote) and its metadata file beside it:
//    `MorningNews-Channel1-20261103-0614.mp4`
//    `MorningNews-Channel1-20261103-0614.json`
//  named by the recordings rule (Title-Channel-YYYYMMDD-HHMM, sidecars.ts
//  clipBaseName). The metadata file says where the clip was cut from.
//
//  Same moments as originals: when the clip is made (`ingest`, called by
//  clip.extract once the file exists), when it is published, and nightly.
//  Same copy job as everything else: the agent fetches the one file, reads
//  it back, and the copy counts only when the checksum matches the file the
//  cloud made. The clip's own file is never removed by the archive.
//
//  Assets that are not clips (uploads, watch folder files) are skipped:
//  their original is `source`. A clip asked for only as HLS has no single
//  file; its package is a copy source of its own (H3-9 (b), not built yet).
// ============================================================================
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { one } from '../../db';
import { config } from '../../config';
import { ownedTarget, queueCopyJob } from './archive';
import { clipBaseName, clipFileOf, isClipAsset, ownedAsset, requestSidecarCopies } from './sidecars';
import { sha256File } from './recordings';

export const CLIP_WHAT = 'clip';
const code = (message: string, c: string) => Object.assign(new Error(message), { code: c });

/**
 * Where the clip's file is for the agent to fetch: on this server's disk,
 * or, on an S3 deployment once the ladder has removed the local copy, the
 * bucket copy clip.extract uploaded beside it. Null when neither is there.
 */
export function clipSourceUri(rel: string): { uri: string; local: boolean } | null {
  const local = join(config.clips.dir, rel);
  if (existsSync(local)) return { uri: local, local: true };
  if (config.mediaStore.driver === 's3' && process.env.CLIPS_S3_UPLOAD !== 'false') return { uri: `s3://${config.aws.s3Bucket}/clips/${rel}`, local: false };
  return null;
}

/**
 * Copy a clip's file and its metadata file to one target. One copy of each
 * per target: one verified or on its way is left alone; one that failed,
 * changed or went missing is copied afresh. Throws (with a code) when the
 * asset is not a clip or its file is not made yet; copyOnRule turns that
 * into a skip.
 */
export async function requestClipCopy(accountId: string, targetId: string, assetId: string, opts: { runAfter?: Date | null; userId?: string | null } = {}) {
  const t = await ownedTarget(accountId, targetId);
  if (t.status !== 'active') throw code('This storage target is disabled', 'target_disabled');
  if (t.site_status !== 'active') throw code('The site of this storage target is disabled', 'site_disabled');
  const a = await ownedAsset(accountId, assetId);
  if (!a) throw code('asset not found', 'not_found');
  if (!isClipAsset(a)) throw code('This asset is not a clip; its original is copied as "source"', 'not_a_clip');
  const file = clipFileOf(a);
  if (!file) throw code('This clip has no file yet (still being made, failed, or made as HLS only)', 'clip_not_made');
  const src = clipSourceUri(file.rel);
  if (!src) throw code('The clip\'s file is not on this server', 'clip_not_made');

  const queued: string[] = [], kept: string[] = [];
  const existing = await one<any>(
    `SELECT c.id, c.state, j.state AS job_state FROM archive_copies c LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.target_id = $1 AND c.vod_asset_id = $2 AND c.what = $3`, [t.id, a.id, CLIP_WHAT]);
  if (existing && (existing.state === 'verified' || (existing.state === 'queued' && ['queued', 'running'].includes(existing.job_state)))) {
    kept.push(existing.id);
  } else {
    const fileName = `${await clipBaseName(a)}.${file.ext}`;
    // The checksum of the file the cloud made: the copy counts only when the
    // target reads back the same. A bucket copy is checked against its size
    // and the bytes downloaded (as an S3 original is).
    const facts = src.local ? { bytes: statSync(src.uri).size, sha256: await sha256File(src.uri) } : { bytes: null, sha256: null };
    const row = await one<any>(
      `INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, expected_sha256, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT id FROM users WHERE id = $8))
       ON CONFLICT (target_id, vod_asset_id, what) DO UPDATE
         SET source_uri = EXCLUDED.source_uri, file_name = EXCLUDED.file_name, expected_sha256 = EXCLUDED.expected_sha256,
             state = 'queued', stored_path = NULL, sha256 = NULL, bytes = NULL, error = NULL, error_code = NULL,
             copied_at = NULL, verified_at = NULL, checked_at = NULL, verify_job_id = NULL, updated_at = now()
       RETURNING id`,
      [accountId, t.id, a.id, CLIP_WHAT, src.uri, fileName, facts.sha256, opts.userId ?? null]);
    await queueCopyJob(t, row.id, { fileName, uri: src.uri, bytes: facts.bytes, sha256: facts.sha256 }, opts.userId ?? null, opts.runAfter ?? null);
    queued.push(row.id);
  }
  // Its sidecar: the metadata file, named after the clip. Shared with a
  // "sidecars" copy of the same asset (one metadata row per target).
  const side = await requestSidecarCopies(accountId, t.id, a.id, { runAfter: opts.runAfter ?? null, userId: opts.userId ?? null, only: ['metadata'] });
  return { queued: [...queued, ...side.queued], kept: [...kept, ...side.kept] };
}

/**
 * The clip's file exists (clip.extract): run the copy rules' `ingest`
 * moment for it, as an upload's landing does. Never throws.
 */
export async function copyClipOnReady(assetId: string): Promise<void> {
  try {
    const { assetAccount } = await import('../availability');
    const found = await assetAccount(assetId);
    if (!found) return;
    const { copyOnRule } = await import('./archive');
    await copyOnRule(found.accountId, assetId, 'ingest');
  } catch (e: any) {
    console.warn(`[archive] copy rules for clip ${assetId} not applied:`, e?.message ?? e);
  }
}
