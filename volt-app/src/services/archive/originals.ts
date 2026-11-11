// ============================================================================
//  COPY-BEFORE-DELETE FOR ORIGINALS (build queue H3-5, decided by Christian on
//  11 Nov 2026; HYBRID_SITES.md "Add-on: Mirror and Archive").
//
//  A retention rule with `original_after_days` removes an asset's ORIGINAL
//  file from the cloud that many days after it landed, and only once a
//  verified archive copy of that very file is held at one of the account's
//  storage targets. Only the original goes: the encoded renditions, the
//  images and the metadata stay, so the title keeps playing. The original
//  comes back from the archive when it is needed for a re-encode: RESTORE
//  (H3-5b, at the end of this file) has a server at the copy's site read the
//  copy and upload it, and the cloud checks it against the archived checksum
//  before the asset points at it again.
//
//  Four rules, each one there because the obvious version gets it wrong:
//
//  1. NEVER THE ONLY COPY. The copy must be `verified` (read back from the
//     target and matched), of THIS original (same source address: a replaced
//     file is not covered by the old one's copy), and its checksum must have
//     been compared with the original's. A copy that is corrupt, missing,
//     failed, still being made or of an earlier file keeps the original.
//  2. SAY WHY IT WAITS. A rule that is due and cannot act writes the reason on
//     the asset (`original_wait_code`, `original_wait`), so the console can
//     show it instead of a rung that silently never fires.
//  3. NOT WHILE SOMETHING READS IT. A queued or running job that names the
//     asset (an encode, a FAST preparation) or another copy still being made
//     from it keeps the original until it is done.
//  4. THE REACH IS THE RULE'S. Through a channel or an event as before; an
//     upload or a watch folder file (no channel, no event) only by an account
//     rule that includes uploads (rules made before H3-5 do not).
//
//  The most specific scope whose rule says anything about originals decides
//  (channel, then event, then account), the way copy rules resolve.
// ============================================================================
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { one, query } from '../../db';
import { ApiError } from '../../util/http';
import { hasLicence } from '../sites/licences';
import { deleteVodSource, fetchVodSource, isBucketSource, parseSourceUri, vodSourceRoot } from '../media/vodSource';
import { writeAudit } from '../audit';
import { enqueue, sitePool, type JobRow } from '../jobs/queue';

const DAY = 86_400_000;

export type OriginalWaitCode =
  | 'no_licence' | 'no_copy' | 'copy_pending' | 'copy_failed' | 'copy_corrupt'
  | 'copy_missing' | 'copy_stale' | 'copy_unchecked' | 'in_use' | 'not_removable';

export interface OriginalRule { id: string; name: string; original_after_days: number; scope: 'channel' | 'event' | 'account' }

/** The rule that decides when this asset's original leaves the cloud, or null. */
export async function originalRuleFor(a: { channel_id?: string | null; event_id?: string | null; account_id?: string | null; via_own?: boolean }): Promise<OriginalRule | null> {
  const scopes: ['channel' | 'event' | 'account', string, string | null | undefined][] = [
    ['channel', 'channel_id', a.channel_id], ['event', 'event_id', a.event_id], ['account', 'account_id', a.account_id],
  ];
  for (const [scope, col, id] of scopes) {
    if (!id) continue;
    const uploads = scope === 'account' && a.via_own ? ' AND include_uploads' : '';
    const r = await one<any>(
      `SELECT id, name, original_after_days FROM retention_rules
        WHERE ${col} = $1 AND enabled AND original_after_days IS NOT NULL${uploads}
        ORDER BY created_at LIMIT 1`, [id]);
    if (r) return { ...r, scope };
  }
  return null;
}

export interface Verdict {
  ok: boolean;
  code?: OriginalWaitCode;
  message?: string;
  copy?: { id: string; targetId: string; targetName: string; storedPath: string | null; sha256: string | null };
}

/**
 * May the original go now? Pure over the asset and its copies, so the suite
 * can try every state without a site agent.
 */
