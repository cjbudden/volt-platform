// ============================================================================
//  HYBRID SITES 2: ON-PREM WATCHFOLDERS, UPLOAD TO THE CLOUD (build queue H2,
//  HYBRID_SITES.md "The on-prem flow").
//
//  A `site` watchfolder is on a customer's storage. The site agent there walks
//  it and decides each file with the SAME scanner.ts and rules.ts the cloud
//  runs (it is compiled from these files, not a copy of them), so the dry run
//  in the console and the decision at the site cannot drift apart. The cloud
//  keeps everything else exactly as for a local folder: the folder, its
//  ordered rules, and the queue in watchfolder_items, so the console's review
//  queue, counts and dismiss work unchanged.
//
//  WHAT THE AGENT DOES, AND WHAT IT ASKS
//    1. Pulls its folders and their rules (foldersForSite).
//    2. Scans with the quiet-file rule; a refused file is moved to the review
//       folder ON SITE (it never leaves the customer's network) and reported.
//    3. An accepted file is reported; the cloud classifies it again with its
//       own copy of the rules and records the cloud's answer. If the rules
//       changed in between, the report is refused with `rules_changed` and the
//       agent decides the file again next pass with the new rules.
//    4. Placement 'upload_cloud': the agent uploads the accepted file with tus
//       (modules/siteTus.ts). The upload is opened FOR THE ITEM and kept on
//       it, so an agent that restarts, or loses its state file, resumes the
//       same upload rather than sending the file again. When the last byte
//       lands, the normal upload path runs (ingest rules, duplicate check,
//       metadata, the VOD encode or Loops & Fillers) and the item closes.
//    5. Reprocess in the console cannot move a file on the customer's storage,
//       so it marks the item `site_action = 'return'`; the agent moves the
//       file back out of the review folder and reports it.
//
//  IMAGES, SLATES AND COMPANIONS (build queue H2b-5) cross the same way: the
//  agent uploads them on the same tus path, opened for the item. The copy
//  lands in the folder's staging root on this server (siteStagingRoot, like
//  an S3 folder's mirror) and is then taken in by the SAME passes a local
//  drop uses (ingest.ts, slateIngest.ts, companionIngest.ts, imageAttach.ts),
//  only over files that have landed. A caption that arrives before its video
//  waits there; the pass runs again after every agent pass, so it attaches
//  when the video lands. A companion sent to review is moved into the review
//  folder AT THE SITE by the agent (`site_action = 'review'`), never here.
//  Audio is a Media Library target like video, so it crosses with it.
//
//  PLACEMENT 'encode_site' (build queue H4-3): a video or audio file the
//  folder accepts is REGISTERED, not uploaded. The agent sends its facts
//  (size, checksum, the start of the file and the probe the site's encoder
//  gave) and the cloud runs the same ingest as an upload (rules, naming,
//  duplicate check, metadata, holds) on those facts, creates the asset, keeps
//  the original's place at the site on it (`ingest.siteSource`) and queues the
//  encode at that site (siteEncode.ts). The original never crosses; only the
//  package does. Images, slates, companions and loops in such a folder still
//  upload as above: they are small, and Volt keeps them itself.
//
//  A HOST WAITING FOR APPROVAL DOES NO WORK: every route here refuses it.
// ============================================================================
import { mkdir, rename, copyFile, unlink, stat } from 'node:fs/promises';
import { join, sep, extname } from 'node:path';
import { query, one } from '../../db';
import { ApiError, notFound, conflict, badRequest } from '../../util/http';
import { pgItemStore, toScanFolder, siteStagingRoot } from '../watchfolder/store';
import { classify, quarantineKey } from '../watchfolder/rules';
import { videoTargetFor, videoTargetKinds, videoTypeOf } from '../watchfolder/videoIngest';
import { libraryKindFor, ingestableTargetKinds, DEFAULT_MAX_INGEST_BYTES } from '../watchfolder/ingest';
import { isSlateTarget, slateTargetKinds, SLATE_MAX_BYTES } from '../watchfolder/slateIngest';
import { isCompanionTarget, companionTargetKinds, COMPANION_MAX_BYTES } from '../watchfolder/companionIngest';
import type { SitePrincipal } from './sites';

export const PLACEMENTS = ['upload_cloud', 'encode_site'] as const;
export type Placement = typeof PLACEMENTS[number];
/** Placements a folder may be given today (Encode at site since H4-3). */
export const PLACEMENTS_BUILT: readonly Placement[] = ['upload_cloud', 'encode_site'];

