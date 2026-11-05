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
//  A HOST WAITING FOR APPROVAL DOES NO WORK: every route here refuses it.
//  Placement 'encode_site' is H4; such a folder is scanned but nothing is
//  uploaded (the API does not yet accept it).
// ============================================================================
import { query, one } from '../../db';
import { ApiError, notFound, conflict, badRequest } from '../../util/http';
import { pgItemStore, toScanFolder } from '../watchfolder/store';
import { classify } from '../watchfolder/rules';
import { videoTargetFor, videoTargetKinds, videoTypeOf } from '../watchfolder/videoIngest';
import type { SitePrincipal } from './sites';

export const PLACEMENTS = ['upload_cloud', 'encode_site'] as const;
export type Placement = typeof PLACEMENTS[number];
/** Placements a folder may be given today. 'encode_site' arrives with site encoders (H4). */
export const PLACEMENTS_BUILT: readonly Placement[] = ['upload_cloud'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // ONLY VIDEO CROSSES TO THE CLOUD FROM A SITE FOR NOW (VOD and loops).
    // An image target would otherwise wait for ever: the image ingest reads
    // the file from this server's disk, and a site file is not on it.
    if (!videoTargetFor(d.targetKind)) {
      await query(
        `UPDATE watchfolder_items SET status = 'failed', resolved_at = now(),
                reason = $4
          WHERE watchfolder_id = $1 AND object_key = $2 AND checksum = $3 AND status = 'seen'`,
        [f.id, objectKey, checksum,
         // Companions (captions, sidecars) are not carried from a site yet either (H2b-4).
         `"${d.targetKind}" goes to ${String(d.targetKind ?? '').toLowerCase() === 'companion' ? 'a video as a companion file' : 'the Image Library'}, which an on-prem folder does not feed yet; only video (Media Library and Loops & Fillers) is taken in from a site`]);
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
  return pgItemStore.isKnown(f.id, relKey(objectKey, 'objectKey'), String(checksum ?? ''));
}

export async function quarantineKeysInUse(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  return [...await pgItemStore.quarantineKeysInUse(f.id)];
}

/**
 * Accepted video files still to be uploaded, oldest first, with the upload
 * already opened for each (and how far it got), so a restarted agent resumes.
 */
export async function pendingUploads(p: SitePrincipal, folderId: string) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  if ((f.placement ?? 'upload_cloud') !== 'upload_cloud') return [];
  const rows = await query<any>(
    `SELECT i.id, i.object_key, i.checksum, i.size_bytes, i.target_kind,
            u.id AS upload_id, u.state AS upload_state, u.received_bytes
       FROM watchfolder_items i
       LEFT JOIN upload_sessions u ON u.id = i.upload_session_id
      WHERE i.watchfolder_id = $1 AND i.status = 'seen' AND i.site_action IS NULL
        AND lower(i.target_kind) = ANY($2::text[])
      ORDER BY i.seen_at LIMIT 50`, [f.id, videoTargetKinds()]);
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

/** The agent's pass over one folder: when, and whether it failed. Shown on the folder page. */
export async function scanReport(p: SitePrincipal, folderId: string, error: unknown) {
  requireApprovedHost(p);
  const f = await siteFolder(p, folderId);
  const msg = error ? String(error).slice(0, 500) : null;
  await query(`UPDATE watchfolders SET last_scan_at = now(), last_scan_error = $2 WHERE id = $1`, [f.id, msg]);
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
  if ((r.placement ?? 'upload_cloud') !== 'upload_cloud') throw conflict('This folder encodes at the site; its files are not uploaded');
  if (r.status !== 'seen') throw conflict(`This file is ${r.status === 'ingested' ? 'already in the library' : r.status}; there is nothing to upload`);
  const target = videoTargetFor(r.target_kind);
  if (!target) throw conflict('Only video files are uploaded from a site');
  if (Number(r.size_bytes) !== length) throw conflict(`The file is ${length} bytes now and was ${r.size_bytes} when it was accepted; it has changed, so it will be decided again as a new file`);
  return {
    item: r, target,
    existingUpload: r.upload_session_id && r.upload_state === 'open' ? String(r.upload_session_id) : null,
    contentType: videoTypeOf(String(r.object_key)),
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
