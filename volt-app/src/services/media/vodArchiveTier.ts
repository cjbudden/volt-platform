// ============================================================================
//  THE ARCHIVE STORAGE TIER FOR VOD TITLES (build queue P5-3 (a),
//  PUBLISHING_POLICIES.md phase 5 "storage tier move").
//
//  An archived title is off the catalogue and cannot play, but its media is
//  kept so it can come back. Kept in the bucket's normal class it costs the
//  same as a title people watch. A publishing policy's Retention section can
//  set **Archive storage tier** (`retention.archiveTier`):
//
//    infrequent  S3 Standard-IA. About half the price per GB, readable at once,
//                a charge per GB read and a 30-day minimum.
//    glacier     S3 Glacier Flexible Retrieval. A fraction of the price, but a
//                byte can only be read after a restore that takes hours, and
//                a 90-day minimum.
//
//  It is opt-in per policy: with no tier set nothing moves (the open question
//  in PUBLISHING_POLICIES.md, settled as "the policy says").
//
//  What moves: everything under the title's own folder in the origin bucket,
//  vod/<id>/ (the package, repackage folders, FAST ladder variants, reframes),
//  and its original under vod-src/ when that is in the bucket. The keys do not
//  change, only the class (a copy onto itself), so nothing that links to the
//  media has to change either. On the Mac (VOD_STORE=local) there is one tier
//  and nothing moves; the drawer says nothing about a tier then.
//
//  The hourly retention sweep moves titles archived since the last pass
//  (sweepArchiveTiers); the archive route also starts it at once. A tier only
//  ever moves media to a colder class while the title stays archived: a policy
//  edited to a warmer tier, or to none, applies at the next archive, because
//  moving back would cost a copy (and, from Glacier, a restore) for nothing.
//
//  RESTORE to Draft or Published (POST /api/vod/:id/unarchive):
//    infrequent  restored at once (IA is readable); the media is moved back to
//                the normal class straight after.
//    glacier     the restore time is said first: the route answers 409
//                `restore_wait` with when it is expected, and only a request
//                with `acceptWait: true` starts it. The title stays archived
//                while S3 restores (`archive_tier_state = 'restoring'`); the
//                sweep watches, copies the restored media back to the normal
//                class, then restores the title to what was asked for.
// ============================================================================
import { one, query } from '../../db';
import { config } from '../../config';
import { writeAudit } from '../audit';
import { restoreWindowMs, type StorageTier } from './storage';

export type ArchiveTier = 'infrequent' | 'glacier';
export const TIER: Record<ArchiveTier, StorageTier> = { infrequent: 's3_ia', glacier: 's3_glacier_flexible' };
const RANK: Record<string, number> = { infrequent: 1, glacier: 2 };
/** How a Glacier restore is asked for: Standard, the cheapest that finishes the same day. */
export const RESTORE_SPEED = 'standard' as const;

/** PURE. Whether media in `current` should move to `wanted`: only ever colder. */
export function shouldMove(wanted: ArchiveTier | null | undefined, current: string | null | undefined): boolean {
  if (!wanted || !RANK[wanted]) return false;
  return RANK[wanted] > (current ? RANK[current] ?? 0 : 0);
}

/** PURE. How long a restore from this tier takes before the title can play again, in ms (0: at once). */
export function restoreWaitMs(tier: string | null | undefined): number {
  if (tier !== 'glacier') return 0;
  return restoreWindowMs(TIER.glacier, RESTORE_SPEED) ?? 0;
}

/** PURE. The wait in words, for the confirmation and the drawer. */
export function waitWords(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h >= 1 ? `about ${h} hour${h === 1 ? '' : 's'}` : `about ${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

/** Where the title's media sits in the bucket, as storage-driver locations. Empty on the Mac. */
export async function locationsOf(t: { id: string; source_key?: string | null; original_removed_at?: any }): Promise<string[]> {
  const out: string[] = [];
  const { vodStore } = await import('../fast/vodStore');
  if (vodStore() === 's3') out.push(`s3://${config.aws.s3Bucket}/vod/${t.id}/`);
  const { isBucketSource } = await import('./vodSource');
  if (t.source_key && !t.original_removed_at && isBucketSource(t.source_key)) out.push(String(t.source_key));
  return out;
}