/** In an Encode at site folder, is this accepted file registered (encoded at the site) rather than uploaded? */
export function registersAtSite(placement: string | null | undefined, targetKind: string | null | undefined): boolean {
  return placement === 'encode_site' && siteTargetFor(targetKind) === 'vod';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an accepted site file becomes on this side: a Media Library or Loops &
 * Fillers upload (video and audio, the upload path), or a FILE taken in by the
 * local-drop passes once its copy lands (images, slates, companions).
 */
export function siteTargetFor(targetKind?: string | null): 'vod' | 'loop' | 'file' | null {
  const v = videoTargetFor(targetKind);
  if (v) return v;
  if (libraryKindFor(targetKind) || isSlateTarget(targetKind) || isCompanionTarget(targetKind)) return 'file';
  return null;
}
export function siteTargetKinds(): string[] {
  return [...videoTargetKinds(), ...ingestableTargetKinds(), ...slateTargetKinds(), ...companionTargetKinds()];
}

/** The type an upload records, from the name: video, or audio for an audio asset (H2b-4). */
export function mediaTypeOf(name: string): string {
  const audio: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };
  return audio[extname(name).toLowerCase()] ?? videoTypeOf(name);
}

/**
 * The most a file of this target may weigh, with the words the local passes
 * use when they refuse it, so a 2 GB TIFF is refused at the decision instead
 * of after crossing the customer's line. Null: no ceiling here (video).
 */
function ceilingFor(targetKind: string, folderConfig: any): { max: number; companion: boolean } | null {
  if (isCompanionTarget(targetKind)) return { max: COMPANION_MAX_BYTES, companion: true };
  if (isSlateTarget(targetKind)) return { max: SLATE_MAX_BYTES, companion: false };
  if (libraryKindFor(targetKind)) return { max: Number(folderConfig?.max_ingest_bytes ?? DEFAULT_MAX_INGEST_BYTES), companion: false };
  return null;
}

/** A pending host may heartbeat and read config, nothing more. */
export function requireApprovedHost(p: SitePrincipal) {
  if (p.hostStatus !== 'approved') {
    throw Object.assign(new ApiError(403, 'This host is waiting for approval in Admin, Sites'), { code: 'waiting_for_approval' });
  }
}

/** One of THIS site's folders, or 404: a credential never reaches another site's or account's folder. */
export async function siteFolder(p: SitePrincipal, id: string) {
  if (!UUID.test(String(id))) throw notFound('watchfolder not found');
  const f = await one<any>(
    `SELECT * FROM watchfolders WHERE id = $1 AND account_id = $2 AND kind = 'site' AND site_id = $3`,
    [id, p.accountId, p.siteId]);
  if (!f) throw notFound('watchfolder not found');
  return f;
}

/** What the agent runs: the site's enabled folders, each as the scanner takes it, with its placement. */
export async function foldersForSite(p: SitePrincipal) {
  const rows = await query<any>(
    `SELECT * FROM watchfolders WHERE account_id = $1 AND kind = 'site' AND site_id = $2 AND enabled ORDER BY created_at`,
    [p.accountId, p.siteId]);
  const out = [];
  for (const f of rows) {
    const path = String(f.config?.path ?? '');
    if (!path) continue;
    const sf = await toScanFolder(f, path);
    out.push({ ...sf, name: f.name, placement: (f.placement ?? 'upload_cloud') as Placement });
  }
  return out;
}

/** A key relative to the watched root, with no way out of it. */
function relKey(v: unknown, what: string): string {
  const s = String(v ?? '').replace(/\\/g, '/');
  if (!s || s.length > 1024 || s.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(s) || /[\u0000-\u001f]/.test(s)) {
    throw badRequest(`${what} must be a path inside the watched folder`);
  }
  return s;
}

export interface DecisionReport {
  objectKey: string; checksum: string; sizeBytes: number;
  status: 'seen' | 'quarantined';
  reason?: string | null; matchedRuleId?: string | null; quarantineKey?: string | null;
}

/**
 * The agent reports one decision. A refusal is recorded as it happened (the
 * file is already in the review folder at the site). An acceptance is decided
 * again here with the cloud's rules, and the cloud's answer is what is kept.
 */
