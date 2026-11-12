// ============================================================================
//  THE HOUSE PREVIEW OF A SLATE OR LOOP, ITS QC, AND ITS APPROVAL
//  (Christian, 11 Nov 2026; migration 0161).
//
//  WHY. Loops & Fillers showed a loop as a hover animation stepped through
//  sprite sheets: small, soft, silent and nothing like what reaches a viewer.
//  And a loop is never played as uploaded. Each stream re-encodes it to its own
//  ladder and cuts it to whole segments (volt-encoder/bin/filler_build.py), so
//  a 13.4 s file with 4 s segments plays as 12 s and the picture jumps where it
//  restarts. Nobody could see that until it was on air.
//
//  WHAT. When a slate or loop lands, it is built ONCE in the account's house
//  format by the same filler_build.py the streams use, packaged as HLS, and
//  kept under ORIGIN_DIR/filler-preview/<id>/ (on AWS, in the bucket: see
//  WHERE THE BUILD IS KEPT below). The console plays it three
//  times back to back (preview.m3u8: the media playlists repeated with a
//  discontinuity, the way playout.py splices a loop), so the join is watched,
//  not imagined. QC then measures that build, not the upload: the same checks
//  as a clip (services/qc.ts: media, playback, black, silence, loudness) plus
//  the ones a loop fails in its own ways (the cut to whole segments, a jump or
//  a click where it restarts, upscaling, bars, frame rate, interlacing).
//
//  THE HOUSE FORMAT is what the account actually delivers: its transcode
//  output profile used by the most channels (through their channel groups) (the top rung and the rung nearest
//  720p below it, at the profile's segment length). An account with no
//  profile gets the standard: 1080p and 720p H.264 High at 25 fps, AAC stereo
//  48 kHz. A stream's own copy can still differ (its own ladder, its
//  watermark); the details page lists those per stream as before.
//
//  FINDINGS, NOT VERDICTS, as in qc.ts: QC never approves or rejects. A person
//  does, and only an approved slate or loop can be newly given to a channel,
//  event or FAST channel (modules/fillerAssets.ts assertFillerAsset). Approving
//  over a QC error, or with no preview at all, needs a note that says why.
// ============================================================================
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { one, query } from '../../db';
import { config } from '../../config';
import { py, lastJson } from '../fillerPrep';
import { parseBlack, parseLoudness, parseSilence, playbackErrors, type QcSeverity } from '../qc';

/** How many times the console's preview plays the loop back to back. */
export const PREVIEW_REPEATS = 3;
/** filler_build.py never builds more than this much of a loop. */
export const LOOP_CAP_SECONDS = 60;

export const previewDir = (id: string) => resolve(config.testStream.originDir, 'filler-preview', id);
/** Served by the /origin static route like every stream's own filler copy. */
export const previewUrl = (id: string) => `/origin/filler-preview/${id}/preview.m3u8`;

// ---- where the build is kept -----------------------------------------------
//  WHERE THE BUILD IS KEPT (build queue 2.1a-3b). On the Mac the build stays in
//  ORIGIN_DIR/filler-preview/<id>/ and /origin serves it, as before. On AWS the
//  control plane is several tasks that come and go, so a preview on one task's
//  disk did not play from the others, its QC could not run there, and it was
//  lost with the task. With FILLER_STORE_DRIVER=s3 the build is made on the
//  task's disk as scratch, then stored in the bucket under
//  filler/preview/<id>/<build>/ and served by any task at /filler/... (like a
//  stream's pre-built loop, 2.1a-3). Each build gets its own folder, so its
//  files never change once written (they are served as immutable) and a
//  rebuild cannot be confused with the build before it. QC on another task
//  copies just the two tracks it measures into scratch, and its stills are
//  stored beside the build.

/** The folder of one stored build. Pure. */
export function previewPrefix(id: string, build: string): string {
  const i = String(id).replace(/[^0-9a-zA-Z-]/g, '');
  const b = String(build ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 32) || 'build';
  return `filler/preview/${i}/${b}/`;
}
/** Every stored build of one slate or loop. Pure. */
export const previewRoot = (id: string) => `filler/preview/${String(id).replace(/[^0-9a-zA-Z-]/g, '')}/`;

/**
 * Upload order of a build: segments and inits, then the media playlists, then
 * the master, the repeats and preview.m3u8 last, so the console never finds a
 * playlist naming a file that is not there yet. QC's working files stay out.
 */
export function previewRank(rel: string): number {
  if (rel === 'preview.m3u8') return 3;
  if (rel === 'master.m3u8' || rel.endsWith('.loop.m3u8')) return 2;
  return /\.m3u8$/.test(rel) ? 1 : 0;
}
export const previewSkip = (rel: string) => rel.startsWith('.qc/') || rel.startsWith('qc-frames/');

/** Store a finished build in the bucket (S3 only; null on the Mac). */
async function storePreview(id: string, dir: string): Promise<string | null> {
  const { fillerDriver, putFillerDir } = await import('./fillerStore');
  if (fillerDriver() !== 's3') return null;
  const prefix = previewPrefix(id, Date.now().toString(36) + randomBytes(3).toString('hex'));
  await putFillerDir(dir, prefix, { rank: previewRank, skip: previewSkip });
  return prefix;
}

