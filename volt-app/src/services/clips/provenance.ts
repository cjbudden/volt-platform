// ============================================================================
//  CLIP PROVENANCE — record what was used, and answer for it later.
//
//  Written at the end of extraction, from the SAME Resolution the media was
//  built from, so the record and the file cannot disagree. Read back by the
//  tracing endpoint, which walks the chain outward from a clip to the physical
//  segments and reports what still exists.
//
//  The interesting half is what happens as the sources age out. Retention takes
//  recordings away; the foreign keys are ON DELETE SET NULL so the rows here
//  survive with the ids gone but the run, the sequence range and the times
//  intact. That is the difference between "this clip came from somewhere we no
//  longer have" and no answer at all.
// ============================================================================
import { one, query } from '../../db';
import type { Resolution, ResolvedBlock } from './resolve';
import { existsSync } from 'node:fs';

export interface ClipBlockRow {
  id: string;
  vod_asset_id: string;
  ordinal: number;
  recording_id: string | null;
  container_id: string | null;
  run_id: string;
  block_index: number;
  rendition: string;
  first_seq: number;
  last_seq: number;
  segment_count: number;
  source_from_ms: string | number;
  source_to_ms: string | number;
  clip_offset_ms: string | number;
  duration_ms: string | number;
  partial_head: boolean;
  partial_tail: boolean;
}

/**
 * Which recording row covers an instant on a stream.
 *
 * A block's media is on disk under a run id; the recording row is the
 * BOOKKEEPING for that capture, and the two are joined by time. Deliberately
 * tolerant: a recording whose end is still open counts up to now, and a block
 * that matches nothing (media on disk with no row, which a crash can leave) gets
 * a null rather than blocking the clip.
 */
async function recordingCovering(
  streamId: string, atMs: number
): Promise<{ id: string; container_id: string | null } | null> {
  return one<{ id: string; container_id: string | null }>(
    `SELECT id, container_id FROM recordings
      WHERE (channel_id = $1 OR event_id = $1)
        AND start_epoch_ms <= $2
        AND COALESCE(end_epoch_ms, (extract(epoch from now()) * 1000)::bigint) >= $2
      ORDER BY start_epoch_ms DESC
      LIMIT 1`,
    [streamId, Math.round(atMs)]
  );
}

/** The wall-clock span of a block actually taken, honouring the trim. */
function takenSpan(b: ResolvedBlock, r: Resolution): { from: number; to: number } {
  const first = b.segments[0];
  const last = b.segments[b.segments.length - 1];
  return {
    from: Math.max(r.requestedFromMs, first.startMs + first.takeFromMs),
    to: Math.min(r.requestedToMs, last.startMs + last.takeToMs),
  };
}

/**
 * Write the provenance chain for a finished clip.
 *
 * Replaces any previous chain for the asset: a re-cut of the same asset must not
 * leave the old blocks behind, or the record describes media that is gone.
 */