async function driver() {
  const { S3Driver, mediaS3Client } = await import('./s3Driver');
  return new S3Driver(() => mediaS3Client(config.aws.region));
}

/** Move every location that has objects; a location with nothing in it is skipped. */
async function moveAll(uris: string[], to: StorageTier, restored = false): Promise<number> {
  const d = await driver();
  let bytes = 0;
  for (const uri of uris) {
    if (!(await d.objects(uri)).length) continue;
    bytes += (await d.transition(uri, to, { restored })).bytes;
  }
  return bytes;
}

const ROW = `
  SELECT v.id, v.title, v.source_key, v.original_removed_at, v.archived_at, v.schema_id, v.channel_id, v.event_id,
         v.availability_override, v.created_at, v.available_from, v.available_until, v.availability_state, v.published,
         v.archive_tier, v.archive_tier_state, v.archive_tier_at, v.archive_tier_error,
         v.archive_restore_to, v.archive_restore_by, v.archive_restore_expected_by, v.retention_due_at,
         COALESCE(g.account_id, v.account_id) AS account_id
    FROM vod_assets v
    LEFT JOIN channels c ON c.id = v.channel_id
    LEFT JOIN events   e ON e.id = v.event_id
    LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)`;

async function logEvent(t: any, event: string, message: string) {
  const { log } = await import('./vodRetention');
  await log(t, event, { dueAt: t.retention_due_at ?? null, message }).catch(() => {});
}

/**
 * Move one archived title's media to the tier its policy asks for. Returns
 * what was done: 'moved', 'kept' (no tier, already there, nothing in the
 * bucket) or 'failed' (the error is kept on the title and the next sweep
 * tries again).
 */
export async function applyArchiveTier(t: any, wanted: ArchiveTier | null | undefined, by = 'retention:sweep'): Promise<'moved' | 'kept' | 'failed'> {
  if (!t.archived_at || t.archive_tier_state === 'restoring' || t.archive_tier_state === 'returning') return 'kept';
  if (!shouldMove(wanted, t.archive_tier)) return 'kept';
  const uris = await locationsOf(t);
  if (!uris.length) return 'kept';
  try {
    const bytes = await moveAll(uris, TIER[wanted!]);
    if (!bytes) return 'kept';
    await query(`UPDATE vod_assets SET archive_tier = $2, archive_tier_state = 'moved', archive_tier_at = now(), archive_tier_error = NULL WHERE id = $1`, [t.id, wanted]);
    await logEvent(t, 'tier_moved', `Its media (${(bytes / 1e9).toFixed(2)} GB) moved to ${wanted === 'glacier' ? 'Archive storage: a restore takes hours' : 'Infrequent access storage'}.`);
    await writeAudit(null, { accountId: t.account_id, userId: null, label: by, action: 'update', entityType: 'vod_asset', entityId: t.id,
      changes: { archive_tier: { from: t.archive_tier ?? null, to: wanted } }, snapshot: { title: t.title, bytes } }).catch(() => {});
    return 'moved';
  } catch (e: any) {
    await query(`UPDATE vod_assets SET archive_tier_error = $2 WHERE id = $1`, [t.id, String(e?.message ?? e).slice(0, 500)]);
    return 'failed';
  }
}

/** Back to the normal class, once nothing is in the way (IA, or a Glacier restore that landed). */
async function returnToStandard(t: any): Promise<boolean> {
  try {
    await moveAll(await locationsOf(t), 's3_standard', t.archive_tier === 'glacier');
    await query(`UPDATE vod_assets SET archive_tier = NULL, archive_tier_state = NULL, archive_tier_at = now(), archive_tier_error = NULL,
                   archive_restore_to = NULL, archive_restore_by = NULL, archive_restore_expected_by = NULL WHERE id = $1`, [t.id]);
    return true;
  } catch (e: any) {
    await query(`UPDATE vod_assets SET archive_tier_error = $2 WHERE id = $1`, [t.id, String(e?.message ?? e).slice(0, 500)]);
    return false;
  }
}

