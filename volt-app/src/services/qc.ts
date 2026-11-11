// ============================================================================
//  QC — what a machine can say about a finished clip.
//
//  These are FINDINGS, not verdicts. Each one reports what was measured, what
//  was expected, and where in the clip it happened, and a person decides what
//  that means. The distinction is not pedantry: a check that blocks publication
//  on its own is a check people learn to route around, and a routed-around check
//  is worse than none because it still looks like assurance.
//
//  Five checks, and each one exists because it catches a real way a clip goes
//  out wrong:
//
//    DURATION   the file is not the length that was asked for. The symptom of a
//               trim that landed on the wrong frame, or media that was not there.
//    COVERAGE   the source range had holes in it. Read from the provenance chain
//               rather than re-measured, so it agrees with what was actually cut.
//    SILENCE    a stretch with no audio. The classic bad clip: trimmed into the
//               gap between items, or the source lost its audio track.
//    BLACK      a stretch of black frames. The video equivalent, and the one
//               that gets published because nobody watched past the first ten
//               seconds.
//    LOUDNESS   integrated loudness far from the target, or a true peak over
//               full scale. Not a defect on its own, which is why it is a
//               warning: a quiet interview is quiet on purpose.
//
//  And two that come first, because nothing else means anything without them
//  (27 Oct 2026, after Sorotan: a clip whose build had FAILED got "pass",
//  because every check that needs a file was skipped and skipped counted as
//  nothing wrong):
//
//    MEDIA      is there anything to measure at all. No media is an ERROR, not
//               a skip: the asset cannot be played, so it cannot pass.
//    PLAYBACK   does the media open and decode, end to end, the way a player
//               would read it (the HLS manifest for a manifest clip, not an
//               MP4 that was never made). A file that will not decode is an
//               ERROR and marks the asset unplayable.
//
//  All five run off ONE ffmpeg pass where they can, because decoding a clip
//  twice to ask two questions about it is the sort of thing that makes an
//  automated check too expensive to run by default.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { one, query } from '../db';
import { config } from '../config';
import { writeAudit } from './audit';

export type QcSeverity = 'info' | 'warning' | 'error';

export interface QcFinding {
  check: 'media' | 'playback' | 'duration' | 'coverage' | 'silence' | 'black' | 'loudness';
  severity: QcSeverity;
  fromMs?: number | null;
  toMs?: number | null;
  measured?: string | null;
  expected?: string | null;
  message: string;
}

export interface QcResult {
  assetId: string;
  state: 'pass' | 'warnings' | 'failed';
  findings: QcFinding[];
  /** Checks that could not run, and why. Reported rather than counted as a
   *  pass: "we did not look" and "we looked and it was fine" are different
   *  answers and only one of them is assurance. */
  skipped: { check: string; reason: string }[];
}

// ---- thresholds ------------------------------------------------------------
/** A clip more than this far from its requested length is worth flagging. */
const DURATION_TOLERANCE_MS = 500;
/** Beyond this the length is wrong, not just keyframe-aligned. */
const DURATION_ERROR_MS = 2500;
/** Silence shorter than this is a pause, not a fault. */
const MIN_SILENCE_MS = 2000;
/** Below this the audio is silence for practical purposes. */
const SILENCE_DB = -50;
/** Black shorter than this is a cut, not a fault. */
const MIN_BLACK_MS = 2000;
/** Broadcast target, and how far from it is worth mentioning. */
const TARGET_LUFS = -23;
const LUFS_TOLERANCE = 6;
/** Above this a true peak will clip on a consumer decoder. */
const TRUE_PEAK_CEILING_DBFS = -1;

function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(config.clips.ffmpegBin ?? 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    let done = false;
    const finish = () => { if (done) return; done = true; try { p.kill('SIGKILL'); } catch { /* */ } resolve(out); };
    const timer = setTimeout(finish, timeoutMs);
    p.stderr.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    p.on('close', () => { clearTimeout(timer); finish(); });
    p.on('error', () => { clearTimeout(timer); finish(); });
  });
}

