// ============================================================================
//  REPACKAGE ON A CONFIRMED DRM CHANGE (build queue P4-3,
//  PUBLISHING_POLICIES.md "Encode-time vs delivery-time fields").
//
//  DRM is decided when a title is packaged (services/encodePolicy.ts). When a
//  rule, a title's own setting or a bulk change turns DRM on or off for
//  published titles, the save asks first (409 confirm_repackage, with the
//  count and the time of jobs it will take). Once confirmed, this queues a
//  `vod.repackage` job for each published title whose files no longer match
//  its policy.
//
//  WHY A JOB TYPE OF ITS OWN and not another vod.encode: the title is already
//  playable. A repackage must never make it read as "processing" or
//  "failed" (services/assetReadiness.ts reads the title's encode job), and a
//  FAST channel waiting on an encode must not wait on it. So it does not
//  touch `encode_job_id`, and a repackage that fails leaves the title playing
//  from the files it has.
//
//  PROTECTION NEVER DROPS DURING THE CHANGE. The repackage writes the new
//  files into a folder beside the title's own and swaps them in whole once
//  they are complete (services/jobs/handlers/vodEncode.ts), so viewers keep
//  getting the current files until then. Turning DRM off therefore keeps the
//  title encrypted until its clear files are ready, and turning it on keeps
//  it in the clear only as long as it already was.
//
//  A REPACKAGE IS AN ENCODE FROM THE ORIGINAL today: Shaka cannot take an
//  encrypted package back to clear, and Volt keeps no clear mezzanine of the
//  ladder. That is why it is projected from the title's length.
//
//  IN BATCHES: a change that touches a whole catalogue queues its jobs in
//  batches, each a little after the one before and behind new uploads
//  (lower priority), so a policy change never holds up the account's new
//  titles or takes every encode worker at once.
//
//  ON THE BUCKET STORE (VOD_STORE=s3, build queue P4-4) a title's segments
//  are cached by the CDN as immutable under their names for a year, so the
//  new files cannot replace the old ones under the same keys: old and new
//  (clear and encrypted) would mix. The repackage uploads under a prefix of
//  its own, vod/<id>/r-<job>-a<n>/ (fast/vodStore.ts repackSubdir), and
//  master_key moves there; everything that reads a title's files follows
//  master_key. The old package is removed by `vod.repackage.cleanup` once
//  no viewer can still be reading it (oldPackageGraceMs).
// ============================================================================
import { one, query } from '../db';
import { resolveForAsset } from './publishingRules';
import { packagedOf, pendingFields } from './encodePolicy';

export const VOD_REPACKAGE = 'vod.repackage';
/** Titles per batch. */
export const REPACKAGE_BATCH = 25;
/** Each batch starts this long after the one before it. */
export const REPACKAGE_BATCH_GAP_MS = 10 * 60_000;
/** Behind new uploads (100) and QC (40): lower runs first. */
export const REPACKAGE_PRIORITY = 150;

/**
 * PURE. The job time a title's repackage is projected to take, in seconds:
 * an encode of the ladder from the original runs at about real time on one
 * encode worker (Volt's cloud encode tasks; faster for short titles, slower
 * for UHD), plus about 30 s to fetch the original, ask for the key and
 * package. A projection for the confirmation, not a promise.
 */
export function repackageSeconds(durationMs: number | null | undefined): number {
  const d = Number(durationMs);
  return Math.round(30 + (Number.isFinite(d) && d > 0 ? d / 1000 : 0));
}

/** PURE. "about 3 h", "about 95 min", "about 2 min" of jobs: minutes under two hours. */
export function repackageTimeLabel(seconds: number): string {
  if (seconds >= 7200) return `about ${Math.round(seconds / 3600)} h`;
  return `about ${Math.max(1, Math.round(seconds / 60))} min`;
}

export interface RepackageScope { kind: 'account' | 'schema' | 'owner' | 'metadata' | 'asset' | 'assets'; id: string | null; ids?: string[] }

export interface RepackageOutcome {
  /** Repackage jobs queued (or already queued for that title). */
  queued: number;
  /** Projected job time of what was queued, in seconds. */
  seconds: number;
  /** Published titles that need it but could not be queued, and why. */
  waiting: { id: string; title: string; reason: string }[];
  jobs: string[];
}

/**
 * After a confirmed change: queue a repackage for every published title in
 * the scope whose files no longer carry what its policy asks for. Titles
 * already matching (a change that was undone, a title encoded since) are
 * left alone, so confirming twice queues nothing twice.
 */