// ---- the house format ------------------------------------------------------
export interface HouseRung {
  label: string; width: number; height: number; fps: number; bitrate_kbps: number;
  x264_profile: 'high'; x264_level: null; pix_fmt: 'yuv420p';
}
export interface HouseFormat {
  profileId: string | null; profileName: string; usedBy: number; standard: boolean;
  segmentSeconds: number; video: HouseRung[];
  audio: { sample_rate: number; channels: number; bitrate_kbps: number };
}

const even = (n: number) => { const v = Math.round(n); return v - (v % 2); };
const rungOf = (height: number, kbps: number, fps: number): HouseRung => ({
  label: `${height}p`, width: even((height * 16) / 9), height, fps, bitrate_kbps: kbps,
  x264_profile: 'high', x264_level: null, pix_fmt: 'yuv420p',
});
const AUDIO = { sample_rate: 48000, channels: 2, bitrate_kbps: 128 };

export const STANDARD_HOUSE: HouseFormat = {
  profileId: null, profileName: 'Standard (1080p and 720p)', usedBy: 0, standard: true,
  segmentSeconds: 4, video: [rungOf(1080, 6000, 25), rungOf(720, 3000, 25)], audio: AUDIO,
};

/**
 * The house format from an output profile: its top rung, plus the rung nearest
 * 720p below it. Two renditions are enough to judge a loop by (the best a
 * viewer gets, and what most phones get) at a fraction of the full ladder's
 * encode time. Pure, so the choice is tested without a database.
 */
export function houseFromProfile(p: { id: string; name: string; rungs: any; segment_dur: any } | null, usedBy = 0): HouseFormat {
  const rungs = (Array.isArray(p?.rungs) ? p!.rungs : [])
    .map((r: any) => ({ height: Number(r.height), kbps: Number(r.bitrate_kbps), fps: Number(r.fps) || 25 }))
    .filter((r: any) => r.height > 0 && r.kbps > 0)
    .sort((a: any, b: any) => b.height - a.height || b.kbps - a.kbps);
  if (!p || !rungs.length) return STANDARD_HOUSE;
  const top = rungs[0];
  const below = rungs.filter((r: any) => r.height < top.height);
  const second = below.length ? below.reduce((a: any, b: any) => (Math.abs(b.height - 720) < Math.abs(a.height - 720) ? b : a)) : null;
  const seg = Number(p.segment_dur);
  return {
    profileId: p.id, profileName: p.name, usedBy, standard: false,
    segmentSeconds: Number.isFinite(seg) && seg > 0 ? seg : 4,
    video: [rungOf(top.height, top.kbps, top.fps), ...(second ? [rungOf(second.height, second.kbps, second.fps)] : [])],
    audio: AUDIO,
  };
}

export async function houseFormat(accountId: string): Promise<HouseFormat> {
  const p = await one<any>(
    `SELECT p.id, p.name, p.rungs, p.segment_dur, count(c.id)::int AS n
       FROM output_profiles p
       LEFT JOIN groups g ON g.output_profile_id = p.id
       LEFT JOIN channels c ON c.group_id = g.id
      WHERE p.account_id = $1 AND p.workflow_type::text = 'transcode'
      GROUP BY p.id ORDER BY count(c.id) DESC, p.created_at ASC LIMIT 1`, [accountId]);
  return houseFromProfile(p ?? null, Number(p?.n ?? 0));
}

// ---- the preview playlists -------------------------------------------------
/**
 * A VOD media playlist played `times` times: the segments repeated with a
 * discontinuity between rounds (their timestamps start again), which is how
 * playout.py puts a loop on air. Pure.
 */
export function repeatPlaylist(text: string, times: number): string {
  const head: string[] = [], body: string[] = [];
  let inBody = false;
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim() || l.startsWith('#EXT-X-ENDLIST')) continue;
    if (!inBody && (l.startsWith('#EXT-X-MAP') || l.startsWith('#EXTINF'))) inBody = true;
    (inBody ? body : head).push(l);
  }
  const out = [...head];
  for (let i = 0; i < Math.max(1, times); i++) {
    if (i > 0) out.push('#EXT-X-DISCONTINUITY');
    out.push(...body);
  }
  out.push('#EXT-X-ENDLIST');
  return out.join('\n') + '\n';
}

/** The master playlist pointed at the repeated media playlists. Pure. */
export function repeatMaster(text: string): string {
  return text.replace(/([A-Za-z0-9_.-]+?)\.m3u8/g, (_m, name: string) => (name.endsWith('.loop') ? `${name}.m3u8` : `${name}.loop.m3u8`));
}

async function writePreviewPlaylists(dir: string, times: number): Promise<void> {
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.m3u8') || f.endsWith('.loop.m3u8') || f === 'master.m3u8' || f === 'preview.m3u8') continue;
    await writeFile(join(dir, f.replace(/\.m3u8$/, '.loop.m3u8')), repeatPlaylist(await readFile(join(dir, f), 'utf8'), times));
  }
  await writeFile(join(dir, 'preview.m3u8'), repeatMaster(await readFile(join(dir, 'master.m3u8'), 'utf8')));
}