/**
 * One decode, every filter that needs the samples.
 *
 * silencedetect and ebur128 both want the audio; blackdetect wants the video.
 * Run together they cost one decode; run separately they cost three, which is
 * the difference between a check that runs on every clip and one that gets
 * turned off.
 */
async function analyse(path: string, hasVideo: boolean, hasAudio = true): Promise<string> {
  const filters: string[] = [];
  if (hasVideo) filters.push(`[0:v]blackdetect=d=${MIN_BLACK_MS / 1000}:pic_th=0.98[v]`);
  // A video-only file has no [0:a]: asking for it fails the whole filter graph,
  // which would read as "will not decode" for a file that plays fine.
  if (hasAudio) filters.push(
    `[0:a]silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE_MS / 1000}[s]`,
    `[s]ebur128=peak=true[a]`
  );
  const args = [
    '-hide_banner', '-nostdin', '-i', path,
    '-filter_complex', filters.join(';'),
    ...(hasVideo ? ['-map', '[v]'] : []),
    ...(hasAudio ? ['-map', '[a]'] : []),
    '-f', 'null', '-',
  ];
  return runFfmpeg(args);
}

/** What the media holds, and why it could not be opened when it could not. */
async function probeStreams(path: string): Promise<{ video: boolean; audio: boolean; error: string | null; durationMs: number | null }> {
  const r = await new Promise<{ out: string; err: string }>((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'default=nw=1', path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, 60_000);
    p.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    p.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    p.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ out: '', err: String(e) }); });
  });
  const video = /codec_type=video/.test(r.out), audio = /codec_type=audio/.test(r.out);
  const d = /duration=([\d.]+)/.exec(r.out);
  const firstErr = r.err.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
  return { video, audio, durationMs: d ? Math.round(parseFloat(d[1]) * 1000) : null,
           error: video || audio ? null : (firstErr ?? 'no audio or video stream found') };
}

/** Lines in a decode log that mean a player would stall or fail here. */
export function playbackErrors(log: string): string[] {
  return log.split('\n').map((l) => l.trim()).filter((l) =>
    /Failed to open segment|Failed to reload playlist|No such file or directory|Error opening input|Invalid data found when processing input|Server returned 4\d\d|Server returned 5\d\d|moov atom not found/i.test(l))
    .slice(0, 5);
}

/**
 * WHERE THE MEDIA A PLAYER WOULD READ IS, as a local path or a URL ffmpeg can
 * open. In the order a viewer gets it: the HLS manifest, the progressive file
 * (built clips and encoded uploads are under /clips/...; on S3 the key is a
 * URL), then the audio downloads. A full-event replay reads the recording's
 * own manifest under the origin directory.
 */
export function mediaInputFor(asset: any): string | null {
  const local = (key: string | null | undefined): string | null => {
    if (!key) return null;
    if (/^https?:\/\//.test(key)) return key;
    if (key.startsWith('/clips/')) {
      const f = `${config.clips.dir}${key.slice('/clips'.length)}`;
      return existsSync(f) ? f : null;
    }
    const o = `${config.testStream.originDir}/${key.replace(/^\/+(origin\/)?/, '')}`;
    return existsSync(o) ? o : null;
  };
  // The manifest first: that is what the library player and every viewer app
  // read, and a clip whose MP4 is fine but whose manifest is broken does not play.
  const legacy = clipFilePath(asset.id);
  return local(asset.master_key) ?? local(asset.progressive_key)
    ?? (existsSync(legacy) ? legacy : null)
    ?? local(asset.export_mp3_key) ?? local(asset.export_m4a_key);
}

// ---- parsing ---------------------------------------------------------------
export function parseSilence(log: string): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  let start: number | null = null;
  for (const line of log.split('\n')) {
    const a = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (a) { start = parseFloat(a[1]); continue; }
    const b = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (b && start != null) {
      out.push({ fromMs: Math.max(0, Math.round(start * 1000)), toMs: Math.round(parseFloat(b[1]) * 1000) });
      start = null;
    }
  }
  // A silence that runs to the end of the file never gets an end marker, and a
  // clip that ends in silence is exactly the case worth catching.
  if (start != null) out.push({ fromMs: Math.max(0, Math.round(start * 1000)), toMs: -1 });
  return out;
}

