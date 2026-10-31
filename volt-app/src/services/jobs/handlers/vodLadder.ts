// ============================================================================
//  JOB HANDLER — vod.ladder
//
//  Package an asset to a FAST channel's ladder, beside its own encode
//  (services/fast/ladder.ts says why). Payload:
//
//    { vodAssetId, accountId, sourcePath, ladderGroupId, segmentSeconds, loudnorm, channelId? }
//
//  Differences from vod.encode, each on purpose:
//    * EVERY RUNG, NOT FITTED TO THE SOURCE. A channel's live playlists are the
//      ladder's rungs; an asset missing one has nothing to put in it. (The
//      builder offers only sources that fill the top rung; one that does not
//      is scaled up, and the variant says so.)
//    * EVERY RUNG IN ITS 16:9 BOX ("box" in the job file: scale to fit, pad,
//      square pixels). A 2.39:1 film becomes 1920x1080 with bars rather than
//      1920x804, so RESOLUTION is the same for every asset on the channel.
//    * THE LADDER'S FRAME RATE, not capped to the source: one frame rate per
//      channel keeps every rung's GOP the same length across the splice.
//    * Its own folder (clips/vod/<id>/ladders/<group>/<seg>s[-loud]/) and its
//      own row (vod_asset_ladders). The asset's own encode, master_key,
//      thumbnails and QC are not touched.
// ============================================================================
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../../../db';
import { loadLadder, NoLadderError } from '../../encode/store';
import { PermanentError, type JobContext } from '../worker';
import { JobLog } from '../jobLog';
import { outDirFor, publicBase, runEncoder, lastJson, probeSource } from './vodEncode';
import { toChannelLadder, variantRel, fitToTop, sourceQuality, fmtKbps } from '../../fast/ladder';

export interface VodLadderPayload {
  vodAssetId: string;
  accountId: string;
  sourcePath: string;
  ladderGroupId: string;
  segmentSeconds: number;
  loudnorm?: boolean;
  channelId?: string | null;
}

