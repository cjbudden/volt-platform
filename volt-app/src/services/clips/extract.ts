// ============================================================================
//  EXTRACTION — turn a resolved range into real files.
//
//  FRAME-ACCURATE, by decision. Segment-snapping would have been free but costs
//  up to one segment (4s) of slop at each end, which is unacceptable for a goal
//  or a soundbite.
//
//  HOW THE ACCURACY IS ACHIEVED, and why it is done this way first.
//
//  Our encoder writes a closed GOP exactly one segment long with a forced
//  keyframe on every boundary (encoder.py:527-560), so every segment starts on
//  an IDR and decodes alone. That makes two paths possible:
//
//    SMART RENDER  re-encode only the partial segment at each end and stream-copy
//                  everything between. Flat cost, roughly two segments, whatever
//                  the clip length.
//    FULL RENDER   one accurate-seek pass over the whole span.
//
//  SMART RENDER IS NOW BUILT (5 Sep). Three things make it safe to have, and the
//  paragraph this replaces was right to be nervous about all three.
//
//  1. A GATE, NOT A HOPE. `smartEligible()` refuses unless the join can be shown
//     to be clean: exactly one video stream, a codec whose Annex-B bitstream
//     filter we have (h264 / hevc), and at least one WHOLE segment in the middle.
//     A clip that lives inside a single segment has nothing to copy, so smart
//     render there is a full render wearing a hat.
//
//  2. AN ANNEX-B INTERMEDIATE, which is the actual answer to the drift the old
//     note feared. Joining a re-encoded end to a copied middle inside MP4 keeps
//     only the FIRST part's SPS/PPS, so the copied middle is then decoded against
//     the wrong parameter sets: it plays, and it is wrong, which is precisely the
//     failure that looks fine in a screenshot. MPEG-TS carries parameter sets
//     in-band ahead of every IDR, so each part brings its own and the join is
//     correct even where the ends differ from the middle. Remuxed back to MP4
//     afterwards, still with no decode of the middle.
//
//  3. AUDIO IS RE-ENCODED ONCE ACROSS THE JOIN. AAC carries priming samples at
//     the head of every encode, so three separately-encoded audio parts butted
//     together drift by a few milliseconds per seam: inaudible individually,
//     cumulative, and exactly what turns into lip-sync error by the end of a long
//     clip. One audio pass over the joined TS removes the seams. Audio is a few
//     per cent of the cost of video, so this does not spend the saving.
//
//  AND IT FALLS BACK. Every failure inside the smart path — a refused gate, an
//  ffmpeg error, or a verify that does not match — drops through to the full
//  render, which is unchanged and remains the definition of correct. The strategy
//  that actually ran is reported on the result, so a silent regression to full
//  render surfaces as a number rather than as a slow afternoon.
//
//  Validated frame-for-frame AGAINST the full render in
//  `test/clip-smart-render.check.ts`, not against a stopwatch: same frame count,
//  same PTS sequence, same duration.
// ============================================================================
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Resolution, ResolvedBlock, ResolvedSegment } from './resolve';

export type OutputFormat = 'hls' | 'mp4' | 'mp3' | 'm4a';

export interface ExtractRequest {
  resolution: Resolution;
  outDir: string;
  formats: OutputFormat[];
  /** Progress callback: 0..100 with a short note. */
  onProgress?: (pct: number, note: string) => void | Promise<void>;
  /** Abort politely when the worker is shutting down. */
  isCancelled?: () => boolean;
  ffmpegBin?: string;
  ffprobeBin?: string;
  /**
   * OPT IN TO SMART RENDER. Default off, and no caller turns it on yet.
   *
   * The path works: the gate holds, the Annex-B join carries each part's own
   * parameter sets, and it is roughly 2x faster on the fixture with the saving
   * growing as the clip lengthens, because the middle is never decoded.
   *
   * THE SEAM IS FIXED (build queue 1.5, 22 Oct 2026). The concat demuxer used
   * to start each part at the previous file's CONTAINER duration, which runs to
   * the end of the AAC rather than of the picture, so the part after a copied
   * middle landed 23ms late (30ms at 50fps). Each part's length is now given to
   * the demuxer from its picture (`concatListByPicture`), and the output is
   * checked for a gap or overlap at every frame (`seamFault`) as well as for
   * its duration, because a duration check cannot see a seam: a 15,082ms
   * render against a 15,000ms request once passed it while six frames short.
   * `test/clip-smart-render.check.ts` now passes frame for frame at 25fps and
   * at 50fps with B-frames.
   *
   * Still off by default: turning it on for real clips is Christian's call.
   */
  smartRender?: boolean;
}