export function parseBlack(log: string): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  for (const line of log.split('\n')) {
    const m = /black_start:\s*([\d.]+).*?black_end:\s*([\d.]+)/.exec(line);
    if (m) out.push({ fromMs: Math.round(parseFloat(m[1]) * 1000), toMs: Math.round(parseFloat(m[2]) * 1000) });
  }
  return out;
}

export function parseLoudness(log: string): { lufs: number | null; truePeak: number | null } {
  // ebur128's summary block is printed at the end; take the LAST occurrence so a
  // per-frame line cannot be mistaken for the integrated figure.
  const i = log.lastIndexOf('Integrated loudness');
  const tail = i >= 0 ? log.slice(i) : log;
  const l = /I:\s*(-?[\d.]+)\s*LUFS/.exec(tail);
  const p = /Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(tail);
  return {
    lufs: l ? parseFloat(l[1]) : null,
    truePeak: p ? (p[1] === '-inf' ? -100 : parseFloat(p[1])) : null,
  };
}

/**
 * WHERE THE LOUDNESS IS, so a loudness finding can be jumped to like any other.
 *
 * ebur128 prints a line every 100 ms with the short-term loudness (S, the
 * 3 seconds ending at t) and the true peak of that frame per channel (FTPK).
 * The loudest short-term window is where an over-target clip is most over;
 * the highest frame peak is where it would clip. Both are positions in the
 * clip, in ms.
 */
export function parseLoudnessPlaces(log: string): { loudest: { atMs: number; lufs: number } | null; peak: { atMs: number; dbfs: number } | null } {
  let loudest: { atMs: number; lufs: number } | null = null;
  let peak: { atMs: number; dbfs: number } | null = null;
  for (const line of log.split('\n')) {
    const t = /\bt:\s*([\d.]+)/.exec(line);
    if (!t) continue;
    const atMs = Math.round(parseFloat(t[1]) * 1000);
    const st = /\bS:\s*(-?[\d.]+)/.exec(line);
    if (st) {
      const v = parseFloat(st[1]);
      // the first 3 s have no full window yet and read low, so they never win unfairly
      if (Number.isFinite(v) && (!loudest || v > loudest.lufs)) loudest = { atMs, lufs: v };
    }
    const fp = /FTPK:\s*([-\d.\sinf]+?)\s*dBFS/.exec(line);
    if (fp) {
      for (const tok of fp[1].trim().split(/\s+/)) {
        const v = tok === '-inf' ? -Infinity : parseFloat(tok);
        if (Number.isFinite(v) && (!peak || v > peak.dbfs)) peak = { atMs, dbfs: v };
      }
    }
  }
  return { loudest, peak };
}

// ---- the pass --------------------------------------------------------------
/**
 * Run QC over a finished clip.
 *
 * Reads the asset for what was ASKED for and the provenance chain for what was
 * used, then measures the file itself. All three have to agree, and where they
 * do not, the disagreement is the finding.
 */