export function judgeOriginal(asset: { source_key: string; sha256?: string | null }, copies: any[], busyJobs = 0): Verdict {
  const own = copies.filter((c) => c.what === 'source');
  const ofThis = own.filter((c) => c.source_uri === asset.source_key);
  const assetSha = typeof asset.sha256 === 'string' ? asset.sha256.toLowerCase() : null;
  const sound = (c: any) => c.state === 'verified' && !!c.sha256 && !!c.expected_sha256
    && c.sha256 === c.expected_sha256 && (!assetSha || assetSha === c.sha256);
  const good = ofThis.filter(sound)
    .sort((x, y) => new Date(y.verified_at ?? 0).getTime() - new Date(x.verified_at ?? 0).getTime())[0];
  const t = (c: any) => c.target_name ?? 'the storage target';

  // Another copy still being made reads the original: wait for it, even with
  // a verified copy elsewhere, or that copy would fail half way.
  const pending = ofThis.find((c) => c.state === 'queued' || c.state === 'copying');
  if (good && pending) {
    return { ok: false, code: 'copy_pending', message: `The archive copy to ${t(pending)} is still being made from the original. It is removed once that copy is finished.` };
  }
  if (good && busyJobs > 0) {
    return { ok: false, code: 'in_use', message: `A job is using the original (an encode or a preparation). It is removed after the job finishes.` };
  }
  if (good) {
    return { ok: true, copy: { id: good.id, targetId: good.target_id, targetName: t(good), storedPath: good.stored_path ?? null, sha256: good.sha256 } };
  }
  if (pending) {
    return { ok: false, code: 'copy_pending', message: `The archive copy to ${t(pending)} is not finished yet. The original is removed from the cloud once that copy is verified.` };
  }
  const unchecked = ofThis.find((c) => c.state === 'verified');
  if (unchecked) {
    return { ok: false, code: 'copy_unchecked', message: `The copy at ${t(unchecked)} could not be compared with the original's checksum, so the original stays in the cloud.` };
  }
  const corrupt = ofThis.find((c) => c.state === 'corrupt');
  if (corrupt) return { ok: false, code: 'copy_corrupt', message: `The archive copy at ${t(corrupt)} no longer matches the original, so the original stays in the cloud. Copy it again.` };
  const missing = ofThis.find((c) => c.state === 'missing');
  if (missing) return { ok: false, code: 'copy_missing', message: `The archive copy at ${t(missing)} is no longer there, so the original stays in the cloud. Copy it again.` };
  const failed = ofThis.find((c) => c.state === 'failed');
  if (failed) return { ok: false, code: 'copy_failed', message: `The archive copy to ${t(failed)} failed${failed.error ? `: ${failed.error}` : ''}. The original stays in the cloud until a copy is verified.` };
  if (own.length) {
    return { ok: false, code: 'copy_stale', message: `The archive copy at ${t(own[0])} is of an earlier original (the file was replaced), so this one stays until it is copied too.` };
  }
  return { ok: false, code: 'no_copy', message: 'No archive copy of the original has been made. A copy rule or Copy to archive makes one; the original stays in the cloud until the copy is verified.' };
}

const landedAt = (a: any) => new Date(a.original_restored_at ?? a.created_at).getTime();

const ASSET_SELECT = `
  SELECT v.id, v.title, v.channel_id, v.event_id, v.source_key, v.sha256, v.created_at,
         v.original_removed_at, v.original_removed_key, v.original_copy_id, v.original_wait_code, v.original_wait, v.original_checked_at,
         v.original_restore_job_id, v.original_restore_error, v.original_restored_at,
         COALESCE(gc.account_id, ge.account_id, CASE WHEN c.id IS NULL AND e.id IS NULL THEN v.account_id END) AS account_id,
         (c.id IS NULL AND e.id IS NULL) AS via_own
    FROM vod_assets v
    LEFT JOIN channels c ON c.id = v.channel_id
    LEFT JOIN events   e ON e.id = v.event_id
    LEFT JOIN groups  gc ON gc.id = c.group_id
    LEFT JOIN groups  ge ON ge.id = e.group_id`;