export async function queueRepackage(accountId: string, scope: RepackageScope, opts: { createdBy?: string | null } = {}): Promise<RepackageOutcome> {
  const out: RepackageOutcome = { queued: 0, seconds: 0, waiting: [], jobs: [] };
  // A metadata rule governs whichever titles meet it: every published title
  // of the account is looked at, and only those whose files disagree move.
  const where = scope.kind === 'schema' ? 'AND v.schema_id = $2'
    : scope.kind === 'owner' ? 'AND (v.channel_id = $2 OR v.event_id = $2)'
    : scope.kind === 'asset' ? 'AND v.id = $2'
    : scope.kind === 'assets' ? 'AND v.id = ANY($2::uuid[])' : '';
  const titles = await query<any>(
    `SELECT v.id, v.title, v.schema_id, v.channel_id, v.event_id, v.availability_override, v.policy_snapshot, v.encode_result,
            v.source_key, v.duration_ms, v.ladder_group_id, v.master_key, v.ingest->'siteSource' AS site_source
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.archived_at IS NULL
        AND v.availability_state IN ('available', 'scheduled') AND v.master_key IS NOT NULL ${where}
      ORDER BY v.created_at, v.id`,
    where ? [accountId, scope.kind === 'assets' ? (scope.ids ?? []) : scope.id] : [accountId]);
  const due: any[] = [];
  for (const t of titles) {
    const r = await resolveForAsset(accountId, t);
    if (!pendingFields({ drm: !!r.settings.protection?.drm }, { drm: packagedOf(t).drm }).length) continue;
    due.push(t);
  }
  if (!due.length) return out;
  const { enqueue } = await import('./jobs/queue');
  const start = Date.now();
  let n = 0;
  for (const t of due) {
    const payload = { vodAssetId: t.id, accountId, ladderGroupId: t.ladder_group_id ?? null, repackage: true };
    const dedupeKey = `${VOD_REPACKAGE}:${t.id}`;
    if (!t.source_key) {
      // Kept at a site: its keys need the proxy of H5-4. In the archive: the
      // restore is started and the repackage queued once the original lands
      // (H3-5d), the same as an encode. Otherwise nothing to package from.
      if (t.site_source?.siteId) {
        out.waiting.push({ id: t.id, title: t.title, reason: 'its original is kept at a site, where DRM packaging is not built yet; it keeps its current files' });
        continue;
      }
      const { restoreThen } = await import('./archive/originals');
      const r = await restoreThen(t.id, { kind: 'job', type: VOD_REPACKAGE, payload, dedupeKey, priority: REPACKAGE_PRIORITY, maxAttempts: 2 } as any).catch(() => null);
      if (!r) {
        out.waiting.push({ id: t.id, title: t.title, reason: 'its original is not kept, so it cannot be packaged again; it keeps its current files' });
        continue;
      }
      out.jobs.push(r.jobId);
      out.queued++;
      out.seconds += repackageSeconds(t.duration_ms);
      continue;
    }
    const batch = Math.floor(n / REPACKAGE_BATCH);
    const job = await enqueue({
      type: VOD_REPACKAGE,
      payload: { ...payload, sourcePath: t.source_key },
      dedupeKey, priority: REPACKAGE_PRIORITY, maxAttempts: 2,
      runAfter: batch ? new Date(start + batch * REPACKAGE_BATCH_GAP_MS) : undefined,
      createdBy: opts.createdBy ?? null,
    });
    out.jobs.push(job.id);
    out.queued++;
    out.seconds += repackageSeconds(t.duration_ms);
    n++;
  }
  return out;
}

/** The title's repackage in flight, if any: for the Encode tab. */
export async function repackageInFlight(assetId: string): Promise<{ jobId: string; state: string; runAfter: string | null } | null> {
  const j = await one<any>(
    `SELECT id, state, run_after FROM jobs WHERE dedupe_key = $1 AND state IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`,
    [`${VOD_REPACKAGE}:${assetId}`]);
  return j ? { jobId: j.id, state: j.state, runAfter: j.run_after ? new Date(j.run_after).toISOString() : null } : null;
}

/**
 * Why a queued repackage has nothing left to do (null: it is still due):
 * the title is gone, or its files already carry what its policy asks for.
 */
export async function stillPending(assetId: string): Promise<string | null> {
  const t = await one<any>(
    `SELECT v.id, v.schema_id, v.channel_id, v.event_id, v.availability_override, v.policy_snapshot, v.encode_result, v.master_key,
            COALESCE(g.account_id, v.account_id) AS account_id
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND v.archived_at IS NULL`, [assetId]);
  if (!t?.account_id) return 'the title is gone';
  const r = await resolveForAsset(t.account_id, t);
  if (!pendingFields({ drm: !!r.settings.protection?.drm }, { drm: packagedOf(t).drm }).length)
    return 'its files already carry what its publishing policy asks for';
  return null;
}