// ---- QC --------------------------------------------------------------------
export type FillerCheck = 'media' | 'playback' | 'loop_length' | 'loop_point' | 'audio_loop_point' | 'resolution'
  | 'aspect' | 'frame_rate' | 'interlaced' | 'black' | 'silence' | 'loudness';
export interface FillerFinding {
  check: FillerCheck; severity: QcSeverity; message: string;
  fromMs?: number | null; toMs?: number | null; measured?: string | null; expected?: string | null;
  /** Stable across QC runs for the same fault at the same place: what an acceptance is kept against. */
  key?: string;
  /** Stills from the preview at the finding's moment (a join gets the last frame and the first). */
  frames?: { label: string; atMs: number; url: string }[];
}

/** The key a finding's acceptance is kept against (migration 0175). Pure. */
export const findingKey = (f: Pick<FillerFinding, 'check' | 'fromMs'>) => `${f.check}:${f.fromMs ?? ''}`;

/**
 * THE MOMENTS TO SHOW for a finding (Christian, 12 Nov: see the content at
 * the time QC points to). A jump or click at the join shows both sides of
 * it, the loop's last frame and its first, side by side; anything else with
 * a place shows the frame there. Pure: times in ms, inside the loop.
 */
export function framesFor(f: FillerFinding, loopMs: number, fps: number): { label: string; atMs: number }[] {
  const frameMs = Math.round(1000 / (fps || 25));
  if (f.check === 'loop_point' || f.check === 'audio_loop_point') {
    return [{ label: 'Last frame', atMs: Math.max(0, loopMs - frameMs) }, { label: 'First frame (after the join)', atMs: 0 }];
  }
  if (f.fromMs == null || !loopMs) return [];
  const at = Math.min(Math.max(0, f.fromMs), Math.max(0, loopMs - frameMs));
  return [{ label: `At ${(at / 1000).toFixed(1)} s`, atMs: at }];
}
export interface FillerQc { state: 'pass' | 'warnings' | 'failed'; findings: FillerFinding[]; skipped: { check: string; reason: string }[] }

export function qcState(findings: FillerFinding[]): FillerQc['state'] {
  return findings.some((f) => f.severity === 'error') ? 'failed' : findings.some((f) => f.severity === 'warning') ? 'warnings' : 'pass';
}

const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * THE CUT TO WHOLE SEGMENTS. filler_build.py makes a loop a whole number of
 * segments (at least two, at most 60 s), so the length played is rarely the
 * length uploaded. Played shorter, the end of the file is never seen and the
 * picture jumps back to the start; longer, the start repeats before the join.
 * Pure.
 */
export function loopLengthFinding(sourceMs: number | null, loopMs: number, segmentSeconds: number, frameMs = 40): FillerFinding | null {
  if (!sourceMs || sourceMs <= 0) return null;
  const diff = loopMs - sourceMs;
  if (Math.abs(diff) <= frameMs) return null;
  const seg = segmentSeconds;
  const fit = (n: number) => `${(n * seg).toFixed(0)} s`;
  const lower = Math.max(2, Math.floor(sourceMs / 1000 / seg)), upper = Math.max(2, Math.ceil(sourceMs / 1000 / seg));
  const hint = lower === upper ? fit(lower) : `${fit(lower)} or ${fit(upper)}`;
  const capped = sourceMs > LOOP_CAP_SECONDS * 1000 + frameMs;
  const severity: QcSeverity = Math.abs(diff) >= 500 ? 'warning' : 'info';
  const message = capped
    ? `Only the first ${s1(loopMs)} of this ${s1(sourceMs)} file is played: loops are capped at ${LOOP_CAP_SECONDS} s, so the picture jumps back to the start after that.`
    : diff < 0
      ? `The house format plays ${s1(loopMs)} of this ${s1(sourceMs)} file: loops are cut to whole ${seg} s segments, so the last ${s1(-diff)} is never seen and the picture jumps where it restarts. Trim or extend the file to ${hint} for a clean join.`
      : `The house format plays ${s1(loopMs)}, longer than this ${s1(sourceMs)} file: loops fill whole ${seg} s segments, so the first ${s1(diff)} is shown again before it restarts. Make the file ${hint} for a clean join.`;
  return { check: 'loop_length', severity, measured: s1(loopMs), expected: s1(sourceMs), fromMs: Math.min(loopMs, sourceMs), toMs: Math.max(loopMs, sourceMs), message };
}

/**
 * A JUMP WHERE THE LOOP RESTARTS. Compares the last frame with the first
 * (SSIM, 1 = identical) against how much one frame normally differs from the
 * next in the middle of the loop. Fast footage changes a lot every frame, so
 * only a join much worse than the loop's own motion is a jump. Pure.
 */
export function loopPointFinding(seamSsim: number | null, motionSsim: number | null, loopMs: number): FillerFinding | null {
  if (seamSsim == null || motionSsim == null) return null;
  const jump = seamSsim < motionSsim - 0.2 || (seamSsim < 0.5 && motionSsim > 0.7);
  if (!jump) return null;
  return {
    check: 'loop_point', severity: 'warning', fromMs: Math.max(0, loopMs - 1000), toMs: loopMs,
    measured: `similarity ${seamSsim.toFixed(2)} across the join`, expected: `about ${motionSsim.toFixed(2)}, like the rest of the loop`,
    message: 'The picture visibly jumps where the loop restarts: the last frame is very different from the first. Viewers see it every time it repeats.',
  };
}

