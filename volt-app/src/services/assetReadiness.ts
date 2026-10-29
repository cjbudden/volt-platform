// ============================================================================
//  CAN THIS ASSET BE USED?  (usage status)
//
//  One answer, derived in one place, and the base rule for every place that
//  offers an asset to be scheduled or played: FAST playlists, loops and
//  fillers, blocking / replacement, the library's status filter.
//
//  The answer comes from three independent facts on the row:
//
//    MEDIA    did a build or encode produce files (media_state, migration
//             0110, or the encode job for an uploaded file)
//    QC       has a machine decoded it and found nothing that stops it
//             (qc_state, services/qc.ts)
//    REVIEW   has a person accepted it despite QC findings (review_state
//             'approved' overrides a QC failure: that is what review is for)
//
//  USAGE STATUS, in the order it is decided:
//
//    failed       the build or encode failed. media_error says why.
//    unplayable   files exist but QC could not decode them.
//    processing   a build or encode is queued or running.
//    no_media     no files and nothing coming to make them.
//    qc_failed    playable, but QC found an error (a gap, wrong length) and
//                 nobody has approved it.
//    unchecked    playable as far as we know, QC has not run.
//    ready        media built, QC pass or warnings (or approved). The ONLY
//                 status a picker offers.
//
//  "We did not look" is not "we looked and it was fine": an unchecked asset is
//  not offered for scheduling. QC is cheap and queued automatically after every
//  build, so unchecked is a short-lived state.
// ============================================================================
import { query } from '../db';

export const USAGE_STATUSES = ['ready', 'unchecked', 'qc_failed', 'processing', 'failed', 'unplayable', 'no_media'] as const;
export type UsageStatus = typeof USAGE_STATUSES[number];

export type MediaState = 'processing' | 'ready' | 'failed' | 'missing' | 'unplayable';

/**
 * Evidence that a build wrote media, for rows no producer has stamped yet
 * (created before migration 0110, or by a path that does not set media_state).
 * Built clips and encoded uploads are served from /clips/...; a full-event
 * replay IS the recording's own manifest.
 */
export function mediaEvidenceSql(v = 'v'): string {
  return `(${v}.built_at IS NOT NULL
    OR COALESCE(${v}.master_key, '') LIKE '/clips/%'
    OR COALESCE(${v}.progressive_key, '') LIKE '/clips/%'
    OR ${v}.export_mp3_key IS NOT NULL
    OR (${v}.kind = 'full_event' AND ${v}.master_key IS NOT NULL))`;
}

/**
 * The usage status as SQL. `jobState` is the state of the asset's encode job
 * (uploads); pass the joined column when the query already joins jobs, or
 * leave the default sub-select.
 */
export function usageStatusSql(v = 'v', jobState?: string): string {
  const js = jobState ?? `(SELECT jx.state::text FROM jobs jx WHERE jx.id = ${v}.encode_job_id)`;
  return `(CASE
    WHEN ${v}.media_state = 'failed' OR ${js} IN ('failed', 'cancelled') THEN 'failed'
    WHEN ${v}.media_state = 'unplayable' THEN 'unplayable'
    WHEN ${v}.media_state = 'processing' OR ${js} IN ('queued', 'running') THEN 'processing'
    WHEN ${v}.media_state = 'missing' THEN 'no_media'
    WHEN ${v}.media_state IS NULL AND NOT ${mediaEvidenceSql(v)} AND COALESCE(${js}, '') <> 'succeeded' THEN 'no_media'
    WHEN ${v}.qc_state = 'failed' AND ${v}.review_state::text <> 'approved' THEN 'qc_failed'
    WHEN ${v}.qc_state IS NULL AND ${v}.review_state::text <> 'approved' THEN 'unchecked'
    ELSE 'ready' END)`;
}

/** True when the asset may be offered to FAST, loops, blocking and playout. */
export function usableSql(v = 'v', jobState?: string): string {
  return `(${usageStatusSql(v, jobState)} = 'ready')`;
}

/** The same decision in TypeScript, for rows already in hand (and the tests). */
export function usageStatusOf(a: {
  media_state?: string | null; encode_state?: string | null; qc_state?: string | null;
  review_state?: string | null; built_at?: unknown; master_key?: string | null;
  progressive_key?: string | null; export_mp3_key?: string | null; kind?: string | null;
}): UsageStatus {
  const js = a.encode_state ?? null;
  const evidence = !!a.built_at || (a.master_key ?? '').startsWith('/clips/')
    || (a.progressive_key ?? '').startsWith('/clips/') || !!a.export_mp3_key
    || (a.kind === 'full_event' && !!a.master_key);
  if (a.media_state === 'failed' || js === 'failed' || js === 'cancelled') return 'failed';
  if (a.media_state === 'unplayable') return 'unplayable';
  if (a.media_state === 'processing' || js === 'queued' || js === 'running') return 'processing';
  if (a.media_state === 'missing') return 'no_media';
  if (a.media_state == null && !evidence && js !== 'succeeded') return 'no_media';
  const approved = a.review_state === 'approved';
  if (a.qc_state === 'failed' && !approved) return 'qc_failed';
  if (a.qc_state == null && !approved) return 'unchecked';
  return 'ready';
}

/** Plain-language reason a picker or panel can show next to the status. */
export function usageStatusLabel(s: UsageStatus): string {
  switch (s) {
    case 'ready': return 'Ready';
    case 'unchecked': return 'Not checked yet';
    case 'qc_failed': return 'QC failed';
    case 'processing': return 'Building';
    case 'failed': return 'Build failed';
    case 'unplayable': return 'Will not play';
    case 'no_media': return 'No media';
  }
}

/**
 * Record what a producer did to the media. Never downgrades a 'failed' to
 * 'unplayable' or similar by accident: callers say exactly what happened.
 */
export async function setMediaState(vodAssetId: string, state: MediaState, err?: { message?: string | null; code?: string | null }): Promise<void> {
  await query(
    `UPDATE vod_assets SET media_state = $2, media_error = $3, media_error_code = $4,
            media_state_at = now(), updated_at = now()
      WHERE id = $1`,
    [vodAssetId, state, err?.message ? String(err.message).slice(0, 1000) : null, err?.code ?? null]
  );
}
