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

export function s3StagingRoot(folderId: string): string { return join(config.ingest.s3StagingDir, folderId); }

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

/** Mirror an S3 folder's new objects into staging, then mirror any local quarantine decisions back. */
export async function syncS3(id: string): Promise<SyncResult | null> {
  const f = await loadS3Folder(id);
  if (!f) return null;
  if (!s3api) s3api = await realS3({ region: config.aws.region, endpoint: config.ingest.s3Endpoint });
  const known = async (rel: string, etag: string) => !!(await one(`SELECT 1 FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2 AND (checksum = $3 OR status IN ('ingested','quarantined','skipped'))`, [id, rel, etag]));
  return syncS3Folder(f, s3api, known);
}

/** After a local scan of a mirrored folder, push its quarantines to the bucket's review prefix. */
export async function mirrorQuarantines(id: string, quarantined: { objectKey: string; quarantineKey?: string | null }[]): Promise<void> {
  const f = await loadS3Folder(id);
  if (!f || !s3api || !quarantined.length) return;
  for (const q of quarantined) if (q.quarantineKey) await quarantineInS3(f, s3api, q.objectKey, q.quarantineKey).catch((e) => console.warn('[s3 watch] quarantine mirror failed', e));
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
  // An S3 folder is mirrored into a local staging root first (s3walk.ts), and
  // from there it is a local folder like any other. The path is that root.
  const path = f.kind === 's3' ? s3StagingRoot(f.id) : String(f.config?.path ?? '');
  if (!path) return null;
  if (f.kind === 's3') mkdirSync(path, { recursive: true });

  const rules = await query<any>(
    `SELECT id, ordinal, name, match_type, pattern, target_kind, workflow, action, reject_reason, enabled
       FROM watchfolder_rules WHERE watchfolder_id = $1 ORDER BY ordinal`, [id]);

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
      if (kind === 's3') await syncS3(id);
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

  async markIngested(itemId, mediaFileId, path) {
    await query(
      `UPDATE watchfolder_items
          SET status = 'ingested', media_file_id = $2, resolved_at = now(), reason = $3
        WHERE id = $1 AND status = 'seen'`,
      [itemId, mediaFileId, `ingested to ${path}`]
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
export async function loadIngestFolder(id: string): Promise<IngestFolder | null> {
  const f = await one<any>(
    `SELECT id, account_id, kind, config, enabled FROM watchfolders WHERE id = $1`, [id]);
  if (!f || !f.enabled || f.kind !== 'local') return null;
  const path = String(f.config?.path ?? '');
  if (!path) return null;
  return {
    id: f.id,
    accountId: f.account_id,
    path,
    libraryFolder: f.config?.library_folder ?? null,
    deleteAfterIngest: !!f.config?.delete_after_ingest,
    maxBytes: Number(f.config?.max_ingest_bytes ?? DEFAULT_MAX_INGEST_BYTES),
  };
}

/**
 * Items waiting to be ingested.
 *
 * NARROWED TO THE TARGETS THIS PASS CAN HANDLE. A folder whose rules produce
 * `vod` would otherwise return the same deferred rows on every pass forever,
 * growing with the library and doing nothing with them. They stay `seen` for the
 * workflow that owns them, and this query simply does not ask for them.
 */
export async function pendingItems(folderId: string, limit = 200): Promise<PendingItem[]> {
  const rows = await query<any>(
    `SELECT id, object_key, checksum, target_kind, workflow
       FROM watchfolder_items
      WHERE watchfolder_id = $1 AND status = 'seen'
        -- Not already claimed by a pass that is still working on it. The claim
        -- itself is what makes this safe; this only avoids loading rows that
        -- would immediately fail to claim.
        AND (resolved_at IS NULL OR resolved_at < now() - interval '10 minutes')
        AND lower(target_kind) = ANY($2::text[])
      ORDER BY seen_at LIMIT $3`,
    [folderId, ingestableTargetKinds(), limit]
  );
  return rows.map((r) => ({
    id: r.id, objectKey: r.object_key, checksum: r.checksum,
    targetKind: r.target_kind, workflow: r.workflow,
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
    `SELECT id, account_id, kind, config, enabled, ladder_group_id
       FROM watchfolders WHERE id = $1`, [id]);
  if (!f || !f.enabled || f.kind !== 'local') return null;
  const path = String(f.config?.path ?? '');
  if (!path) return null;
  return { id: f.id, accountId: f.account_id, path, ladderGroupId: f.ladder_group_id ?? null };
}

/** Ingest whatever is waiting in one folder: images now, video queued. */
export async function ingestFolder(folderId: string): Promise<IngestSummary | null> {
  const f = await loadIngestFolder(folderId);
  if (!f) return null;
  const items = await pendingItems(folderId);
  const summary = items.length
    ? await ingestPending(f, items, pgIngestStore)
    : { ingested: 0, deferred: 0, skipped: 0, failed: 0, outcomes: [] };

  // VIDEO IS QUEUED, NOT INGESTED, and it is counted separately for that reason:
  // an encode that has been accepted is not an asset that can be played, and one
  // counter for both would report work as finished that has not started.
  const vf = await loadVideoIngestFolder(folderId);
  if (vf) {
    const vids = await pendingVideoItems(folderId);
    for (const item of vids) {
      const o = await ingestVideoItem(vf, item, pgVideoIngestStore);
      summary.outcomes.push(o as any);
      if (o.result === 'queued' || o.result === 'registered') summary.queued = (summary.queued ?? 0) + 1;
      else if (o.result === 'failed') summary.failed++;
      else if (o.result === 'skipped') summary.skipped++;
      else summary.deferred++;
    }
  }
  return summary;
}

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