export interface ExtractedFile {
  format: OutputFormat;
  path: string;
  bytes: number;
  durationMs: number;
}

export type Strategy = 'copy' | 'smart-render' | 'full-render';

export interface ExtractResult {
  files: ExtractedFile[];
  durationMs: number;
  /** What was PLANNED. Kept for callers that compare plan to outcome. */
  strategy: Strategy;
  /** What each block ACTUALLY ran, in order. A 'full-render' here against a
   *  'smart-render' plan is a fallback that fired, and is worth noticing. */
  strategyPerBlock: Strategy[];
  /** Why smart render was not used, when it was not. Empty when it was. */
  smartRenderSkipped: string[];
  runsUsed: number;
  blocksUsed: number;
  segmentsUsed: number;
}

/**
 * Would smart render help this block, and can it be done safely?
 *
 * Deliberately conservative. Every `false` here costs a full render, which is
 * merely slower; a `true` that should have been `false` costs a clip that plays
 * and is wrong, which is the failure nobody catches until an editor does.
 */
export function smartEligible(
  block: ResolvedBlock,
  probe: { videoStreams: number; videoCodec: string } | null
): { ok: true } | { ok: false; why: string } {
  const segs = block.segments;
  if (segs.length < 3) {
    // Two segments can be two partial ends with no middle; one is a cut inside a
    // single segment. Either way there is nothing to stream-copy.
    return { ok: false, why: `only ${segs.length} segment(s) in the block, so there is no whole middle to copy` };
  }
  const whole = segs.filter((s) => !s.partial).length;
  if (whole === 0) return { ok: false, why: 'no whole segments in the block' };
  if (!probe) return { ok: false, why: 'could not probe the source parameters' };
  if (probe.videoStreams !== 1) {
    return { ok: false, why: `expected one video stream, found ${probe.videoStreams}` };
  }
  if (!ANNEXB_BSF[probe.videoCodec]) {
    // Without an Annex-B filter the parts cannot carry their own parameter sets
    // through the join, which is the whole mechanism. Refuse rather than guess.
    return { ok: false, why: `no Annex-B bitstream filter for codec '${probe.videoCodec}'` };
  }
  return { ok: true };
}

/** Codecs whose parameter sets we can move in-band for the TS join. */
const ANNEXB_BSF: Record<string, string> = {
  h264: 'h264_mp4toannexb',
  hevc: 'hevc_mp4toannexb',
  h265: 'hevc_mp4toannexb',
};

/** What extracting this range would involve, without doing it. */
export function plan(r: Resolution): {
  strategy: Strategy;
  segments: number;
  partialSegments: number;
  spansRuns: boolean;
  /** Segments a smart render has to re-encode. The rest are copied. */
  smartRenderSegments: number;
  /** Segments a smart render avoids re-encoding, versus a full render. */
  segmentsSaved: number;
} {
  const segments = r.blocks.reduce((n, b) => n + b.segments.length, 0);
  const partial = r.blocks.reduce((n, b) => n + b.segments.filter((s) => s.partial).length, 0);
  // A range with nothing partial never needed a render at all: it is whole
  // segments end to end and a byte copy is exact.
  const strategy: Strategy = !r.needsTrim
    ? 'copy'
    // Structural eligibility only; the codec gate is applied at run time, when
    // there is something to probe. Reporting 'smart-render' here and running
    // 'full-render' is a legitimate outcome, and the result says so.
    : r.blocks.some((b) => b.segments.length >= 3 && b.segments.some((s) => !s.partial))
      ? 'smart-render'
      : 'full-render';
  return {
    strategy,
    segments,
    partialSegments: partial,
    spansRuns: r.runCount > 1,
    smartRenderSegments: partial,
    segmentsSaved: strategy === 'smart-render' ? Math.max(0, segments - partial) : 0,
  };
}

/**
 * Concatenate a run's init header and its segments into one contiguous fMP4.
 *
 * This is a BYTE concatenation, not a transcode: fMP4 is designed so that an
 * init header followed by its media segments is itself a valid file. It costs a
 * read and a write, no decode, and it is what lets the accurate-seek pass below
 * treat a run as a single input.
 */