export async function recordDecision(p: SitePrincipal, folderId: string, raw: any) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const objectKey = relKey(raw?.objectKey, 'objectKey');
  const checksum = String(raw?.checksum ?? '');
  if (!/^[0-9a-f]{64}$/i.test(checksum)) throw badRequest('checksum must be the SHA-256 of the file, in hex');
  const sizeBytes = Number(raw?.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw badRequest('sizeBytes must be a whole number of bytes');
  const status = raw?.status;
  if (status !== 'seen' && status !== 'quarantined') throw badRequest('status must be seen or quarantined');

  if (status === 'quarantined') {
    const quarantineKey = relKey(raw?.quarantineKey, 'quarantineKey');
    await pgItemStore.record(f.id, f.account_id, {
      objectKey, checksum, sizeBytes, status: 'quarantined',
      reason: String(raw?.reason ?? 'refused at the site').slice(0, 500),
      matchedRuleId: UUID.test(String(raw?.matchedRuleId ?? '')) ? raw.matchedRuleId : null,
      quarantineKey,
    });
  } else {
    const sf = await toScanFolder(f, String(f.config?.path ?? ''));
    const d = classify(objectKey, sizeBytes, sf.rules, sf.policy);
    if (d.decision !== 'accept') {
      throw Object.assign(new ApiError(409, `The folder's rules changed: this file is now refused (${d.reason}). Decide it again with the current rules.`), { code: 'rules_changed' });
    }
    await pgItemStore.record(f.id, f.account_id, {
      objectKey, checksum, sizeBytes, status: 'seen',
      targetKind: d.targetKind, workflow: d.workflow, matchedRuleId: d.ruleId,
    });
    // A FILE OVER ITS TARGET'S CEILING is refused now, before it crosses the
    // customer's line, with the words the local passes would use: an image
    // or slate fails, a companion goes to review at the site.
    const cap = ceilingFor(String(d.targetKind ?? '').toLowerCase().trim(), f.config);
    if (cap && sizeBytes > cap.max) {
      const item = await one<any>(
        `SELECT id FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2 AND checksum = $3 AND status = 'seen'`,
        [f.id, objectKey, checksum]);
      const name = objectKey.split('/').pop();
      if (item && cap.companion) {
        await sendToReviewAtSite(f, Number(item.id), objectKey,
          `${name} is ${(sizeBytes / 1024 / 1024).toFixed(0)} MB, over the ${COMPANION_MAX_BYTES / 1024 / 1024} MB limit for companion files`);
      } else if (item) {
        await query(`UPDATE watchfolder_items SET status = 'failed', resolved_at = now(), reason = $2 WHERE id = $1 AND status = 'seen'`,
          [item.id, `file is ${sizeBytes} bytes, over the ${cap.max} byte ingest ceiling for this folder; it was not uploaded from the site`]);
      }
    }
  }
  const row = await one<any>(
    `SELECT id, status, target_kind, reason, quarantine_key FROM watchfolder_items
      WHERE watchfolder_id = $1 AND object_key = $2 AND checksum = $3`, [f.id, objectKey, checksum]);
  return { itemId: Number(row.id), status: row.status, targetKind: row.target_kind, reason: row.reason, quarantineKey: row.quarantine_key };
}

/** Is this exact content at this key already dealt with? (the scanner's own question) */
export async function isKnown(p: SitePrincipal, folderId: string, objectKey: unknown, checksum: unknown) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const key = relKey(objectKey, 'objectKey');
  if (await pgItemStore.isKnown(f.id, key, String(checksum ?? ''))) return true;
  const sum = String(checksum ?? '').toLowerCase();
  // VOLT'S OWN INGEST SIDECAR (H4-7): the agent wrote it beside an original
  // registered from this folder. With the exact text Volt made it is not a new
  // drop (the companion rule would otherwise attach it to its own video); a
  // file edited since is decided like any other.
  return !!(await one<any>(
    `SELECT 1 AS x FROM watchfolder_items i JOIN vod_assets a ON a.id = i.vod_asset_id
      WHERE i.watchfolder_id = $1 AND a.ingest->'siteSidecar'->>'name' = $2 AND a.ingest->'siteSidecar'->>'sha256' = $3 LIMIT 1`,
    [f.id, key, sum]));
}

export async function quarantineKeysInUse(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  return [...await pgItemStore.quarantineKeysInUse(f.id)];
}

/**
 * Accepted files still to be uploaded, oldest first, with the upload already
 * opened for each (and how far it got), so a restarted agent resumes. A file
 * whose upload has landed and is waiting here (a caption waiting for its
 * video) is not asked for again.
 */
export async function pendingUploads(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  // An Encode at site folder uploads everything except what it registers.
  const kinds = (f.placement ?? 'upload_cloud') === 'encode_site'
    ? siteTargetKinds().filter((k) => !registersAtSite('encode_site', k)) : siteTargetKinds();
  const rows = await query<any>(
    `SELECT i.id, i.object_key, i.checksum, i.size_bytes, i.target_kind,
            u.id AS upload_id, u.state AS upload_state, u.received_bytes
       FROM watchfolder_items i
       LEFT JOIN upload_sessions u ON u.id = i.upload_session_id
      WHERE i.watchfolder_id = $1 AND i.status = 'seen' AND i.site_action IS NULL
        AND lower(i.target_kind) = ANY($2::text[])
        AND (u.id IS NULL OR u.state <> 'complete')
      ORDER BY i.seen_at LIMIT 50`, [f.id, kinds]);
  return rows.map((r) => ({
    itemId: Number(r.id), objectKey: r.object_key, checksum: r.checksum, sizeBytes: Number(r.size_bytes),
    targetKind: r.target_kind,
    upload: r.upload_id && r.upload_state === 'open'
      ? { id: r.upload_id, offset: Number(r.received_bytes ?? 0), url: `/api/site-agent/tus/${r.upload_id}` }
      : null,
  }));
}