export async function runQc(vodAssetId: string, opts: { path?: string } = {}): Promise<QcResult> {
  const asset = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [vodAssetId]);
  if (!asset) throw new Error(`vod asset ${vodAssetId} not found`);

  const findings: QcFinding[] = [];
  const skipped: { check: string; reason: string }[] = [];

  // ---- coverage, from the chain rather than re-measured -------------------
  if (asset.source_coverage_pct != null) {
    const pct = Number(asset.source_coverage_pct);
    const gapMs = Number(asset.source_gap_ms ?? 0);
    if (pct < 100) {
      findings.push({
        check: 'coverage', severity: gapMs > 1000 ? 'error' : 'warning',
        measured: `${pct}%`, expected: '100%',
        message: `The source range was ${pct}% covered: ${(gapMs / 1000).toFixed(1)}s of it was never recorded.`,
      });
    }
    if ((asset.source_block_count ?? 1) > 1) {
      findings.push({
        check: 'coverage', severity: 'info',
        measured: `${asset.source_block_count} blocks`,
        message: `This clip was joined from ${asset.source_block_count} separate stretches of media. ` +
                 `Check the joins.`,
      });
    }
  } else {
    skipped.push({ check: 'coverage', reason: 'this asset has no recorded provenance' });
  }

  // ---- is there media at all ----------------------------------------------
  // NO MEDIA IS A FAILURE, NOT A SKIP. This branch used to record four skips
  // and return 'pass'.
  const path = opts.path ?? mediaInputFor(asset);
  if (!path || (!/^https?:/.test(path) && !existsSync(path))) {
    findings.push({
      check: 'media', severity: 'error',
      message: asset.media_state === 'failed' && asset.media_error
        ? `No media: the build failed. ${asset.media_error}`
        : asset.media_state === 'processing'
          ? 'No media yet: the build has not finished.'
          : 'No media: nothing was built for this asset, so there is nothing to play.',
    });
    for (const c of ['playback', 'duration', 'silence', 'black', 'loudness']) skipped.push({ check: c, reason: 'there is no media to measure' });
    return finish(vodAssetId, findings, skipped, asset.media_state === 'failed' || asset.media_state === 'processing' ? null : 'missing');
  }

  // ---- does it open and decode, as a player would read it ------------------
  const streams = await probeStreams(path);
  if (streams.error) {
    findings.push({
      check: 'playback', severity: 'error',
      message: `The media will not open: ${streams.error}`,
    });
    for (const c of ['duration', 'silence', 'black', 'loudness']) skipped.push({ check: c, reason: 'the media will not open' });
    return finish(vodAssetId, findings, skipped, 'unplayable');
  }
  const hasVideo = streams.video;
  const log = await analyse(path, hasVideo, streams.audio);
  const decodeFaults = playbackErrors(log);
  const decodedAnything = /time=\d+:\d+:[\d.]+/.test(log);
  if (!decodedAnything || decodeFaults.length) {
    findings.push({
      check: 'playback', severity: 'error',
      measured: decodedAnything ? `${decodeFaults.length} fault(s)` : 'nothing decoded',
      message: decodedAnything
        ? `Playback breaks part way: ${decodeFaults[0]}`
        : `The media opened but nothing decoded${decodeFaults[0] ? `: ${decodeFaults[0]}` : '.'}`,
    });
  }

  // duration: what the file is, against what was asked for
  const durM = /time=(\d+):(\d+):([\d.]+)/g;
  let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
  while ((m = durM.exec(log)) !== null) last = m;
  // The container's own duration first: ffmpeg's progress `time=` lags the
  // end of the file by a few seconds and read a 300.96 s clip as 293.7 s.
  const measuredMs = streams.durationMs ?? (last
    ? Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000)
    : null);
  const wantedMs = Number(asset.end_epoch_ms) - Number(asset.start_epoch_ms);
  if (measuredMs == null) {
    skipped.push({ check: 'duration', reason: 'ffmpeg reported no duration' });
  } else if (Math.abs(measuredMs - wantedMs) > DURATION_TOLERANCE_MS) {
    findings.push({
      // A clip built by stream copy lands on the keyframes either side of the
      // range, so a second or two over is the method, not a fault: warn. More
      // than that is media that was not there, or a trim in the wrong place.
      check: 'duration', severity: Math.abs(measuredMs - wantedMs) > DURATION_ERROR_MS ? 'error' : 'warning',
      measured: `${(measuredMs / 1000).toFixed(2)}s`, expected: `${(wantedMs / 1000).toFixed(2)}s`,
      // WHERE TO LOOK: the end, which is where a clip that is too short stops
      // early and a clip that is too long runs on. The last 5 s, or the part
      // past the requested length.
      fromMs: measuredMs > wantedMs ? Math.max(0, wantedMs) : Math.max(0, measuredMs - 5000),
      toMs: measuredMs,
      message: `The clip is ${(Math.abs(measuredMs - wantedMs) / 1000).toFixed(2)}s ` +
               `${measuredMs > wantedMs ? 'longer' : 'shorter'} than the range that was asked for.`,
    });
  }

  // silence
  for (const s of parseSilence(log)) {
    const toMs = s.toMs < 0 ? (measuredMs ?? s.fromMs) : s.toMs;
    const lenS = (toMs - s.fromMs) / 1000;
    findings.push({
      check: 'silence',
      // Silence at the very end is the one that gets published. Silence in the
      // middle is more often deliberate.
      severity: measuredMs != null && toMs >= measuredMs - 500 ? 'warning' : 'info',
      fromMs: s.fromMs, toMs,
      measured: `${lenS.toFixed(1)}s below ${SILENCE_DB} dBFS`,
      message: `${lenS.toFixed(1)}s of silence` +
               (measuredMs != null && toMs >= measuredMs - 500 ? ' at the end of the clip.' : '.'),
    });
  }

  // black
  if (hasVideo) {
    for (const b of parseBlack(log)) {
      const lenS = (b.toMs - b.fromMs) / 1000;
      findings.push({
        check: 'black', severity: 'warning',
        fromMs: b.fromMs, toMs: b.toMs,
        measured: `${lenS.toFixed(1)}s`,
        message: `${lenS.toFixed(1)}s of black frames.`,
      });
    }
  } else {
    skipped.push({ check: 'black', reason: 'this clip has no video track' });
  }

  // NO AUDIO TRACK AT ALL on a picture cut from a live channel or event is a
  // defect: every live source carries sound. Found 27 Oct 2026: clips built
  // from the video rendition alone came out silent and QC reported it as "not
  // checked". An uploaded file may legitimately be picture only: a warning.
  if (hasVideo && !streams.audio) {
    findings.push({
      check: 'silence', severity: asset.source_kind === 'recording' ? 'error' : 'warning',
      measured: 'no audio track', expected: 'an audio track',
      message: 'There is no audio track: this plays as silent picture.',
    });
  }

  // loudness
  const { lufs, truePeak } = parseLoudness(log);
  const places = parseLoudnessPlaces(log);
  if (!streams.audio) {
    skipped.push({ check: 'silence', reason: 'this media has no audio track' });
    skipped.push({ check: 'loudness', reason: 'this media has no audio track' });
  } else if (lufs == null) {
    skipped.push({ check: 'loudness', reason: 'ebur128 reported no integrated loudness' });
  } else {
    if (Math.abs(lufs - TARGET_LUFS) > LUFS_TOLERANCE) {
      findings.push({
        check: 'loudness', severity: 'warning',
        measured: `${lufs.toFixed(1)} LUFS`, expected: `${TARGET_LUFS} LUFS ±${LUFS_TOLERANCE}`,
        // Loudness is a whole-clip figure, but a reviewer still needs somewhere
        // to listen: the loudest 3 s when it is over target. Under target has
        // no single place, so it carries none.
        ...(lufs > TARGET_LUFS && places.loudest
          ? { fromMs: Math.max(0, places.loudest.atMs - 3000), toMs: places.loudest.atMs } : {}),
        message: `Integrated loudness is ${lufs.toFixed(1)} LUFS, ` +
                 `${Math.abs(lufs - TARGET_LUFS).toFixed(1)} LU ${lufs > TARGET_LUFS ? 'above' : 'below'} target.` +
                 (lufs > TARGET_LUFS && places.loudest ? ` Loudest at ${(places.loudest.atMs / 1000).toFixed(1)}s (${places.loudest.lufs.toFixed(1)} LUFS short-term).` : ''),
      });
    }
    if (truePeak != null && truePeak > TRUE_PEAK_CEILING_DBFS) {
      findings.push({
        check: 'loudness', severity: 'warning',
        measured: `${truePeak.toFixed(1)} dBFS`, expected: `at or below ${TRUE_PEAK_CEILING_DBFS} dBFS`,
        ...(places.peak ? { fromMs: Math.max(0, places.peak.atMs - 1000), toMs: places.peak.atMs + 1000 } : {}),
        message: `True peak reaches ${truePeak.toFixed(1)} dBFS and will clip on some decoders.` +
                 (places.peak ? ` Highest at ${(places.peak.atMs / 1000).toFixed(1)}s.` : ''),
      });
    }
  }

  const unplayable = findings.some((f) => f.check === 'playback' && f.severity === 'error');
  return finish(vodAssetId, findings, skipped, unplayable ? 'unplayable' : 'ready');
}