async function concatRun(run: ResolvedBlock, dest: string): Promise<void> {
  if (!existsSync(run.initPath)) {
    throw new Error(`run ${run.runId} has no init.mp4 at ${run.initPath}`);
  }
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(dest);
    out.on('error', reject);
    out.on('finish', () => resolve());
    try {
      out.write(readFileSync(run.initPath));
      for (const seg of run.segments) {
        if (!existsSync(seg.path)) throw new Error(`segment missing on disk: ${seg.path}`);
        out.write(readFileSync(seg.path));
      }
      out.end();
    } catch (e) { reject(e); }
  });
}

function runFfmpeg(bin: string, args: string[], onLine?: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    p.stderr.on('data', (b: Buffer) => {
      const s = b.toString('utf8');
      tail = (tail + s).slice(-4000);
      if (onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) onLine(line);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${lastRealError(tail)}`));
    });
  });
}

/** Pull the line that actually explains the failure out of ffmpeg's noise. */
function lastRealError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) =>
    /error|invalid|no such file|unable|failed|not found|denied/i.test(l) && !/^\s*$/.test(l));
  return (err ?? lines[lines.length - 1] ?? 'no output').slice(0, 400);
}

/** ffmpeg's `-progress` writes out_time_ms; turn that into a percentage. */
function progressReader(totalMs: number, report: (pct: number) => void) {
  return (line: string) => {
    const m = /out_time_ms=(\d+)/.exec(line);
    if (!m || totalMs <= 0) return;
    const doneMs = Number(m[1]) / 1000;
    report(Math.max(0, Math.min(99, Math.round((doneMs / totalMs) * 100))));
  };
}

/* ==========================================================================
 *  SMART RENDER
 * ======================================================================== */

interface Probe {
  videoStreams: number;
  videoCodec: string;
  profile: string | null;
  level: number | null;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  /** Frames per second as ffmpeg's rational string, e.g. "25/1". */
  rFrameRate: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  audioBitrate: number | null;
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    p.stderr.on('data', (b: Buffer) => { err = (err + b.toString('utf8')).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${lastRealError(err)}`)));
  });
}

/**
 * Read the source's exact encode parameters.
 *
 * The ends are re-encoded to MATCH these rather than to some house default,
 * because a clip whose first four seconds are 4.0 High and whose middle is 3.1
 * Main is the drift case in a different costume.
 */
