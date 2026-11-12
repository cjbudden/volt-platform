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
import { JobLog } from '../jobLog';

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
export function outDirFor(assetId: string): string {
  return join(config.clips.dir, 'vod', assetId);
}
export function publicBase(assetId: string): string {
  return `/clips/vod/${assetId}`;
}

function encoderScript(): string {
  return join(config.testStream.encoderBin, 'vod_encoder.py');
}

/** Run the encoder script, capturing its JSON result line. */
export function runEncoder(
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
export function lastJson(s: string): any | null {
  const lines = s.trim().split('\n').reverse();
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* keep looking */ }
  }
  return null;
}

export async function probeSource(sourcePath: string, onLine: (s: string) => void): Promise<SourceProbe & { ok: boolean; error?: string }> {
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

/** What an encode will do: the ladder fitted to the probed source. */
export interface EncodePlan {
  ladder: Awaited<ReturnType<typeof loadLadder>>;
  fit: ReturnType<typeof fitToSource>;
  audioOnly: boolean;
  summary: string;
}

/** The fields of a plan the plan step needs from the payload. */
export type PlanInput = Pick<VodEncodePayload, 'accountId' | 'ladderGroupId' | 'segmentSeconds' | 'loudnorm'>;

/**
 * THE PLAN HALF OF vod.encode (build queue H4, HYBRID_SITES.md "One handler,
 * two halves"): from the probe, decide what is encoded. It always runs in the
 * cloud, so the upscale policy and the ladder choice stay in one place whether
 * the encode itself runs here or at a customer's site. In the cloud both
 * halves still run in the same job, so its behaviour and outputs are unchanged.
 */
export async function planEncode(p: PlanInput, probe: SourceProbe, log: Pick<JobLog, 'step'>, ctx?: Pick<JobContext, 'progress'>): Promise<EncodePlan> {
  // A FILE WITH NO PICTURE IS AN AUDIO ASSET (build queue H2b-4), not a failed
  // encode. It used to be refused here ("no video track"), so a dropped mp3
  // could only go to review. Now it takes the sound-only path: one AAC
  // rendition on the same encoder contract as every other encode's sound
  // (ladder_args.py audio_track_args), packaged HLS and DASH like a video, and
  // the library and the player know it is audio from the probe's hasVideo.
  // A file with neither picture nor sound has nothing to encode.
  const audioOnly = probe.hasVideo === false;
  if (audioOnly && probe.hasAudio === false) {
    throw new PermanentError('this file has neither picture nor sound, so there is nothing to encode', 'no_media');
  }
  if (audioOnly) log.step('no picture in this file: encoding it as an audio asset (sound only)');

  await ctx?.progress(6, 'choosing the ladder');
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

  // Sound only: no rungs to fit. The ladder still gives the segment length
  // and the packaging, so an audio asset cuts and packages like the rest.
  const fit: ReturnType<typeof fitToSource> = audioOnly
    ? { ...fitToSource(ladder, { height: 1080 }), kept: [], dropped: [], adapted: [], notes: ['sound only: one AAC rendition, 128 kb/s stereo 48 kHz'] } as any
    : fitToSource(ladder, probe);
  const summary = audioOnly ? 'sound only, AAC 128 kb/s' : describeFit(fit);
  if (!audioOnly && !fit.kept.length) {
    // fitToSource is written so this cannot happen; if it ever does, refusing is
    // far better than an encode that produces nothing and reports success.
    throw new PermanentError('the ladder fitted no rungs to this source', 'empty_ladder');
  }
  log.step(`ladder "${ladder.groupName}": ${summary}`);
  for (const n of fit.notes ?? []) log.step(`  ${n}`);
  if (fit.dropped.length) log.step(`  dropped: ${fit.dropped.map((r) => `${r.height}p (${r.why})`).join(', ')}`);
  return { ladder, fit, audioOnly, summary };
}

/**
 * The encoder's job file without the paths, which belong to whoever runs it:
 * this box (input, out_dir, work_dir under clips/vod) or a site worker (its
 * own scratch folder). Both run vod_encoder.py with the same settings, so a
 * site encode packages exactly as a cloud one does.
 */
export function encoderJobFor(plan: EncodePlan, p: PlanInput, probe: SourceProbe & { durationMs?: number | null }): Record<string, unknown> {
  const { ladder, fit, audioOnly } = plan;
  return {
    segment_seconds: p.segmentSeconds ?? ladder.segmentSeconds,
    fps: fit.fps,
    loudnorm: !!p.loudnorm,
    gpu: ladder.codecBackend === 'nvenc',
    packaging: ladder.packaging,
    has_audio: probe.hasAudio !== false,
    // no video outputs at all (vod_encoder.py): the asset is its sound
    audio_only: audioOnly,
    // a fixed-size ladder (frame_mode 'box'): every rung in its 16:9 box (vod_encoder.py box_filter)
    ...(fit.boxed ? { fit: 'box' } : {}),
    ladder: fit.kept,
    // For the script's "progress encode N%" lines.
    duration_sec: probe.durationMs ? probe.durationMs / 1000 : null,
  };
}

/** What happened to each output beyond the renditions, for the Encoding queue's job view. */
type StepOutcome = { state: 'ok' | 'failed' | 'skipped'; count?: number; detail?: string; error?: string };

// THE JOB'S LOG (services/jobs/jobLog.ts): every stage, the encoder's own output and
// any step that failed without failing the job, kept with the job for the console.
export async function handleVodEncode(ctx: JobContext): Promise<Record<string, unknown>> {
  const log = await JobLog.open(ctx.job.id, ctx.job.attempts || 1);
  try {
    return await encode(ctx, log);
  } catch (e: any) {
    log.err(`FAILED: ${String(e?.message ?? e)}\n`);
    throw e;
  } finally {
    await log.close();
  }
}

async function encode(ctx: JobContext, log: JobLog): Promise<Record<string, unknown>> {
  const given = ctx.job.payload as VodEncodePayload;
  if (!given?.vodAssetId || !given?.sourcePath || !given?.accountId) {
    throw new PermanentError('vod.encode payload needs vodAssetId, accountId and sourcePath', 'bad_payload');
  }
  // THE ORIGINAL MAY BE IN THE BUCKET (build queue 2.1a-2b): on AWS the task that
  // finished the upload is rarely the one running this job, so an s3:// source is
  // fetched into this task's scratch space for the length of the encode and
  // removed afterwards. A local path is used as it is.
  const { fetchVodSource } = await import('../../media/vodSource');
  const src = await fetchVodSource(given.sourcePath);
  if (!src) {
    // TAKEN OUT OF THE CLOUD BY RETENTION, KEPT IN THE ARCHIVE (H3-5d): the
    // restore is started and this encode is queued again once it lands,
    // rather than failing as if no original had been kept.
    const { restoreForJob } = await import('../../archive/originals');
    const why = await restoreForJob(ctx.job, given.vodAssetId).catch(() => null);
    if (why) throw new PermanentError(why, 'original_in_archive');
    // A retry cannot make a missing file appear.
    throw new PermanentError(`the source file is not there: ${given.sourcePath}`, 'source_missing');
  }
  if (src.fetched) log.step(`fetched ${given.sourcePath} to this task's scratch space`);
  try { return await encodeFrom(ctx, log, { ...given, sourcePath: src.path }); }
  finally { await src.release(); }
}

async function encodeFrom(ctx: JobContext, log: JobLog, p: VodEncodePayload): Promise<Record<string, unknown>> {

  let srcBytes: number | null = null;
  try { srcBytes = (await stat(p.sourcePath)).size; } catch { /* reported below */ }
  log.step(`source ${p.sourcePath}${srcBytes != null ? ` (${(srcBytes / 1048576).toFixed(1)} MB)` : ''}`);
  await ctx.progress(2, 'reading the source');
  const probe = await probeSource(p.sourcePath, (s) => log.out(s));
  if (probe.ok !== false) {
    log.step(`probe: ${probe.width ?? '?'}x${probe.height ?? '?'}${probe.fps ? ` ${probe.fps} fps` : ''}, ${probe.videoCodec ?? 'video ?'}`
      + `${probe.durationMs ? `, ${(probe.durationMs / 1000).toFixed(1)} s` : ''}, audio ${probe.hasAudio === false ? 'none' : `${(probe.audioTracks ?? []).length || 1} track(s)`}`);
  }
  if (probe.ok === false) {
    throw new PermanentError(
      `the source could not be read (${probe.error ?? 'no reason given'})`, 'unreadable_source');
  }
  const plan = await planEncode(p, probe, log, ctx);
  const { ladder, fit, audioOnly, summary } = plan;
  await ctx.progress(10, `encoding ${summary}`);

  const outDir = outDirFor(p.vodAssetId);
  await mkdir(outDir, { recursive: true });
  const jobPath = join(outDir, 'encode-job.json');
  await writeFile(jobPath, JSON.stringify({
    input: p.sourcePath,
    out_dir: outDir,
    work_dir: join(outDir, '.enc'),
    ...encoderJobFor(plan, p, probe),
  }, null, 1));

  // THE LEASE IS 120 s AND AN ENCODE IS NOT. Two things keep it: a timer that beats
  // every 20 s for as long as the encoder process is alive (a live process is working,
  // however quiet), and the script's "progress encode N%" lines, which set the
  // percentage (10 to 90 over the encode). Output alone was not enough: ffmpeg ran
  // silent, a 4K source outlived the lease, the reaper re-queued the job mid-encode and
  // a second worker started the same encode beside the first (both CPU-bound, the
  // console starved, then "worker stopped reporting; lease expired").
  let pct = 10;
  let note = `encoding ${summary}`;
  const beat = () => { void ctx.progress(Math.round(pct), note).catch(() => { /* the lease will be reaped */ }); };
  const timer = setInterval(beat, 20_000);
  let lastBeat = Date.now();
  let r;
  try {
    log.step('encoder started');
    r = await runEncoder(jobPath, (chunk) => {
      log.out(chunk);
      const m = [...chunk.matchAll(/progress encode (\d+(?:\.\d+)?)%(?: at (\S+))?/g)].pop();
      if (m) {
        pct = 10 + 80 * Math.min(1, Number(m[1]) / 100);
        note = `encoding ${summary}: ${Math.round(Number(m[1]))}%${m[2] && m[2] !== '?' ? ` at ${m[2]}` : ''}`;
      } else if (/\[vod-encoder\] package:/.test(chunk)) {
        pct = 90; note = 'packaging HLS and DASH';
      }
      if (Date.now() - lastBeat > 5_000) { lastBeat = Date.now(); beat(); }
    });
  } finally {
    clearInterval(timer);
  }

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
  log.step(`packaged: ${[master ? 'HLS master.m3u8' : null, mpd ? 'DASH manifest.mpd' : null].filter(Boolean).join(', ')}`);

  return finishEncode(ctx, log, { p, probe, plan, master, mpd, outDir, sourcePath: p.sourcePath, srcBytes, result });
}

/** What the execute half produced, for the finish. */
export interface EncodeOutcome {
  p: Pick<VodEncodePayload, 'vodAssetId' | 'accountId' | 'segmentSeconds'>;
  probe: SourceProbe & Record<string, any>;
  plan: EncodePlan;
  master: string | null;
  mpd: string | null;
  outDir: string;
  /** The source on this box; null when it stayed at a site (H4). */
  sourcePath: string | null;
  srcBytes: number | null;
  /** vod_encoder.py's JSON result line (zero_start, loudnorm). */
  result: any;
}

/**
 * THE FINISH OF vod.encode: record what was produced on the asset, make the
 * MP4 when the source allows, push to the origin bucket, then the stills,
 * sprite sheets and follow-up jobs. Shared by the cloud encode and a site
 * encode whose package the cloud has verified (services/sites/siteEncode.ts),
 * so an asset encoded at a site is recorded exactly as one encoded here.
 */
export async function finishEncode(ctx: Pick<JobContext, 'progress'>, log: JobLog, o: EncodeOutcome): Promise<Record<string, unknown>> {
  const { p, probe, plan: { ladder, fit, audioOnly, summary }, master, mpd, outDir, srcBytes, result } = o;
  const sourcePath = o.sourcePath;
  // The stills and sprite sheets read the picture from the source; a site
  // encode's source is not here, so they read the packaged master instead
  // (ffmpeg takes the top rendition), which is the picture viewers get.
  const pictureSource = sourcePath ?? join(outDir, 'master.m3u8');
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
    // 'box': every rung at its fixed 16:9 size, so a FAST channel on the same ladder airs it as it is
    frame: fit.boxed ? 'box' : 'scale',
    kept: fit.kept,
    dropped: fit.dropped,
    adapted: fit.adapted,
    sourceUnmeasured: fit.sourceUnmeasured,
    notes: fit.notes,
    probe: {
      width: probe.width ?? null, height: probe.height ?? null,
      fps: probe.fps ?? null, durationMs: probe.durationMs ?? null,
      hasAudio: probe.hasAudio ?? null,
      hasVideo: probe.hasVideo ?? null,
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
    // what the asset is: 'audio' when the file had no picture (H2b-4)
    kind: audioOnly ? 'audio' : 'video',
    summary: summary,
  };

  const bytes = srcBytes;

  // AN MP4 BESIDE HLS AND DASH (27 Oct 2026). An uploaded file that browsers
  // already play (H.264 video, AAC or no audio, in MP4 / MOV) is repackaged as
  // the asset's MP4: a stream copy with the index at the front, so it costs
  // seconds and loses nothing. Anything else keeps HLS / DASH only: nothing
  // makes an MP4 of it later, so the Media Library's Download section says so.
  let mp4File: string | null = null;
  {
    const vc = String(probe.videoCodec ?? '').toLowerCase();
    const ac = String(probe.audioTracks?.[0]?.codec ?? '').toLowerCase();
    const okVideo = vc === 'h264' || vc === 'avc1';
    const okAudio = probe.hasAudio === false || !probe.audioTracks?.length || ac === 'aac' || ac === 'mp4a';
    if (audioOnly) {
      log.step('MP4: none for a sound-only asset; HLS and DASH');
    } else if (!sourcePath) {
      // A SITE ENCODE (H4): the source stayed at the customer's site, so there is
      // nothing here to repackage. HLS and DASH only, as for a source browsers
      // cannot play.
      log.step('MP4: not made, the source is at the site; HLS and DASH only, no MP4 to download');
    } else if (/\.(mp4|m4v|mov)$/i.test(sourcePath) && okVideo && okAudio) {
      await ctx.progress(96, 'making the MP4');
      const target = join(outDir, 'file.mp4');
      const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
        const ch = spawn(config.clips.ffmpegBin, ['-y', '-v', 'error', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-dn', '-sn', '-movflags', '+faststart', target]);
        let err = ''; ch.stderr.on('data', (d) => { err += String(d); });
        ch.on('error', (e) => resolve({ code: -1, err: String(e?.message ?? e) }));
        ch.on('close', (code) => resolve({ code, err }));
      });
      if (r.code === 0 && existsSync(target)) { mp4File = 'file.mp4'; log.step('MP4: the source repackaged (stream copy, faststart)'); }
      else log.warn(`MP4 not made: ${r.err.slice(0, 300) || `ffmpeg exited ${r.code}`}`);
    } else {
      log.step(`MP4: not made from the source (${okVideo ? '' : `video ${vc || 'unknown'}`}${!okVideo && !okAudio ? ', ' : ''}${okAudio ? '' : `audio ${ac || 'unknown'}`}); HLS and DASH only, no MP4 to download`);
    }
  }
  // THE SOURCE'S FACTS, read fresh for the asset page (resolution, bitrates,
  // codecs, profile, colour), so files uploaded before the probe recorded them
  // show them too.
  if (sourcePath) try {
    const { probeFileFacts } = await import('../../ingest/metadata');
    const facts = await probeFileFacts(sourcePath);
    if (facts) await query(`UPDATE vod_assets SET ingest = jsonb_set(COALESCE(ingest, '{}'::jsonb), '{probe}', $2::jsonb) WHERE id = $1`, [p.vodAssetId, JSON.stringify(facts)]);
  } catch (e: any) { log.warn(`source facts not refreshed: ${String(e?.message ?? e).slice(0, 200)}`); }

  // PRODUCTION: the packaged media goes to the origin bucket, so it is served
  // by the CDN and readable by a FAST playout on another server, instead of
  // living on this task's disk (services/fast/vodStore.ts).
  let storedMaster = master, storedMpd = mpd;
  const { vodStore, uploadVodDir } = await import('../../fast/vodStore');
  if (vodStore() === 's3') {
    await ctx.progress(97, 'uploading to the origin');
    log.step('uploading the packaged media to the origin bucket');
    const up = await uploadVodDir(outDir, p.vodAssetId);
    storedMaster = master ? up.master : null;
    storedMpd = mpd ? up.mpd : null;
  }

  await query(
    `UPDATE vod_assets
        SET master_key = COALESCE($2, master_key),
            progressive_key = $8,
            duration_ms = COALESCE($3, duration_ms),
            end_epoch_ms = COALESCE($3, end_epoch_ms),
            source_bytes = COALESCE($4, source_bytes),
            encode_result = $5::jsonb,
            formats = $6::jsonb,
            media_facts = $7::jsonb,
            thumb_status = 'ready',
            media_state = 'ready', media_error = NULL, media_error_code = NULL, media_state_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [p.vodAssetId, storedMaster, probe.durationMs ?? null, bytes,
     JSON.stringify(encodeResult),
     JSON.stringify({ hls: !!storedMaster, dash: !!storedMpd, progressive: !!mp4File }),
     mediaFacts ? JSON.stringify(mediaFacts) : null,
     // the MP4 sits beside the master, locally and on the origin bucket alike
     mp4File ? (storedMaster ? storedMaster.replace(/[^/]*$/, mp4File) : `${publicBase(p.vodAssetId)}/${mp4File}`) : null]
  );

  // A NEW ENCODE MAKES ITS FAST PACKAGINGS STALE (services/fast/ladder.ts): they were
  // made from the previous encode or source. Forgotten, so each channel's prepare
  // packages it again (its own encode plays meanwhile).
  await query(`DELETE FROM vod_asset_ladders WHERE vod_asset_id = $1`, [p.vodAssetId]).catch(() => null);
  // The master and MPD just uploaded carry no caption tracks; on S3 players get
  // them from the CDN, so the asset's tracks are written back in (fails open).
  if (vodStore() === 's3') {
    const { syncBucketTracks } = await import('../../companions/bucketTracks');
    const st = await syncBucketTracks(p.vodAssetId);
    if (st.error) log.warn(`caption tracks not written into the bucket's playlists: ${st.error}`);
    else {
      const n = st.written.filter((k) => k.includes('/subs/') && k.endsWith('.m3u8')).length;
      if (n) log.step(`caption tracks written into the bucket's playlists (${n})`);
    }
  }
  fireHook('vod.encoded', 'vod_asset', p.vodAssetId, { renditions: fit.kept.length });
  // Subtitles and a description, when an ingest rule asked for them
  // (services/media/postProcess.ts): only steps still waiting start, so a
  // re-encode does not make them again. Own jobs; never fails the encode.
  await (await import('../../media/postProcess')).startPostProcess(p.vodAssetId);
  // While the source is on disk: candidate stills to pick the asset's image
  // from (services/media/assetImage.ts) and the sprite sheets for hover
  // previews (services/thumbnails/fileSprites.ts). Never fails the encode.
  // Each step on its own, so a failed one is reported and the next still runs.
  const outputs: { thumbnails: StepOutcome; sprites: StepOutcome; image: StepOutcome } = {
    thumbnails: { state: 'skipped' }, sprites: { state: 'skipped' }, image: { state: 'skipped' },
  };
  // NOTHING TO LOOK AT in a sound-only asset: no stills, sprite sheets, frame
  // index or social formats tracking. Its picture is a Cover image, set on
  // its page or from the name of an image dropped beside it (H2b-3).
  if (audioOnly) {
    log.step('sound only: no stills, sprite sheets, frame index or social formats');
  } else {
    try {
      await ctx.progress(98, 'choosing a thumbnail');
      const { extractFrames } = await import('../../media/assetImage');
      const c = await extractFrames(p.vodAssetId, p.accountId, pictureSource, probe.durationMs ?? null);
      outputs.thumbnails = { state: c.length ? 'ok' : 'failed', count: c.length, ...(c.length ? {} : { error: 'no frames could be read' }) };
      log[c.length ? 'step' : 'warn'](`thumbnails: ${c.length} candidate stills`);
    } catch (e: any) {
      outputs.thumbnails = { state: 'failed', error: String(e?.message ?? e).slice(0, 400) };
      log.warn(`thumbnails failed: ${outputs.thumbnails.error}`);
    }
    try {
      await ctx.progress(99, 'building the sprite sheets');
      const sp = await (await import('../../thumbnails/fileSprites')).buildFileSprites(p.vodAssetId, p.accountId, pictureSource, probe.durationMs ?? null);
      if (sp) {
        const tiles = sp.sheets.reduce((a, s) => a + s.tiles, 0);
        outputs.sprites = { state: 'ok', count: sp.sheets.length, detail: `${tiles} previews, one every ${sp.intervalMs / 1000} s` };
        log.step(`sprite sheets: ${sp.sheets.length} (${outputs.sprites.detail})`);
      } else {
        outputs.sprites = { state: 'skipped', detail: 'no duration or no video to sample' };
        log.warn('sprite sheets: none made (no duration or no video to sample)');
      }
    } catch (e: any) {
      outputs.sprites = { state: 'failed', error: String(e?.message ?? e).slice(0, 400) };
      log.warn(`sprite sheets failed: ${outputs.sprites.error}`);
    }
    try {
      await (await import('./vodImage')).queueAssetImage(p.vodAssetId);
      outputs.image = { state: 'ok', detail: 'asset image chosen by a vod.image job' };
      log.step('queued: choose the asset image (vod.image)');
    } catch (e: any) {
      outputs.image = { state: 'failed', error: String(e?.message ?? e).slice(0, 400) };
      log.warn(`asset image not queued: ${outputs.image.error}`);
    }
    // Skip markers: the intro and credits, against the other episodes of its series.
    await (await import('./vodMarkers')).queueMarkerDetection(p.vodAssetId);
    // Frame index of the rendition players get, for exact frames (services/frames).
    await (await import('./frameIndex')).queueFrameIndex(p.vodAssetId);
    // Social formats: follow what is in the picture (tracking only; cheap). Volt/REFRAME.md.
    await (await import('./reframe')).queueReframeAnalysis(p.vodAssetId);
    log.step('queued: skip marker detection (vod.markers) and social formats tracking');
  }
  // QC: an uploaded file is confirmed playable the same way a clip is, by
  // decoding what was packaged. Until it has run the asset reads "not checked"
  // and no picker offers it (services/assetReadiness.ts).
  try {
    const { enqueue } = await import('../queue');
    const { QC_RUN } = await import('./qcRun');
    await enqueue({ type: QC_RUN, payload: { vodAssetId: p.vodAssetId }, dedupeKey: `qc.run:${p.vodAssetId}`, priority: 40 });
    log.step('queued: QC (qc.run)');
  } catch (e: any) {
    log.warn(`QC not queued: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  log.step('done');

  return {
    vodAssetId: p.vodAssetId,
    master, mpd,
    renditions: fit.kept.length,
    dropped: fit.dropped.length,
    summary: summary,
    outputs,
  };
}

export function registerVodEncodeHandlers(): void {
  registerHandler(VOD_ENCODE, handleVodEncode);
  // A FAST channel's ladder, encoded beside the asset's own (vodLadder.ts). Registered
  // here so it starts wherever vod.encode does.
  registerHandler('vod.ladder', async (ctx) => (await import('./vodLadder')).handleVodLadder(ctx));
}