/** Refused files an operator sent back: the agent moves each out of the review folder. */
export async function pendingReturns(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const rows = await query<any>(
    `SELECT id, object_key, quarantine_key FROM watchfolder_items
      WHERE watchfolder_id = $1 AND site_action = 'return' ORDER BY resolved_at LIMIT 200`, [f.id]);
  return rows.map((r) => ({ itemId: Number(r.id), objectKey: r.object_key, quarantineKey: r.quarantine_key }));
}

/**
 * SENT TO REVIEW HERE, MOVED AT THE SITE (H2b-5). A companion this side
 * cannot attach (too big, no video in 24 hours, a caption Volt cannot read)
 * goes to Needs review as a local one does, but its file is on the
 * customer's storage: the row names the review key and asks the agent to
 * move it there (`site_action = 'review'`). The copy here is removed.
 */
export async function sendToReviewAtSite(f: { id: string; quarantine_path?: string | null }, itemId: number, objectKey: string, reason: string): Promise<string> {
  const inUse = await pgItemStore.quarantineKeysInUse(f.id);
  const root = String(f.quarantine_path || '_review').replace(/^\/+|\/+$/g, '');
  const qKey = quarantineKey(root, objectKey, inUse);
  await query(
    `UPDATE watchfolder_items SET status = 'quarantined', reason = $2, quarantine_key = $3, resolved_at = NULL, site_action = 'review'
      WHERE id = $1`, [itemId, reason.slice(0, 500), qKey]);
  await unlink(stagedPath(f.id, objectKey)).catch(() => { /* never landed, or already gone */ });
  return qKey;
}

/** Files to move into the review folder at the site. */
export async function pendingReviews(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const rows = await query<any>(
    `SELECT id, object_key, quarantine_key FROM watchfolder_items
      WHERE watchfolder_id = $1 AND site_action = 'review' ORDER BY seen_at LIMIT 200`, [f.id]);
  return rows.map((r) => ({ itemId: Number(r.id), objectKey: r.object_key, quarantineKey: r.quarantine_key }));
}

/** The agent moved a file into the review folder (or could not, and says why). */
export async function reviewed(p: SitePrincipal, folderId: string, itemId: unknown, ok: boolean, error?: string | null) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const id = Number(itemId);
  if (!Number.isSafeInteger(id)) throw notFound('item not found');
  // Either way the row stays in Needs review: a file that could not be moved
  // (someone took it away) is still one a person has to look at, and the
  // note says it is not where the row says.
  const r = await one<any>(
    `UPDATE watchfolder_items SET site_action = NULL,
            resolution_note = CASE WHEN $3::boolean THEN resolution_note ELSE $4 END
      WHERE id = $1 AND watchfolder_id = $2 AND site_action = 'review' RETURNING id, status`,
    [id, f.id, ok, `the site agent could not move it to the review folder: ${String(error ?? 'unknown error')}`.slice(0, 500)]);
  if (!r) throw notFound('item not found, or not waiting to be moved to review');
  return { itemId: id, status: r.status };
}

/** The agent moved a file back (or could not): the row says which. */
export async function returned(p: SitePrincipal, folderId: string, itemId: unknown, ok: boolean, error?: string | null) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const id = Number(itemId);
  if (!Number.isSafeInteger(id)) throw notFound('item not found');
  const r = ok
    ? await one<any>(
        `UPDATE watchfolder_items SET site_action = NULL WHERE id = $1 AND watchfolder_id = $2 AND site_action = 'return' RETURNING id, status`, [id, f.id])
    // THE FILE COULD NOT BE PUT BACK (someone moved it, the share is read-only):
    // the row goes back to Needs review with the reason, rather than saying a
    // file will be looked at again that is not in the drop.
    : await one<any>(
        `UPDATE watchfolder_items SET site_action = NULL, status = 'quarantined',
                resolution_note = $3
          WHERE id = $1 AND watchfolder_id = $2 AND site_action = 'return' RETURNING id, status`,
        [id, f.id, `the site agent could not move it back: ${String(error ?? 'unknown error')}`.slice(0, 500)]);
  if (!r) throw notFound('item not found, or not waiting to be moved back');
  return { itemId: id, status: r.status };
}

/**
 * The agent's pass over one folder: when, and whether it failed. Shown on the
 * folder page. Each pass also runs the folder's ingest again, so a caption or
 * typed image waiting for its video attaches once the video has landed, and
 * one waiting a day goes to review, with no scheduler of its own.
 */
export async function scanReport(p: SitePrincipal, folderId: string, error: unknown) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const msg = error ? String(error).slice(0, 500) : null;
  await query(`UPDATE watchfolders SET last_scan_at = now(), last_scan_error = $2 WHERE id = $1`, [f.id, msg]);
  await ingestSiteFolder(f.id).catch((e) => console.warn('[site watch] ingest after a pass failed', f.id, e?.message ?? e));
  return { ok: true };
}

/**
 * The item an upload is opened for, checked: this site's folder, accepted,
 * video, and the size the agent reported. Returns the open upload when there
 * is one already, so a second create resumes rather than starts again.
 */