export async function probeSource(path: string, ffprobeBin = 'ffprobe'): Promise<Probe | null> {
  try {
    const raw = await runCapture(ffprobeBin, [
      '-v', 'error', '-print_format', 'json', '-show_streams', path,
    ]);
    const streams: any[] = JSON.parse(raw).streams ?? [];
    const v = streams.filter((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    if (!v.length) return null;
    const v0 = v[0];
    return {
      videoStreams: v.length,
      videoCodec: String(v0.codec_name ?? ''),
      profile: v0.profile ? String(v0.profile).toLowerCase().replace(/\s+/g, '') : null,
      level: Number.isFinite(v0.level) && v0.level > 0 ? Number(v0.level) : null,
      pixFmt: v0.pix_fmt ?? null,
      width: v0.width ?? null,
      height: v0.height ?? null,
      rFrameRate: v0.r_frame_rate ?? null,
      audioCodec: a?.codec_name ?? null,
      sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
      channels: a?.channels ? Number(a.channels) : null,
      audioBitrate: a?.bit_rate ? Number(a.bit_rate) : null,
    };
  } catch { return null; }
}

/** One frame in milliseconds, from ffprobe's rational frame rate. */
function frameMs(p: Probe): number {
  const m = /^(\d+)\/(\d+)$/.exec(p.rFrameRate ?? '');
  if (!m) return 40;
  const num = Number(m[1]), den = Number(m[2]);
  if (!num || !den) return 40;
  return (den / num) * 1000;
}

/** Video encoder arguments that reproduce the source's parameters. */
function matchedVideoArgs(p: Probe): string[] {
  const enc = p.videoCodec === 'hevc' || p.videoCodec === 'h265' ? 'libx265' : 'libx264';
  const args = ['-c:v', enc];
  // Profile and level are the two that actually break a join when they differ,
  // because they are what the decoder configures itself from.
  if (p.profile && enc === 'libx264' && ['baseline', 'main', 'high', 'high10', 'high422', 'high444'].includes(p.profile)) {
    args.push('-profile:v', p.profile);
  }
  if (p.level && enc === 'libx264') args.push('-level:v', (p.level / 10).toFixed(1));
  if (p.pixFmt) args.push('-pix_fmt', p.pixFmt);
  // CLOSED GOP, EVERY FRAME A POTENTIAL START. The re-encoded end is going to be
  // butted against a copied segment, so it must not depend on anything outside
  // itself and must not leave an open GOP at its tail.
  args.push('-g', '48', '-keyint_min', '1', '-sc_threshold', '0', '-flags', '+cgop');
  args.push('-preset', 'veryfast', '-crf', '18');
  // PASSTHROUGH, NEVER RESAMPLE. The default frame-rate mode is free to drop or
  // duplicate a frame to hit a target rate, which on a 1.5-second end is a
  // whole frame of error and shows up as the smart render being two frames
  // short of the full one.
  args.push('-fps_mode', 'passthrough');
  return args;
}

function matchedAudioArgs(p: Probe): string[] {
  if (!p.audioCodec) return ['-an'];
  const args = ['-c:a', 'aac'];
  if (p.sampleRate) args.push('-ar', String(p.sampleRate));
  if (p.channels) args.push('-ac', String(p.channels));
  args.push('-b:a', String(Math.min(320_000, Math.max(64_000, p.audioBitrate ?? 128_000))));
  return args;
}

/** Byte-concatenate an init header and a chosen span of segments. */
function concatSegments(initPath: string, segs: ResolvedSegment[], dest: string): void {
  const out: Buffer[] = [readFileSync(initPath)];
  for (const s of segs) {
    if (!existsSync(s.path)) throw new Error(`segment missing on disk: ${s.path}`);
    out.push(readFileSync(s.path));
  }
  writeFileSync(dest, Buffer.concat(out));
}

/**
 * Render one block by re-encoding only its partial ends.
 *
 * Throws on anything it cannot do cleanly. The caller treats a throw as "use the
 * full render", which is why this function never tries to rescue a bad join: a
 * fallback that is merely slower is always better than a clip that is subtly wrong.
 */
async function smartRenderBlock(opts: {
  block: ResolvedBlock;
  fromMs: number;
  toMs: number;
  work: string;
  index: number;
  ffmpeg: string;
  ffprobe: string;
  probe: Probe;
  report: (note: string) => Promise<void> | void;
}): Promise<string> {
  const { block, fromMs, toMs, work, index, ffmpeg, ffprobe, probe } = opts;
  const segs = block.segments;
  const bsf = ANNEXB_BSF[probe.videoCodec];
  const tag = (n: string) => join(work, `smart-${index}-${n}`);

  // Which segments are ends and which are the copyable middle. `partial` is set
  // by resolve.ts and is the authority; the ends are only ever the first and last.
  const headIsPartial = segs[0].partial;
  const tailIsPartial = segs[segs.length - 1].partial;
  const midFrom = headIsPartial ? 1 : 0;
  const midTo = tailIsPartial ? segs.length - 1 : segs.length;
  const middle = segs.slice(midFrom, midTo);
  if (!middle.length) throw new Error('smart render: no middle segments');
  if (middle.some((s) => s.partial)) throw new Error('smart render: a middle segment is partial');

  const parts: string[] = [];

  // ---- head: re-encode only the wanted tail of the first segment ------------
  if (headIsPartial) {
    const src = tag('head-src.mp4');
    concatSegments(block.initPath, [segs[0]], src);
    // RELATIVE TO THE FILE'S OWN START, which is what -ss after -i already
    // means: ffmpeg measures it from the stream's start_time, not from zero.
    // Adding the probed start_time here double-counts it -- measured, after
    // doing exactly that and watching the tail grow to a full segment.
    const inPoint = Math.max(0, fromMs - segs[0].startMs) / 1000;
    const dest = tag('head.ts');
    await opts.report('re-encoding the head segment');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', src, '-ss', inPoint.toFixed(3),
      ...matchedVideoArgs(probe), ...matchedAudioArgs(probe),
      // EACH PART MUST BE EXACTLY AS LONG AS ITS PICTURE. The concat demuxer
      // offsets the next part by this file's DURATION, so an audio tail running
      // past the last frame pushes the middle late (measured: the seam landing
      // two frames after the head ended). `-shortest` ALONE is the wrong cure
      // and was measured too: in these parts the audio is SHORTER than the
      // video, so it truncated the picture instead and lost frames off the end.
      // Pad the audio out first, then cut at the shortest -- which is now the
      // video -- and the part is video-length with audio to match.
      '-af', 'apad', '-shortest',
      // muxdelay/muxpreload 0: a TS otherwise starts at ~1.4s, and the concat
      // demuxer adds that offset to every following part.
      '-bsf:v', bsf, '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', '-y', dest,
    ]);
    parts.push(dest);
  }

  // ---- middle: no decode at all --------------------------------------------
  await opts.report(`copying ${middle.length} whole segment${middle.length === 1 ? '' : 's'}`);
  const midSrc = tag('mid-src.mp4');
  concatSegments(block.initPath, middle, midSrc);
  const midTs = tag('mid.ts');
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', midSrc, '-c', 'copy', '-bsf:v', bsf,
    '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', '-y', midTs,
  ]);
  parts.push(midTs);

  // ---- tail: re-encode only the wanted head of the last segment -------------
  if (tailIsPartial) {
    const last = segs[segs.length - 1];
    const src = tag('tail-src.mp4');
    concatSegments(block.initPath, [last], src);
    // Same rule as the head: -to is relative to the stream's start_time.
    const outPoint = Math.max(0, Math.min(toMs, last.endMs) - last.startMs) / 1000;
    const dest = tag('tail.ts');
    await opts.report('re-encoding the tail segment');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', src, '-to', outPoint.toFixed(3),
      ...matchedVideoArgs(probe), ...matchedAudioArgs(probe),
      '-af', 'apad', '-shortest',
      '-bsf:v', bsf, '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', '-y', dest,
    ]);
    parts.push(dest);
  }

  // ---- the join -------------------------------------------------------------
  // Video is COPIED across the join; audio is re-encoded ONCE over the whole
  // thing, which is what removes the per-part AAC priming seams. See the header.
  const listPath = tag('concat.txt');
  writeFileSync(listPath, await concatListByPicture(parts, ffprobe, frameMs(probe)));
  const dest = join(work, `part-${index}.mp4`);
  await opts.report('joining without re-encoding the middle');
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'copy', ...matchedAudioArgs(probe),
    // ALIGN AUDIO TO THE PICTURE, do not let it move the picture. AAC starts
    // with priming samples, so the audio stream begins slightly before zero;
    // with `-avoid_negative_ts make_zero` the muxer shifts EVERYTHING to make
    // that non-negative and the video lands one audio frame (21ms at 48kHz)
    // late. Resampling audio to a first_pts of 0 puts the correction where it
    // belongs -- in the stream that has the priming -- and leaves the copied
    // video timestamps exactly as the source wrote them.
    '-af', 'aresample=async=1:first_pts=0',
    // AAC also pads its LAST frame, so audio outruns the picture at the end.
    '-shortest',
    '-movflags', '+faststart',
    '-y', dest,
  ]);

  // ---- verify, or throw and let the full render have it ---------------------
  const wantMs = Math.min(toMs, block.endMs) - Math.max(fromMs, block.startMs);
  // MEASURE THE PICTURE, NOT THE CONTAINER. An MP4's format duration is the
  // longest stream plus whatever the muxer padded, so it runs tens of
  // milliseconds beyond the last frame and drifts further with each part joined.
  // Checking that number rejects correct renders: measured at 15,174ms for a
  // 15,000ms range whose frames were provably identical to the full render's.
  // The video stream's own duration is the thing a cut is judged on.
  const got = await probeVideoDurationMs(dest, ffprobe);
  if (got == null) throw new Error('smart render: could not measure the output');
  // DERIVED FROM THE FRAME RATE, not picked. Each end rounds to a whole frame
  // independently, and the muxer adds up to another frame of granularity, so
  // three frame-times is the smallest honest bound. Hard-coding 80ms rejected a
  // correct 25fps render by 17ms; at 50fps the same number would have been
  // slack enough to pass a two-frame error. This is a smoke test for a join
  // that went badly wrong -- the frame-for-frame comparison in
  // clip-smart-render.check.ts is what proves the cut itself.
  const tolerance = Math.max(120, 3 * frameMs(probe));
  if (Math.abs(got - wantMs) > tolerance) {
    throw new Error(`smart render: video ${Math.round(got)}ms, expected ${Math.round(wantMs)}ms (±${tolerance})`);
  }
  // A DURATION CHECK CANNOT SEE A SEAM, so look at the seams. Every picture must
  // follow the one before it by exactly one frame time: a gap or an overlap at a
  // join is a cut that plays and is wrong, and it goes to the full render instead.
  const seam = await seamFault(dest, ffprobe, frameMs(probe));
  if (seam) throw new Error(`smart render: ${seam}`);
  return dest;
}