async function copiesOf(accountId: string, assetId: string): Promise<any[]> {
  return query<any>(
    `SELECT c.*, t.name AS target_name FROM archive_copies c JOIN archive_targets t ON t.id = c.target_id
      WHERE c.vod_asset_id = $1 AND c.account_id = $2 AND c.what = 'source'`, [assetId, accountId]);
}

async function busyJobsOf(assetId: string): Promise<number> {
  const r = await one<any>(
    `SELECT count(*)::int AS n FROM jobs WHERE state IN ('queued','running') AND payload->>'vodAssetId' = $1`, [assetId]);
  return r?.n ?? 0;
}

async function verdictFor(a: any): Promise<Verdict> {
  if (!(await hasLicence(a.account_id, 'mirror_archive'))) {
    return { ok: false, code: 'no_licence', message: 'The Mirror and Archive add-on is off for this account, so no archive copy can be made and the original stays in the cloud.' };
  }
  return judgeOriginal(a, await copiesOf(a.account_id, a.id), await busyJobsOf(a.id));
}

export interface OriginalsResult { considered: number; removed: number; waiting: number; failed: number }

/** Walk the assets whose original a rule may remove. Bounded per pass. */
export async function sweepOriginals(opts: { limit?: number; accountId?: string; dryRun?: boolean; actor?: string; now?: number } = {}): Promise<OriginalsResult> {
  const res: OriginalsResult = { considered: 0, removed: 0, waiting: 0, failed: 0 };
  const now = opts.now ?? Date.now();
  const actor = opts.actor ?? 'retention';
  const rows = await query<any>(
    `SELECT * FROM (${ASSET_SELECT}
      WHERE v.source_key IS NOT NULL AND v.original_removed_at IS NULL) a
     WHERE a.account_id IS NOT NULL AND ($2::uuid IS NULL OR a.account_id = $2)
       -- Only assets some rule could act on, so the pass does not read the
       -- whole library every time.
       AND EXISTS (SELECT 1 FROM retention_rules rr WHERE rr.enabled AND rr.original_after_days IS NOT NULL
                     AND (rr.channel_id = a.channel_id OR rr.event_id = a.event_id
                          OR (rr.account_id = a.account_id AND (NOT a.via_own OR rr.include_uploads))))
     ORDER BY a.original_checked_at NULLS FIRST, a.created_at
     LIMIT $1`, [opts.limit ?? 500, opts.accountId ?? null]);

  for (const a of rows) {
    res.considered++;
    const rule = await originalRuleFor(a);
    // A restored original (H3-5b) landed again: its clock starts at the restore,
    // so it is not taken out again on the next pass before the re-encode it
    // was brought back for.
    const due = rule ? landedAt(a) + rule.original_after_days * DAY : Infinity;
    if (!rule || due > now) {
      if (!opts.dryRun) {
        await query(`UPDATE vod_assets SET original_wait_code = NULL, original_wait = NULL, original_checked_at = now() WHERE id = $1`, [a.id]);
      }
      continue;
    }
    const v = await verdictFor(a);
    if (!v.ok) {
      res.waiting++;
      if (!opts.dryRun) {
        await query(`UPDATE vod_assets SET original_wait_code = $2, original_wait = $3, original_checked_at = now() WHERE id = $1`, [a.id, v.code, v.message]);
      }
      continue;
    }
    if (opts.dryRun) { res.removed++; continue; }
    try {
      await removeOriginal(a, v, rule, actor);
      res.removed++;
    } catch (e: any) {
      res.failed++;
      const msg = `The original could not be removed: ${String(e?.message ?? e).slice(0, 300)}`;
      await query(`UPDATE vod_assets SET original_wait_code = 'not_removable', original_wait = $2, original_checked_at = now() WHERE id = $1`, [a.id, msg]);
      console.error('[retention] original not removed for', a.id, e);
    }
  }
  return res;
}