// ---------------------------------------------------------------------------
//  THE OLD PACKAGE ON THE BUCKET (P4-4). Once master_key points at the new
//  prefix, the old files are no longer listed by any playlist Volt serves,
//  but a viewer who started before the switch still has the old media
//  playlists loaded (an on-demand player reads them once) and asks for old
//  segments until the end of the title. So the old prefix goes after the
//  playlist cache time (60 s, fast/vodStore.ts) PLUS the title's length and
//  a margin, not after the cache time alone: deleting sooner would stop
//  every viewer who was mid-title at the moment of the switch.
// ---------------------------------------------------------------------------
export const VOD_REPACKAGE_CLEANUP = 'vod.repackage.cleanup';
/** The playlists' Cache-Control max-age on the bucket (uploadVodDir). */
const PLAYLIST_CACHE_MS = 60_000;
/** Margin for a paused viewer, a slow CDN and clock skew. */
const OLD_PACKAGE_MARGIN_MS = 10 * 60_000;
/** A title with no length is given this long, as if it were a feature film. */
const UNKNOWN_LENGTH_MS = 3 * 3_600_000;

/** PURE. How long the old package stays on the bucket after the switch. */
export function oldPackageGraceMs(durationMs: number | null | undefined): number {
  const d = Number(durationMs);
  return PLAYLIST_CACHE_MS + OLD_PACKAGE_MARGIN_MS + (Number.isFinite(d) && d > 0 ? d : UNKNOWN_LENGTH_MS);
}

/** Folders at the asset's root that are not the packaging's own and outlive a repackage. */
const KEPT_AT_ROOT = new Set(['ladders', 'reframe']);

/**
 * PURE. Which of the keys under an old package's folder go. `oldBase` and
 * `currentBase` are folders (vod/<id> or vod/<id>/r-<job>-a<n>, no slash at
 * the end). When the old package is the asset's root folder, FAST ladder
 * variants, reframes and every repackage folder (the current one, and one a
 * later repackage is still writing) stay. A repackage folder goes whole.
 * Nothing ever goes when the old and current folders are the same, or when
 * the old folder is not one of the asset's own.
 */
export function stalePackageKeys(keys: string[], o: { assetId: string; oldBase: string; currentBase: string | null }, isRepackDir: (name: string) => boolean): string[] {
  const root = `vod/${o.assetId}`;
  const oldBase = String(o.oldBase).replace(/\/+$/, '');
  const cur = o.currentBase ? String(o.currentBase).replace(/\/+$/, '') : null;
  if (!oldBase || oldBase === cur) return [];
  const sub = oldBase === root ? null : oldBase.slice(root.length + 1);
  if (!oldBase.startsWith(root) || (sub !== null && (!oldBase.startsWith(root + '/') || sub.includes('/') || !isRepackDir(sub)))) return [];
  return keys.filter((k) => {
    if (!k.startsWith(oldBase + '/')) return false;
    if (cur && k.startsWith(cur + '/')) return false;
    if (sub !== null) return true;
    const first = k.slice(root.length + 1).split('/')[0];
    return !(KEPT_AT_ROOT.has(first) || isRepackDir(first));
  });
}

/** After a repackage on the bucket: remove the old package once its grace is over. */
export async function queueOldPackageCleanup(assetId: string, oldBase: string, durationMs: number | null | undefined): Promise<string | null> {
  const { enqueue } = await import('./jobs/queue');
  const j = await enqueue({
    type: VOD_REPACKAGE_CLEANUP, payload: { vodAssetId: assetId, oldBase },
    dedupeKey: `${VOD_REPACKAGE_CLEANUP}:${assetId}:${oldBase}`, priority: REPACKAGE_PRIORITY, maxAttempts: 3,
    runAfter: new Date(Date.now() + oldPackageGraceMs(durationMs)),
  });
  return j?.id ?? null;
}

/**
 * The cleanup job: delete the old package's keys, reading where the title's
 * master is NOW (a later repackage may have moved it again, or the title
 * may be gone, in which case its files went to the restore bin with it).
 */
export async function removeOldPackage(assetId: string, oldBase: string): Promise<{ removed: number; reason?: string }> {
  const a = await one<any>(`SELECT id, master_key FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) return { removed: 0, reason: 'the title is gone; its files went with it' };
  const { bucketBaseOf } = await import('./companions/bucketTracks');
  const { listPrefix, REPACK_DIR } = await import('./fast/vodStore');
  const current = bucketBaseOf(a.id, a.master_key);
  if (!current) return { removed: 0, reason: 'the title\'s master is not in the bucket' };
  const keys = (await listPrefix(`${String(oldBase).replace(/\/+$/, '')}/`)).map((k) => k.key);
  const gone = stalePackageKeys(keys, { assetId: a.id, oldBase, currentBase: current }, (n) => REPACK_DIR.test(n));
  if (!gone.length) return { removed: 0 };
  const { deleteKeys } = await import('./fast/vodStore');
  await deleteKeys(gone);
  return { removed: gone.length };
}