export async function itemForUpload(p: SitePrincipal, itemId: unknown, length: number) {
  requireApprovedHost(p);
  const id = Number(itemId);
  if (!Number.isSafeInteger(id)) throw badRequest('Upload-Metadata must carry the itemId this file was accepted as');
  const r = await one<any>(
    `SELECT i.*, w.ladder_group_id, w.placement, u.state AS upload_state
       FROM watchfolder_items i
       JOIN watchfolders w ON w.id = i.watchfolder_id
       LEFT JOIN upload_sessions u ON u.id = i.upload_session_id
      WHERE i.id = $1 AND w.account_id = $2 AND w.kind = 'site' AND w.site_id = $3`, [id, p.accountId, p.siteId]);
  if (!r) throw notFound('item not found');
  if (registersAtSite(r.placement, r.target_kind)) throw conflict('This folder encodes at the site; its video and audio files are registered, not uploaded');
  if (r.status !== 'seen') throw conflict(`This file is ${r.status === 'ingested' ? 'already in the library' : r.status}; there is nothing to upload`);
  const target = siteTargetFor(r.target_kind);
  if (!target) throw conflict(`"${r.target_kind}" is not something a site uploads`);
  if (r.upload_state === 'complete') throw conflict('This file has been uploaded already and is waiting to be taken in');
  if (Number(r.size_bytes) !== length) throw conflict(`The file is ${length} bytes now and was ${r.size_bytes} when it was accepted; it has changed, so it will be decided again as a new file`);
  return {
    item: r, target,
    existingUpload: r.upload_session_id && r.upload_state === 'open' ? String(r.upload_session_id) : null,
    contentType: mediaTypeOf(String(r.object_key)),
  };
}

/** Keep the upload on the item; if another create won the race, say which upload is the item's. */
export async function attachUpload(itemId: number, uploadId: string): Promise<string> {
  const won = await one<any>(
    `UPDATE watchfolder_items SET upload_session_id = $2
      WHERE id = $1 AND (upload_session_id IS NULL OR upload_session_id NOT IN (SELECT id FROM upload_sessions WHERE state = 'open'))
      RETURNING upload_session_id`, [itemId, uploadId]);
  if (won) return uploadId;
  const cur = await one<any>(`SELECT upload_session_id FROM watchfolder_items WHERE id = $1`, [itemId]);
  return String(cur?.upload_session_id ?? uploadId);
}

/**
 * The last byte landed and the normal upload path has run (ingest rules, the
 * encode or Loops & Fillers). Close the item the way a local drop closes.
 */
export async function closeUploadedItem(uploadId: string) {
  const s = await one<any>(`SELECT id, vod_asset_id, filler_asset_id, error FROM upload_sessions WHERE id = $1`, [uploadId]);
  if (!s) return;
  let note: string;
  if (s.vod_asset_id) {
    // A site drop is a watchfolder drop, whatever carried the bytes.
    await query(`UPDATE vod_assets SET source_kind = 'watchfolder' WHERE id = $1 AND source_kind = 'upload'`, [s.vod_asset_id]);
    const a = await one<any>(`SELECT title, encode_job_id, ingest FROM vod_assets WHERE id = $1`, [s.vod_asset_id]);
    const st = String(a?.ingest?.status ?? 'ingested');
    note = a?.encode_job_id
      ? `uploaded from the site; in the Media Library as "${a?.title ?? ''}", queued for encoding${st === 'awaiting_metadata' ? ' (waiting for required metadata before it is ingested)' : ''}`
      : `uploaded from the site; in the Media Library as "${a?.title ?? ''}", held by the ingest rules (${st.replace(/_/g, ' ')})`;
  } else if (s.filler_asset_id) {
    note = 'uploaded from the site; in Loops & Fillers';
  } else {
    note = 'uploaded from the site';
  }
  await query(
    `UPDATE watchfolder_items SET status = 'ingested', resolved_at = now(), vod_asset_id = $2, reason = $3
      WHERE upload_session_id = $1 AND status = 'seen'`,
    [uploadId, s.vod_asset_id ?? null, note.slice(0, 500)]);
}

/* ----------------------------------------- images and companions (H2b-5) */

/** Where an item's uploaded copy waits on this server. */
export function stagedPath(folderId: string, objectKey: string): string {
  return join(siteStagingRoot(folderId), ...objectKey.split('/'));
}

/**
 * The last byte of an image, slate or companion landed. Check it is the file
 * that was accepted (its SHA-256), put the copy where the folder's ingest
 * reads it, close the upload and take it in now. Never throws: the bytes
 * are a copy, and the original is still at the site.
 */
