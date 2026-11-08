// ============================================================================
//  RECORDING REMOVAL LOG
//
//  When retention removes a recording, the recording leaves the Recordings
//  tables (its row stays as a tombstone with storage_state = 'deleted', which
//  every list filters out, and a restore from the bin brings it back). The
//  record of what happened must not leave with it. Every attempt writes:
//
//    - a recording_removals row (migration 0145): the recording as it was
//      (source, title, span), when it expired, which rule or date removed it,
//      the outcome, and what was taken (segments, stills, sprite sheets, media
//      objects, bytes, the bin item it went to), or the error;
//    - an audit_log row, so the removal is in the account's activity history
//      beside every other change, attributed to the retention actor.
//
//  A failure is logged too, but not on every hourly retry: a second failure
//  with the same error inside a day is not a new fact.
// ============================================================================
import { one, query } from '../../db';
import { writeAudit } from '../audit';
import type { PruneResult } from './prune';

export type RemovalTrigger = 'rule' | 'manual' | 'legacy';
export type RemovalOutcome = 'removed' | 'kept_for_clips' | 'failed';

export interface RemovedSummary {
  segments?: number;
  keptSegments?: number;
  clips?: number;
  stills?: number;
  spriteSheets?: number;
  mediaObjects?: number;
  bytes?: number;
  binIds?: string[];
}

/** Fold the per-run prune results into one summary of what was taken. */
export function summarisePrune(results: PruneResult[], extra: Partial<RemovedSummary> = {}): RemovedSummary {
  const s: RemovedSummary = { segments: 0, keptSegments: 0, clips: 0, stills: 0, spriteSheets: 0, binIds: [] };
  for (const r of results) {
    s.segments! += r.removedSegments;
    s.keptSegments! += r.keptSegments;
    s.clips = Math.max(s.clips!, r.clips);
    s.stills! += r.stills;
    s.spriteSheets! += r.sheets;
    if (r.binId) s.binIds!.push(r.binId);
  }
  return { ...s, ...extra };
}

const FAILURE_QUIET_MS = 24 * 60 * 60 * 1000;

export async function logRecordingRemoval(o: {
  recordingId: string;
  trigger: RemovalTrigger;
  outcome: RemovalOutcome;
  actor: string;
  ruleName?: string | null;
  reason?: string | null;
  expiredAt?: Date | string | null;
  removed?: RemovedSummary;
  error?: string | null;
}): Promise<void> {
  try {
    const rec = await one<any>(
      `SELECT r.id, r.title, r.channel_id, r.event_id, r.start_epoch_ms, r.end_epoch_ms, r.duration_ms,
              r.expires_at, r.delete_after,
              COALESCE(c.name, e.name) AS source_name,
              CASE WHEN c.kind = 'radio' THEN 'radio' WHEN c.id IS NOT NULL THEN 'channel' ELSE 'event' END AS source_type,
              COALESCE(gc.account_id, ge.account_id) AS account_id
         FROM recordings r
         LEFT JOIN channels c ON c.id = r.channel_id LEFT JOIN groups gc ON gc.id = c.group_id
         LEFT JOIN events e ON e.id = r.event_id LEFT JOIN groups ge ON ge.id = e.group_id
        WHERE r.id = $1`, [o.recordingId]);
    if (!rec) return;

    const error = o.error ? String(o.error).slice(0, 1000) : null;
    if (o.outcome === 'failed') {
      const last = await one<any>(
        `SELECT outcome, error, created_at FROM recording_removals WHERE recording_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [o.recordingId]);
      if (last && last.outcome === 'failed' && last.error === error
          && Date.now() - new Date(last.created_at).getTime() < FAILURE_QUIET_MS) return;
    }

    // Bytes the removal took, from the objects it deleted (their last known size).
    let removed = o.removed ?? {};
    if (o.outcome !== 'failed' && removed.bytes == null) {
      const b = await one<any>(
        `SELECT count(*)::int AS n, COALESCE(sum(bytes), 0)::bigint AS bytes
           FROM media_objects WHERE recording_id = $1 AND state = 'deleted'`, [o.recordingId]);
      removed = { ...removed, mediaObjects: removed.mediaObjects ?? b?.n ?? 0, bytes: Number(b?.bytes ?? 0) };
    }

    const expiredAt = o.expiredAt ?? rec.delete_after ?? rec.expires_at ?? null;
    const row = await one<any>(
      `INSERT INTO recording_removals (account_id, recording_id, source_id, source_name, source_type, title,
              start_epoch_ms, end_epoch_ms, duration_ms, expired_at, trigger, rule_name, reason, outcome, removed, error, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17) RETURNING id`,
      [rec.account_id, rec.id, rec.channel_id ?? rec.event_id, rec.source_name, rec.source_type, rec.title,
       rec.start_epoch_ms, rec.end_epoch_ms, rec.duration_ms, expiredAt ? new Date(expiredAt) : null,
       o.trigger, o.ruleName ?? null, o.reason ?? null, o.outcome, JSON.stringify(removed), error, o.actor]);

    await writeAudit(null, {
      accountId: rec.account_id, userId: null, label: o.actor,
      action: o.outcome === 'failed' ? 'update' : 'delete',
      entityType: 'recording', entityId: rec.id,
      snapshot: {
        retention: o.outcome === 'failed' ? 'removal failed' : o.outcome === 'kept_for_clips' ? 'removed, kept what clips use' : 'removed',
        removalLogId: row?.id ?? null,
        source: rec.source_name, title: rec.title,
        startMs: rec.start_epoch_ms != null ? Number(rec.start_epoch_ms) : null,
        endMs: rec.end_epoch_ms != null ? Number(rec.end_epoch_ms) : null,
        expiredAt, trigger: o.trigger, rule: o.ruleName ?? null, reason: o.reason ?? null,
        removed, error,
      },
    }).catch(() => {});
  } catch (e) {
    // The log must never be the reason a removal is reported as failed.
    console.error('[retention] removal log not written for', o.recordingId, e);
  }
}

/** One account's removal log, newest first, for the report and the storage page. */
export async function listRemovals(accountId: string, opts: {
  outcome?: RemovalOutcome; sourceId?: string; from?: number; to?: number; limit?: number; before?: string;
} = {}): Promise<any[]> {
  const rows = await query<any>(
    `SELECT * FROM recording_removals
      WHERE account_id = $1
        AND ($2::text IS NULL OR outcome = $2)
        AND ($3::uuid IS NULL OR source_id = $3)
        AND ($4::bigint IS NULL OR created_at >= to_timestamp($4::bigint/1000.0))
        AND ($5::bigint IS NULL OR created_at <= to_timestamp($5::bigint/1000.0))
        AND ($6::timestamptz IS NULL OR created_at < $6)
      ORDER BY created_at DESC LIMIT $7`,
    [accountId, opts.outcome ?? null, opts.sourceId ?? null, opts.from ?? null, opts.to ?? null,
     opts.before ?? null, Math.min(Math.max(opts.limit ?? 200, 1), 1000)]);
  return rows.map((r) => ({
    id: r.id, recordingId: r.recording_id,
    source: { id: r.source_id, name: r.source_name, type: r.source_type },
    title: r.title,
    startMs: r.start_epoch_ms != null ? Number(r.start_epoch_ms) : null,
    endMs: r.end_epoch_ms != null ? Number(r.end_epoch_ms) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    expiredAt: r.expired_at, trigger: r.trigger, ruleName: r.rule_name, reason: r.reason,
    outcome: r.outcome, removed: r.removed ?? {}, error: r.error, actor: r.actor, at: r.created_at,
  }));
}
