// ============================================================================
//  RETENTION FOR VOD TITLES (build queue P5, PUBLISHING_POLICIES.md phase 5).
//
//  A publishing policy's Retention section says how long a title is kept:
//  `keep: 'days'` with `days` counted from ingest, Available from or Available
//  until (services/publishingRules.ts). Until now nothing acted on it. The
//  hourly retention sweep (orchestrator sweepRetention) now calls
//  sweepVodRetention(), which for every title of every account:
//
//    1. works out when its policy deletes it (retainUntil in
//       publishingPolicies.ts, the same date the editor's conflict check
//       reasons about) and stores it on the title (`retention_due_at`);
//    2. 7 days ahead, logs one warning (`vod_retention_log` event `warned`);
//       GET /api/storage/vod-retention is the warning list;
//    3. when due, moves it to the restore bin (services/vodRemove.ts, the same
//       path as a Media Library delete, so it can be restored for the bin's
//       days) unless something keeps it, and says what on the title
//       (`retention_wait_code`, `retention_wait`):
//         legal_hold      a legal hold (POST /api/storage/vod/:id/hold);
//         still_available it is published and its publish window is still
//                         open (dates moved after the policy was saved; the
//                         conflict check stops a policy that would do this);
//         in_fast_lineup  it airs in an active FAST lineup;
//         copy rung       its policy copies the original to an archive target
//                         (Mirror and Archive) and that copy is not verified:
//                         the same copy-before-delete verdict H3-5 uses before
//                         removing an original (archive/originals.ts).
//
//  A hold that exists always keeps the title, even after a policy turns
//  `legalHoldAllowed` off: the setting stops new holds, it never deletes held
//  material. Removing a hold is logged; the next sweep then decides.
//
//  The storage tier move for archived titles (`archiveTier`) is
//  services/media/vodArchiveTier.ts (build queue P5-3).
// ============================================================================
import { one, query } from '../../db';
import { writeAudit } from '../audit';
import { retainUntil, windowOf } from '../publishingPolicies';
import { editorialStateOf } from '../publicStatus';

export const WARN_DAYS = 7;
const DAY = 86_400_000;

export type WaitCode = 'legal_hold' | 'still_available' | 'in_fast_lineup'
  | 'no_licence' | 'no_copy' | 'copy_pending' | 'copy_unchecked' | 'copy_corrupt' | 'copy_missing' | 'copy_failed' | 'copy_stale' | 'in_use';

export interface Plan {
  /** When retention deletes it; null: kept (keep forever, or a date it cannot work out yet). */
  dueAt: Date | null;
  /** The rung the retention came from (account, schema, owner, metadata, asset). */
  rule: string | null;
  /** Its policy copies the original to an archive target first. */
  copyFirst: boolean;
  legalHoldAllowed: boolean;
}

/**
 * PURE. When a title's resolved policy deletes it. `settings` is the resolved
 * policy (Resolved.settings); the title's own dates win over the policy's.
 */
export function planFor(settings: any, fieldSources: Record<string, string> | null, t: {
  created_at?: string | Date | null; available_from?: string | Date | null; available_until?: string | Date | null;
}): Plan {
  const d = (v: any) => (v == null || v === '' ? null : new Date(v));
  const r = settings?.retention ?? {};
  const w = windowOf(settings, { availableFrom: d(t.available_from), availableUntil: d(t.available_until) });
  const dueAt = retainUntil(settings, { createdAt: d(t.created_at) }, w);
  const copies = (settings?.archive?.copies ?? []) as { what?: string[] }[];
  return {
    dueAt,
    rule: dueAt ? (fieldSources?.['retention.days'] ?? null) : null,
    copyFirst: copies.some((c) => !c.what || !c.what.length || c.what.includes('source')),
    legalHoldAllowed: r.legalHoldAllowed !== false,
  };
}

/**
 * PURE. What keeps a due title, in the order a person needs to hear it, or
 * null when nothing does. The copy verdict is passed in (it needs the
 * database): null when its policy has no copy rule.
 */
