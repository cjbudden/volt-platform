// ============================================================================
//  JOB HANDLER — vod.encode
//
//  A video file becomes a playable VOD asset: probe it, fit the ladder to what
//  it actually contains, encode and package it, and write back what was really
//  produced.
//
//  THE ORDER IS PROBE, THEN DECIDE, THEN ENCODE, and the middle step is here
//  rather than in the encoder on purpose. The upscale policy is a control-plane
//  decision an operator can see the result of; putting it in the encoder would
//  put it beyond the console's reach and give two places an opinion about which
//  rungs exist.
//
//  WHAT WAS PRODUCED IS WRITTEN TO THE ASSET, not just to the job. Jobs are
//  pruned; an asset with three renditions sitting beside one with four is a
//  question somebody asks months later, and the answer has to be on the asset.
//
//  A FAILED ENCODE MUST NOT LEAVE A HALF-ASSET LOOKING READY. master_key is set
//  only after the packager has actually written a master playlist, so an asset
//  that failed has no master and reads as unplayable rather than as playable and
//  broken.
// ============================================================================
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../../../db';
import { config } from '../../../config';
import { fitToSource, describeFit, type SourceProbe } from '../../encode/ladder';
import { loadLadder, resolveLadderFor, NoLadderError } from '../../encode/store';
import { PermanentError, registerHandler, type JobContext } from '../worker';
import { fireHook } from '../../workflows/hooks';

export const VOD_ENCODE = 'vod.encode';

export interface VodEncodePayload {
  vodAssetId: string;
  accountId: string;
  /** Absolute path of the source file on this box. */
  sourcePath: string;
  /** Named explicitly, or resolved from the account default when absent. */
  ladderGroupId?: string | null;
  /** Override the ladder's segment length (a FAST slate is packaged in 1 s segments). */
  segmentSeconds?: number | null;
  /** Bring the audio to broadcast loudness (ads and house spots on FAST channels). */
  loudnorm?: boolean;
}

/** Where a file-sourced asset's media lives. Under clips/, not origin/, for the
 *  same reason a clip is: origin is pruned by the channel's retention rules and
 *  an uploaded asset has no channel whose retention should be able to delete it. */
function outDirFor(assetId: string): string {
  return join(config.clips.dir, 'vod', assetId);
}
function publicBase(assetId: string): string {
  return `/clips/vod/${assetId}`;
}

function encoderScript(): string {
  return join(config.testStream.encoderBin, 'vod_encoder.py');
}

/** Run the encoder script, capturing its JSON result line. */
function runEncoder(
  jobPath: string,
  onLine: (s: string) => void
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(config.testStream.pythonBin, [encoderScript(), jobPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (b) => { const s = String(b); out += s; onLine(s); });
    p.stderr.on('data', (b) => { const s = String(b); err += s; onLine(s); });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    p.on('error', (e) => resolve({ code: 1, out, err: String(e?.message ?? e) }));
  });
}

/** The last line of stdout that parses as JSON. The script logs progress on
 *  stdout too, so taking the whole buffer would never parse. */
function lastJson(s: string): any | null {
  const lines = s.trim().split('\n').reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
}

async function probeSource(sourcePath: string, onLine: (s: string) => void): Promise<SourceProbe & { ok: boolean; error?: string }> {
  const dir = join(config.clips.dir, 'vod', '_probe');
  await mkdir(dir, { recursive: true });
  const jobPath = join(dir, `${process.pid}-${Date.now()}.json`);
  await writeFile(jobPath, JSON.stringify({ input: sourcePath, out_dir: dir, probe_only: true }));
  try {
    const r = await runEncoder(jobPath, onLine);
    const parsed = lastJson(r.out);
    if (!parsed) {
      return { ok: false, error: (r.err || r.out || 'the probe produced no output').slice(0, 400) };
    }
    return parsed;
  } finally {
    await rm(jobPath, { force: true });
  }
}