export async function landSiteFile(uploadId: string, dataPath: string, sha: string): Promise<void> {
  const s = await one<any>(`SELECT id, state FROM upload_sessions WHERE id = $1`, [uploadId]);
  if (!s || s.state === 'complete') return;
  const it = await one<any>(
    `SELECT i.id, i.object_key, i.checksum, i.watchfolder_id FROM watchfolder_items i WHERE i.upload_session_id = $1`, [uploadId]);
  const { removeStaged } = await import('../uploadStaging');
  const close = async () => {
    await query(`UPDATE upload_sessions SET state = 'complete', error = NULL, updated_at = now() WHERE id = $1`, [uploadId]);
    await removeStaged(uploadId).catch(() => 0);
  };
  if (!it) { await close(); return; }
  if (it.checksum && sha !== it.checksum) {
    // Same rule as every other path: the row describes the file as it was
    // classified. Changed content is a new item on the next pass.
    await query(`UPDATE watchfolder_items SET status = 'failed', resolved_at = now(), reason = $2 WHERE id = $1 AND status = 'seen'`,
      [it.id, `the file changed while it was uploading (was ${String(it.checksum).slice(0, 12)}, arrived ${sha.slice(0, 12)}); the new content will be picked up as a new item`]);
    await close();
    return;
  }
  const dest = stagedPath(it.watchfolder_id, it.object_key);
  await mkdir(join(dest, '..'), { recursive: true });
  try { await rename(dataPath, dest); }
  catch { await copyFile(dataPath, dest); await unlink(dataPath).catch(() => {}); }
  await close();
  await ingestSiteFolder(it.watchfolder_id).catch((e) => console.warn('[site watch] ingest after an upload failed', it.watchfolder_id, e?.message ?? e));
}

/**
 * Take in what has landed for one site folder, with the local-drop passes:
 * images to the Image Library, slates to Loops & Fillers, companions to their
 * video, typed images to their asset. Only files whose upload completed are
 * considered.
 *
 * A COPY THAT IS NOT ON THIS SERVER IS ASKED FOR AGAIN. On AWS the upload may
 * have landed on another task, or the disk was replaced: the upload is taken
 * off the item, so the agent sends the file again on its next pass, rather
 * than the item failing for a file the site still has.
 */
export async function ingestSiteFolder(folderId: string) {
  const S = await import('../watchfolder/store');
  const { ingestPending } = await import('../watchfolder/ingest');
  const { ingestSlateItem } = await import('../watchfolder/slateIngest');
  const { ingestCompanions } = await import('../watchfolder/companionIngest');
  const { attachTypedImages } = await import('../watchfolder/imageAttach');
  const f = await S.loadIngestFolder(folderId, true);
  if (!f) return null;

  const landed = await query<any>(
    `SELECT i.id, i.object_key FROM watchfolder_items i JOIN upload_sessions u ON u.id = i.upload_session_id
      WHERE i.watchfolder_id = $1 AND i.status = 'seen' AND u.state = 'complete' AND lower(i.target_kind) = ANY($2::text[])`,
    [folderId, [...ingestableTargetKinds(), ...slateTargetKinds(), ...companionTargetKinds()]]);
  let requeued = 0;
  for (const r of landed) {
    if (!(await stat(stagedPath(folderId, r.object_key)).catch(() => null))) {
      await query(`UPDATE watchfolder_items SET upload_session_id = NULL WHERE id = $1 AND status = 'seen'`, [r.id]);
      requeued++;
    }
  }

  const images = await S.pendingItems(folderId, 200, ingestableTargetKinds(), true);
  const summary = await ingestPending(f, images, S.pgIngestStore);
  let slates = 0;
  for (const item of await S.pendingItems(folderId, 200, slateTargetKinds(), true)) {
    const o = await ingestSlateItem(f, item, S.pgSlateStore);
    if (o.result === 'slate') slates++;
  }
  const q = await one<any>(`SELECT quarantine_path FROM watchfolders WHERE id = $1`, [folderId]);
  const siteCompanions = { ...S.pgCompanionStore,
    toReview: (cf: any, item: any, reason: string) => sendToReviewAtSite({ id: cf.id, quarantine_path: cf.quarantinePath }, Number(item.id), item.objectKey, reason) };
  const companions = await ingestCompanions(
    { id: f.id, accountId: f.accountId, path: f.path, quarantinePath: q?.quarantine_path || '_review', deleteAfterIngest: true },
    await S.pendingCompanionItems(folderId, 200, true), siteCompanions);
  const typed = await attachTypedImages({ id: f.id, accountId: f.accountId }, await S.waitingTypedImages(folderId, f.imageTypes ?? []), S.pgImageAttachStore);

  // A copy that will not be taken in (failed) is not kept: the site has the original.
  for (const o of [...summary.outcomes, ...companions]) {
    if (o.result !== 'failed') continue;
    const key = [...images, ...landed.map((r) => ({ id: r.id, objectKey: r.object_key }))].find((x) => String(x.id) === String(o.itemId))?.objectKey;
    if (key) await unlink(stagedPath(folderId, key)).catch(() => {});
  }
  return {
    requeued, ingested: summary.ingested, failed: summary.failed, slates,
    attached: companions.filter((o) => o.result === 'attached').length,
    waiting: companions.filter((o) => o.result === 'waiting').length,
    review: companions.filter((o) => o.result === 'review').length,
    typed: typed.filter((o) => o.result === 'typed').length,
  };
}

