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
//  All five run off ONE ffmpeg pass where they can, because decoding a clip
//  twice to ask two questions about it is the sort of thing that makes an
//  automated check too expensive to run by default.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { one, query } from '../db';
import { config } from '../config';

export type QcSeverity = 'info' | 'warning' | 'error';

export interface QcFinding {
  check: 'duration' | 'coverage' | 'silence' | 'black' | 'loudness';
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
async function analyse(path: string, hasVideo: boolean): Promise<string> {
  const filters: string[] = [];
  if (hasVideo) filters.push(`[0:v]blackdetect=d=${MIN_BLACK_MS / 1000}:pic_th=0.98[v]`);
  filters.push(
    `[0:a]silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE_MS / 1000}[s]`,
    `[s]ebur128=peak=true[a]`
  );
  const args = [
    '-hide_banner', '-nostdin', '-i', path,
    '-filter_complex', filters.join(';'),
    ...(hasVideo ? ['-map', '[v]'] : []),
    '-map', '[a]',
    '-f', 'null', '-',
  ];
  return runFfmpeg(args);
}

/** Does this file have a video stream? Asked once, cheaply. */
async function probeHasVideo(path: string): Promise<boolean> {
  const out = await new Promise<string>((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    p.stdout.on('data', (b: Buffer) => { s += b.toString('utf8'); });
    p.on('close', () => resolve(s));
    p.on('error', () => resolve(''));
  });
  return out.includes('video');
}

// ---- parsing ---------------------------------------------------------------
function parseSilence(log: string): { fromMs: number; toMs: number }[] {
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

function parseBlack(log: string): { fromMs: number; toMs: number }[] {
  const out: { fromMs: number; toMs: number }[] = [];
  for (const line of log.split('\n')) {
    const m = /black_start:\s*([\d.]+).*?black_end:\s*([\d.]+)/.exec(line);
    if (m) out.push({ fromMs: Math.round(parseFloat(m[1]) * 1000), toMs: Math.round(parseFloat(m[2]) * 1000) });
  }
  return out;
}

function parseLoudness(log: string): { lufs: number | null; truePeak: number | null } {
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

  // ---- the file itself ----------------------------------------------------
  const path = opts.path ?? clipFilePath(vodAssetId);
  if (!path || !existsSync(path)) {
    skipped.push({ check: 'duration', reason: 'no rendered file to measure' });
    skipped.push({ check: 'silence', reason: 'no rendered file to measure' });
    skipped.push({ check: 'black', reason: 'no rendered file to measure' });
    skipped.push({ check: 'loudness', reason: 'no rendered file to measure' });
    return finish(vodAssetId, findings, skipped);
  }

  const hasVideo = await probeHasVideo(path);
  const log = await analyse(path, hasVideo);

  // duration: what the file is, against what was asked for
  const durM = /time=(\d+):(\d+):([\d.]+)/g;
  let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
  while ((m = durM.exec(log)) !== null) last = m;
  const measuredMs = last
    ? Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000)
    : null;
  const wantedMs = Number(asset.end_epoch_ms) - Number(asset.start_epoch_ms);
  if (measuredMs == null) {
    skipped.push({ check: 'duration', reason: 'ffmpeg reported no duration' });
  } else if (Math.abs(measuredMs - wantedMs) > DURATION_TOLERANCE_MS) {
    findings.push({
      check: 'duration', severity: 'error',
      measured: `${(measuredMs / 1000).toFixed(2)}s`, expected: `${(wantedMs / 1000).toFixed(2)}s`,
      message: `The clip is ${((measuredMs - wantedMs) / 1000).toFixed(2)}s ` +
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

  // loudness
  const { lufs, truePeak } = parseLoudness(log);
  if (lufs == null) {
    skipped.push({ check: 'loudness', reason: 'ebur128 reported no integrated loudness' });
  } else {
    if (Math.abs(lufs - TARGET_LUFS) > LUFS_TOLERANCE) {
      findings.push({
        check: 'loudness', severity: 'warning',
        measured: `${lufs.toFixed(1)} LUFS`, expected: `${TARGET_LUFS} LUFS ±${LUFS_TOLERANCE}`,
        message: `Integrated loudness is ${lufs.toFixed(1)} LUFS, ` +
                 `${Math.abs(lufs - TARGET_LUFS).toFixed(1)} LU ${lufs > TARGET_LUFS ? 'above' : 'below'} target.`,
      });
    }
    if (truePeak != null && truePeak > TRUE_PEAK_CEILING_DBFS) {
      findings.push({
        check: 'loudness', severity: 'warning',
        measured: `${truePeak.toFixed(1)} dBFS`, expected: `at or below ${TRUE_PEAK_CEILING_DBFS} dBFS`,
        message: `True peak reaches ${truePeak.toFixed(1)} dBFS and will clip on some decoders.`,
      });
    }
  }

  return finish(vodAssetId, findings, skipped);
}

/** Where the rendered MP4 for a clip lives. */
function clipFilePath(vodAssetId: string): string {
  return `${config.clips.dir}/${vodAssetId}/clip.mp4`;
}

async function finish(assetId: string, findings: QcFinding[], skipped: { check: string; reason: string }[]): Promise<QcResult> {
  const state: QcResult['state'] =
    findings.some((f) => f.severity === 'error') ? 'failed'
    : findings.some((f) => f.severity === 'warning') ? 'warnings'
    : 'pass';

  // A re-run replaces its own findings entirely: stale findings from a previous
  // cut are worse than none, because they describe media that no longer exists.
  await query(`DELETE FROM qc_events WHERE vod_asset_id = $1`, [assetId]);
  for (const f of findings) {
    await query(
      `INSERT INTO qc_events (vod_asset_id, check_name, severity, from_ms, to_ms, measured, expected, message)
       VALUES ($1,$2,$3::qc_severity,$4,$5,$6,$7,$8)`,
      [assetId, f.check, f.severity, f.fromMs ?? null, f.toMs ?? null,
       f.measured ?? null, f.expected ?? null, f.message]
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
    `UPDATE vod_assets SET qc_state = $2, qc_at = now(), updated_at = now() WHERE id = $1`,
    [assetId, state]
  );
  return { assetId, state, findings, skipped };
}

export async function qcFindings(assetId: string) {
  return query<any>(
    `SELECT check_name, severity, from_ms, to_ms, measured, expected, message, at
       FROM qc_events WHERE vod_asset_id = $1
      ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, from_ms NULLS LAST`,
    [assetId]
  );
}