/** Where the rendered MP4 for a clip lives. */
function clipFilePath(vodAssetId: string): string {
  return `${config.clips.dir}/${vodAssetId}/clip.mp4`;
}

/**
 * `media` is what QC learned about the media itself: 'ready' (it decoded),
 * 'unplayable' (it did not), 'missing' (there is none), or null (say nothing:
 * a failed or running build already says it). A build failure is never
 * overwritten, and 'ready' only replaces a state QC itself can vouch for.
 */
async function finish(assetId: string, findings: QcFinding[], skipped: { check: string; reason: string }[],
                      media: 'ready' | 'unplayable' | 'missing' | null = null): Promise<QcResult> {
  const state: QcResult['state'] =
    findings.some((f) => f.severity === 'error') ? 'failed'
    : findings.some((f) => f.severity === 'warning') ? 'warnings'
    : 'pass';

  // VERDICTS SURVIVE A RE-RUN when the same finding comes back. Read them
  // before the findings are replaced, and match each new finding to an old
  // one: same check, severity and measurement, at the same place within a
  // second. A finding that changed is a new finding and needs a new look.
  const prior = await query<any>(
    `SELECT check_name, severity::text AS severity, from_ms, measured, review_state, review_note, reviewed_by, reviewed_at
       FROM qc_events WHERE vod_asset_id = $1 AND review_state IS NOT NULL`, [assetId]);
  const verdictFor = (f: QcFinding) => prior.find((p: any) =>
    p.check_name === f.check && p.severity === f.severity && (p.measured ?? null) === (f.measured ?? null)
    && ((p.from_ms == null && f.fromMs == null) || (p.from_ms != null && f.fromMs != null && Math.abs(Number(p.from_ms) - f.fromMs) <= 1000)));

  // A re-run replaces its own findings entirely: stale findings from a previous
  // cut are worse than none, because they describe media that no longer exists.
  await query(`DELETE FROM qc_events WHERE vod_asset_id = $1`, [assetId]);
  for (const f of findings) {
    const v = verdictFor(f);
    await query(
      `INSERT INTO qc_events (vod_asset_id, check_name, severity, from_ms, to_ms, measured, expected, message,
                              review_state, review_note, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3::qc_severity,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [assetId, f.check, f.severity, f.fromMs ?? null, f.toMs ?? null,
       f.measured ?? null, f.expected ?? null, f.message,
       v?.review_state ?? null, v?.review_note ?? null, v?.reviewed_by ?? null, v?.reviewed_at ?? null]
    );
  }
  // Checks that could not run are recorded too. "We did not look" and "we looked
  // and it was fine" are different answers, and only one of them is assurance.
  for (const s of skipped) {
    await query(
      `INSERT INTO qc_events (vod_asset_id, check_name, severity, message)
       VALUES ($1,$2,'info'::qc_severity,$3)`,
      [assetId, s.check, `Not checked: ${s.reason}.`]
    );
  }
  await query(
    `UPDATE vod_assets SET qc_machine_state = $2, qc_at = now(), updated_at = now() WHERE id = $1`,
    [assetId, state]
  );
  // The state every gate reads: the machine's, less what a person accepted.
  await refreshQcState(assetId);
  if (media) {
    await query(
      `UPDATE vod_assets SET
         media_state = $2,
         media_error = CASE WHEN $2 = 'ready' THEN NULL ELSE $3 END,
         media_error_code = CASE WHEN $2 = 'ready' THEN NULL ELSE $4 END,
         media_state_at = now()
       WHERE id = $1
         AND (media_state IS NULL OR media_state IN ('ready', 'unplayable', 'missing'))`,
      [assetId, media,
       findings.find((f) => f.check === 'playback' || f.check === 'media')?.message ?? null,
       media === 'unplayable' ? 'qc_playback' : media === 'missing' ? 'qc_no_media' : null]
    );
  }
  return { assetId, state, findings, skipped };
}

export async function qcFindings(assetId: string) {
  return query<any>(
    `SELECT id, check_name, severity, from_ms, to_ms, measured, expected, message, at,
            review_state, review_note, reviewed_by, reviewed_at
       FROM qc_events WHERE vod_asset_id = $1
      ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               CASE check_name WHEN 'media' THEN 0 WHEN 'playback' THEN 1 ELSE 2 END, from_ms NULLS LAST`,
    [assetId]
  );
}

// ---- review: a person's verdict on a finding --------------------------------
/** Skipped-check rows are recorded as info findings; they are not reviewable. */
const NOT_CHECKED = `message LIKE 'Not checked:%'`;

/**
 * Recompute the asset's QC state from its findings, discounting the ones a
 * person accepted. Every gate (publishing, readiness, the review queue) reads
 * vod_assets.qc_state, so accepting the last error is what lets the asset
 * through, and nothing downstream needs to know about verdicts.
 */
export async function refreshQcState(assetId: string): Promise<{ state: QcResult['state']; machine: string | null }> {
  const r = await one<any>(
    `SELECT
       bool_or(severity = 'error'   AND review_state IS DISTINCT FROM 'accepted') AS err,
       bool_or(severity = 'warning' AND review_state IS DISTINCT FROM 'accepted') AS warn
       FROM qc_events WHERE vod_asset_id = $1 AND NOT (${NOT_CHECKED})`, [assetId]);
  const state: QcResult['state'] = r?.err ? 'failed' : r?.warn ? 'warnings' : 'pass';
  const row = await one<any>(
    `UPDATE vod_assets SET qc_state = $2, updated_at = now() WHERE id = $1 RETURNING qc_machine_state`, [assetId, state]);
  return { state, machine: row?.qc_machine_state ?? null };
}

export class QcReviewError extends Error { status = 400; }

/**
 * Record a verdict on one finding: 'accepted' (looked at it, it is fine),
 * 'confirmed' (looked at it, it is a real problem) or null (undo). Accepting
 * an ERROR needs a note: it overrides a check that would otherwise block the
 * asset, and the next person to wonder why should be able to read why.
 */
export async function reviewQcFinding(o: {
  assetId: string; findingId: number; verdict: 'accepted' | 'confirmed' | null; note?: string | null;
  actorLabel: string; actorId: string | null; accountId: string | null;
}): Promise<{ state: QcResult['state']; machine: string | null; finding: any }> {
  const f = await one<any>(`SELECT * FROM qc_events WHERE id = $1 AND vod_asset_id = $2`, [o.findingId, o.assetId]);
  if (!f) throw Object.assign(new Error('QC finding not found'), { status: 404 });
  if (/^Not checked:/.test(f.message)) throw new QcReviewError('A check that did not run has nothing to review. Run QC again once it can.');
  const note = o.note?.trim() || null;
  if (o.verdict === 'accepted' && f.severity === 'error' && !note) {
    throw new QcReviewError('Say why: accepting an error overrides QC, so it needs a note (for example "checked, the end is the closing credits").');
  }
  const updated = await one<any>(
    `UPDATE qc_events SET review_state = $3, review_note = $4,
            reviewed_by = CASE WHEN $3::text IS NULL THEN NULL ELSE $5 END,
            reviewed_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
      WHERE id = $1 AND vod_asset_id = $2
      RETURNING id, check_name, severity, from_ms, to_ms, measured, expected, message, at,
                review_state, review_note, reviewed_by, reviewed_at`,
    [o.findingId, o.assetId, o.verdict, o.verdict ? note : null, o.actorLabel]);
  const st = await refreshQcState(o.assetId);
  await writeAudit(null, {
    accountId: o.accountId, userId: o.actorId, label: o.actorLabel, action: 'update',
    entityType: 'vod_asset', entityId: o.assetId,
    snapshot: { qcReview: {
      finding: f.message, check: f.check_name, severity: f.severity, fromMs: f.from_ms, toMs: f.to_ms,
      verdict: o.verdict ?? 'cleared', note, qcState: st.state, qcMachineState: st.machine,
    } },
  }).catch(() => {});
  return { ...st, finding: updated };
}