export function keeper(t: {
  legal_hold_at?: any; legal_hold_reason?: string | null; archived_at?: any; availability_state?: string | null; published?: boolean | null;
  available_from?: any; available_until?: any;
}, settings: any, now: Date, o: { fast?: string[]; copy?: { ok: boolean; code?: string; message?: string } | null } = {}): { code: WaitCode; message: string } | null {
  if (t.legal_hold_at) {
    return { code: 'legal_hold', message: `A legal hold keeps it${t.legal_hold_reason ? ` (${t.legal_hold_reason})` : ''}. It is deleted after the hold is released.` };
  }
  const d = (v: any) => (v == null || v === '' ? null : new Date(v));
  const w = windowOf(settings, { availableFrom: d(t.available_from), availableUntil: d(t.available_until) });
  if (editorialStateOf(t as any) === 'published' && (!w.until || w.until > now)) {
    return { code: 'still_available', message: w.until
      ? `It is published until ${w.until.toISOString().slice(0, 16).replace('T', ' ')} UTC, so it is not deleted while it can still be watched.`
      : 'It is published with no end date, so it is not deleted while it can still be watched. Set Available until or archive it.' };
  }
  if (o.fast?.length) {
    return { code: 'in_fast_lineup', message: `It is in the active lineup of FAST ${o.fast.length === 1 ? 'channel' : 'channels'} ${o.fast.join(', ')}. It is deleted once it is out of the lineup.` };
  }
  if (o.copy && !o.copy.ok) {
    return { code: (o.copy.code ?? 'no_copy') as WaitCode, message: `Its policy keeps an archive copy of the original first. ${o.copy.message ?? ''}`.trim() };
  }
  return null;
}

const SELECT = `
  SELECT v.id, v.title, v.schema_id, v.channel_id, v.event_id, v.availability_override, v.created_at,
         v.available_from, v.available_until, v.availability_state, v.published, v.archived_at,
         v.source_key, v.sha256, v.original_removed_at, v.original_copy_id,
         v.legal_hold_at, v.legal_hold_by, v.legal_hold_reason,
         v.retention_due_at, v.retention_warned_at, v.retention_wait_code, v.retention_wait,
         COALESCE(g.account_id, v.account_id) AS account_id
    FROM vod_assets v
    LEFT JOIN channels c ON c.id = v.channel_id
    LEFT JOIN events   e ON e.id = v.event_id
    LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)`;

/** Resolve the policy of many titles of one account with one read of its rules. */
export async function resolver(accountId: string) {
  const rows = await query<any>(`SELECT id, scope_kind, scope_id, settings, locked_fields, name, preset_key FROM publishing_rules WHERE account_id = $1`, [accountId]);
  const { loadRules, firstMatches, rungOf } = await import('../publishingMetadataRules');
  const { resolveFromRows } = await import('../publishingRules');
  const metaRules = await loadRules(accountId, { enabledOnly: true });
  const matched = await firstMatches(accountId, null, metaRules);
  return (t: any) => resolveFromRows(rows, t, matched.get(String(t.id)) ?? null, rungOf as any);
}

async function fastLineupsOf(assetId: string): Promise<string[]> {
  const r = await query<{ name: string }>(
    `SELECT c.name FROM fast_lineups l JOIN channels c ON c.id = l.channel_id
      WHERE l.status = 'active' AND l.slots::text LIKE '%' || $1 || '%' ORDER BY c.name`, [assetId]).catch(() => [] as { name: string }[]);
  return r.map((x) => x.name);
}

/** The copy-before-delete verdict H3-5 gives an original (archive/originals.ts). */
async function copyVerdict(t: any): Promise<{ ok: boolean; code?: string; message?: string }> {
  // Its original already left the cloud on a verified copy: that copy is the archive.
  if (t.original_removed_at && t.original_copy_id) return { ok: true };
  const { hasLicence } = await import('../sites/licences');
  if (!(await hasLicence(t.account_id, 'mirror_archive'))) {
    return { ok: false, code: 'no_licence', message: 'The Mirror and Archive add-on is off for this account, so no archive copy can be made.' };
  }
  const { judgeOriginal } = await import('../archive/originals');
  const copies = await query<any>(
    `SELECT c.*, tg.name AS target_name FROM archive_copies c JOIN archive_targets tg ON tg.id = c.target_id
      WHERE c.vod_asset_id = $1 AND c.account_id = $2 AND c.what = 'source'`, [t.id, t.account_id]);
  const busy = await one<any>(`SELECT count(*)::int AS n FROM jobs WHERE state IN ('queued','running') AND payload->>'vodAssetId' = $1`, [String(t.id)]);
  return judgeOriginal(t, copies, busy?.n ?? 0);
}