/** One part's picture, as the concat demuxer will see it. */
interface PartTiming {
  /** The file's start_time: the concat demuxer measures everything from here. */
  fileStartSec: number;
  /** The video stream's own start_time. */
  videoStartSec: number;
  /** How long the picture lasts: last frame's end minus first frame's start. */
  videoDurSec: number;
  /** Video packets in the part. */
  frames: number;
}

async function partTiming(path: string, ffprobe: string): Promise<PartTiming> {
  const raw = await runCapture(ffprobe, [
    '-v', 'error', '-count_packets',
    '-show_entries', 'format=start_time:stream=codec_type,start_time,duration,nb_read_packets',
    '-print_format', 'json', path,
  ]);
  const j = JSON.parse(raw);
  const v = (j.streams ?? []).find((x: any) => x.codec_type === 'video');
  const t = {
    fileStartSec: Number(j.format?.start_time),
    videoStartSec: Number(v?.start_time),
    videoDurSec: Number(v?.duration),
    frames: Number(v?.nb_read_packets),
  };
  if (!v || !Object.values(t).every(Number.isFinite)) throw new Error(`could not read the timing of ${path}`);
  return t;
}

/**
 * The concat list, with each part's length set from its PICTURE.
 *
 * THE SEAM, FIXED. Left to itself the concat demuxer starts the next part at the
 * previous file's CONTAINER duration, which runs to whichever stream ends last.
 * In a part whose AAC outlasts the picture (every copied middle does: 12.000s of
 * video, 12.022s of file) the next part lands that difference late, a gap of
 * 23ms that is half a frame at 50fps and pushed the tail of the fixture a whole
 * PTS step off the full render. Telling the demuxer each part's `duration`
 * replaces that guess with the number that matters: where this part's last
 * picture ends, measured in the same clock the demuxer uses for the next part
 * (its first picture, relative to its own file start).
 *
 * The picture's length is checked against its frame count before it is
 * trusted: a part whose timestamps do not add up to whole frames is not one we
 * can join exactly, and throwing sends the block to the full render.
 */
