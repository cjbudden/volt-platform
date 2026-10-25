// ============================================================================
//  REVIEW — a person's decision about a clip, kept as an act rather than a flag.
//
//  The current state is a cache of the latest decision. The decisions themselves
//  are the record, because the question asked afterwards is never "what state is
//  it in" — it is "who approved this, when, and what did they say".
//
//  THE GATE IS SOFT BY DEFAULT, and that is a considered choice. An operator can
//  publish over a QC warning, and doing so is written down. A check that blocks
//  publication on its own is a check people learn to route around, and a
//  routed-around check is worse than no check because it still looks like
//  assurance. A hard block exists per account for the places that genuinely need
//  one, and turning it on is a decision somebody makes for a reason.
// ============================================================================
import { one, query } from '../db';
import { fireHook } from './workflows/hooks';

export type ReviewState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'rejected';

/**
 * What may follow what.
 *
 * Approved -> in_review is legal on purpose: a re-cut of an approved clip has to
 * go round again, and the alternative is a clip carrying an approval for media
 * that no longer exists.
 */
const LEGAL: Record<ReviewState, ReviewState[]> = {
  draft:             ['in_review', 'rejected'],
  in_review:         ['approved', 'rejected', 'changes_requested'],
  changes_requested: ['in_review', 'draft', 'rejected'],
  approved:          ['in_review', 'rejected'],
  rejected:          ['draft', 'in_review'],
};

export class IllegalReview extends Error {
  constructor(public from: ReviewState, public to: ReviewState) {
    super(`A clip cannot go from ${from} to ${to}.`);
    this.name = 'IllegalReview';
  }
}

export interface ReviewDecision {
  assetId: string;
  to: ReviewState;
  actorId?: string | null;
  actorLabel: string;
  note?: string | null;
}

export async function decide(d: ReviewDecision): Promise<any> {
  const asset = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [d.assetId]);
  if (!asset) throw Object.assign(new Error('VOD asset not found'), { status: 404 });

  const from: ReviewState = asset.review_state ?? 'draft';
  if (from === d.to) return asset;
  if (!LEGAL[from].includes(d.to)) throw new IllegalReview(from, d.to);

  // Approving with QC findings outstanding is allowed, and it leaves a mark.
  // That mark is the whole reason a soft gate is worth having.
  const qc = asset.qc_state ?? null;
  const overrode = d.to === 'approved' && (qc === 'failed' || qc === 'warnings');

  await query(
    `INSERT INTO asset_reviews
       (vod_asset_id, actor_id, actor_label, from_state, to_state, note,
        overrode_qc, qc_state_at_decision)
     VALUES ($1,$2,$3,$4::review_state,$5::review_state,$6,$7,$8)`,
    [d.assetId, d.actorId ?? null, d.actorLabel, from, d.to, d.note ?? null, overrode, qc]
  );

  const updated = await one<any>(
    `UPDATE vod_assets
        SET review_state = $2::review_state,
            reviewed_by = $3,
            reviewed_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [d.assetId, d.to, d.actorId ?? null]
  );
  fireHook('review.decided', 'vod_asset', d.assetId, { from, to: d.to, overrodeQc: overrode });
  // An approval is what a held asset was waiting for: if its rules publish
  // automatically, they publish now (services/availability.ts). The answer
  // carries the outcome and the asset as it stands after it, so the console
  // shows "published" without a reload. Imported here, not at the top:
  // availability imports this file for the publish gate.
  if (d.to === 'approved') {
    const { autoPublishWhenReady } = await import('./availability');
    const autoPublish = await autoPublishWhenReady(d.assetId, 'approved');
    if (autoPublish !== 'skipped') {
      const fresh = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [d.assetId]);
      return { ...(fresh ?? updated), autoPublish };
    }
    return { ...updated, autoPublish };
  }
  return updated;
}

export async function historyOf(assetId: string) {
  return query<any>(
    `SELECT at, actor_label, from_state, to_state, note, overrode_qc, qc_state_at_decision
       FROM asset_reviews WHERE vod_asset_id = $1 ORDER BY at DESC, id DESC`,
    [assetId]
  );
}

export interface PublishGate {
  allowed: boolean;
  code: 'ok' | 'not_approved' | 'qc_failed';
  message: string;
  reviewState: ReviewState;
  qcState: string | null;
  /** True when publishing would go ahead over an outstanding QC finding. The
   *  caller shows this so the decision is taken knowingly rather than silently. */
  wouldOverride: boolean;
}

/**
 * May this be published?
 *
 * Reports the gate rather than throwing, because the caller needs to be able to
 * SHOW the reason before asking someone to confirm. Both blocking rules are per
 * account and both default to off.
 */
export async function publishGate(assetId: string): Promise<PublishGate> {
  const row = await one<any>(
    `SELECT v.review_state, v.qc_state,
            COALESCE(ga.require_review_to_publish, false) AS need_review,
            COALESCE(ga.block_publish_on_qc_error, false) AS block_qc
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
       LEFT JOIN accounts ga ON ga.id = g.account_id
      WHERE v.id = $1`,
    [assetId]
  );
  if (!row) throw Object.assign(new Error('VOD asset not found'), { status: 404 });

  const reviewState: ReviewState = row.review_state ?? 'draft';
  const qcState: string | null = row.qc_state ?? null;
  const wouldOverride = qcState === 'failed' || qcState === 'warnings';

  if (row.need_review && reviewState !== 'approved') {
    return {
      allowed: false, code: 'not_approved',
      message: `This account requires review before publishing, and this clip is ${reviewState.replace('_', ' ')}.`,
      reviewState, qcState, wouldOverride,
    };
  }
  if (row.block_qc && qcState === 'failed') {
    return {
      allowed: false, code: 'qc_failed',
      message: 'This account blocks publishing when QC has failed. Re-cut the clip, or clear the findings.',
      reviewState, qcState, wouldOverride,
    };
  }
  return {
    allowed: true, code: 'ok',
    message: wouldOverride
      ? 'Publishing is allowed, but QC has outstanding findings on this clip.'
      : 'Ready to publish.',
    reviewState, qcState, wouldOverride,
  };
}

/** The review queue: what is waiting for somebody, oldest first. */
export async function queue(accountId: string, limit = 100) {
  return query<any>(
    `SELECT v.id, v.title, v.kind, v.review_state, v.qc_state, v.created_at,
            v.duration_ms, v.start_epoch_ms, v.end_epoch_ms,
            v.source_block_count, v.source_coverage_pct,
            COALESCE(c.name, e.name) AS source_name,
            (SELECT count(*) FROM qc_events q
              WHERE q.vod_asset_id = v.id AND q.severity = 'error')::int AS qc_errors,
            (SELECT count(*) FROM qc_events q
              WHERE q.vod_asset_id = v.id AND q.severity = 'warning')::int AS qc_warnings
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.review_state IN ('in_review', 'changes_requested')
      ORDER BY v.created_at
      LIMIT $2`,
    [accountId, limit]
  );
}