export async function recordProvenance(opts: {
  vodAssetId: string;
  streamId: string;
  resolution: Resolution;
  strategy: string;
}): Promise<ClipBlockRow[]> {
  const { vodAssetId, streamId, resolution: r, strategy } = opts;

  await query(`DELETE FROM clip_segments WHERE vod_asset_id = $1`, [vodAssetId]);

  const rows: ClipBlockRow[] = [];
  const containers = new Set<string>();
  let offset = 0;

  for (const [ordinal, b] of r.blocks.entries()) {
    const span = takenSpan(b, r);
    const durationMs = Math.max(0, span.to - span.from);
    const rec = await recordingCovering(streamId, span.from);
    if (rec?.container_id) containers.add(rec.container_id);

    const first = b.segments[0];
    const last = b.segments[b.segments.length - 1];

    const row = await one<ClipBlockRow>(
      `INSERT INTO clip_segments
         (vod_asset_id, ordinal, recording_id, container_id, run_id, block_index,
          rendition, first_seq, last_seq, segment_count,
          source_from_ms, source_to_ms, clip_offset_ms, duration_ms,
          partial_head, partial_tail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        vodAssetId, ordinal, rec?.id ?? null, rec?.container_id ?? null,
        b.runId, b.blockIndex, b.rendition,
        first.seq, last.seq, b.segments.length,
        Math.round(span.from), Math.round(span.to),
        Math.round(offset), Math.round(durationMs),
        first.partial, last.partial,
      ]
    );
    if (row) rows.push(row);
    offset += durationMs;
  }

  const gapMs = r.gaps.reduce((n, g) => n + g.ms, 0);
  await query(
    `UPDATE vod_assets SET
       source_block_count     = $2,
       source_run_count       = $3,
       source_container_count = $4,
       source_segment_count   = $5,
       source_gap_ms          = $6,
       source_coverage_pct    = $7,
       build_strategy         = $8,
       built_at               = now(),
       updated_at             = now()
     WHERE id = $1`,
    [
      vodAssetId, r.blocks.length, r.runCount, containers.size,
      r.blocks.reduce((n, b) => n + b.segments.length, 0),
      Math.round(gapMs), r.coveragePct, strategy,
    ]
  );

  return rows;
}

// ---------------------------------------------------------------------------
//  Reading it back
// ---------------------------------------------------------------------------
export interface TracedBlock {
  ordinal: number;
  runId: string;
  blockIndex: number;
  rendition: string;
  segments: { first: number; last: number; count: number };
  source: { fromMs: number; toMs: number };
  clip: { offsetMs: number; durationMs: number };
  trimmed: { head: boolean; tail: boolean };
  recording: { id: string; title: string | null; status: string } | null;
  container: { id: string; day: string; tz: string } | null;
  /** Is the media this block was cut from still on disk? */
  sourceMediaPresent: boolean;
}

export interface ClipTrace {
  assetId: string;
  title: string | null;
  streamId: string | null;
  requested: { fromMs: number; toMs: number; ms: number };
  counts: {
    blocks: number; runs: number; containers: number; segments: number;
    /** Recordings still on record, and how many the chain has outlived. */
    recordingsLinked: number; recordingsGone: number;
  };
  coveragePct: number | null;
  gapMs: number | null;
  buildStrategy: string | null;
  builtAt: string | null;
  spansBroadcastDays: boolean;
  blocks: TracedBlock[];
}

/**
 * Trace an asset back to the media it was made from.
 *
 * Reports what is STILL THERE as well as what was used, because the two answers
 * carry different consequences: a clip whose sources have been pruned cannot be
 * re-cut at a different length, and the operator should learn that here rather
 * than from a job that fails an hour later.
 */
export async function traceClip(vodAssetId: string, originBase: (id: string) => string): Promise<ClipTrace | null> {
  const asset = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [vodAssetId]);
  if (!asset) return null;

  const rows = await query<any>(
    `SELECT cs.*,
            r.title  AS rec_title,  r.status AS rec_status,
            to_char(c.broadcast_day, 'YYYY-MM-DD') AS day, c.tz AS c_tz
       FROM clip_segments cs
       LEFT JOIN recordings r           ON r.id = cs.recording_id
       LEFT JOIN recording_containers c ON c.id = cs.container_id
      WHERE cs.vod_asset_id = $1
      ORDER BY cs.ordinal`,
    [vodAssetId]
  );

  const streamId: string | null = asset.channel_id ?? asset.event_id ?? null;
  let gone = 0, linked = 0;

  const blocks: TracedBlock[] = rows.map((r) => {
    if (r.recording_id) linked++; else gone++;
    // Presence is checked against the run's init header: without it the segments
    // are undecodable, so its absence is the honest test for "can this still be
    // re-cut", not the presence of any one segment file.
    const present = streamId != null && existsSync(
      `${originBase(streamId)}/runs/${r.run_id}/${r.rendition}/init.mp4`
    );
    return {
      ordinal: r.ordinal,
      runId: r.run_id,
      blockIndex: r.block_index,
      rendition: r.rendition,
      segments: { first: r.first_seq, last: r.last_seq, count: r.segment_count },
      source: { fromMs: Number(r.source_from_ms), toMs: Number(r.source_to_ms) },
      clip: { offsetMs: Number(r.clip_offset_ms), durationMs: Number(r.duration_ms) },
      trimmed: { head: r.partial_head, tail: r.partial_tail },
      recording: r.recording_id
        ? { id: r.recording_id, title: r.rec_title ?? null, status: r.rec_status }
        : null,
      container: r.container_id
        ? { id: r.container_id, day: r.day, tz: r.c_tz }
        : null,
      sourceMediaPresent: present,
    };
  });

  return {
    assetId: asset.id,
    title: asset.title ?? null,
    streamId,
    requested: {
      fromMs: Number(asset.start_epoch_ms),
      toMs: Number(asset.end_epoch_ms),
      ms: Number(asset.end_epoch_ms) - Number(asset.start_epoch_ms),
    },
    counts: {
      blocks: asset.source_block_count ?? rows.length,
      runs: asset.source_run_count ?? new Set(rows.map((r) => r.run_id)).size,
      containers: asset.source_container_count
        ?? new Set(rows.map((r) => r.container_id).filter(Boolean)).size,
      segments: asset.source_segment_count
        ?? rows.reduce((n, r) => n + r.segment_count, 0),
      recordingsLinked: linked,
      recordingsGone: gone,
    },
    coveragePct: asset.source_coverage_pct != null ? Number(asset.source_coverage_pct) : null,
    gapMs: asset.source_gap_ms != null ? Number(asset.source_gap_ms) : null,
    buildStrategy: asset.build_strategy ?? null,
    builtAt: asset.built_at ? new Date(asset.built_at).toISOString() : null,
    spansBroadcastDays: (asset.source_container_count ?? 0) > 1,
    blocks,
  };
}

/**
 * Everything cut from a run, newest first.
 *
 * The question retention and takedowns ask: before pruning a run, what did it
 * produce that is still published? Answering it from the provenance table means
 * the answer stays right after the recording row itself has gone.
 */
export interface DerivedAsset {
  assetId: string; title: string | null; published: boolean;
  fromMs: number; toMs: number; segments: number; blocks: number;
}

async function derivedBy(column: 'run_id' | 'recording_id', value: string): Promise<DerivedAsset[]> {
  const rows = await query<any>(
    `SELECT cs.vod_asset_id, v.title, v.published,
            min(cs.source_from_ms)     AS from_ms,
            max(cs.source_to_ms)       AS to_ms,
            sum(cs.segment_count)::int AS segments,
            count(*)::int              AS blocks
       FROM clip_segments cs
       JOIN vod_assets v ON v.id = cs.vod_asset_id
      WHERE cs.${column} = $1
      GROUP BY cs.vod_asset_id, v.title, v.published
      ORDER BY min(cs.source_from_ms) DESC`,
    [value]
  );
  return rows.map((r) => ({
    assetId: r.vod_asset_id,
    title: r.title ?? null,
    published: r.published,
    fromMs: Number(r.from_ms),
    toMs: Number(r.to_ms),
    segments: r.segments,
    blocks: r.blocks,
  }));
}

export const clipsFromRun = (runId: string) => derivedBy('run_id', runId);
export const clipsFromRecording = (recordingId: string) => derivedBy('recording_id', recordingId);