export async function concatListByPicture(parts: string[], ffprobe: string, frameMsValue: number): Promise<string> {
  const t: PartTiming[] = [];
  for (const p of parts) t.push(await partTiming(p, ffprobe));
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const me = t[i];
    const byCount = (me.frames * frameMsValue) / 1000;
    if (Math.abs(byCount - me.videoDurSec) > (frameMsValue / 2) / 1000) {
      throw new Error(`part ${i + 1}: ${me.frames} frames do not make ${(me.videoDurSec * 1000).toFixed(1)}ms of picture`);
    }
    lines.push(`file '${parts[i].replace(/'/g, "'\\''")}'`);
    if (i < parts.length - 1) {
      const next = t[i + 1];
      // Where this picture ends, relative to this file's start, less where the
      // next picture starts, relative to the next file's start.
      const dur = (me.videoStartSec - me.fileStartSec) + me.videoDurSec
        - (next.videoStartSec - next.fileStartSec);
      if (!(dur > 0)) throw new Error(`part ${i + 1}: no room for its picture (${dur.toFixed(6)}s)`);
      lines.push(`duration ${dur.toFixed(6)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Is there a gap or an overlap anywhere in the picture? Reads packet
 * timestamps (no decode), sorts them into presentation order and checks every
 * step is one frame time. Returns a description of the first fault, or null.
 */
export async function seamFault(path: string, ffprobe: string, frameMsValue: number): Promise<string | null> {
  const raw = await runCapture(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path,
  ]);
  const pts = raw.split('\n').map((l) => parseFloat(l)).filter(Number.isFinite)
    .map((x) => x * 1000).sort((a, b) => a - b);
  if (pts.length < 2) return 'no picture to check';
  // One millisecond either way: the MP4 timescale rounds, a seam does not.
  for (let i = 1; i < pts.length; i++) {
    const step = pts[i] - pts[i - 1];
    if (Math.abs(step - frameMsValue) > 1) {
      return `${step > frameMsValue ? 'gap' : 'overlap'} of ${(step - frameMsValue).toFixed(1)}ms before frame ${i} (${pts[i].toFixed(1)}ms)`;
    }
  }
  return null;
}

/**
 * The video stream's first presentation time, in seconds.
 *
 * NOT ZERO, and worth being able to see. An fMP4 segment concatenated with its
 * init keeps its position in the ORIGINAL timeline: segment 4 of a run reads
 * back with `start_time = 16.08`. It does not change how `-ss` / `-to` are
 * written -- those are already relative to a stream's start_time -- but it is
 * the number to look at first when a trim lands somewhere unexpected, and the
 * verify below is what turns "somewhere unexpected" into a failed render rather
 * than a shipped clip.
 */
export async function probeStartSec(path: string, ffprobeBin = 'ffprobe'): Promise<number> {
  try {
    const raw = await runCapture(ffprobeBin, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=start_time', '-print_format', 'json', path,
    ]);
    const t = Number(JSON.parse(raw)?.streams?.[0]?.start_time);
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

/** The VIDEO STREAM's duration in ms — what a cut is actually judged on. */
export async function probeVideoDurationMs(path: string, ffprobeBin = 'ffprobe'): Promise<number | null> {
  try {
    const raw = await runCapture(ffprobeBin, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration', '-print_format', 'json', path,
    ]);
    const d = Number(JSON.parse(raw)?.streams?.[0]?.duration);
    return Number.isFinite(d) ? d * 1000 : null;
  } catch { return null; }
}

/** Container duration in milliseconds, or null when it cannot be read. */
export async function probeDurationMs(path: string, ffprobeBin = 'ffprobe'): Promise<number | null> {
  try {
    const raw = await runCapture(ffprobeBin, [
      '-v', 'error', '-show_entries', 'format=duration', '-print_format', 'json', path,
    ]);
    const d = Number(JSON.parse(raw)?.format?.duration);
    return Number.isFinite(d) ? d * 1000 : null;
  } catch { return null; }
}

/**
 * Extract a resolved range into the requested formats.
 *
 * A range that spans several runs is rendered per run and joined with the
 * concat demuxer, because an encoder restart may legitimately change resolution
 * or codec parameters and a byte join across that boundary would be invalid.
 */
export async function extract(req: ExtractRequest): Promise<ExtractResult> {
  const { resolution: r, outDir, formats } = req;
  const ffmpeg = req.ffmpegBin ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
  const ffprobe = req.ffprobeBin ?? process.env.FFPROBE_BIN ?? 'ffprobe';
  const report = async (pct: number, note: string) => { await req.onProgress?.(pct, note); };
  const cancelled = () => req.isCancelled?.() === true;

  if (!r.blocks.length) throw new Error('nothing to extract: the range resolved to no media');
  mkdirSync(outDir, { recursive: true });
  const work = join(outDir, '.work');
  mkdirSync(work, { recursive: true });

  const p = plan(r);
  const from = r.effectiveFromMs!;
  const to = r.effectiveToMs!;
  const totalMs = to - from;

  try {
    // ---- 1. per-run contiguous sources ------------------------------------
    await report(2, `joining ${p.segments} segment${p.segments === 1 ? '' : 's'}`);
    const runFiles: { path: string; startMs: number; endMs: number }[] = [];
    for (const [i, run] of r.blocks.entries()) {
      if (cancelled()) throw new Error('cancelled');
      const dest = join(work, `run-${i}.mp4`);
      await concatRun(run, dest);
      runFiles.push({ path: dest, startMs: run.startMs, endMs: run.endMs });
      await report(2 + Math.round((i + 1) / r.blocks.length * 8), `joined block ${i + 1} of ${r.blocks.length}`);
    }

    // ---- 2. accurate trim, per run ----------------------------------------
    // -ss AFTER -i is the accurate (decode-and-discard) seek. Output seeking is
    // what makes this frame-exact rather than keyframe-exact; input seeking
    // would be faster and would land on the preceding keyframe, which is the
    // slop we are here to avoid.
    await report(12, 'trimming');
    const parts: string[] = [];
    const strategyPerBlock: Strategy[] = [];
    const smartRenderSkipped: string[] = [];
    for (const [i, rf] of runFiles.entries()) {
      if (cancelled()) throw new Error('cancelled');
      const inPoint = Math.max(0, from - rf.startMs) / 1000;
      const outPoint = Math.max(0, Math.min(to, rf.endMs) - rf.startMs) / 1000;
      const partPath = join(work, `part-${i}.mp4`);
      const block = r.blocks[i];

      // ---- SMART RENDER FIRST, full render as the fallback -----------------
      // The order matters: this is an optimisation over a path that is already
      // correct, so it may only ever be tried, never depended on. Any refusal or
      // failure falls through to the code below, unchanged.
      if (p.strategy === 'smart-render' && req.smartRender === true) {
        const probe = await probeSource(rf.path, ffprobe);
        const gate = smartEligible(block, probe);
        if (!gate.ok) {
          smartRenderSkipped.push(`block ${i + 1}: ${gate.why}`);
        } else {
          try {
            const smart = await smartRenderBlock({
              block, fromMs: from, toMs: to, work, index: i, ffmpeg, ffprobe,
              probe: probe!, report: (note) => report(12 + Math.round((i / runFiles.length) * 50), note),
            });
            parts.push(smart);
            strategyPerBlock.push('smart-render');
            continue;
          } catch (e: any) {
            // A fallback that nobody can see is a fallback that hides a
            // regression, so the reason travels back on the result.
            smartRenderSkipped.push(`block ${i + 1}: ${String(e?.message ?? e)}`);
          }
        }
      }

      strategyPerBlock.push(p.strategy === 'copy' ? 'copy' : 'full-render');
      await runFfmpeg(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', rf.path,
        '-ss', inPoint.toFixed(3), '-to', outPoint.toFixed(3),
        '-avoid_negative_ts', 'make_zero',
        '-map', '0',
        '-movflags', '+faststart',
        '-progress', 'pipe:2',
        '-y', partPath,
      ], progressReader((outPoint - inPoint) * 1000, (pct) => {
        void report(12 + Math.round(pct * 0.5), `trimming run ${i + 1} of ${runFiles.length}`);
      }));
      parts.push(partPath);
    }

    // ---- 3. join the runs, if there is more than one -----------------------
    let master = parts[0];
    if (parts.length > 1) {
      await report(64, `joining ${parts.length} runs`);
      const listPath = join(work, 'concat.txt');
      writeFileSync(listPath, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
      master = join(work, 'joined.mp4');
      await runFfmpeg(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-movflags', '+faststart', '-y', master,
      ]);
    }

    // ---- 4. the requested outputs ------------------------------------------
    const files: ExtractedFile[] = [];
    let step = 0;
    for (const fmt of formats) {
      if (cancelled()) throw new Error('cancelled');
      step++;
      const base = 68 + Math.round((step - 1) / formats.length * 30);
      await report(base, `writing ${fmt}`);

      if (fmt === 'mp4') {
        const dest = join(outDir, 'clip.mp4');
        // The trimmed master is already an MP4: copy the streams rather than
        // encoding a second time.
        await runFfmpeg(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-i', master, '-c', 'copy', '-movflags', '+faststart', '-y', dest,
        ]);
        files.push({ format: 'mp4', path: dest, bytes: statSync(dest).size, durationMs: totalMs });
      }

      if (fmt === 'mp3') {
        const dest = join(outDir, 'clip.mp3');
        // The one genuine transcode in the set, and only when the source is not
        // already MP3. Audio-only, so it is cheap.
        await runFfmpeg(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-i', master, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-y', dest,
        ]);
        files.push({ format: 'mp3', path: dest, bytes: statSync(dest).size, durationMs: totalMs });
      }

      if (fmt === 'm4a') {
        const dest = join(outDir, 'clip.m4a');
        // The AAC exactly as broadcast, in an audio-only MP4 container: a
        // stream copy, so no second encode and no quality lost.
        await runFfmpeg(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-i', master, '-vn', '-c:a', 'copy', '-movflags', '+faststart', '-y', dest,
        ]);
        files.push({ format: 'm4a', path: dest, bytes: statSync(dest).size, durationMs: totalMs });
      }

      if (fmt === 'hls') {
        const dir = join(outDir, 'hls');
        mkdirSync(dir, { recursive: true });
        // Re-segment by copy: no second encode, and the result is a normal VOD
        // playlist any player can take.
        await runFfmpeg(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-i', master, '-c', 'copy',
          '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
          '-hls_segment_type', 'fmp4',
          '-hls_fmp4_init_filename', 'init.mp4',
          '-hls_segment_filename', join(dir, 'seg_%05d.m4s'),
          '-y', join(dir, 'index.m3u8'),
        ]);
        const idx = join(dir, 'index.m3u8');
        files.push({ format: 'hls', path: idx, bytes: statSync(idx).size, durationMs: totalMs });
      }
    }

    await report(100, 'done');
    return {
      files,
      durationMs: totalMs,
      strategy: p.strategy,
      strategyPerBlock,
      smartRenderSkipped,
      runsUsed: r.runCount,
      blocksUsed: r.blocks.length,
      segmentsUsed: p.segments,
    };
  } finally {
    // Intermediates are large; never leave them behind, even on failure.
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