/**
 * The row first, guarded on the key still being the one judged (a replace
 * that landed meanwhile wins), then the file. If the file cannot go, the row
 * is put back: never a row that says "archived" over bytes still billed, nor
 * bytes gone with a row that still points at them.
 */
async function removeOriginal(a: any, v: Verdict, rule: OriginalRule, actor: string): Promise<void> {
  const key: string = a.source_key;
  const done = await one<any>(
    `UPDATE vod_assets SET source_key = NULL, original_removed_at = now(), original_removed_key = $2, original_copy_id = $3,
            original_wait_code = NULL, original_wait = NULL, original_checked_at = now()
      WHERE id = $1 AND source_key = $2 AND original_removed_at IS NULL RETURNING id`, [a.id, key, v.copy!.id]);
  if (!done) return;
  try {
    await deleteVodSource(key);
    if (!isBucketSource(key) && existsSync(key)) throw new Error('the file is outside the originals folder, so Volt does not remove it');
  } catch (e) {
    await query(
      `UPDATE vod_assets SET source_key = $2, original_removed_at = NULL, original_removed_key = NULL, original_copy_id = NULL WHERE id = $1`,
      [a.id, key]);
    throw e;
  }
  await writeAudit(null, {
    accountId: a.account_id, userId: null, label: actor, action: 'delete', entityType: 'vod_original', entityId: a.id,
    snapshot: { rule: rule.name, afterDays: rule.original_after_days, archiveCopyId: v.copy!.id, target: v.copy!.targetName,
      storedPath: v.copy!.storedPath, sha256: v.copy!.sha256 },
  }).catch(() => {});
}

export type OriginalState = 'none' | 'kept' | 'scheduled' | 'waiting' | 'removed';

/** Where an asset's original is and what retention will do with it, for the console. */
export async function originalStatus(accountId: string, assetId: string): Promise<any | null> {
  const a = await one<any>(`SELECT * FROM (${ASSET_SELECT} WHERE v.id = $1) a WHERE a.account_id = $2`, [assetId, accountId]);
  if (!a) return null;
  const base = { vodAssetId: a.id, title: a.title, checkedAt: a.original_checked_at };
  if (a.original_removed_at) {
    const c = a.original_copy_id ? await one<any>(
      `SELECT c.id, c.target_id, c.stored_path, c.state, t.name AS target_name FROM archive_copies c JOIN archive_targets t ON t.id = c.target_id WHERE c.id = $1`,
      [a.original_copy_id]) : null;
    const rj = a.original_restore_job_id ? await one<any>(`SELECT state FROM jobs WHERE id = $1`, [a.original_restore_job_id]) : null;
    const restoring = !!rj && (rj.state === 'queued' || rj.state === 'running');
    return { ...base, state: 'removed', removedAt: a.original_removed_at, restoring, restoreError: restoring ? null : (a.original_restore_error ?? null),
      restorable: !restoring && c?.state === 'verified',
      message: `The original was removed from the cloud on ${new Date(a.original_removed_at).toISOString().slice(0, 10)}; its archive copy is at ${c?.target_name ?? 'a storage target'}. The renditions still play.`,
      copy: c ? { id: c.id, targetId: c.target_id, targetName: c.target_name, storedPath: c.stored_path, state: c.state } : null };
  }
  if (!a.source_key) return { ...base, state: 'none', message: 'No original file is kept for this asset.' };
  const rule = await originalRuleFor(a);
  if (!rule) return { ...base, state: 'kept', message: 'No retention rule removes this original, so it stays in the cloud.' };
  const dueAt = new Date(landedAt(a) + rule.original_after_days * DAY);
  const r = { rule: { id: rule.id, name: rule.name, afterDays: rule.original_after_days, scope: rule.scope }, dueAt };
  if (dueAt.getTime() > Date.now()) {
    return { ...base, ...r, state: 'scheduled',
      message: `Retention rule "${rule.name}" removes the original from the cloud on ${dueAt.toISOString().slice(0, 10)}, once an archive copy of it is verified.` };
  }
  const v = await verdictFor(a);
  if (v.ok) return { ...base, ...r, state: 'scheduled', message: `Due now: the original is removed at the next retention pass; its archive copy at ${v.copy!.targetName} is verified.` };
  return { ...base, ...r, state: 'waiting', code: v.code, message: v.message };
}