export class RestoreWait extends Error {
  constructor(public code: 'restore_wait' | 'restoring', msg: string, public expectedBy: Date, public waitMs: number) { super(msg); }
}

/**
 * Before an archived title is restored (POST /api/vod/:id/unarchive). Returns
 * 'now' when the route can restore it at once (no tier, or Infrequent access,
 * whose media is moved back afterwards by `afterUnarchive`), or 'started' when
 * a Glacier restore was asked for and the title waits for it. Throws
 * RestoreWait to say the wait first, or that one is already running.
 */
export async function beforeUnarchive(assetId: string, to: 'draft' | 'published', by: string, acceptWait: boolean, now = Date.now()): Promise<'now' | 'started'> {
  const t = await one<any>(`${ROW} WHERE v.id = $1`, [assetId]);
  if (!t || !t.archive_tier) return 'now';
  if (t.archive_tier_state === 'restoring') {
    const at = t.archive_restore_expected_by ? new Date(t.archive_restore_expected_by) : new Date(now);
    throw new RestoreWait('restoring', `It is already being restored from Archive storage, expected by ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC. It becomes ${t.archive_restore_to === 'published' ? 'published' : 'a draft'} then.`, at, Math.max(0, at.getTime() - now));
  }
  const wait = restoreWaitMs(t.archive_tier);
  if (!wait) return 'now';
  const expectedBy = new Date(now + wait);
  if (!acceptWait) {
    throw new RestoreWait('restore_wait', `Its media is in Archive storage. Bringing it back takes ${waitWords(wait)} (expected by ${expectedBy.toISOString().slice(0, 16).replace('T', ' ')} UTC); it stays archived until then and becomes ${to === 'published' ? 'published' : 'a draft'} when the media is back.`, expectedBy, wait);
  }
  const d = await driver();
  for (const uri of await locationsOf(t)) if ((await d.objects(uri)).length) await d.requestRestore(uri, RESTORE_SPEED);
  await query(`UPDATE vod_assets SET archive_tier_state = 'restoring', archive_restore_to = $2, archive_restore_by = $3, archive_restore_expected_by = $4, archive_tier_error = NULL WHERE id = $1`,
    [assetId, to, by.slice(0, 300), expectedBy]);
  await logEvent(t, 'tier_restoring', `Restore from Archive storage asked for by ${by}, expected by ${expectedBy.toISOString().slice(0, 16).replace('T', ' ')} UTC; then ${to === 'published' ? 'published' : 'a draft'}.`);
  return 'started';
}

/** After a title in Infrequent access is restored: move its media back to the normal class. */
export async function afterUnarchive(assetId: string): Promise<void> {
  const t = await one<any>(`${ROW} WHERE v.id = $1`, [assetId]);
  if (!t || t.archived_at || t.archive_tier !== 'infrequent') return;
  await query(`UPDATE vod_assets SET archive_tier_state = 'returning' WHERE id = $1`, [assetId]);
  if (await returnToStandard({ ...t, archive_tier_state: 'returning' })) await logEvent(t, 'tier_returned', 'Its media moved back to normal storage.');
}

/**
 * Finish a Glacier restore once S3 has made every object readable: copy the
 * media back to the normal class, then restore the title as asked. Returns
 * 'waiting' while S3 is still restoring.
 */
export async function finishRestore(t: any): Promise<'waiting' | 'restored' | 'failed'> {
  const d = await driver();
  for (const uri of await locationsOf(t)) {
    if (!(await d.objects(uri)).length) continue;
    if (!(await d.restoreStatus(uri)).ready) return 'waiting';
  }
  if (!(await returnToStandard(t))) return 'failed';
  const { unarchiveAsset } = await import('../publicStatus');
  const to = t.archive_restore_to === 'published' ? 'published' : 'draft';
  let refused: string | null = null;
  try { await unarchiveAsset(t.id, t.archive_restore_by ?? 'retention:sweep', to); }
  catch (e: any) {
    const { NotPublishable } = await import('../availability');
    if (!(e instanceof NotPublishable)) throw e;
    refused = e.message;
    await (await import('../publicStatus')).refreshPublicStatus(t.id);
  }
  await logEvent(t, 'tier_returned', refused
    ? `Its media is back from Archive storage. Restored as a draft: it could not be published (${refused}).`
    : `Its media is back from Archive storage. Restored as ${to === 'published' ? 'published' : 'a draft'}.`);
  await writeAudit(null, { accountId: t.account_id, userId: null, label: t.archive_restore_by ?? 'retention:sweep', action: 'update', entityType: 'vod_asset', entityId: t.id,
    changes: { editorial_state: { from: 'archived', to: refused ? 'draft' : to } }, snapshot: { fromArchiveTier: 'glacier', refused } }).catch(() => {});
  return 'restored';
}