async function setRow(p: VodLadderPayload, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  await query(
    `INSERT INTO vod_asset_ladders (vod_asset_id, ladder_group_id, segment_seconds, loudnorm, origin, ${cols.join(', ')})
     VALUES ($1, $2, $3, $4, 'variant', ${cols.map((_, i) => `$${i + 5}`).join(', ')})
     ON CONFLICT (vod_asset_id, ladder_group_id, segment_seconds, loudnorm)
     DO UPDATE SET origin = 'variant', ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
    [p.vodAssetId, p.ladderGroupId, p.segmentSeconds, !!p.loudnorm, ...cols.map((c) => {
      const v = fields[c];
      return v != null && typeof v === 'object' ? JSON.stringify(v) : v;
    })]);
}

export async function handleVodLadder(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as VodLadderPayload;
  if (!p?.vodAssetId || !p?.accountId || !p?.ladderGroupId || !p?.segmentSeconds) {
    throw new PermanentError('vod.ladder payload needs vodAssetId, accountId, ladderGroupId and segmentSeconds', 'bad_payload');
  }
  const log = await JobLog.open(ctx.job.id, ctx.job.attempts || 1);
  try {
    return await run(ctx, p, log);
  } catch (e: any) {
    log.err(`FAILED: ${String(e?.message ?? e)}\n`);
    // the row says why; a retry (not permanent, attempts left) sets it back to encoding
    const last = e instanceof PermanentError || (ctx.job.attempts ?? 1) >= (ctx.job.max_attempts ?? 1);
    if (last) await setRow(p, { state: 'failed', error: String(e?.message ?? e).slice(0, 1000), job_id: ctx.job.id }).catch(() => null);
    throw e;
  } finally {
    await log.close();
  }
}

async function run(ctx: JobContext, p: VodLadderPayload, log: JobLog): Promise<Record<string, unknown>> {
  const asset = await one<any>(`SELECT id, title, source_key, ingest, encode_result, top_height FROM vod_assets WHERE id = $1 AND account_id = $2`, [p.vodAssetId, p.accountId]);
  if (!asset) throw new PermanentError('the asset is gone', 'asset_missing');
  // On AWS the original is in the bucket (build queue 2.1a-2b): a private scratch
  // copy for the length of the job, removed afterwards. A local path as it is.
  const given = p.sourcePath || asset.source_key;
  const { fetchVodSource } = await import('../../media/vodSource');
  const fetched = given ? await fetchVodSource(given) : null;
  if (!fetched) throw new PermanentError(`the source file is not on this server: ${given ?? '(none)'}`, 'source_missing');
  try { return await runFrom(ctx, p, log, asset, fetched.path); }
  finally { await fetched.release(); }
}

async function runFrom(ctx: JobContext, p: VodLadderPayload, log: JobLog, asset: any, src: string): Promise<Record<string, unknown>> {
  await setRow(p, { state: 'encoding', error: null, job_id: ctx.job.id });

  let ladder;
  try { ladder = toChannelLadder(await loadLadder(p.ladderGroupId, p.accountId), false); }
  catch (e: any) {
    if (e instanceof NoLadderError || /no rungs|no renditions|not found/.test(String(e?.message))) throw new PermanentError(String(e?.message ?? e), 'no_ladder');
    throw e;
  }

  await ctx.progress(2, 'reading the source');
  const probe = await probeSource(src, (s) => log.out(s));
  if (probe.ok === false) throw new PermanentError(`the source could not be read (${probe.error ?? 'no reason given'})`, 'unreadable_source');
  if (probe.hasVideo === false) throw new PermanentError('this file has no video track, so it cannot go on a video ladder', 'no_video');

  const notes: string[] = [];
  const q = sourceQuality({ ingest: asset.ingest, encode_result: { probe } });
  const fit = fitToTop(q, ladder.rungs[0]);
  if (fit.fit === 'below') notes.push(`below the top rung: ${fit.why}; scaled up so the channel keeps every rung`);
  if (q.width && q.height && Math.abs(q.width / q.height - 16 / 9) >= 0.01) notes.push(`${q.width}x${q.height} is not 16:9: fitted into each rung's 16:9 box with ${q.width / q.height > 16 / 9 ? 'bars above and below' : 'bars at the sides'}`);
  if (probe.fps && Math.abs(Number(probe.fps) - ladder.fps) > 0.5) notes.push(`the source is ${probe.fps} fps; encoded at the ladder's ${ladder.fps} fps so every asset on the channel shares one frame rate`);
  const rungs = ladder.rungs;
  const label = `${ladder.groupName}: ${rungs.map((r) => `${r.height}p ${fmtKbps(r.bitrate_kbps)}`).join(', ')}${p.segmentSeconds !== ladder.segmentSeconds ? `, ${p.segmentSeconds} s segments` : ''}${p.loudnorm ? ', loudness normalised' : ''}`;
  log.step(`packaging to ${label}`);
  for (const n of notes) log.step(`  ${n}`);

  // ONE FOLDER PER VERSION OF THE LADDER (its renditions and frame rate): a
  // re-package after the ladder changed must not delete segments a running
  // playout is still reading from the previous one.
  const ver = createHash('sha1').update(JSON.stringify([rungs.map((r) => [r.height, r.width, r.bitrate_kbps]), ladder.fps])).digest('hex').slice(0, 8);
  const rel = `${variantRel(p.ladderGroupId, p.segmentSeconds, !!p.loudnorm)}/${ver}`;
  const outDir = join(outDirFor(p.vodAssetId), rel);
  // fresh: a previous attempt's segments must not end up in this one's playlists
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const jobPath = join(outDir, 'encode-job.json');
  await writeFile(jobPath, JSON.stringify({
    input: src, out_dir: outDir, work_dir: join(outDir, '.enc'),
    segment_seconds: p.segmentSeconds, fps: ladder.fps, loudnorm: !!p.loudnorm,
    gpu: ladder.codecBackend === 'nvenc', packaging: ladder.packaging, has_audio: probe.hasAudio !== false,
    fit: 'box',
    ladder: rungs.map((r) => ({ height: r.height, width: r.width, bitrate_kbps: r.bitrate_kbps })),
    duration_sec: probe.durationMs ? probe.durationMs / 1000 : null,
  }, null, 1));

  let pct = 5, note = `packaging to ${ladder.groupName}`;
  const beat = () => { void ctx.progress(Math.round(pct), note).catch(() => { /* the lease will be reaped */ }); };
  const timer = setInterval(beat, 20_000);
  let lastBeat = Date.now();
  let r;
  try {
    r = await runEncoder(jobPath, (chunk) => {
      log.out(chunk);
      const m = [...chunk.matchAll(/progress encode (\d+(?:\.\d+)?)%/g)].pop();
      if (m) { pct = 5 + 85 * Math.min(1, Number(m[1]) / 100); note = `packaging to ${ladder.groupName}: ${Math.round(Number(m[1]))}%`; }
      else if (/\[vod-encoder\] package:/.test(chunk)) { pct = 90; note = 'packaging HLS and DASH'; }
      if (Date.now() - lastBeat > 5_000) { lastBeat = Date.now(); beat(); }
    });
  } finally {
    clearInterval(timer);
  }
  if (r.code !== 0) {
    const why = (r.err || r.out || '').trim().split('\n').slice(-6).join('\n').slice(0, 800);
    if (/is not installed or not on PATH|source file not found|Invalid data found/i.test(why)) throw new PermanentError(`the encode failed: ${why}`, 'encode_failed');
    throw new Error(`the encode failed (exit ${r.code}): ${why}`);
  }
  const result = lastJson(r.out);
  let master = result?.master && existsSync(result.master) ? `${publicBase(p.vodAssetId)}/${rel}/master.m3u8` : null;
  let mpd = result?.mpd && existsSync(result.mpd) ? `${publicBase(p.vodAssetId)}/${rel}/manifest.mpd` : null;
  if (!master && !mpd) throw new Error('the encode reported success but wrote no manifest');

  const { vodStore, uploadVodDir } = await import('../../fast/vodStore');
  if (vodStore() === 's3') {
    await ctx.progress(95, 'uploading to the origin');
    const up = await uploadVodDir(outDir, p.vodAssetId, { subdir: rel });
    master = master ? up.master : null;
    mpd = mpd ? up.mpd : null;
  }
  await setRow(p, {
    state: 'ready', master_key: master, mpd_key: mpd, zero_start: result?.zero_start === true,
    rungs, fps: ladder.fps, notes, error: null, job_id: ctx.job.id,
  });
  log.step(`ready: ${master ?? mpd}`);
  log.step('done');
  return { vodAssetId: p.vodAssetId, ladderGroupId: p.ladderGroupId, master, mpd, rungs: rungs.length, notes };
}