// ============================================================================
//  RESTORE (H3-5b): the original back to the cloud from its archive copy.
//
//  An `archive.restore` job in the copy's site pool. The agent reads the copy
//  from the target, checks it against the archived checksum and uploads it
//  through an upload transfer that names the original's old address (on the
//  Mac a file under vod-src, written beside and renamed in; in the bucket a
//  presigned PUT held to the checksum). The cloud then reads back what it now
//  holds and only when that matches does the asset point at it again. A
//  mismatch removes what arrived; the job is retried with the queue's backoff.
// ============================================================================
const SHA = /^[0-9a-f]{64}$/;
const apiErr = (status: number, message: string, code: string) => Object.assign(new ApiError(status, message), { code });

/** Where the original goes back to: its old address, if Volt may write there. */
function restoreDest(key: string | null | undefined): string | null {
  if (!key) return null;
  if (isBucketSource(key)) return key;
  if (/^[a-z0-9]+:\/\//i.test(key)) return null;
  const abs = resolve(key);
  return abs.startsWith(vodSourceRoot() + sep) ? abs : null;
}

export async function requestRestore(accountId: string, userId: string | null, assetId: string): Promise<{ created: boolean; jobId: string }> {
  const a = /^[0-9a-f-]{36}$/i.test(String(assetId))
    ? await one<any>(`SELECT * FROM (${ASSET_SELECT} WHERE v.id = $1) a WHERE a.account_id = $2`, [assetId, accountId]) : null;
  if (!a) throw apiErr(404, 'asset not found', 'not_found');
  if (!a.original_removed_at) throw apiErr(409, 'The original of this asset is in the cloud, so there is nothing to restore.', 'not_removed');
  if (a.original_restore_job_id) {
    const j = await one<any>(`SELECT state FROM jobs WHERE id = $1`, [a.original_restore_job_id]);
    if (j && (j.state === 'queued' || j.state === 'running')) return { created: false, jobId: a.original_restore_job_id };
  }
  const c = a.original_copy_id ? await one<any>(
    `SELECT c.*, t.id AS t_id, t.name AS target_name, t.kind, t.path, t.s3, t.bandwidth_mbps, t.status AS target_status, t.site_id, s.status AS site_status
       FROM archive_copies c JOIN archive_targets t ON t.id = c.target_id JOIN sites s ON s.id = t.site_id
      WHERE c.id = $1 AND c.account_id = $2`, [a.original_copy_id, accountId]) : null;
  if (!c) throw apiErr(409, 'The archive copy this original was removed against is gone, so it cannot be restored from Volt.', 'no_copy');
  if (c.state !== 'verified' || !c.stored_path || !c.sha256) {
    throw apiErr(409, `The archive copy at ${c.target_name} is ${c.state}, so it cannot be restored from. Check it again; if it is gone or changed, the original has to come from elsewhere.`, 'copy_not_verified');
  }
  if (c.target_status !== 'active') throw apiErr(409, `The storage target ${c.target_name} is disabled`, 'target_disabled');
  if (c.site_status !== 'active') throw apiErr(409, 'The site of this storage target is disabled', 'site_disabled');
  const dest = restoreDest(a.original_removed_key);
  if (!dest) throw apiErr(422, 'The original\'s old address is not one Volt writes originals to, so it cannot be restored there.', 'not_restorable');

  const { ARCHIVE_RESTORE, targetForAgent } = await import('./archive');
  const job = await enqueue({
    type: ARCHIVE_RESTORE, pool: sitePool(c.site_id), createdBy: userId, maxAttempts: 5,
    dedupeKey: `${ARCHIVE_RESTORE}:${a.id}`,
    payload: {
      vodAssetId: a.id, copyId: c.id, storedPath: c.stored_path, sha256: c.sha256, bytes: c.bytes === null ? null : Number(c.bytes),
      target: targetForAgent({ id: c.t_id, kind: c.kind, path: c.path, s3: c.s3, bandwidth_mbps: c.bandwidth_mbps }),
      transfers: [{ name: 'restore', direction: 'upload', uri: dest, bytes: c.bytes === null ? null : Number(c.bytes), sha256: c.sha256 }],
    },
  });
  await query(`UPDATE vod_assets SET original_restore_job_id = $2, original_restore_error = NULL WHERE id = $1`, [a.id, job.id]);
  return { created: true, jobId: job.id };
}

async function hashLocal(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** The agent says the upload is done: is what the cloud now holds the archived file? */
export async function judgeRestore(job: JobRow, result: any): Promise<{ ok: true; apply: () => Promise<void> } | { ok: false; status: number; code: string; message: string; permanent?: boolean }> {
  const p = job.payload ?? {};
  const a = await one<any>(`SELECT id, account_id, original_removed_at, original_removed_key FROM vod_assets WHERE id = $1`, [p.vodAssetId]);
  if (!a || !a.original_removed_at) return { ok: true, apply: async () => {} };   // already back (or the asset is gone)
  const sha = typeof result?.sha256 === 'string' ? result.sha256.toLowerCase() : '';
  if (!SHA.test(sha)) return { ok: false, status: 400, code: 'bad_result', message: 'A restore reports the sha256 it uploaded' };
  const t = (Array.isArray(p.transfers) ? p.transfers : []).find((x: any) => x?.name === 'restore');
  const dest: string | undefined = t?.uri;
  let back: string | null = null;
  try {
    const f = await fetchVodSource(dest);
    if (f) { try { back = await hashLocal(f.path); } finally { await f.release(); } }
  } catch (e: any) {
    return { ok: false, status: 422, code: 'not_uploaded', message: `The restored file could not be read back in the cloud (${String(e?.message ?? e).slice(0, 200)})` };
  }
  if (!back) return { ok: false, status: 422, code: 'not_uploaded', message: 'The restored file is not in the cloud; upload it before completing the job' };
  if (back !== p.sha256 || sha !== p.sha256) {
    await deleteVodSource(dest).catch(() => {});
    return { ok: false, status: 422, code: 'checksum_mismatch', message: 'The restored file does not match the archived checksum, so it was removed; the restore is tried again' };
  }
  return { ok: true, apply: async () => {
    const r = await one<any>(
      `UPDATE vod_assets SET source_key = original_removed_key, original_removed_at = NULL, original_removed_key = NULL, original_copy_id = NULL,
              original_restore_job_id = NULL, original_restore_error = NULL, original_restored_at = now(),
              original_wait_code = NULL, original_wait = NULL, original_checked_at = now()
        WHERE id = $1 AND original_removed_at IS NOT NULL AND original_removed_key = $2 RETURNING id`, [a.id, dest]);
    if (!r) return;
    const acct = a.account_id ?? (await one<any>(`SELECT COALESCE(g.account_id, v.account_id) AS id FROM vod_assets v
      LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
      LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id) WHERE v.id = $1`, [a.id]))?.id ?? null;
    await writeAudit(null, { accountId: acct, userId: null, label: 'site agent', action: 'update', entityType: 'vod_original', entityId: a.id,
      snapshot: { restored: true, archiveCopyId: p.copyId, sha256: p.sha256 } }).catch(() => {});
  } };
}

/** A restore attempt failed: the reason goes on the asset (never on the copy). */
export async function restoreFailed(job: JobRow, message: string, code: string | null, exhausted: boolean): Promise<void> {
  await query(
    `UPDATE vod_assets SET original_restore_error = $2, original_restore_job_id = CASE WHEN $3 THEN NULL ELSE original_restore_job_id END
      WHERE id = $1 AND original_restore_job_id = $4`,
    [job.payload?.vodAssetId, `${message}${code ? ` (${code})` : ''}`.slice(0, 2000), exhausted, job.id]);
}