export async function log(t: any, event: string, o: { dueAt?: Date | null; rule?: string | null; code?: string | null; message?: string | null; bin?: string | null } = {}) {
  await query(
    `INSERT INTO vod_retention_log (account_id, vod_asset_id, title, event, due_at, rule, code, message, bin_item_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [t.account_id, t.id, t.title ?? null, event, o.dueAt ?? null, o.rule ?? null, o.code ?? null, o.message ?? null, o.bin ?? null]);
}

export interface VodRetentionResult { considered: number; scheduled: number; warned: number; removed: number; waiting: number; held: number; failed: number }

/**
 * One pass over every title (or one account's). Bounded by `limit` titles
 * removed per pass, so a policy shortened on a big library drains over a few
 * sweeps instead of one long one.
 */
export async function sweepVodRetention(opts: { accountId?: string; now?: number; limit?: number; dryRun?: boolean; actor?: string } = {}): Promise<VodRetentionResult> {
  const res: VodRetentionResult = { considered: 0, scheduled: 0, warned: 0, removed: 0, waiting: 0, held: 0, failed: 0 };
  const now = new Date(opts.now ?? Date.now());
  const limit = opts.limit ?? 200;
  // Only accounts where some rung keeps for a number of days can delete
  // anything; the rest are skipped without reading their titles. Every rung
  // counts: a rule, a metadata rule and a title's own setting (the asset
  // rung), which the first build missed (found by P5-2's docs seed).
  const days = `->'retention'->>'keep' = 'days'`;
  const accounts = await query<{ account_id: string }>(
    `SELECT account_id FROM (
       SELECT account_id FROM publishing_rules WHERE settings${days}
       UNION SELECT account_id FROM publishing_metadata_rules WHERE settings${days}
       UNION SELECT COALESCE(g.account_id, v.account_id) FROM vod_assets v
               LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
               LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
              WHERE v.availability_override${days}) a
      WHERE account_id IS NOT NULL ${opts.accountId ? 'AND account_id = $1' : ''}`,
    opts.accountId ? [opts.accountId] : []);
  for (const { account_id } of accounts) {
    const resolve = await resolver(account_id);
    const titles = await query<any>(`${SELECT} WHERE COALESCE(g.account_id, v.account_id) = $1`, [account_id]);
    for (const t of titles) {
      res.considered++;
      const r = resolve(t);
      const p = planFor(r.settings, r.fieldSources, t);
      const was = t.retention_due_at ? new Date(t.retention_due_at).getTime() : null;
      if (!opts.dryRun && (p.dueAt?.getTime() ?? null) !== was) {
        // A date that moved later (a longer policy, a new Available until)
        // earns a fresh warning when it comes near again.
        await query(`UPDATE vod_assets SET retention_due_at = $2, retention_warned_at = CASE WHEN $2::timestamptz IS NULL OR $2::timestamptz > retention_due_at THEN NULL ELSE retention_warned_at END WHERE id = $1`, [t.id, p.dueAt]);
        if (!p.dueAt || (was && p.dueAt.getTime() > was)) t.retention_warned_at = null;
      }
      if (!p.dueAt) {
        if (!opts.dryRun && t.retention_wait_code) await query(`UPDATE vod_assets SET retention_wait_code = NULL, retention_wait = NULL WHERE id = $1`, [t.id]);
        continue;
      }
      if (p.dueAt.getTime() > now.getTime()) {
        res.scheduled++;
        if (p.dueAt.getTime() - now.getTime() <= WARN_DAYS * DAY && !t.retention_warned_at) {
          res.warned++;
          if (!opts.dryRun) {
            await query(`UPDATE vod_assets SET retention_warned_at = now() WHERE id = $1`, [t.id]);
            await log(t, 'warned', { dueAt: p.dueAt, rule: p.rule, message: `Deleted by retention on ${p.dueAt.toISOString().slice(0, 10)} unless it is held.` });
          }
        }
        continue;
      }
      // DUE. What keeps it, if anything.
      const wait = keeper(t, r.settings, now, {
        fast: await fastLineupsOf(t.id),
        copy: p.copyFirst ? await copyVerdict(t) : null,
      });
      if (wait) {
        if (wait.code === 'legal_hold') res.held++; else res.waiting++;
        if (!opts.dryRun && (t.retention_wait_code !== wait.code || t.retention_wait !== wait.message)) {
          await query(`UPDATE vod_assets SET retention_wait_code = $2, retention_wait = $3, retention_checked_at = now() WHERE id = $1`, [t.id, wait.code, wait.message]);
          // Logged when the reason changes, not every hour.
          await log(t, wait.code === 'legal_hold' ? 'held' : 'waiting', { dueAt: p.dueAt, rule: p.rule, code: wait.code, message: wait.message });
        }
        continue;
      }
      if (res.removed >= limit) continue;
      if (opts.dryRun) { res.removed++; continue; }
      try {
        const { removeVodAsset } = await import('../vodRemove');
        const bin = await removeVodAsset(t.id, { reason: `deleted by retention (its publishing policy keeps titles ${r.settings.retention?.days} days)`, by: opts.actor ?? 'retention:sweep' });
        res.removed++;
        await log(t, 'removed', { dueAt: p.dueAt, rule: p.rule, bin });
        await writeAudit(null, { accountId: t.account_id, userId: null, label: opts.actor ?? 'retention:sweep', action: 'delete', entityType: 'vod_asset', entityId: t.id,
          snapshot: { title: t.title, retention: { days: r.settings.retention?.days, anchor: r.settings.retention?.anchor, rule: p.rule, dueAt: p.dueAt }, bin } }).catch(() => {});
      } catch (e: any) {
        res.failed++;
        await log(t, 'failed', { dueAt: p.dueAt, rule: p.rule, message: String(e?.message ?? e).slice(0, 500) }).catch(() => {});
      }
    }
  }
  return res;
}

/**
 * The warning list: titles retention deletes within `withinDays`, and titles
 * already due that something keeps, soonest first. Read from what the last
 * sweep stored, so it is one query however large the library.
 */
export async function retentionList(accountId: string, withinDays = WARN_DAYS) {
  const rows = await query<any>(
    `${SELECT} WHERE COALESCE(g.account_id, v.account_id) = $1
        AND (v.retention_due_at IS NOT NULL AND v.retention_due_at <= now() + make_interval(days => $2::int)
             OR v.legal_hold_at IS NOT NULL)
      ORDER BY v.retention_due_at NULLS LAST, v.title`, [accountId, withinDays]);
  return rows.map((t) => ({
    id: t.id, title: t.title, dueAt: t.retention_due_at, warnedAt: t.retention_warned_at,
    due: !!t.retention_due_at && new Date(t.retention_due_at) <= new Date(),
    legalHold: t.legal_hold_at ? { at: t.legal_hold_at, by: t.legal_hold_by, reason: t.legal_hold_reason } : null,
    waiting: t.retention_wait_code ? { code: t.retention_wait_code, message: t.retention_wait } : null,
  }));
}

/** The log for one account (or one title), newest first. */
export async function retentionLog(accountId: string, o: { assetId?: string; limit?: number } = {}) {
  return query<any>(
    `SELECT id, vod_asset_id AS "assetId", title, event, due_at AS "dueAt", rule, code, message, bin_item_id AS "binItemId", created_at AS "at"
       FROM vod_retention_log WHERE account_id = $1 ${o.assetId ? 'AND vod_asset_id = $3' : ''}
      ORDER BY created_at DESC LIMIT $2`, o.assetId ? [accountId, o.limit ?? 100, o.assetId] : [accountId, o.limit ?? 100]);
}

export class HoldRefused extends Error { constructor(public code: string, msg: string) { super(msg); } }

/**
 * Put a legal hold on a title or release it. A new hold is refused when the
 * title's policy does not allow legal holds; releasing is always allowed.
 */
export async function setLegalHold(accountId: string, assetId: string, hold: boolean, reason: string | null, by: string): Promise<any | null> {
  const t = await one<any>(`${SELECT} WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [assetId, accountId]);
  if (!t) return null;
  if (hold) {
    const r = (await resolver(accountId))(t);
    if (r.settings.retention?.legalHoldAllowed === false) {
      throw new HoldRefused('legal_hold_not_allowed', `Its publishing policy does not allow legal holds (set by the ${r.fieldSources['retention.legalHoldAllowed'] ?? 'account'} rule).`);
    }
    await query(`UPDATE vod_assets SET legal_hold_at = COALESCE(legal_hold_at, now()), legal_hold_by = $2, legal_hold_reason = $3 WHERE id = $1`, [assetId, by, reason]);
  } else {
    await query(`UPDATE vod_assets SET legal_hold_at = NULL, legal_hold_by = NULL, legal_hold_reason = NULL,
                   retention_wait_code = CASE WHEN retention_wait_code = 'legal_hold' THEN NULL ELSE retention_wait_code END,
                   retention_wait = CASE WHEN retention_wait_code = 'legal_hold' THEN NULL ELSE retention_wait END WHERE id = $1`, [assetId]);
  }
  await log(t, hold ? 'held' : 'released', { dueAt: t.retention_due_at, code: hold ? 'legal_hold' : null, message: hold ? `Legal hold by ${by}${reason ? `: ${reason}` : ''}` : `Legal hold released by ${by}` });
  await writeAudit(null, { accountId, userId: null, label: by, action: 'update', entityType: 'vod_asset', entityId: assetId,
    changes: { legal_hold: { from: !!t.legal_hold_at, to: hold } }, snapshot: { title: t.title, reason } }).catch(() => {});
  return { id: assetId, legalHold: hold, reason: hold ? reason : null, dueAt: t.retention_due_at };
}