/* ------------------------------------ Encode at site: registration (H4-3) */

/** The most of the file's start the agent sends: enough to sniff the type and read an ID3 tag without cover art. */
export const SITE_HEAD_MAX_BYTES = 192 * 1024;

/**
 * Accepted video and audio files of an Encode at site folder that are not
 * registered yet, oldest first.
 */
export async function pendingRegistrations(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  if ((f.placement ?? 'upload_cloud') !== 'encode_site') return [];
  const rows = await query<any>(
    `SELECT id, object_key, checksum, size_bytes, target_kind FROM watchfolder_items
      WHERE watchfolder_id = $1 AND status = 'seen' AND site_action IS NULL AND vod_asset_id IS NULL
        AND lower(target_kind) = ANY($2::text[])
      ORDER BY seen_at LIMIT 50`, [f.id, siteTargetKinds().filter((k) => registersAtSite('encode_site', k))]);
  return rows.map((r) => ({ itemId: Number(r.id), objectKey: r.object_key, checksum: r.checksum, sizeBytes: Number(r.size_bytes), targetKind: r.target_kind }));
}

/** The original's absolute path at the site: the folder's path and the key, as the agent joins them. */
export function sitePathOf(folderPath: string, objectKey: string): string {
  const root = String(folderPath).replace(/[\\/]+$/, '');
  const winLike = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  return root + (winLike ? '\\' : '/') + objectKey.split('/').join(winLike ? '\\' : '/');
}

/**
 * REGISTER ONE FILE (HYBRID_SITES.md "The on-prem flow", step 2). The file
 * stays at the site. The asset is made as for an upload from this folder and
 * the same ingest runs on the facts the agent sent; then, unless the rules
 * held it as a duplicate or refused it, the encode is queued at the site and
 * the asset reads Processing until the package is verified.
 *
 * Registering twice returns the first registration: the item keeps the asset
 * it was registered as, and a second asset made by a racing call is removed.
 */
