// ============================================================================
//  JOB HANDLER — clip.extract
//
//  This is the seam that did not exist. Before it, createClipVod() inserted a
//  vod_assets row naming files nobody wrote, and the extractor that could have
//  written them had no caller. A clip was a promise the system never kept.
//
//  The handler owns the whole life of one clip: resolve the requested wall-clock
//  range to real media, refuse it clearly if the media is not there, extract the
//  requested formats, and write the resulting paths back onto the asset so the
//  UI can play and download them.
// ============================================================================
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { one, query } from '../../../db';
import { config } from '../../../config';
import { resolveRange, assessRange, segmentCount } from '../../clips/resolve';
import { extract, plan, type OutputFormat } from '../../clips/extract';
import { recordProvenance } from '../../clips/provenance';
import { PermanentError, registerHandler, type JobContext } from '../worker';

export interface ClipExtractPayload {
  vodAssetId: string;
  streamId: string;          // channel_id or event_id: the origin namespace
  fromMs: number;
  toMs: number;
  formats: OutputFormat[];
  kind?: 'video' | 'audio';
}

export const CLIP_EXTRACT = 'clip.extract';

/**
 * Public URL for a produced file. Clips live under their own static mount, not
 * under origin, so that retention pruning of the source run cannot take the
 * clip with it.
 */
function publicPath(vodAssetId: string, rest: string): string {
  return `/clips/${vodAssetId}/${rest}`;
}

export async function handleClipExtract(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as ClipExtractPayload;
  if (!p?.vodAssetId || !p?.streamId) {
    throw new PermanentError('clip.extract payload is missing vodAssetId or streamId', 'bad_payload');
  }

  const asset = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [p.vodAssetId]);
  if (!asset) {
    // The asset was deleted while the job waited. Retrying cannot bring it back.
    throw new PermanentError(`vod asset ${p.vodAssetId} no longer exists`, 'asset_gone');
  }

  await ctx.progress(1, 'resolving range');
  const kind = p.kind ?? 'video';
  const resolution = resolveRange(p.streamId, p.fromMs, p.toMs, kind);

  // Refuse before doing work, with the reason the operator needs. These are
  // PERMANENT: a missing hour of recording will still be missing on a retry, and
  // three attempts with backoff only delays telling the operator.
  const verdict = assessRange(resolution);
  if (!verdict.ok) {
    throw new PermanentError(verdict.message, verdict.code);
  }

  const outDir = join(config.clips.dir, p.vodAssetId);
  const shape = plan(resolution);
  console.log(
    `[clip.extract] ${p.vodAssetId}: ${segmentCount(resolution)} segment(s) across ` +
    `${resolution.blocks.length} contiguous block(s) across ${resolution.runCount} run(s), ${shape.strategy}, ` +
    `${((resolution.requestedMs) / 1000).toFixed(1)}s requested`
  );

  let result;
  try {
    result = await extract({
      resolution,
      outDir,
      formats: p.formats?.length ? p.formats : ['mp4', 'hls'],
      ffmpegBin: config.clips.ffmpegBin,
      onProgress: (pct, note) => ctx.progress(pct, note),
      isCancelled: ctx.isCancelled,
    });
  } catch (e) {
    // A half-written clip directory is worse than none: it would look like a
    // playable asset to anything that only checks for existence.
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }

  // ---- write the real paths back onto the asset ---------------------------
  const hls = result.files.find((f) => f.format === 'hls');
  const mp4 = result.files.find((f) => f.format === 'mp4');
  const mp3 = result.files.find((f) => f.format === 'mp3');

  await query(
    `UPDATE vod_assets SET
       master_key      = COALESCE($2, master_key),
       progressive_key = COALESCE($3, progressive_key),
       export_mp4_key  = COALESCE($3, export_mp4_key),
       duration_ms     = $4,
       thumb_status    = 'ready',
       updated_at      = now()
     WHERE id = $1`,
    [
      p.vodAssetId,
      hls ? publicPath(p.vodAssetId, 'hls/index.m3u8') : null,
      mp4 ? publicPath(p.vodAssetId, 'clip.mp4') : null,
      result.durationMs,
    ]
  );

  // ---- record what it was actually built from ------------------------------
  // AFTER the media exists, from the same resolution that produced it, so the
  // chain can never describe a clip that was not made. Not fatal on failure: a
  // playable clip with no provenance row is recoverable by re-recording the
  // chain, whereas throwing here would fail a job whose real work is done and
  // send a retry through the whole extraction again.
  try {
    const chain = await recordProvenance({
      vodAssetId: p.vodAssetId, streamId: p.streamId,
      resolution, strategy: result.strategy,
    });
    await ctx.progress(100, `recorded ${chain.length} source block(s)`);
  } catch (e) {
    console.error(`[clip.extract] ${p.vodAssetId}: provenance not recorded:`, e);
  }

  return {
    durationMs: result.durationMs,
    strategy: result.strategy,
    runsUsed: result.runsUsed,
    blocksUsed: result.blocksUsed,
    segmentsUsed: result.segmentsUsed,
    outputs: {
      hls: hls ? publicPath(p.vodAssetId, 'hls/index.m3u8') : null,
      mp4: mp4 ? publicPath(p.vodAssetId, 'clip.mp4') : null,
      mp3: mp3 ? publicPath(p.vodAssetId, 'clip.mp3') : null,
    },
    bytes: result.files.reduce((n, f) => n + f.bytes, 0),
  };
}

/** Called once at boot, before the worker starts polling. */
export function registerClipHandlers(): void {
  registerHandler(CLIP_EXTRACT, handleClipExtract);
}
