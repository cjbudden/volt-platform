// ============================================================================
//  THE WATCHFOLDER'S PERSISTENCE, AND THE PASS THAT DRIVES IT.
//
//  `scanner.ts` holds the behaviour worth testing against real files; this is the
//  thin adapter that makes it durable, and it implements exactly the `ItemStore`
//  contract the suite exercises with an in-memory version.
//
//  THE UNIQUE INDEX IS THE REAL DEDUPE, not the `isKnown` check. That check is an
//  optimisation which avoids hashing and classifying a file we have already seen;
//  it is not a guarantee, because two scans can run concurrently and both read
//  "not known" before either writes. `ON CONFLICT DO NOTHING` against
//  `uq_watchfolder_items_object` is what actually makes the second one a no-op.
//  A dedupe that lives only in application code is a dedupe that fails the first
//  time two workers overlap.
// ============================================================================
import { query, one } from '../../db';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';
import { syncS3Folder, quarantineInS3, type S3Folder, type SyncResult } from './s3walk';
import { realS3, type S3Api } from '../ingest/s3';
import type { EventDeps } from './s3events';

export function s3StagingRoot(folderId: string): string { return join(config.ingest.s3StagingDir, folderId); }
/** Where an on-prem folder's uploaded images and companions wait to be taken in (H2b-5). */
export function siteStagingRoot(folderId: string): string { return join(config.ingest.siteStagingDir, folderId); }

let s3api: S3Api | null = null;
export function setS3Api(a: S3Api | null) { s3api = a; }

/** The S3 description of a folder, or null for a local one. */
export async function loadS3Folder(id: string): Promise<S3Folder | null> {
  const f = await one<any>(`SELECT id, kind, config, quarantine_path, enabled FROM watchfolders WHERE id = $1`, [id]);
  if (!f || !f.enabled || f.kind !== 's3') return null;
  const bucket = String(f.config?.bucket ?? config.ingest.s3Bucket);
  return { id: f.id, bucket, prefix: String(f.config?.prefix ?? ''), stagingRoot: s3StagingRoot(f.id), quarantinePath: f.quarantine_path || '_review',
           minAgeMs: Number(f.config?.min_age_ms ?? 60000), deleteAfterIngest: !!f.config?.delete_after_ingest, maxObjects: Number(f.config?.max_objects ?? 5000) };
}

async function s3(): Promise<S3Api> {
  if (!s3api) s3api = await realS3({ region: config.aws.region, endpoint: config.ingest.s3Endpoint });
  return s3api;
}