export async function registerSiteItem(p: SitePrincipal, folderId: string, itemId: unknown, raw: any) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const id = Number(itemId);
  if (!Number.isSafeInteger(id)) throw notFound('item not found');
  const it = await one<any>(`SELECT * FROM watchfolder_items WHERE id = $1 AND watchfolder_id = $2`, [id, f.id]);
  if (!it) throw notFound('item not found');
  if (it.vod_asset_id) return registrationOf(it);
  if ((f.placement ?? 'upload_cloud') !== 'encode_site') throw conflict('This folder uploads its files; nothing is registered');
  if (!registersAtSite('encode_site', it.target_kind)) throw conflict(`"${it.target_kind}" is uploaded from the site, not registered`);
  if (it.status !== 'seen') throw conflict(`This file is ${it.status}; there is nothing to register`);
  if (it.site_action) throw conflict('This file is waiting for the site agent to move it');
  // THE ROW DESCRIBES THE FILE AS IT WAS CLASSIFIED, as for an upload: changed
  // content is a new item on the next pass, never registered under this one.
  if (Number(raw?.sizeBytes) !== Number(it.size_bytes) || String(raw?.checksum ?? '').toLowerCase() !== String(it.checksum).toLowerCase()) {
    throw conflict(`The file has changed since it was accepted (it was ${it.size_bytes} bytes, ${String(it.checksum).slice(0, 12)}); it will be decided again as a new file`);
  }
  let head: Buffer;
  try { head = Buffer.from(String(raw?.head ?? ''), 'base64'); } catch { throw badRequest('head must be the start of the file in base64'); }
  if (!head.length && Number(it.size_bytes) > 0) throw badRequest('head must be the start of the file in base64');
  if (head.length > SITE_HEAD_MAX_BYTES) throw badRequest(`head is limited to ${SITE_HEAD_MAX_BYTES} bytes`);
  const probe = raw?.probe && typeof raw.probe === 'object' && !Array.isArray(raw.probe) && JSON.stringify(raw.probe).length <= 32 * 1024 ? raw.probe : null;

  const name = String(it.object_key).split('/').pop() || 'file';
  const sitePath = sitePathOf(String(f.config?.path ?? ''), String(it.object_key));
  const created = await one<any>(
    `INSERT INTO vod_assets
       (account_id, source_kind, kind, title, source_bytes, ladder_group_id,
        start_epoch_ms, end_epoch_ms, duration_ms, thumb_status, rights_profile_id, rights_set_by)
     VALUES ($1,'watchfolder','clip',$2,$3,$4,0,0,0,'processing',
             (SELECT id FROM rights_profiles WHERE id = $5 AND account_id = $1), CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'watchfolder' END)
     RETURNING id`,
    [f.account_id, name.replace(/\.[^.]+$/, '').slice(0, 200), Number(it.size_bytes), f.ladder_group_id ?? null, f.rights_profile_id ?? null]);
  const won = await one<any>(
    `UPDATE watchfolder_items SET vod_asset_id = $2 WHERE id = $1 AND vod_asset_id IS NULL AND status = 'seen' RETURNING id`, [id, created.id]);
  if (!won) {
    await query(`DELETE FROM vod_assets WHERE id = $1`, [created.id]);
    const again = await one<any>(`SELECT * FROM watchfolder_items WHERE id = $1`, [id]);
    if (again?.vod_asset_id) return registrationOf(again);
    throw conflict('This file was dealt with while it was being registered');
  }
  const assetId = String(created.id);

  let status = 'ingested';
  try {
    const { ingestLanded } = await import('../ingest/pipeline');
    const out = await ingestLanded({
      accountId: f.account_id, assetId, path: sitePath, originalName: name, relativePath: it.object_key,
      bytes: Number(it.size_bytes), sha256: String(it.checksum).toLowerCase(), declaredMime: mediaTypeOf(name),
      source: f.id, sessionId: null, uploadedBy: null,
      atSite: { siteId: p.siteId, folderId: f.id, itemId: id, sitePath, objectKey: it.object_key, head, probe },
    });
    status = out.status;
  } catch (e: any) {
    // The same contract as an upload: rules that cannot run are recorded, the
    // file is not lost over them. The place at the site is still recorded so
    // the encode can find it.
    console.warn('[site watch] ingest rules could not run for a registration', assetId, e?.message ?? e);
    await query(
      `UPDATE vod_assets SET original_filename = $2, original_path = $3, sha256 = $4,
              ingest = COALESCE(ingest, '{}'::jsonb) || $5::jsonb, updated_at = now() WHERE id = $1`,
      [assetId, name, it.object_key, String(it.checksum).toLowerCase(),
       JSON.stringify({ status: 'ingested', error: `ingest rules could not run: ${String(e?.message ?? e)}`.slice(0, 500), siteSource: { siteId: p.siteId, folderId: f.id, itemId: id, sitePath, objectKey: it.object_key } })]);
  }

  let note: string;
  const title = (await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [assetId]))?.title ?? name;
  if (status === 'ingested' || status === 'awaiting_metadata') {
    try {
      const { requestSiteEncode } = await import('./siteEncode');
      await requestSiteEncode({ vodAssetId: assetId, accountId: f.account_id, siteId: p.siteId, sitePath, ladderGroupId: f.ladder_group_id ?? null, sourceBytes: Number(it.size_bytes) });
      note = `registered at the site; in the Media Library as "${title}", encoding at the site${status === 'awaiting_metadata' ? ' (waiting for required metadata before it is ingested)' : ''}`;
    } catch (e: any) {
      // Registered, but the encode cannot be queued (the site was disabled, or
      // the add-on withdrawn): the asset says why.
      const msg = String(e?.message ?? e).slice(0, 500);
      await query(
        `UPDATE vod_assets SET media_state = 'failed', media_error = $2, media_error_code = $3, media_state_at = now(), updated_at = now() WHERE id = $1`,
        [assetId, `the encode at the site could not be queued: ${msg}`, String(e?.code ?? 'site_encode_not_queued').slice(0, 60)]);
      note = `registered at the site; in the Media Library as "${title}", but the encode at the site could not be queued (${msg})`;
    }
  } else {
    note = `registered at the site; in the Media Library as "${title}", held by the ingest rules (${status.replace(/_/g, ' ')})`;
  }
  const done = await one<any>(
    `UPDATE watchfolder_items SET status = 'ingested', resolved_at = now(), reason = $2 WHERE id = $1 RETURNING *`, [id, note.slice(0, 500)]);
  return registrationOf(done);
}

async function registrationOf(it: any) {
  const a = await one<any>(
    `SELECT id, title, media_state, encode_job_id, ingest->>'status' AS ingest_status, ingest->'siteSidecar' AS sidecar FROM vod_assets WHERE id = $1`, [it.vod_asset_id]);
  const sc = a?.sidecar && typeof a.sidecar === 'object' ? a.sidecar : null;
  return {
    itemId: Number(it.id), status: it.status, reason: it.reason, vodAssetId: it.vod_asset_id,
    asset: a ? { id: a.id, title: a.title, mediaState: a.media_state, ingest: a.ingest_status, encodeJobId: a.encode_job_id } : null,
    // The ingest sidecar for the agent to write beside the original at the
    // site (H4-7): the name relative to the folder, the text and its SHA-256.
    // Null when the ingest rules ask for none (or the rules could not run).
    sidecar: sc ? { name: String(sc.name), mediaType: String(sc.mediaType), sha256: String(sc.sha256), text: String(sc.text) } : null,
  };
}