/**
 * A CLICK OR A CUT IN THE SOUND WHERE THE LOOP RESTARTS. From the decoded
 * samples (mono, -1..1): a step between the last sample and the first far
 * larger than the loop's own sample-to-sample movement is a click; sound that
 * is loud right up to the end and quiet (or different) right after the start
 * is a cut. Pure.
 */
export function audioLoopPointFinding(samples: Float32Array, sampleRate: number, loopMs: number): FillerFinding | null {
  const n = samples.length;
  if (n < sampleRate / 10) return null;
  const win = Math.max(1, Math.round(sampleRate * 0.02));
  const rmsDb = (from: number, to: number) => {
    let s = 0; for (let i = from; i < to; i++) s += samples[i] * samples[i];
    const r = Math.sqrt(s / Math.max(1, to - from));
    return r > 0 ? 20 * Math.log10(r) : -120;
  };
  const endDb = rmsDb(n - win, n), startDb = rmsDb(0, win);
  // the loop's ordinary movement: the 99th percentile of |x[i+1]-x[i]|
  const diffs: number[] = [];
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i + 1 < n; i += step) diffs.push(Math.abs(samples[i + 1] - samples[i]));
  diffs.sort((a, b) => a - b);
  const p99 = diffs[Math.floor(diffs.length * 0.99)] ?? 0;
  const jump = Math.abs(samples[0] - samples[n - 1]);
  const click = jump > 0.1 && jump > p99 * 8;
  const cut = Math.max(endDb, startDb) > -30 && Math.abs(endDb - startDb) > 12;
  if (!click && !cut) return null;
  return {
    check: 'audio_loop_point', severity: 'warning', fromMs: Math.max(0, loopMs - 500), toMs: loopMs,
    measured: click ? `a step of ${jump.toFixed(2)} at the join` : `${endDb.toFixed(0)} dBFS before the join, ${startDb.toFixed(0)} dBFS after`,
    expected: click ? `under ${(p99 * 8).toFixed(2)}, like the rest of the sound` : 'about the same level either side',
    message: click
      ? 'The sound clicks where the loop restarts. Fade the sound in and out, or cut the file on a quiet moment.'
      : 'The sound is cut off where the loop restarts: it is loud right up to the end and changes abruptly at the start. Fade it, or loop on a quiet moment.',
  };
}

/** What the uploaded file means for the house format: upscaling, bars, frame rate, interlacing. Pure. */
export function sourceFindings(probe: any, house: HouseFormat, kind: 'slate' | 'loop', size?: { width?: number | null; height?: number | null }): FillerFinding[] {
  const out: FillerFinding[] = [];
  const v = probe?.video ?? null;
  const w = Number(v?.width ?? size?.width) || 0, h = Number(v?.height ?? size?.height) || 0;
  const top = house.video[0];
  if (h && top && h < top.height * 0.95) {
    out.push({ check: 'resolution', severity: 'warning', measured: `${w}x${h}`, expected: `${top.width}x${top.height} or more`,
      message: `The ${kind} is ${w}x${h}, so the house format's ${top.label} is upscaled from it and may look soft on large screens.` });
  }
  if (w && h) {
    const ar = w / h, house169 = 16 / 9;
    if (Math.abs(ar - house169) / house169 > 0.02) {
      const bars = ar < house169 ? 'black bars at the sides (pillarboxed)' : 'black bars above and below (letterboxed)';
      out.push({ check: 'aspect', severity: 'warning', measured: `${(ar).toFixed(2)}:1`, expected: '16:9 (1.78:1)',
        message: `It is not 16:9, so it is shown with ${bars}.` });
    }
  }
  if (kind === 'loop' && v) {
    const fps = Number(v.fps) || 0, target = top?.fps ?? 25;
    const matches = (a: number, b: number) => Math.abs(a - b) / b < 0.01;
    if (fps && !matches(fps, target) && !matches(fps, target * 2)) {
      out.push({ check: 'frame_rate', severity: 'info', measured: `${fps} fps`, expected: `${target} fps`,
        message: `Converted from ${fps} to ${target} fps for the house format: smooth motion such as pans may judder.` });
    }
    if (v.scan === 'interlaced') {
      out.push({ check: 'interlaced', severity: 'warning', measured: 'interlaced', expected: 'progressive',
        message: 'The file is interlaced and is not deinterlaced on the way in, so moving edges may show combing. Upload a progressive file.' });
    }
  }
  return out;
}

// ---- measuring -------------------------------------------------------------
function run(bin: string, args: string[], timeoutMs = 300_000, binary = false): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((done) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (b: Buffer) => { if (binary) chunks.push(b); });
    p.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    p.on('close', (code) => { clearTimeout(t); done({ code: code ?? 1, out: Buffer.concat(chunks), err }); });
    p.on('error', (e) => { clearTimeout(t); done({ code: 1, out: Buffer.alloc(0), err: String((e as any)?.message ?? e) }); });
  });
}
const FFMPEG = () => config.clips?.ffmpegBin ?? 'ffmpeg';

async function ssimOf(a: string, b: string): Promise<number | null> {
  const r = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'], 60_000);
  const m = /All:\s*([\d.]+)/.exec(r.err);
  return m ? parseFloat(m[1]) : null;
}