/** The scanner already recorded this object (same content, or closed). */
async function knownObject(id: string, rel: string, etag: string): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2 AND (checksum = $3 OR status IN ('ingested','quarantined','skipped'))`, [id, rel, etag]));
}

/** Mirror an S3 folder's new objects into staging, then mirror any local quarantine decisions back. */
export async function syncS3(id: string): Promise<SyncResult | null> {
  const f = await loadS3Folder(id);
  if (!f) return null;
  const api = await s3();
  lastWalk.set(id, Date.now());
  return syncS3Folder(f, api, (rel, etag) => knownObject(id, rel, etag));
}

/*
 * THE WALK AS A BACKSTOP (build queue 2.6). With the drop queue set
 * (WATCH_S3_QUEUE_URL), the bucket tells the scheduler about each new object
 * (s3events.ts), so listing every S3 folder every minute only costs LIST
 * calls. The walk then runs once per WATCH_S3_BACKSTOP_MIN (an hour by
 * default) per folder, and at the first pass after a start, to catch
 * anything a notification missed (a queue outage, a folder in a bucket with
 * no notification). Scan now still walks every time. Without the queue,
 * every pass walks, as before.
 */
const lastWalk = new Map<string, number>();
export function walkDue(id: string, now = Date.now()): boolean {
  if (!config.ingest.s3EventsQueueUrl) return true;
  return now - (lastWalk.get(id) ?? 0) >= Math.max(1, config.ingest.s3BackstopMinutes) * 60_000;
}
/** Tests: forget when each folder was last walked. */
export function resetWalks(): void { lastWalk.clear(); }

/**
 * Take an S3 folder in now, after a notification put new objects in its
 * mirror: the same scan, quarantine mirror and ingest as Scan now, minus the
 * walk (the objects are already here).
 */
export async function takeInS3Folder(id: string): Promise<void> {
  const loaded = await loadFolder(id);
  if (!loaded) return;
  try {
    const result = await scanFolder(loaded, pgItemStore);
    await mirrorQuarantines(id, result.quarantined);
    await ingestFolder(id);
    await query(`UPDATE watchfolders SET last_scan_at = now(), last_scan_error = NULL WHERE id = $1`, [id]);
  } catch (e: any) {
    await query(`UPDATE watchfolders SET last_scan_at = now(), last_scan_error = $2 WHERE id = $1`, [id, String(e?.message ?? e).slice(0, 500)])
      .catch(() => { /* the report failing must not hide the fault */ });
    throw e;
  }
}

/** What the drop-queue loop (s3events.ts) needs from the database and the bucket. */
export async function s3EventDeps(): Promise<EventDeps> {
  return {
    s3: await s3(),
    async folders() {
      const ids = await query<{ id: string }>(`SELECT id FROM watchfolders WHERE enabled AND kind = 's3' ORDER BY created_at`);
      const out: S3Folder[] = [];
      for (const { id } of ids) { const f = await loadS3Folder(id); if (f) out.push(f); }
      return out;
    },
    known: knownObject,
    takeIn: takeInS3Folder,
  };
}

/** After a local scan of a mirrored folder, push its quarantines to the bucket's review prefix. */
export async function mirrorQuarantines(id: string, quarantined: { objectKey: string; quarantineKey?: string | null }[]): Promise<void> {
  const f = await loadS3Folder(id);
  if (!f || !quarantined.length) return;
  const api = await s3();
  for (const q of quarantined) if (q.quarantineKey) await quarantineInS3(f, api, q.objectKey, q.quarantineKey).catch((e) => console.warn('[s3 watch] quarantine mirror failed', e));
}
import { readImageFacts } from '../images/metadata';
import { insertMediaRow } from '../mediaLibrary';
import { imageStore } from '../imageStore';
import { scanFolder, type ItemStore, type RecordedItem, type ScanFolder, type ScanResult } from './scanner';
import type { WatchRule, FolderPolicy } from './rules';
import {
  ingestPending, ingestableTargetKinds, DEFAULT_MAX_INGEST_BYTES,
  type IngestFolder, type IngestStore, type IngestSummary, type PendingItem,
} from './ingest';
import {
  ingestVideoItem, pgVideoIngestStore, videoTargetKinds,
  type VideoIngestFolder, type VideoOutcome,
} from './videoIngest';
import { quarantineKey } from './rules';
import { moveToQuarantine } from './scanner';
import { ingestCompanions, companionTargetKinds, type CompanionStore, type CompanionFolder } from './companionIngest';
import { ingestSlateItem, slateTargetKinds, type SlateStore } from './slateIngest';
import { attachTypedImages, type ImageAttachStore, type WaitingImage } from './imageAttach';
import type { TypeChoice } from './imageTypes';

export const pgItemStore: ItemStore = {
  async isKnown(folderId, objectKey, checksum) {
    const r = await one<any>(
      `SELECT 1 FROM watchfolder_items
        WHERE watchfolder_id = $1 AND object_key = $2 AND COALESCE(checksum,'') = $3
          -- 'reprocessed' IS NOT "DEALT WITH". It is an operator saying "look at
          -- this again": they corrected a rule and put the file back in the drop.
          -- Counting it as known is how a reprocess request quietly does nothing,
          -- which is the worst outcome because the queue then shows it resolved.
          AND status <> 'reprocessed'
        LIMIT 1`,
      [folderId, objectKey, checksum]
    );
    return !!r;
  },

  async record(folderId, accountId, item: RecordedItem) {
    await query(
      `INSERT INTO watchfolder_items
         (watchfolder_id, account_id, object_key, checksum, size_bytes, status,
          matched_rule_id, target_kind, workflow, reason, quarantine_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       -- THE INDEX IS THE REAL DEDUPE, not the isKnown read above: two scans can
       -- both read "not known" before either writes. DO NOTHING is right for a
       -- genuine duplicate, but a row an operator sent back for REPROCESSING has
       -- to be overwritten by the new decision, or the correction they made to
       -- the rules would never take effect.
       ON CONFLICT (watchfolder_id, object_key, COALESCE(checksum, ''))
       DO UPDATE SET status = EXCLUDED.status, matched_rule_id = EXCLUDED.matched_rule_id,
                     target_kind = EXCLUDED.target_kind, workflow = EXCLUDED.workflow,
                     reason = EXCLUDED.reason, quarantine_key = EXCLUDED.quarantine_key,
                     seen_at = now(), resolved_at = NULL, resolved_by = NULL
       WHERE watchfolder_items.status = 'reprocessed'`,
      [folderId, accountId, item.objectKey, item.checksum, item.sizeBytes, item.status,
       item.matchedRuleId ?? null, item.targetKind ?? null, item.workflow ?? null,
       item.reason ?? null, item.quarantineKey ?? null]
    );
  },

  async quarantineKeysInUse(folderId) {
    const rows = await query<{ quarantine_key: string }>(
      `SELECT quarantine_key FROM watchfolder_items
        WHERE watchfolder_id = $1 AND quarantine_key IS NOT NULL`,
      [folderId]
    );
    return new Set(rows.map((r) => r.quarantine_key));
  },
};

/** One enabled folder, with its ordered rules, ready to scan. */
export async function loadFolder(id: string): Promise<ScanFolder | null> {
  const f = await one<any>(
    `SELECT id, account_id, kind, config, default_target_kind, quarantine_path, enabled
       FROM watchfolders WHERE id = $1`, [id]);
  if (!f || !f.enabled) return null;
  // A SITE FOLDER IS NOT ON THIS MACHINE (build queue H2). Its path is on the
  // customer's storage and the site agent scans it there; scanning the same
  // path here would read whatever this server happens to have at it.
  if (f.kind === 'site') return null;
  // An S3 folder is mirrored into a local staging root first (s3walk.ts), and
  // from there it is a local folder like any other. The path is that root.
  const path = f.kind === 's3' ? s3StagingRoot(f.id) : String(f.config?.path ?? '');
  if (!path) return null;
  if (f.kind === 's3') mkdirSync(path, { recursive: true });

  return toScanFolder(f, path);
}

/**
 * A folder row as the scanner takes it: its ordered rules and its policy. The
 * site agent gets exactly this for its folders (services/sites/siteWatchfolders.ts),
 * so the rules a site runs are the rules the console shows.
 */
export async function toScanFolder(f: any, path: string): Promise<ScanFolder> {
  const rules = await query<any>(
    `SELECT id, ordinal, name, match_type, pattern, target_kind, workflow, action, reject_reason, enabled
       FROM watchfolder_rules WHERE watchfolder_id = $1 ORDER BY ordinal`, [f.id]);

  const policy: FolderPolicy = {
    defaultTargetKind: f.default_target_kind ?? null,
    defaultWorkflow: f.config?.default_workflow ?? null,
    minBytes: f.config?.min_bytes ?? null,
    maxBytes: f.config?.max_bytes ?? null,
  };

  return {
    id: f.id,
    accountId: f.account_id,
    path,
    quarantinePath: f.quarantine_path || '_review',
    rules: rules.map((r): WatchRule => ({
      id: r.id, ordinal: r.ordinal, name: r.name, matchType: r.match_type,
      pattern: r.pattern, targetKind: r.target_kind, workflow: r.workflow,
      action: r.action, rejectReason: r.reject_reason, enabled: r.enabled,
    })),
    policy,
    minAgeMs: Number(f.config?.min_age_ms ?? 5000),
    maxFiles: Number(f.config?.max_files ?? 5000),
  };
}

/**
 * Scan every enabled local folder.
 *
 * THE ERROR IS RECORDED ON THE FOLDER, not thrown. A watched path that has been
 * unmounted must show up in the console as a folder with a problem, not as a
 * scheduler tick that died and took the other folders with it. Same reasoning as
 * the per-file error handling one level down.
 */
export async function scanAllFolders(): Promise<{ folderId: string; result?: ScanResult; error?: string }[]> {
  const ids = await query<{ id: string; kind: string }>(
    `SELECT id, kind FROM watchfolders WHERE enabled AND kind IN ('local', 's3') ORDER BY created_at`);
  const out: { folderId: string; result?: ScanResult; error?: string }[] = [];
  for (const { id, kind } of ids) {
    try {
      const f = await loadFolder(id);
      if (!f) continue;
      if (kind === 's3' && walkDue(id)) await syncS3(id);
      const result = await scanFolder(f, pgItemStore);
      if (kind === 's3') await mirrorQuarantines(id, result.quarantined);
      await query(
        `UPDATE watchfolders SET last_scan_at = now(), last_scan_error = NULL WHERE id = $1`, [id]);
      out.push({ folderId: id, result });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 500);
      await query(
        `UPDATE watchfolders SET last_scan_at = now(), last_scan_error = $2 WHERE id = $1`, [id, msg])
        .catch(() => { /* the scan failing must not be made worse by the report failing */ });
      out.push({ folderId: id, error: msg });
    }
  }
  return out;
}

/* ==========================================================================
 *  INGEST PERSISTENCE — the same shape as the scan's: the behaviour lives in
 *  `ingest.ts` behind an interface, and this is the adapter that makes it real.
 * ========================================================================== */

/**
 * THE STATUS TRANSITION IS GUARDED, and that guard is the whole safety of this.
 *
 * `WHERE status = 'seen'` on both closers means two ingest passes that overlap
 * cannot both close the same item: the second update matches nothing. Without it
 * a slow pass and the operator's Scan button can each ingest the same file, and
 * the library ends up with two records for one drop, the second one suffixed,
 * looking for all the world like the operator dropped it twice.
 */
export const pgIngestStore: IngestStore = {
  async put(key, body, contentType) {
    await imageStore().put(key, body, contentType);
  },

  async removeObject(key) {
    await imageStore().delete(key);
  },

  async pathInUse(accountId, path) {
    const r = await one<any>(
      `SELECT 1 FROM media_files WHERE account_id = $1 AND path = $2 LIMIT 1`, [accountId, path]);
    return !!r;
  },

  async createMediaFile(m) {
    // Same row shape as an upload: dimensions, checksum and the file's own
    // metadata (EXIF, GPS, IPTC, XMP), searchable in the library.
    const facts = m.body ? await readImageFacts(m.body) : undefined;
    const row = await insertMediaRow({
      accountId: m.accountId, kind: m.kind, path: m.path, folder: m.folder, name: m.name,
      storeKey: m.storeKey, sizeBytes: m.sizeBytes, contentType: m.contentType, tags: m.tags,
      userId: m.userId ?? null, source: 'watchfolder',
      facts: { ...(facts ?? {}), width: facts?.width ?? m.width, height: facts?.height ?? m.height, contentType: m.contentType },
    });
    return { id: row.id };
  },

  /**
   * THE CLAIM. `resolved_at` is used as the marker rather than a new column,
   * because both closers set it anyway and the row is meaningless without one of
   * them. The write is a single guarded UPDATE, so of two passes reading the same
   * `seen` row exactly one gets a row back.
   *
   * THE STALE WINDOW IS THE OTHER HALF. A process that dies mid-ingest leaves a
   * claimed row that no later pass would ever touch, and the file would sit in
   * the drop folder looking ingested forever. Ten minutes is far longer than any
   * image ingest and far shorter than a shift.
   */
  async claim(itemId) {
    const r = await one<any>(
      `UPDATE watchfolder_items
          SET resolved_at = now()
        WHERE id = $1 AND status = 'seen'
          AND (resolved_at IS NULL OR resolved_at < now() - interval '10 minutes')
        RETURNING id`,
      [itemId]
    );
    return !!r;
  },

  async markIngested(itemId, mediaFileId, path, want) {
    // An image meant as an asset's image of a type (H2b-3) is marked waiting;
    // the attach pass below matches it to its video.
    await query(
      `UPDATE watchfolder_items
          SET status = 'ingested', media_file_id = $2, resolved_at = now(), reason = $3,
              image_type = $4, image_attach = CASE WHEN $4::text IS NULL THEN NULL ELSE 'waiting' END
        WHERE id = $1 AND status = 'seen'`,
      [itemId, mediaFileId, `ingested to ${path}`, want?.imageType ?? null]
    );
  },

  async markFailed(itemId, reason) {
    await query(
      `UPDATE watchfolder_items
          SET status = 'failed', reason = $2, resolved_at = now()
        WHERE id = $1 AND status = 'seen'`,
      [itemId, reason.slice(0, 500)]
    );
  },
};

/** The folder as the ingest step needs it: paths and policy, no rules. */
/*
 * WHERE A FOLDER'S FILES ARE ON THIS MACHINE: a local folder's own path, an S3
 * folder's staging mirror. Both ingest loaders asked for kind 'local' only, so
 * an S3 folder's files were accepted by the scan and then never ingested: they
 * stayed 'seen' for good (found by build queue 2.6).
 */
function folderPath(f: { id: string; kind: string; config?: any }): string {
  return f.kind === 's3' ? s3StagingRoot(f.id) : f.kind === 'site' ? siteStagingRoot(f.id) : String(f.config?.path ?? '');
}

/**
 * `site`: also an on-prem folder, whose files here are the copies its agent
 * uploaded (siteStagingRoot). Only the site ingest asks for that
 * (siteWatchfolders.ts ingestSiteFolder); the server's own passes never do,
 * because a site file is not here until its upload lands.
 */
export async function loadIngestFolder(id: string, site = false): Promise<IngestFolder | null> {
  const f = await one<any>(
    `SELECT id, account_id, kind, config, enabled FROM watchfolders WHERE id = $1`, [id]);
  if (!f || !f.enabled || !(site ? ['site'] : ['local', 's3']).includes(f.kind)) return null;
  const path = folderPath(f);
  if (!path) return null;
  return {
    id: f.id,
    accountId: f.account_id,
    path,
    libraryFolder: f.config?.library_folder ?? null,
    // An S3 folder's files here are the staging mirror, a copy: once a file
    // is in the library the bucket still has the original, so the copy goes
    // rather than filling the task's disk. The walk and the drop queue both
    // know an ingested object and do not fetch it again.
    // A site folder's files here are copies too (the original stays at the site).
    deleteAfterIngest: f.kind === 's3' || f.kind === 'site' || !!f.config?.delete_after_ingest,
    maxBytes: Number(f.config?.max_ingest_bytes ?? DEFAULT_MAX_INGEST_BYTES),
    imageTypes: await videoImageTypes(f.account_id),
  };
}

/** The account's image types a video asset offers (enabled), as type words read them (H2b-3). */
export async function videoImageTypes(accountId: string): Promise<TypeChoice[]> {
  const { listImageTypes } = await import('../media/assetImageSet');
  return (await listImageTypes(accountId))
    .filter((t) => t.enabled && t.appliesTo.includes('video'))
    .map((t) => ({ key: t.key, label: t.label }));
}

/**
 * Items waiting to be ingested.
 *
 * NARROWED TO THE TARGETS THIS PASS CAN HANDLE. A folder whose rules produce
 * `vod` would otherwise return the same deferred rows on every pass forever,
 * growing with the library and doing nothing with them. They stay `seen` for the
 * workflow that owns them, and this query simply does not ask for them.
 */
/**
 * ONLY WHAT HAS LANDED, for a site folder (H2b-5): its accepted files reach
 * this server one upload at a time, and one not uploaded yet is not missing.
 */
const LANDED = `AND EXISTS (SELECT 1 FROM upload_sessions u WHERE u.id = i.upload_session_id AND u.state = 'complete')`;

export async function pendingItems(folderId: string, limit = 200, kinds: string[] = ingestableTargetKinds(), landedOnly = false): Promise<PendingItem[]> {
  const rows = await query<any>(
    // The rule's image type (H2b-3) as it is now: a rule corrected before the
    // file is taken in applies to it.
    `SELECT i.id, i.object_key, i.checksum, i.target_kind, i.workflow,
            r.image_type, COALESCE(r.image_type_from_name, true) AS image_type_from_name
       FROM watchfolder_items i
       LEFT JOIN watchfolder_rules r ON r.id = i.matched_rule_id
      WHERE i.watchfolder_id = $1 AND i.status = 'seen'
        -- Not already claimed by a pass that is still working on it. The claim
        -- itself is what makes this safe; this only avoids loading rows that
        -- would immediately fail to claim.
        AND (i.resolved_at IS NULL OR i.resolved_at < now() - interval '10 minutes')
        AND lower(i.target_kind) = ANY($2::text[])
        ${landedOnly ? LANDED : ''}
      ORDER BY i.seen_at LIMIT $3`,
    [folderId, kinds, limit]
  );
  return rows.map((r) => ({
    id: r.id, objectKey: r.object_key, checksum: r.checksum,
    targetKind: r.target_kind, workflow: r.workflow,
    imageType: r.image_type ?? null, imageTypeFromName: r.image_type_from_name !== false,
  }));
}

/**
 * Items waiting to become VIDEO assets.
 *
 * A separate query from the image one because they are separate targets with
 * separate stores; folding them together would mean one loop with a branch in
 * it and two sets of failure modes sharing a counter.
 */
export async function pendingVideoItems(folderId: string, limit = 50): Promise<PendingItem[]> {
  const rows = await query<any>(
    `SELECT id, object_key, checksum, target_kind, workflow
       FROM watchfolder_items
      WHERE watchfolder_id = $1 AND status = 'seen'
        AND (resolved_at IS NULL OR resolved_at < now() - interval '10 minutes')
        AND lower(target_kind) = ANY($2::text[])
      ORDER BY seen_at LIMIT $3`,
    [folderId, videoTargetKinds(), limit]
  );
  return rows.map((r) => ({
    id: r.id, objectKey: r.object_key, checksum: r.checksum,
    targetKind: r.target_kind, workflow: r.workflow,
  }));
}

export async function loadVideoIngestFolder(id: string): Promise<VideoIngestFolder | null> {
  const f = await one<any>(
    `SELECT id, account_id, kind, config, enabled, ladder_group_id, rights_profile_id
       FROM watchfolders WHERE id = $1`, [id]);
  if (!f || !f.enabled || !['local', 's3'].includes(f.kind)) return null;
  const path = folderPath(f);
  if (!path) return null;
  return { id: f.id, accountId: f.account_id, path, ladderGroupId: f.ladder_group_id ?? null, rightsProfileId: f.rights_profile_id ?? null };
}

/** Ingest whatever is waiting in one folder: images now, video queued. */
export async function ingestFolder(folderId: string): Promise<IngestSummary | null> {
  const f = await loadIngestFolder(folderId);
  if (!f) return null;
  const items = await pendingItems(folderId);
  const summary = items.length
    ? await ingestPending(f, items, pgIngestStore)
    : { ingested: 0, deferred: 0, skipped: 0, failed: 0, outcomes: [] };

  // SLATES TO LOOPS & FILLERS (H2b-3): images a rule sent there as fallbacks.
  for (const item of await pendingItems(folderId, 200, slateTargetKinds())) {
    const o = await ingestSlateItem(f, item, pgSlateStore);
    summary.outcomes.push(o as any);
    if (o.result === 'slate') summary.slates = (summary.slates ?? 0) + 1;
    else if (o.result === 'failed') summary.failed++;
    else summary.skipped++;
  }

  // VIDEO IS QUEUED, NOT INGESTED, and it is counted separately for that reason:
  // an encode that has been accepted is not an asset that can be played, and one
  // counter for both would report work as finished that has not started.
  const vf = await loadVideoIngestFolder(folderId);
  if (vf) {
    const vids = await pendingVideoItems(folderId);
    for (const item of vids) {
      const o = await ingestVideoItem(vf, item, pgVideoIngestStore);
      summary.outcomes.push(o as any);
      // Each counted for what it is: a loop is usable now, a VOD encodes, a held
      // VOD waits for a person (duplicate, metadata). See ingest.ts.
      if (o.result === 'queued') summary.queued = (summary.queued ?? 0) + 1;
      else if (o.result === 'registered') summary.loops = (summary.loops ?? 0) + 1;
      else if (o.result === 'held') summary.held = (summary.held ?? 0) + 1;
      else if (o.result === 'failed') summary.failed++;
      else if (o.result === 'skipped') summary.skipped++;
      else summary.deferred++;
    }
  }
  // COMPANIONS LAST (build queue H2b-2): a caption dropped beside its video
  // attaches in the same pass, because the video above has just landed.
  const cf = await loadIngestFolder(folderId);
  if (cf) {
    const q = await one<any>(`SELECT quarantine_path FROM watchfolders WHERE id = $1`, [folderId]);
    const folder: CompanionFolder = { id: cf.id, accountId: cf.accountId, path: cf.path, quarantinePath: q?.quarantine_path || '_review', deleteAfterIngest: cf.deleteAfterIngest };
    const outs = await ingestCompanions(folder, await pendingCompanionItems(folderId), pgCompanionStore);
    const reviewed: { objectKey: string; quarantineKey: string }[] = [];
    for (const o of outs) {
      summary.outcomes.push(o as any);
      if (o.result === 'attached') summary.attached = (summary.attached ?? 0) + 1;
      else if (o.result === 'waiting') summary.waiting = (summary.waiting ?? 0) + 1;
      else if (o.result === 'review') { summary.review = (summary.review ?? 0) + 1; reviewed.push(o); }
      else if (o.result === 'failed') summary.failed++;
      else summary.skipped++;
    }
    // A bucket folder's review files go back to the bucket's review prefix.
    if (reviewed.length) await mirrorQuarantines(folderId, reviewed);
  }
  // TYPED IMAGES LAST (H2b-3), for the same reason: a poster dropped beside
  // its video becomes that asset's poster in the pass the video landed in.
  const typed = await attachTypedImages({ id: f.id, accountId: f.accountId }, await waitingTypedImages(folderId, f.imageTypes ?? []), pgImageAttachStore);
  for (const o of typed) {
    summary.outcomes.push(o as any);
    if (o.result === 'typed') summary.typed = (summary.typed ?? 0) + 1;
    else if (o.result === 'waiting') summary.typedWaiting = (summary.typedWaiting ?? 0) + 1;
  }
  return summary;
}

/** Images in the library meant as an asset's image of a type, not matched yet (H2b-3). */
export async function waitingTypedImages(folderId: string, types: TypeChoice[] = [], limit = 200): Promise<WaitingImage[]> {
  const rows = await query<any>(
    `SELECT i.id, i.object_key, i.image_type, i.seen_at, m.store_key, m.kind, m.width, m.height
       FROM watchfolder_items i
       JOIN media_files m ON m.id = i.media_file_id
      WHERE i.watchfolder_id = $1 AND i.status = 'ingested' AND i.image_attach = 'waiting'
      ORDER BY i.seen_at LIMIT $2`, [folderId, limit]);
  return rows.map((r) => ({
    id: r.id, objectKey: r.object_key, imageType: r.image_type, typeLabel: types.find((t) => t.key === r.image_type)?.label,
    storeKey: r.store_key, libraryKind: r.kind, width: r.width ?? null, height: r.height ?? null, seenAt: new Date(r.seen_at).getTime(),
  }));
}

export const pgImageAttachStore: ImageAttachStore = {
  candidates: (folderId) => pgCompanionStore.candidates(folderId),
  async setType(a) {
    const S = await import('../media/assetImageSet');
    const { fitWarnings } = await import('../media/assetImageRules');
    await S.setTypeImage(a.assetId, a.accountId, a.typeKey, `/${a.storeKey}`, a.by);
    const t = (await S.listImageTypes(a.accountId)).find((x) => x.key === a.typeKey);
    const d = await one<any>(`SELECT width, height FROM media_files WHERE account_id = $1 AND store_key = $2`, [a.accountId, a.storeKey]);
    const v = await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [a.assetId]);
    return { assetTitle: v?.title ?? 'the asset', typeLabel: t?.label ?? a.typeKey, warnings: t ? fitWarnings(t, d?.width, d?.height) : [] };
  },
  async note(itemId, state, reason, assetId) {
    await query(
      `UPDATE watchfolder_items SET image_attach = $2, reason = $3, vod_asset_id = COALESCE($4::uuid, vod_asset_id)
        WHERE id = $1 AND (image_attach IS DISTINCT FROM $2 OR reason IS DISTINCT FROM $3)`,
      [itemId, state, reason.slice(0, 500), assetId ?? null]);
  },
};

export const pgSlateStore: SlateStore = {
  claim: (itemId) => pgIngestStore.claim(itemId),
  async createSlate(a) {
    const { putFiller } = await import('../media/fillerStore');
    const { safeExt } = await import('../uploads');
    // Laid out exactly as a slate copied from the Image Library
    // (modules/fillerAssets.ts copy-from-library): row, bytes, then ready.
    const row = await one<any>(
      `INSERT INTO filler_assets(account_id, kind, name, status, width, height, content_type, filename)
       VALUES ($1,'slate',$2,'processing',$3,$4,$5,$6) RETURNING id`,
      [a.accountId, a.name, a.width, a.height, a.contentType, a.filename]);
    const key = `filler/${a.accountId}/${row.id}${safeExt(a.filename)}`;
    try { await putFiller(key, a.body); }
    catch (e) { await query(`DELETE FROM filler_assets WHERE id = $1`, [row.id]).catch(() => {}); throw e; }
    await query(`UPDATE filler_assets SET status = 'ready', source_key = $2, bytes = $3, uploaded_at = now(), updated_at = now() WHERE id = $1`,
      [row.id, key, a.body.length]);
    await (await import('../jobs/handlers/fillerThumbs')).queueFillerThumbs(row.id);
    return { id: row.id };
  },
  async markLanded(itemId, note) {
    await query(`UPDATE watchfolder_items SET status = 'ingested', reason = $2, resolved_at = now() WHERE id = $1 AND status = 'seen'`, [itemId, note.slice(0, 500)]);
  },
  markFailed: (itemId, reason) => pgIngestStore.markFailed(itemId, reason),
};

/** Companions (captions, sidecars) waiting to be attached to their video. */
export async function pendingCompanionItems(folderId: string, limit = 200, landedOnly = false): Promise<(PendingItem & { seenAt: number })[]> {
  const rows = await query<any>(
    `SELECT i.id, i.object_key, i.checksum, i.target_kind, i.workflow, i.seen_at
       FROM watchfolder_items i
      WHERE i.watchfolder_id = $1 AND i.status = 'seen'
        AND (i.resolved_at IS NULL OR i.resolved_at < now() - interval '10 minutes')
        AND lower(i.target_kind) = ANY($2::text[])
        ${landedOnly ? LANDED : ''}
      ORDER BY i.seen_at LIMIT $3`,
    [folderId, companionTargetKinds(), limit]);
  return rows.map((r) => ({ id: r.id, objectKey: r.object_key, checksum: r.checksum, targetKind: r.target_kind, workflow: r.workflow, seenAt: new Date(r.seen_at).getTime() }));
}

const VOD_ONLY = ['vod', 'video', 'programme', 'program', 'episode'];

export const pgCompanionStore: CompanionStore = {
  async candidates(folderId) {
    // Videos this folder took into the Media Library (their asset still
    // there), and videos it accepted that are still waiting to be taken in.
    const rows = await query<any>(
      `SELECT i.object_key, i.seen_at, CASE WHEN i.status = 'ingested' THEN v.id END AS asset_id
         FROM watchfolder_items i
         LEFT JOIN vod_assets v ON v.id = i.vod_asset_id
        WHERE i.watchfolder_id = $1 AND lower(i.target_kind) = ANY($2::text[])
          AND ((i.status = 'ingested' AND v.id IS NOT NULL) OR i.status = 'seen')`,
      [folderId, VOD_ONLY]);
    return rows.map((r) => ({ objectKey: r.object_key, assetId: r.asset_id ?? null, seenAt: new Date(r.seen_at).getTime() }));
  },
  async claim(itemId) {
    const r = await one<any>(
      `UPDATE watchfolder_items SET resolved_at = now()
        WHERE id = $1 AND status = 'seen'
          AND (resolved_at IS NULL OR resolved_at < now() - interval '10 minutes')
        RETURNING id`, [itemId]);
    return !!r;
  },
  async noteWaiting(itemId, reason) {
    await query(`UPDATE watchfolder_items SET reason = $2 WHERE id = $1 AND status = 'seen' AND reason IS DISTINCT FROM $2`, [itemId, reason.slice(0, 500)]);
  },
  async attach(a) {
    const { addFile } = await import('../companions/store');
    const r = await addFile(a.assetId, a.accountId, { name: a.name, buf: a.buf, by: a.by, source: 'watchfolder' });
    const t = await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [a.assetId]);
    return { file: r.file, duplicate: r.duplicate, assetTitle: t?.title ?? 'the asset' };
  },
  async markAttached(itemId, assetId, note) {
    await query(
      `UPDATE watchfolder_items SET status = 'ingested', vod_asset_id = $2, reason = $3, resolved_at = now()
        WHERE id = $1 AND status = 'seen'`, [itemId, assetId, note.slice(0, 500)]);
  },
  async toReview(f, item, reason) {
    // Moved first, then recorded, as the scanner does: a row that says
    // "in the review folder" while the file is still in the drop is the
    // worse half to be left with.
    const inUse = await pgItemStore.quarantineKeysInUse(f.id);
    const root = (f.quarantinePath || '_review').replace(/^\/+|\/+$/g, '');
    const qKey = quarantineKey(root, item.objectKey, inUse);
    await moveToQuarantine(f.path, item.objectKey, qKey);
    // resolved_at back to null: an open review item, as the scan leaves one.
    await query(
      `UPDATE watchfolder_items SET status = 'quarantined', reason = $2, quarantine_key = $3, resolved_at = NULL
        WHERE id = $1`, [item.id, reason.slice(0, 500), qKey]);
    return qKey;
  },
  async markFailed(itemId, reason) {
    await query(
      `UPDATE watchfolder_items SET status = 'failed', reason = $2, resolved_at = now()
        WHERE id = $1 AND status = 'seen'`, [itemId, reason.slice(0, 500)]);
  },
};

/**
 * Ingest every enabled local folder.
 *
 * Same error boundary as the scan pass: a folder whose store has gone away is a
 * folder with a problem, not a scheduler tick that dies and takes the rest with
 * it.
 */
export async function ingestAllFolders(): Promise<{ folderId: string; summary?: IngestSummary; error?: string }[]> {
  const ids = await query<{ id: string }>(
    `SELECT id FROM watchfolders WHERE enabled AND kind IN ('local', 's3') ORDER BY created_at`);
  const out: { folderId: string; summary?: IngestSummary; error?: string }[] = [];
  for (const { id } of ids) {
    try {
      const summary = await ingestFolder(id);
      if (summary) out.push({ folderId: id, summary });
    } catch (e: any) {
      out.push({ folderId: id, error: String(e?.message ?? e).slice(0, 500) });
    }
  }
  return out;
}