export async function handleVodEncode(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as VodEncodePayload;
  if (!p?.vodAssetId || !p?.sourcePath || !p?.accountId) {
    throw new PermanentError('vod.encode payload needs vodAssetId, accountId and sourcePath', 'bad_payload');
  }
  if (!existsSync(p.sourcePath)) {
    // A retry cannot make a missing file appear.
    throw new PermanentError(`the source file is not there: ${p.sourcePath}`, 'source_missing');
  }

  await ctx.progress(2, 'reading the source');
  const probe = await probeSource(p.sourcePath, () => { /* logged by the script */ });
  if (probe.ok === false) {
    throw new PermanentError(
      `the source could not be read (${probe.error ?? 'no reason given'})`, 'unreadable_source');
  }
  if (probe.hasVideo === false) {
    throw new PermanentError(
      'this file has no video track, so it cannot be encoded to a video ladder', 'no_video');
  }

  await ctx.progress(6, 'choosing the ladder');
  let ladder;
  try {
    ladder = p.ladderGroupId
      ? await loadLadder(p.ladderGroupId, p.accountId)
      : await resolveLadderFor(p.accountId, null);
  } catch (e: any) {
    // A missing or empty ladder is a configuration fact, not a transient one.
    if (e instanceof NoLadderError || /no rungs|no renditions|not found/.test(String(e?.message))) {
      throw new PermanentError(String(e?.message ?? e), 'no_ladder');
    }
    throw e;
  }

  const fit = fitToSource(ladder, probe);
  if (!fit.kept.length) {
    // fitToSource is written so this cannot happen; if it ever does, refusing is
    // far better than an encode that produces nothing and reports success.
    throw new PermanentError('the ladder fitted no rungs to this source', 'empty_ladder');
  }
  await ctx.progress(10, `encoding ${describeFit(fit)}`);

  const outDir = outDirFor(p.vodAssetId);
  await mkdir(outDir, { recursive: true });
  const jobPath = join(outDir, 'encode-job.json');
  await writeFile(jobPath, JSON.stringify({
    input: p.sourcePath,
    out_dir: outDir,
    work_dir: join(outDir, '.enc'),
    segment_seconds: p.segmentSeconds ?? ladder.segmentSeconds,
    fps: fit.fps,
    loudnorm: !!p.loudnorm,
    gpu: ladder.codecBackend === 'nvenc',
    packaging: ladder.packaging,
    has_audio: probe.hasAudio !== false,
    ladder: fit.kept,
  }, null, 1));

  // ffmpeg reports progress on stderr; the lease is 120s and a feature-length
  // encode is far longer than that, so the heartbeat has to be driven by output
  // rather than by a timer that assumes the job is short.
  let lastBeat = 0;
  const r = await runEncoder(jobPath, () => {
    const now = Date.now();
    if (now - lastBeat > 15_000) {
      lastBeat = now;
      void ctx.progress(50, `encoding ${describeFit(fit)}`).catch(() => { /* the lease will be reaped */ });
    }
  });

  if (r.code !== 0) {
    const why = (r.err || r.out || '').trim().split('\n').slice(-6).join('\n').slice(0, 800);
    // A missing binary or an unreadable source will not be fixed by trying again.
    const permanent = /is not installed or not on PATH|source file not found|Invalid data found/i.test(why);
    if (permanent) throw new PermanentError(`the encode failed: ${why}`, 'encode_failed');
    throw new Error(`the encode failed (exit ${r.code}): ${why}`);
  }

  const result = lastJson(r.out);
  const master = result?.master && existsSync(result.master) ? `${publicBase(p.vodAssetId)}/master.m3u8` : null;
  const mpd = result?.mpd && existsSync(result.mpd) ? `${publicBase(p.vodAssetId)}/manifest.mpd` : null;

  // THE MASTER IS CHECKED ON DISK, not taken from the script's word for it. A
  // packager that exits 0 having written nothing is rare and the failure it
  // produces — an asset that looks ready and plays nothing — is expensive.
  if (!master && !mpd) {
    throw new Error('the encode reported success but wrote no manifest');
  }

  await ctx.progress(95, 'recording what was produced');
  // WHAT THE FILES CARRY, read back from the packaged init segments while they
  // are still on this disk (services/media/mediaFacts.ts): the real profile and
  // level of each rendition and the audio track's codec, channels and rate.
  // Never fails the encode; an unread answer stays NULL and the tab says so.
  let mediaFacts: Awaited<ReturnType<typeof import('../../media/mediaFacts').probeFiles>> = null;
  try {
    const { probeFiles } = await import('../../media/mediaFacts');
    mediaFacts = await probeFiles([
      ...fit.kept.map((r) => ({ label: `${r.height}p`, path: join(outDir, `${r.height}p`, 'init.mp4') })),
      ...(probe.hasAudio !== false ? [{ label: 'audio', path: join(outDir, 'audio', 'init.mp4') }] : []),
    ], 'encode');
  } catch (e) {
    console.error(`[vod.encode] ${p.vodAssetId}: media facts not read:`, e);
  }
  const srcTracks = probe.audioTracks ?? [];
  // The packager does not copy the source's language tag across, so the one
  // encoded track takes the language of the source track it was made from.
  if (mediaFacts) for (const a of mediaFacts.audio) a.language = a.language ?? srcTracks[0]?.language ?? null;
  const encodeResult = {
    ladder: { groupId: ladder.groupId, name: ladder.groupName, origin: ladder.origin },
    segmentSeconds: p.segmentSeconds ?? ladder.segmentSeconds,
    // from vod_encoder.py: the audio and video segment grids line up, so the
    // asset can be cut at an ad break on a FAST channel (DESIGN_fast_channels.md)
    zeroStart: result?.zero_start === true,
    loudnorm: result?.loudnorm === true,
    fps: fit.fps,
    kept: fit.kept,
    dropped: fit.dropped,
    adapted: fit.adapted,
    sourceUnmeasured: fit.sourceUnmeasured,
    notes: fit.notes,
    probe: {
      width: probe.width ?? null, height: probe.height ?? null,
      fps: probe.fps ?? null, durationMs: probe.durationMs ?? null,
      hasAudio: probe.hasAudio ?? null,
      videoCodec: probe.videoCodec ?? null,
      videoProfile: probe.videoProfile ?? null,
      audioTracks: srcTracks,
      subtitleTracks: probe.subtitleTracks ?? [],
    },
    // WHAT THIS ENCODE DID with the sound, captions and protection, written
    // down so the Encode tab states it rather than infers it. ladder_args.py
    // audio_track_args(0): source audio track 0 only, AAC 128 kb/s stereo
    // 48 kHz. The packager is run without encryption and without text streams,
    // so a file encode is in the clear and carries no caption tracks; the
    // source's own subtitle tracks are listed above, not carried.
    audio: probe.hasAudio === false ? [] : [{ sourceTrack: 0, codec: 'AAC', bitrateKbps: 128, channels: 2, sampleRate: 48000, language: srcTracks[0]?.language ?? null }],
    captions: [],
    drm: 'clear',
    summary: describeFit(fit),
  };

  let bytes: number | null = null;
  try { bytes = (await stat(p.sourcePath)).size; } catch { /* not fatal */ }

  // PRODUCTION: the packaged media goes to the origin bucket, so it is served
  // by the CDN and readable by a FAST playout on another server, instead of
  // living on this task's disk (services/fast/vodStore.ts).
  let storedMaster = master, storedMpd = mpd;
  const { vodStore, uploadVodDir } = await import('../../fast/vodStore');
  if (vodStore() === 's3') {
    await ctx.progress(97, 'uploading to the origin');
    const up = await uploadVodDir(outDir, p.vodAssetId);
    storedMaster = master ? up.master : null;
    storedMpd = mpd ? up.mpd : null;
  }

  await query(
    `UPDATE vod_assets
        SET master_key = COALESCE($2, master_key),
            progressive_key = NULL,
            duration_ms = COALESCE($3, duration_ms),
            end_epoch_ms = COALESCE($3, end_epoch_ms),
            source_bytes = COALESCE($4, source_bytes),
            encode_result = $5::jsonb,
            formats = $6::jsonb,
            media_facts = $7::jsonb,
            thumb_status = 'ready',
            updated_at = now()
      WHERE id = $1`,
    [p.vodAssetId, storedMaster, probe.durationMs ?? null, bytes,
     JSON.stringify(encodeResult),
     JSON.stringify({ hls: !!storedMaster, dash: !!storedMpd, progressive: false }),
     mediaFacts ? JSON.stringify(mediaFacts) : null]
  );

  fireHook('vod.encoded', 'vod_asset', p.vodAssetId, { renditions: fit.kept.length });
  // While the source is on disk: candidate stills to pick the asset's image
  // from (services/media/assetImage.ts) and the sprite sheets for hover
  // previews (services/thumbnails/fileSprites.ts). Never fails the encode.
  try {
    await ctx.progress(98, 'choosing a thumbnail');
    const { extractFrames } = await import('../../media/assetImage');
    await extractFrames(p.vodAssetId, p.accountId, p.sourcePath, probe.durationMs ?? null);
    await ctx.progress(99, 'building the sprite sheets');
    await (await import('../../thumbnails/fileSprites')).buildFileSprites(p.vodAssetId, p.accountId, p.sourcePath, probe.durationMs ?? null);
    await (await import('./vodImage')).queueAssetImage(p.vodAssetId);
  } catch (e) { console.error(`[vod.encode] ${p.vodAssetId}: no thumbnail candidates:`, e); }
  // Skip markers: the intro and credits, against the other episodes of its series.
  await (await import('./vodMarkers')).queueMarkerDetection(p.vodAssetId);
  // Social formats: follow what is in the picture (tracking only; cheap). Volt/REFRAME.md.
  await (await import('./reframe')).queueReframeAnalysis(p.vodAssetId);

  return {
    vodAssetId: p.vodAssetId,
    master, mpd,
    renditions: fit.kept.length,
    dropped: fit.dropped.length,
    summary: describeFit(fit),
  };
}

export function registerVodEncodeHandlers(): void {
  registerHandler(VOD_ENCODE, handleVodEncode);
}