/** First, last and two middle frames of the top rendition, compared. */
async function measureLoopPoint(video: string, frames: number, work: string): Promise<{ seam: number | null; motion: number | null }> {
  const mid = Math.max(1, Math.floor(frames / 2));
  const sel = `select='eq(n\\,0)+eq(n\\,${mid})+eq(n\\,${mid + 1})+gte(n\\,${Math.max(2, frames - 1)})'`;
  const r = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-y', '-i', video, '-vf', `${sel},scale=640:-2`, '-fps_mode', 'passthrough', join(work, 'f%03d.png')], 120_000);
  if (r.code !== 0) return { seam: null, motion: null };
  const files = (await readdir(work)).filter((f) => /^f\d+\.png$/.test(f)).sort();
  if (files.length < 4) return { seam: null, motion: null };
  const p = (f: string) => join(work, f);
  return { seam: await ssimOf(p(files[files.length - 1]), p(files[0])), motion: await ssimOf(p(files[1]), p(files[2])) };
}

async function decodeMono(audio: string, sampleRate = 48000): Promise<Float32Array | null> {
  const r = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-i', audio, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], 120_000, true);
  if (r.code !== 0 || r.out.length < 4) return null;
  const buf = r.out.buffer.slice(r.out.byteOffset, r.out.byteOffset + (r.out.length - (r.out.length % 4)));
  return new Float32Array(buf);
}

/**
 * QC of the house preview. Measures the BUILD, because the build is what
 * airs; reads the upload's own facts (probe, from fillerThumbs) only for what
 * the build hides (its real resolution, frame rate and scan).
 */
