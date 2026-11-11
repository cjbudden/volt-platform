// ============================================================================
//  MIRROR MODE (build queue H3-10, decided by Christian on 11 Nov 2026).
//
//  A copy rule entry with `mode: 'mirror'` keeps its target in step with
//  Volt, deletes included. Every other copy is archive mode: Volt never
//  deletes it. This deletes files at the CUSTOMER'S OWN SITE, so it is built
//  to err on the side of keeping:
//
//    - A copy is only ever deleted when it was made under a mirror rule
//      (`archive_copies.mode`, set by copyOnRule) AND a rule of the account
//      still mirrors to that target when the delete is due. A rule switched
//      back to archive keeps what is there.
//    - The grace period starts only once the asset (or the sidecar) has left
//      Volt for good. An asset deleted from the Media Library sits in the
//      restore bin first: while the bin item is held (it can be restored)
//      nothing starts. A caption or companion file removed from an asset has
//      no bin and leaves at once.
//    - The grace period is the target's: 7 days by default, 0 to 90.
//    - A restore cancels any pending delete (trash.ts restoreItem, and this
//      pass for anything that came back another way).
//    - The agent removes only the file Volt put there: it reads it back
//      first and keeps it if it no longer matches the checksum Volt recorded
//      (someone changed it at the site), and says so.
//    - Every delete the agent makes, and every copy it kept, is audited.
//
//  Recordings (H3-7) are copies of a stretch of a stream, not of an asset,
//  and stay archive mode: there is no "leaving Volt" event for them yet.
// ============================================================================
import { one, query } from '../../db';
import { enqueue, sitePool, type JobRow } from '../jobs/queue';
import { ARCHIVE_DELETE, targetForAgent, type Verdict } from './archive';
export const COPY_MODES = ['archive', 'mirror'] as const;
export type CopyMode = typeof COPY_MODES[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SQL: copy `c` is of something that has left Volt for good. Its asset's row
 * is gone (the link was set to NULL) and no HELD bin item would put it back,
 * or it is a caption or companion file of an asset that still exists but no
 * longer has that file. Recordings never match.
 */
export const GONE_FOR_GOOD = `(
  c.stream_id IS NULL AND (
    (c.vod_asset_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM trash_items ti, jsonb_array_elements(ti.relinks) rl
        WHERE ti.state = 'held' AND rl->>'table' LIKE '%archive_copies' AND (rl->'ids') ? c.id::text))
    OR (c.vod_asset_id IS NOT NULL AND c.what ~ '^(captions|companion):' AND NOT EXISTS (
       SELECT 1 FROM vod_asset_files f WHERE f.id::text = split_part(c.what, ':', 2)))
  ))`;

/** SQL: a rule of the account still says mirror for target `c.target_id`. */
const MIRRORS = (col: string) => `COALESCE(${col}->'archive'->'copies', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('targetId', c.target_id::text, 'mode', 'mirror'))`;
/**
 * SQL: a rung of the account's rules still says mirror for target
 * `c.target_id`: the account, a content type, a channel or event, a metadata
 * rule, or (while the asset exists) the asset's own rung. A mirror set only
 * on a deleted asset's own rung cannot be checked any more, so that copy is
 * kept: when unsure, keep.
 */
const STILL_MIRRORED = `(
  EXISTS (SELECT 1 FROM publishing_rules pr WHERE pr.account_id = c.account_id AND ${MIRRORS('pr.settings')})
  OR EXISTS (SELECT 1 FROM publishing_metadata_rules mr WHERE mr.account_id = c.account_id AND mr.enabled AND ${MIRRORS('mr.settings')})
  OR EXISTS (SELECT 1 FROM vod_assets va WHERE va.id = c.vod_asset_id AND ${MIRRORS('va.availability_override')}))`;

/**
 * Record the mode a rule entry asked for on the copies of one asset at one
 * target (called by copyOnRule each time the rule fires). Copies already
 * removed, and recordings, are left alone.
 */
export async function markMode(targetId: string, assetId: string, mode: CopyMode): Promise<void> {
  await query(
    `UPDATE archive_copies SET mode = $3, updated_at = now()
      WHERE target_id = $1 AND vod_asset_id = $2 AND stream_id IS NULL AND state <> 'removed' AND mode <> $3`, [targetId, assetId, mode]);
}

/** Who did it, for the audit trail: the site agent at a named site. */
async function siteLabel(targetId: string): Promise<string> {
  const s = await one<any>(`SELECT s.name FROM archive_targets t JOIN sites s ON s.id = t.site_id WHERE t.id = $1`, [targetId]).catch(() => null);
  return `site agent${s?.name ? ` at ${s.name}` : ''} (mirror mode)`;
}

async function audit(c: any, action: 'update' | 'delete', snapshot: Record<string, unknown>) {
  const { writeAudit } = await import('../audit');
  await writeAudit(null, { accountId: c.account_id, userId: null, label: await siteLabel(c.target_id), action, entityType: 'archive_copy', entityId: c.id,
    snapshot: { targetId: c.target_id, storedPath: c.stored_path, sha256: c.sha256, bytes: c.bytes === null ? null : Number(c.bytes), what: c.what, ...snapshot } })
    .catch((e) => console.warn('[archive] mirror audit not written', c.id, e?.message ?? e));
}

/**
 * The mirror pass, run by the scheduler (orchestrator/index.ts) every 15
 * minutes; bounded per step.
 *   1. Anything that came back (restored, or its file is there again) has
 *      its pending delete cleared and its queued delete job cancelled.
 *   2. Mirror copies of things gone for good start their target's grace.
 *   3. Deletes that are due go to the site as `archive.delete` jobs, if the
 *      account still holds the add-on, the target and site are active and a
 *      rule still mirrors to the target; if no rule does, the copy is kept
 *      and becomes archive mode, audited.
 */
export async function mirrorPass(opts: { limit?: number; accountId?: string; now?: Date } = {}): Promise<{ cancelled: number; started: number; queued: number; kept: number }> {
  const limit = opts.limit ?? 200, acct = opts.accountId ?? null, now = opts.now ?? new Date();
  const out = { cancelled: 0, started: 0, queued: 0, kept: 0 };

  const back = await query<any>(
    `SELECT c.id, c.delete_job_id FROM archive_copies c
      WHERE c.delete_after IS NOT NULL AND c.state <> 'removed' AND NOT ${GONE_FOR_GOOD}
        AND ($2::uuid IS NULL OR c.account_id = $2) LIMIT $1`, [limit, acct]);
  for (const r of back) { await cancelPending([r.id]); out.cancelled++; }

  const started = await query<any>(
    `UPDATE archive_copies c SET delete_after = $3::timestamptz + make_interval(days => t.mirror_grace_days), updated_at = now()
       FROM archive_targets t
      WHERE t.id = c.target_id AND c.id IN (
        SELECT c.id FROM archive_copies c
         WHERE c.mode = 'mirror' AND c.delete_after IS NULL AND c.stored_path IS NOT NULL AND c.state <> 'removed'
           AND ${GONE_FOR_GOOD} AND ($2::uuid IS NULL OR c.account_id = $2) LIMIT $1)
      RETURNING c.id`, [limit, acct, now.toISOString()]);
  out.started = started.length;

  const due = await query<any>(
    `SELECT c.*, ${STILL_MIRRORED} AS still_mirrored
       FROM archive_copies c
       JOIN archive_targets t ON t.id = c.target_id
       JOIN sites s ON s.id = t.site_id
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN jobs dj ON dj.id = c.delete_job_id
      WHERE c.mode = 'mirror' AND c.delete_after IS NOT NULL AND c.delete_after <= $3 AND c.state <> 'removed'
        AND c.stored_path IS NOT NULL AND ${GONE_FOR_GOOD}
        AND t.status = 'active' AND s.status = 'active' AND 'mirror_archive' = ANY(COALESCE(a.licences, '{}'))
        AND (dj.id IS NULL OR (dj.state NOT IN ('queued', 'running') AND (dj.state <> 'failed' OR dj.finished_at < now() - interval '1 day')))
        AND ($2::uuid IS NULL OR c.account_id = $2)
      ORDER BY c.delete_after LIMIT $1`, [limit, acct, now.toISOString()]);
  for (const c of due) {
    if (!c.still_mirrored) {
      await query(`UPDATE archive_copies SET mode = 'archive', delete_after = NULL, updated_at = now() WHERE id = $1`, [c.id]);
      await audit(c, 'update', { kept: true, why: 'No copy rule mirrors to this target any more, so the copy is kept (archive mode)' });
      out.kept++;
      continue;
    }
    try { await queueDelete(c); out.queued++; }
    catch (e: any) { console.warn(`[archive] mirror delete not queued for ${c.id}:`, e?.message ?? e); }
  }
  return out;
}

/** Clear pending deletes and cancel delete jobs not yet leased (a restore). */
export async function cancelPending(copyIds: string[]): Promise<void> {
  const ids = copyIds.filter((x) => UUID.test(String(x)));
  if (!ids.length) return;
  await query(`UPDATE jobs SET state = 'cancelled', finished_at = now(), lease_until = NULL
                WHERE state = 'queued' AND id IN (SELECT delete_job_id FROM archive_copies WHERE id = ANY($1::uuid[]) AND delete_job_id IS NOT NULL)`, [ids]);
  await query(`UPDATE archive_copies SET delete_after = NULL, updated_at = now() WHERE id = ANY($1::uuid[]) AND state <> 'removed' AND delete_after IS NOT NULL`, [ids]);
}

async function queueDelete(c: any): Promise<string> {
  const t = await one<any>(`SELECT * FROM archive_targets WHERE id = $1`, [c.target_id]);
  let files: { path: string; bytes: number; sha256: string | null }[] | null = null;
  if (c.what === 'package') {
    const { packageFilesOf } = await import('./packages');
    files = await packageFilesOf(c);
    // Without the list of what Volt wrote, Volt cannot tell its files from
    // anyone else's in that folder: keep it.
    if (!files) throw new Error('the list of files this package copy wrote is gone');
  }
  const job = await enqueue({
    type: ARCHIVE_DELETE, pool: sitePool(t.site_id), createdBy: null, maxAttempts: 3,
    payload: { copyId: c.id, storedPath: c.stored_path, sha256: c.sha256, target: targetForAgent(t), ...(files ? { files } : {}) },
  });
  await query(`UPDATE archive_copies SET delete_job_id = $2, updated_at = now() WHERE id = $1`, [c.id, job.id]);
  return job.id;
}

/**
 * Judge what the agent reports for a mirror delete. Removed, or already
 * gone: the copy is `removed` and the row says when. Kept because the file
 * at the target no longer matches what Volt copied: Volt stops trying
 * (archive mode) and says why. Each is audited.
 */
export async function judgeDelete(job: JobRow, result: any): Promise<Verdict> {
  const copyId = job.payload?.copyId;
  const c = UUID.test(String(copyId)) ? await one<any>(`SELECT * FROM archive_copies WHERE id = $1`, [copyId]) : null;
  if (!c) return { ok: true, apply: async () => {} };
  if (result?.present === false || result?.deleted === true) {
    const gone = result?.present === false;
    return { ok: true, apply: async () => {
      await query(
        `UPDATE archive_copies SET state = 'removed', removed_at = now(), delete_after = NULL,
                error = $2, error_code = $3, updated_at = now() WHERE id = $1`,
        [c.id, gone ? 'Mirror mode: the copy was already gone from the target when its delete ran' : null, gone ? 'already_gone' : null]);
      await audit(c, 'delete', { jobId: job.id, mirror: true, removed: !gone, alreadyGone: gone, files: result?.files ?? undefined, missingFiles: result?.missingFiles ?? undefined });
    } };
  }
  if (result?.present === true && result?.deleted === false && result?.changed === true) {
    const n = Number(result?.changedFiles) > 0 ? Number(result.changedFiles) : 0;
    const why = c.what === 'package'
      ? `Mirror mode kept this package: ${n} of its file${n === 1 ? '' : 's'} at the target changed after Volt copied ${n === 1 ? 'it' : 'them'}`
      : 'Mirror mode kept this copy: the file at the target changed after Volt copied it, so it is not Volt\'s to delete';
    return { ok: true, apply: async () => {
      await query(`UPDATE archive_copies SET mode = 'archive', delete_after = NULL, error = $2, error_code = 'changed_kept', updated_at = now() WHERE id = $1`, [c.id, why]);
      await audit(c, 'update', { jobId: job.id, mirror: true, kept: true, why, foundSha256: typeof result?.sha256 === 'string' ? result.sha256 : undefined });
    } };
  }
  return { ok: false, status: 400, code: 'bad_result', message: 'A mirror delete reports present and deleted (and changed when it kept the file)' };
}

/** A delete attempt failed: the reason is kept on the copy; the pass tries again a day after the last attempt. */
export async function deleteFailed(job: JobRow, message: string, code: string | null, exhausted: boolean): Promise<void> {
  const copyId = job.payload?.copyId;
  if (!UUID.test(String(copyId))) return;
  await query(`UPDATE archive_copies SET error = $2, error_code = $3, updated_at = now() WHERE id = $1 AND delete_job_id = $4`,
    [copyId, `${exhausted ? 'The mirror delete failed; it is tried again tomorrow' : 'The mirror delete is being retried'}: ${message}`.slice(0, 2000), code, job.id]);
}
