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
import { enqueue } from '../queue';
import { QC_RUN } from './qcRun';
import { PermanentError, registerHandler, type JobContext } from '../worker';
import { fireHook } from '../../workflows/hooks';
import { setMediaState } from '../../assetReadiness';

export interface ClipExtractPayload {
  vodAssetId: string;
  streamId: string;          // channel_id or event_id: the origin namespace
  fromMs: number;
  toMs: number;
  formats: OutputFormat[];
  kind?: 'video' | 'audio';
  /**
   * How much missing media the operator accepted when they asked for this.
   *
   * It MUST travel with the job. The route assesses the range with the
   * caller's tolerance and then enqueued a payload without it, so the worker
   * re-assessed with the default of zero and threw PermanentError. A clip
   * explicitly requested across an encoder restart was accepted with a 202 and
   * then failed permanently, leaving the asset stuck at thumb_status
   * 'processing' pointing at files nobody would ever write. The recording
   * export path, which sets a 30s tolerance for exactly this reason, failed
   * the same way for every recording with a single gap in it.
   */
  acceptGapsMs?: number;
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

/**
 * A BUILD THAT FAILS SAYS SO ON THE ASSET. The job row has always carried the
 * reason; the asset did not, so a refused build (a gap in the recording, a
 * missing run) left the clip at thumb_status 'processing' in the library,
 * looking normal, until somebody pressed play. Sorotan, 27 Oct 2026: a 26.3 s
 * gap refused the auto-VOD build and the library showed a healthy card.
 *
 * Written only when the failure is FINAL (permanent, or the last attempt), so a
 * transient error that a retry will fix does not flash the asset red.
 */
export async function handleClipExtract(ctx: JobContext): Promise<Record<string, unknown>> {
  try {
    return await buildClip(ctx);
  } catch (e: any) {
    const id = (ctx.job.payload as ClipExtractPayload)?.vodAssetId;
    const final = e instanceof PermanentError || ctx.job.attempts >= ctx.job.max_attempts;
    if (id && final) {
      await setMediaState(id, 'failed', { message: String(e?.message ?? e), code: e?.code ?? null })
        .catch((w) => console.warn('[clip.extract] could not mark', id, 'failed:', w));
    }
    throw e;
  }
}

async function buildClip(ctx: JobContext): Promise<Record<string, unknown>> {
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
  const verdict = assessRange(resolution, { maxGapMs: p.acceptGapsMs ?? 0 });
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

  // WHOLE MILLISECONDS. A range that skips a gap measures a fractional length
  // (174225.44 ms for Sorotan), and duration_ms is a bigint: the UPDATE below
  // threw "invalid input syntax for type bigint" after the files were written.
  result.durationMs = result.durationMs == null ? result.durationMs : Math.round(result.durationMs);

  // ---- write the real paths back onto the asset ---------------------------
  const hls = result.files.find((f) => f.format === 'hls');
  const mp4 = result.files.find((f) => f.format === 'mp4');
  const mp3 = result.files.find((f) => f.format === 'mp3');
  const m4a = result.files.find((f) => f.format === 'm4a');

  await query(
    `UPDATE vod_assets SET
       master_key      = COALESCE($2, master_key),
       progressive_key = COALESCE($3, progressive_key),
       export_mp4_key  = COALESCE($3, export_mp4_key),
       export_mp3_key  = COALESCE($5, export_mp3_key),
       export_m4a_key  = COALESCE($6, export_m4a_key),
       duration_ms     = $4,
       thumb_status    = 'ready',
       media_state     = 'ready', media_error = NULL, media_error_code = NULL, media_state_at = now(),
       updated_at      = now()
     WHERE id = $1`,
    [
      p.vodAssetId,
      hls ? publicPath(p.vodAssetId, 'hls/index.m3u8') : null,
      mp4 ? publicPath(p.vodAssetId, 'clip.mp4') : null,
      result.durationMs,
      mp3 ? publicPath(p.vodAssetId, 'clip.mp3') : null,
      m4a ? publicPath(p.vodAssetId, 'clip.m4a') : null,
    ]
  );

  // ---- put the bytes on the retention ladder -------------------------------
  //
  // Extracted clip output was invisible to the media lifecycle: files under
  // clips/<assetId>/ were never registered as media objects, so the ladder
  // could not see them, no rung ever fired on them, and deleting the asset did
  // not unlink them. They accumulated for the life of the deployment, and
  // nothing in the storage view ever admitted they existed.
  //
  // Registering them with vod_asset_id set means the machinery that already
  // exists does the rest: a rule scoped to the asset's channel applies to them
  // like any other media, and when the asset is deleted the owner FK goes to
  // NULL, which makes the object ownerless and the sweep's orphan reclaim
  // collects it after its grace period. No new deletion path to get wrong.
  try {
    const { registerObject } = await import('../../media/objects');
    const totalBytes = result.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
    await registerObject({
      vodAssetId: p.vodAssetId,
      channelId: (ctx.job as any).channel_id ?? null,
      eventId: (ctx.job as any).event_id ?? null,
      logicalKey: `clips/${p.vodAssetId}`,
      kind: 'clip_output',
      rendition: null,
      tier: 'local',
      uri: outDir,
      bytes: totalBytes || null,
      durationMs: result.durationMs ?? null,
      segmentCount: null,
      actor: 'clip.extract',
    });
    // ON AN S3 DEPLOYMENT the clip also goes to s3://<bucket>/clips/<assetId>/
    // as a second location of the same object, so the ladder that removes the
    // local copy removes the bucket copy too (services/media/s3Driver.ts), and
    // cold/archive rungs have something to move. CLIPS_S3_UPLOAD=false keeps
    // clips local only. (20 Oct 2026)
    if (config.mediaStore.driver === 's3' && process.env.CLIPS_S3_UPLOAD !== 'false') {
      const { uploadTree, mediaS3Client } = await import('../../media/s3Driver');
      const up = await uploadTree(await mediaS3Client(config.aws.region), outDir, config.aws.s3Bucket, `clips/${p.vodAssetId}`);
      await registerObject({
        vodAssetId: p.vodAssetId,
        channelId: (ctx.job as any).channel_id ?? null,
        eventId: (ctx.job as any).event_id ?? null,
        logicalKey: `clips/${p.vodAssetId}`,
        kind: 'clip_output',
        rendition: null,
        tier: 's3_standard',
        uri: up.uri,
        bytes: up.bytes,
        durationMs: result.durationMs ?? null,
        segmentCount: null,
        actor: 'clip.extract',
      });
      await ctx.progress(100, `uploaded ${up.files} file(s) to ${up.uri}`);
    }
  } catch (e) {
    // Same reasoning as the provenance write below: the media exists and is
    // playable. An unregistered object costs storage, which is recoverable;
    // failing the job here would re-run an extraction that already succeeded.
    console.error(`[clip.extract] could not register clip output for ${p.vodAssetId}`, e);
  }

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

  // ITS THUMBNAIL VTT: the stream's hourly storyboard cues for the clip's
  // source ranges, re-timed to the clip and pointing at the same sprite sheets
  // (services/thumbnails/clips.ts). Nothing is re-rendered. Best effort: the API
  // serves a fresh VTT on request either way.
  try {
    const t = await (await import('../../thumbnails/clips')).writeClipThumbnails(p.vodAssetId);
    if (t.cues) await ctx.progress(100, `thumbnail VTT written (${t.cues} cues)`);
  } catch (e) {
    console.warn(`[clip.extract] ${p.vodAssetId}: thumbnail VTT not written:`, e);
  }

  fireHook('clip.ready', 'vod_asset', p.vodAssetId, { strategy: result.strategy });

  // QC runs on its own job, so every clip reaches the review queue with its
  // findings already attached. A reviewer who opens a clip and sees "not checked
  // yet" is a reviewer who approves it unchecked.
  try {
    await enqueue({
      type: QC_RUN,
      payload: { vodAssetId: p.vodAssetId },
      channelId: asset.channel_id, eventId: asset.event_id,
      dedupeKey: `qc.run:${p.vodAssetId}`,
      priority: 40,
    });
  } catch (e) {
    console.error(`[clip.extract] ${p.vodAssetId}: QC not queued:`, e);
  }

  // Skip markers: the intro and credits, against the other episodes of its series.
  await (await import('./vodMarkers')).queueMarkerDetection(p.vodAssetId, { channelId: asset.channel_id, eventId: asset.event_id });
  // Social formats: follow what is in the picture (tracking only; cheap). Volt/REFRAME.md.
  await (await import('./reframe')).queueReframeAnalysis(p.vodAssetId);

  // THE RULES MAY PUBLISH IT NOW. After the files and the ladder are in
  // place; a rule that says manual, or a gate that says no, simply leaves it.
  const auto = await import('../../availability').then((m) => m.autoPublishOnBuild(p.vodAssetId)).catch((e) => {
    console.warn('[clip.extract] auto-publish check failed for', p.vodAssetId, e); return 'skipped' as const;
  });

  return {
    autoPublish: auto,
    durationMs: result.durationMs,
    strategy: result.strategy,
    runsUsed: result.runsUsed,
    blocksUsed: result.blocksUsed,
    segmentsUsed: result.segmentsUsed,
    outputs: {
      hls: hls ? publicPath(p.vodAssetId, 'hls/index.m3u8') : null,
      mp4: mp4 ? publicPath(p.vodAssetId, 'clip.mp4') : null,
      mp3: mp3 ? publicPath(p.vodAssetId, 'clip.mp3') : null,
      m4a: m4a ? publicPath(p.vodAssetId, 'clip.m4a') : null,
    },
    bytes: result.files.reduce((n, f) => n + f.bytes, 0),
  };
}

/** Called once at boot, before the worker starts polling. */
export function registerClipHandlers(): void {
  registerHandler(CLIP_EXTRACT, handleClipExtract);
}