export async function runFillerQc(id: string, opts: { dir?: string } = {}): Promise<FillerQc> {
  const fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [id]);
  if (!fa) throw new Error('That slate or loop no longer exists');
  const { fillerDriver, copyFillerPrefix } = await import('./fillerStore');
  // the build in the bucket (AWS), when it was stored there
  const stored = fillerDriver() === 's3' && fa.preview?.key ? String(fa.preview.key) : null;
  const top = fa.preview?.renditions?.[0]?.label;
  if (!stored || opts.dir || fa.preview_status !== 'ready' || !top) return qcIn(fa, opts.dir ?? previewDir(id), stored, null);
  // Built on another task (or this one, earlier): copy the top rendition and
  // the sound into scratch, measure them there, and remove them afterwards.
  const scratch = join(process.env.FILLER_CACHE_DIR || join(tmpdir(), 'volt-filler-cache'), 'preview-qc', `${id}-${process.pid}-${Date.now().toString(36)}`);
  try {
    let readError: string | null = null;
    await copyFillerPrefix(stored, scratch, (rel) => rel === `${top}.m3u8` || rel.startsWith(`${top}/`) || rel === 'audio.m3u8' || rel.startsWith('audio/'))
      .catch((e) => { readError = String(e?.message ?? e).slice(0, 200); });
    return await qcIn(fa, scratch, stored, readError);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** QC of the build in `dir`; `stored` is its folder in the bucket, where its stills go too. */
async function qcIn(fa: any, dir: string, stored: string | null, readError: string | null): Promise<FillerQc> {
  const id: string = fa.id;
  const findings: FillerFinding[] = [];
  const skipped: { check: string; reason: string }[] = [];
  const pv = fa.preview ?? null;
  const kind: 'slate' | 'loop' = fa.kind === 'slate' ? 'slate' : 'loop';
  const top = pv?.renditions?.[0]?.label;
  const video = top ? join(dir, `${top}.m3u8`) : null;
  const audio = join(dir, 'audio.m3u8');

  if (fa.preview_status !== 'ready' || !video || !existsSync(video)) {
    findings.push({ check: 'media', severity: 'error', message: fa.preview_error
      ? `The house preview could not be made: ${fa.preview_error}`
      : readError ? `The house preview could not be read from storage: ${readError}`
      : stored && fa.preview_status === 'ready' ? 'The house preview is missing from storage. Build it again.'
      : 'There is no house preview to check yet.' });
    return store(id, { state: 'failed', findings, skipped });
  }
  const loopMs = Math.round(Number(pv.loopSeconds) * 1000);
  const house: HouseFormat = pv.house?.format ?? STANDARD_HOUSE;

  // one decode: black, silence and loudness, and whether it plays at all
  const hasAudio = existsSync(audio);
  const filters = ['[0:v]blackdetect=d=2:pic_th=0.98[v]'];
  if (hasAudio) filters.push('[1:a]silencedetect=noise=-50dB:d=2[s]', '[s]ebur128=peak=true[a]');
  const r = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-i', video, ...(hasAudio ? ['-i', audio] : []),
    '-filter_complex', filters.join(';'), '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []), '-f', 'null', '-']);
  const errs = playbackErrors(r.err);
  if (r.code !== 0 || errs.length) {
    findings.push({ check: 'playback', severity: 'error', measured: (errs[0] ?? r.err.trim().split('\n').pop() ?? '').slice(0, 200),
      message: 'The house preview does not decode cleanly, so a player would stall or fail on it.' });
  }
  const black = parseBlack(r.err);
  const blackMs = black.reduce((n, b) => n + (b.toMs - b.fromMs), 0);
  if (loopMs && blackMs >= loopMs * 0.9) {
    findings.push({ check: 'black', severity: 'error', measured: s1(blackMs), fromMs: 0, toMs: loopMs, message: `It is black: ${s1(blackMs)} of ${s1(loopMs)} has no picture.` });
  } else {
    for (const b of black) findings.push({ check: 'black', severity: 'warning', fromMs: b.fromMs, toMs: b.toMs, measured: s1(b.toMs - b.fromMs),
      message: `${s1(b.toMs - b.fromMs)} of black from ${s1(b.fromMs)}.` });
  }
  if (kind === 'loop') {
    const hadSound = !!fa.probe?.audio;
    if (!hadSound) {
      findings.push({ check: 'silence', severity: 'info', message: 'The file has no sound, so viewers hear silence while it plays.' });
    } else if (hasAudio) {
      for (const sl of parseSilence(r.err)) {
        const to = sl.toMs < 0 ? loopMs : sl.toMs;
        findings.push({ check: 'silence', severity: to - sl.fromMs >= loopMs * 0.9 ? 'warning' : 'info', fromMs: sl.fromMs, toMs: to, measured: s1(to - sl.fromMs),
          message: to - sl.fromMs >= loopMs * 0.9 ? 'The sound track is silent all the way through.' : `${s1(to - sl.fromMs)} of silence from ${s1(sl.fromMs)}.` });
      }
      const { lufs, truePeak } = parseLoudness(r.err);
      if (lufs != null && lufs > -70 && Math.abs(lufs - -23) > 6) {
        findings.push({ check: 'loudness', severity: 'warning', measured: `${lufs.toFixed(1)} LUFS`, expected: '-23 LUFS (within 6)',
          message: lufs > -23 ? 'Much louder than the broadcast target: it will jump out when a stream falls back to it.' : 'Much quieter than the broadcast target: viewers may think the sound has gone.' });
      }
      if (truePeak != null && truePeak > -1) {
        findings.push({ check: 'loudness', severity: 'warning', measured: `${truePeak.toFixed(1)} dBFS true peak`, expected: '-1 dBFS or lower',
          message: 'The sound peaks above -1 dBFS and may distort on some players.' });
      }
    }
  } else {
    skipped.push({ check: 'silence', reason: 'a slate carries a silent track by design' });
  }

  if (kind === 'loop') {
    const lf = loopLengthFinding(Number(fa.duration_ms) || null, loopMs, Number(pv.segmentSeconds) || house.segmentSeconds,
      Math.round(1000 / (house.video[0]?.fps || 25)));
    if (lf) findings.push(lf);
    const work = join(dir, '.qc');
    await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
    try {
      const fps = Number(pv.renditions?.[0]?.fps) || 25;
      const lp = await measureLoopPoint(video, Math.round((loopMs / 1000) * fps), work);
      if (lp.seam == null) skipped.push({ check: 'loop_point', reason: 'the frames either side of the join could not be read' });
      const f = loopPointFinding(lp.seam, lp.motion, loopMs);
      if (f) findings.push(f);
    } finally { await rm(work, { recursive: true, force: true }); }
    if (hasAudio && fa.probe?.audio) {
      const pcm = await decodeMono(audio);
      if (!pcm) skipped.push({ check: 'audio_loop_point', reason: 'the sound could not be decoded' });
      else { const f = audioLoopPointFinding(pcm, 48000, loopMs); if (f) findings.push(f); }
    }
  } else {
    skipped.push({ check: 'loop_point', reason: 'a slate is a still: there is no join to see' });
  }
  findings.push(...sourceFindings(fa.probe, house, kind, { width: fa.width, height: fa.height }));
  await addFrames(id, findings, video, loopMs, Number(pv.renditions?.[0]?.fps) || 25, dir, stored);
  return store(id, { state: qcState(findings), findings, skipped });
}

/**
 * Stills for each finding, from the top rendition of the preview, written
 * beside it (ORIGIN_DIR/filler-preview/<id>/qc-frames/) and served by
 * /origin like the preview; on AWS stored beside the build in the bucket
 * (<build>/qc-frames/) and served by any task at /filler/... (2.1a-3b).
 * Remade on every QC run under a new name, so a browser never shows an old
 * still for a new finding.
 */
async function addFrames(id: string, findings: FillerFinding[], video: string, loopMs: number, fps: number,
  buildDir: string = previewDir(id), stored: string | null = null): Promise<void> {
  const dir = join(buildDir, 'qc-frames');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const run_ = Date.now().toString(36);
  const frameMs = Math.round(1000 / (fps || 25));
  const total = Math.max(1, Math.round(loopMs / frameMs));
  const nOf = (ms: number) => Math.min(total - 1, Math.max(0, Math.round(ms / frameMs)));
  const wanted = findings.map((f) => framesFor(f, loopMs, fps));
  // WHY NO SEEK: ffmpeg cannot seek inside these fMP4 HLS playlists (it lands
  // mid-sample and decodes garbage), so the stills are picked by frame number
  // in one decode from the start, which is short: a loop is 60 s at most.
  const last = total - 1;
  const inner = [...new Set(wanted.flat().map((w) => nOf(w.atMs)).filter((n) => n < last))].sort((a, b) => a - b);
  const names = new Map<number, string>();
  if (inner.length) {
    const sel = inner.map((n) => `eq(n\\,${n})`).join('+');
    const r = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-y', '-i', video, '-vf', `select='${sel}',scale=480:-2`,
      '-fps_mode', 'passthrough', '-q:v', '3', join(dir, `${run_}-in-%03d.jpg`)], 120_000);
    if (r.code === 0) inner.forEach((n, k) => { const f = `${run_}-in-${String(k + 1).padStart(3, '0')}.jpg`; if (existsSync(join(dir, f))) names.set(n, f); });
  }
  if (wanted.flat().some((w) => nOf(w.atMs) >= last)) {
    // the last frame: keep overwriting one still from near the end, so the last decoded stays
    const f = `${run_}-last.jpg`;
    const r = await run(FFMPEG(), ['-hide_banner', '-nostdin', '-y', '-i', video, '-vf', `select='gte(n\\,${Math.max(0, last - 3)})',scale=480:-2`,
      '-fps_mode', 'passthrough', '-q:v', '3', '-update', '1', join(dir, f)], 120_000);
    if (r.code === 0 && existsSync(join(dir, f))) names.set(last, f);
  }
  let base = `/origin/filler-preview/${id}/qc-frames/`;
  if (stored) {
    // The last run's stills are no longer named by any finding.
    const { putFiller, deleteFillerPrefix } = await import('./fillerStore');
    await deleteFillerPrefix(`${stored}qc-frames/`).catch(() => 0);
    try {
      for (const name of new Set(names.values())) await putFiller(`${stored}qc-frames/${name}`, await readFile(join(dir, name)));
      base = `/${stored}qc-frames/`;
    } catch (e: any) {
      // Stills help a person judge a finding; without them the finding still stands.
      console.warn(`[filler.preview] ${id}: QC stills not stored:`, e?.message ?? e);
      names.clear();
    }
    await rm(dir, { recursive: true, force: true });
  }
  findings.forEach((f, k) => {
    const frames = wanted[k].flatMap((w) => {
      const name = names.get(nOf(w.atMs));
      return name ? [{ label: w.label, atMs: w.atMs, url: `${base}${name}` }] : [];
    });
    if (frames.length) f.frames = frames;
  });
}