export interface ArchiveTierResult { moved: number; restoring: number; restored: number; returned: number; failed: number }

/** One pass (the hourly retention sweep): archived titles to their tier, restores that landed, moves back. */
export async function sweepArchiveTiers(opts: { accountId?: string; limit?: number } = {}): Promise<ArchiveTierResult> {
  const res: ArchiveTierResult = { moved: 0, restoring: 0, restored: 0, returned: 0, failed: 0 };
  const limit = opts.limit ?? 200;
  const scope = opts.accountId ? `AND COALESCE(g.account_id, v.account_id) = $1` : '';
  const args = opts.accountId ? [opts.accountId] : [];
  // Only accounts where some rung sets an archive tier can move anything.
  const tiered = `->'retention'->>'archiveTier' IN ('infrequent','glacier')`;
  const accounts = await query<{ account_id: string }>(
    `SELECT account_id FROM (
       SELECT account_id FROM publishing_rules WHERE settings${tiered}
       UNION SELECT account_id FROM publishing_metadata_rules WHERE settings${tiered}
       UNION SELECT COALESCE(g.account_id, v.account_id) FROM vod_assets v
               LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
               LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
              WHERE v.availability_override${tiered}) a
      WHERE account_id IS NOT NULL ${opts.accountId ? 'AND account_id = $1' : ''}`, args);
  const { resolver } = await import('./vodRetention');
  for (const { account_id } of accounts) {
    const resolve = await resolver(account_id);
    const titles = await query<any>(`${ROW} WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.archived_at IS NOT NULL
        AND v.archive_tier_state IS DISTINCT FROM 'restoring' ORDER BY v.archived_at`, [account_id]);
    for (const t of titles) {
      if (res.moved >= limit) break;
      const r = await applyArchiveTier(t, resolve(t).settings?.retention?.archiveTier ?? null);
      if (r === 'moved') res.moved++; else if (r === 'failed') res.failed++;
    }
  }
  for (const t of await query<any>(`${ROW} WHERE v.archive_tier_state = 'restoring' ${scope}`, args)) {
    try {
      const r = await finishRestore(t);
      if (r === 'waiting') res.restoring++; else if (r === 'restored') res.restored++; else res.failed++;
    } catch (e: any) {
      res.failed++;
      await query(`UPDATE vod_assets SET archive_tier_error = $2 WHERE id = $1`, [t.id, String(e?.message ?? e).slice(0, 500)]);
    }
  }
  // Out of the archive in Infrequent access, and not back yet (the route's move failed or the task went).
  for (const t of await query<any>(`${ROW} WHERE v.archived_at IS NULL AND v.archive_tier IS NOT NULL ${scope}`, args)) {
    if (await returnToStandard(t)) res.returned++; else res.failed++;
  }
  return res;
}

/** For the asset drawer (GET /api/vod/:id): where its media is and what a restore involves. Null: the normal class. */
export function archiveStorageOf(row: any, now = Date.now()) {
  if (!row?.archive_tier) return null;
  const wait = restoreWaitMs(row.archive_tier);
  return {
    tier: row.archive_tier as ArchiveTier,
    state: row.archive_tier_state ?? 'moved',
    since: row.archive_tier_at ?? null,
    error: row.archive_tier_error ?? null,
    restoreWaitMs: wait,
    restoreWait: wait ? waitWords(wait) : null,
    restoreExpectedBy: row.archive_tier_state === 'restoring' ? row.archive_restore_expected_by : (wait ? new Date(now + wait).toISOString() : null),
    restoreTo: row.archive_restore_to ?? null,
  };
}