async function store(id: string, qc: FillerQc): Promise<FillerQc> {
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  qc.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of qc.findings) f.key = findingKey(f);
  await query(`UPDATE filler_assets SET qc_state = $2, qc_findings = $3::jsonb, qc_skipped = $4::jsonb, qc_at = now() WHERE id = $1`,
    [id, qc.state, JSON.stringify(qc.findings), JSON.stringify(qc.skipped)]);
  return qc;
}

// ---- the build -------------------------------------------------------------
/**
 * Build (or rebuild) the house preview, then QC it. Throws only when the slate
 * or loop is gone; a failed build is recorded on the row with its reason and
 * a QC media error, so the page says why instead of spinning.
 */
export async function buildFillerPreview(id: string): Promise<{ status: 'ready' | 'failed'; error?: string; qc: FillerQc }> {
  const fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [id]);
  if (!fa) throw new Error('That slate or loop no longer exists');
  const fail = async (why: string) => {
    await query(`UPDATE filler_assets SET preview_status = 'failed', preview_error = $2, preview_at = now() WHERE id = $1`, [id, why.slice(0, 400)]);
    return { status: 'failed' as const, error: why, qc: await runFillerQc(id) };
  };
  if (fa.status !== 'ready' || !fa.source_key) return fail(`it is ${fa.status}, with no file to build from yet`);
  await query(`UPDATE filler_assets SET preview_status = 'building', preview_error = NULL WHERE id = $1`, [id]);
  const house = await houseFormat(fa.account_id);
  const { fillerSource } = await import('../fast/fillerBridge');
  const src = await fillerSource(fa);
  if (!src) return fail('its file is missing from the store');
  const still = fa.kind === 'slate' || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(src);
  const spec = {
    segment_seconds: house.segmentSeconds, source: { kind: still ? 'image' : 'video', path: src },
    video: house.video, audio: house.audio, max_loop_seconds: LOOP_CAP_SECONDS,
  };
  const dir = previewDir(id);
  await mkdir(dirname(dir), { recursive: true });
  const specPath = `${dir}.spec.json`;
  await writeFile(specPath, JSON.stringify(spec, null, 1));
  const res = await py('filler_build.py', [specPath, dir], 20 * 60_000);
  const meta = lastJson(res.out);
  if (res.code !== 0 || !meta || meta.error) return fail(String(meta?.error ?? (res.err || 'the build failed').trim().split('\n').pop()));
  await writePreviewPlaylists(dir, PREVIEW_REPEATS);
  let key: string | null = null;
  try { key = await storePreview(id, dir); } catch (e: any) {
    return fail(`the preview was built but could not be stored: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const preview = {
    // key: where the build is kept in the bucket (AWS); the Mac serves it from /origin
    url: key ? `/${key}preview.m3u8` : previewUrl(id), ...(key ? { key } : {}), repeats: PREVIEW_REPEATS,
    house: { profileId: house.profileId, profileName: house.profileName, usedBy: house.usedBy, standard: house.standard, format: house },
    segmentSeconds: house.segmentSeconds, loopSeconds: Number(meta.loop_seconds), sourceMs: still ? null : Number(fa.duration_ms) || null,
    renditions: house.video.map((v) => ({ label: v.label, width: v.width, height: v.height, fps: v.fps, bitrateKbps: v.bitrate_kbps })),
    audio: house.audio, buildSeconds: Number(meta.build_seconds) || null, builtAt: new Date().toISOString(),
  };
  await query(`UPDATE filler_assets SET preview_status = 'ready', preview = $2::jsonb, preview_error = NULL, preview_at = now() WHERE id = $1`,
    [id, JSON.stringify(preview)]);
  // QC reads the build where it was just made, so nothing is fetched back.
  const qc = await runFillerQc(id, { dir });
  if (key) {
    // Stored: the disk copy was only scratch. The previous build's folder is
    // no longer named by anything (a player that had it open keeps the
    // segments it already has; a new play asks for the new playlist).
    await rm(dir, { recursive: true, force: true });
    await rm(specPath, { force: true });
    const prev = fa.preview?.key ? String(fa.preview.key) : null;
    if (prev && prev !== key) {
      const { deleteFillerPrefix } = await import('./fillerStore');
      await deleteFillerPrefix(prev).catch((e) => console.warn(`[filler.preview] ${id}: old preview not removed:`, e?.message ?? e));
    }
  }
  return { status: 'ready', qc };
}

/** Everything the preview left on disk and in the bucket (the slate or loop was deleted). */
export async function removeFillerPreview(id: string): Promise<void> {
  const { deleteFillerPrefix } = await import('./fillerStore');
  await deleteFillerPrefix(previewRoot(id));
  const dir = previewDir(id);
  await rm(dir, { recursive: true, force: true });
  await rm(`${dir}.spec.json`, { force: true });
  await rm(`${dir}.tmp`, { recursive: true, force: true });
}

// ---- the review --------------------------------------------------------------
export class ReviewError extends Error { constructor(message: string, public status = 409) { super(message); } }

/**
 * A person approves or rejects. Approving over a QC error or without a preview
 * needs a note: the finding stays on record beside the reason it was accepted.
 * Rejecting does not take it off streams that already use it (that would put
 * them on black mid-outage); the answer lists them so the page can say so.
 */
export async function reviewFiller(o: { id: string; accountId: string; decision: 'approve' | 'reject' | 'reset'; note?: string | null;
  userId: string | null; label: string | null }): Promise<any> {
  const fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1 AND account_id = $2`, [o.id, o.accountId]);
  if (!fa) throw new ReviewError('That slate or loop is not in this account', 404);
  const note = (o.note ?? '').trim() || null;
  // An error a person has accepted (with its frames in front of them) is a
  // decision already made: only errors nobody has accepted need the note.
  const accepted = fa.qc_accepted ?? {};
  const openErrors = ((fa.qc_findings ?? []) as FillerFinding[]).filter((f) => f.severity === 'error' && !accepted[f.key ?? findingKey(f)]);
  if (o.decision === 'approve' && (fa.preview_status !== 'ready' || openErrors.length) && !note) {
    throw new ReviewError(fa.preview_status !== 'ready'
      ? 'There is no house preview to approve from. Add a note saying why it is approved without one.'
      : 'QC found errors that nobody has accepted. Accept them, or add a note saying why it is approved anyway.', 400);
  }
  const state = o.decision === 'approve' ? 'approved' : o.decision === 'reject' ? 'rejected' : 'pending';
  const row = await one<any>(
    `UPDATE filler_assets SET review_state = $2, review_note = $3, reviewed_by = $4, reviewed_by_label = $5,
            reviewed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [o.id, state, o.decision === 'reset' ? null : note, o.decision === 'reset' ? null : o.userId, o.decision === 'reset' ? null : o.label]);
  return { asset: row, from: fa.review_state, to: state };
}

/**
 * A person accepts one QC finding (or takes the acceptance back). Kept by
 * the finding's key, so it survives QC running again while the same fault is
 * at the same place (migration 0175).
 */
export async function acceptFinding(o: { id: string; accountId: string; key: string; accepted: boolean; note?: string | null; label: string | null }): Promise<any> {
  const fa = await one<any>(`SELECT qc_findings FROM filler_assets WHERE id = $1 AND account_id = $2`, [o.id, o.accountId]);
  if (!fa) throw new ReviewError('That slate or loop is not in this account', 404);
  const known = ((fa.qc_findings ?? []) as FillerFinding[]).some((f) => (f.key ?? findingKey(f)) === o.key);
  if (!known) throw new ReviewError('That finding is not on this slate or loop (QC may have run again)', 404);
  const row = o.accepted
    ? await one<any>(`UPDATE filler_assets SET qc_accepted = qc_accepted || jsonb_build_object($2::text, jsonb_build_object('by', $3::text, 'at', now(), 'note', $4::text)), updated_at = now() WHERE id = $1 RETURNING *`,
      [o.id, o.key, o.label, (o.note ?? '').trim() || null])
    : await one<any>(`UPDATE filler_assets SET qc_accepted = qc_accepted - $2::text, updated_at = now() WHERE id = $1 RETURNING *`, [o.id, o.key]);
  return row;
}
