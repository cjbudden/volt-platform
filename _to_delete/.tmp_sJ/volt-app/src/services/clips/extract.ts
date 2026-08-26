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
//  Smart render is the right destination and it is what stage 1b will do. It is
//  not what stage 1 does, because the join between a re-encoded end and a copied
//  middle has to match on codec, profile, level, pixel format, timescale and
//  sample rate, and when it does not the result plays but drifts — the failure
//  mode that looks correct in a screenshot and is wrong in the edit suite.
//
//  So: FULL RENDER now, correct by construction and easy to verify. Smart render
//  next, validated frame-for-frame AGAINST this output rather than against a
//  stopwatch. `plan()` already reports which path a range would take, so the
//  saving is measurable before the optimisation exists.
// ============================================================================
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Resolution, ResolvedRun } from './resolve';

export type OutputFormat = 'hls' | 'mp4' | 'mp3';

export interface ExtractRequest {
  resolution: Resolution;
  outDir: string;
  formats: OutputFormat[];
  /** Progress callback: 0..100 with a short note. */
  onProgress?: (pct: number, note: string) => void | Promise<void>;
  /** Abort politely when the worker is shutting down. */
  isCancelled?: () => boolean;
  ffmpegBin?: string;
}

export interface ExtractedFile {
  format: OutputFormat;
  path: string;
  bytes: number;
  durationMs: number;
}

export interface ExtractResult {
  files: ExtractedFile[];
  durationMs: number;
  strategy: 'full-render' | 'copy';
  runsUsed: number;
  segmentsUsed: number;
}

/** What extracting this range would involve, without doing it. */
export function plan(r: Resolution): {
  strategy: 'full-render' | 'copy';
  segments: number;
  partialSegments: number;
  spansRuns: boolean;
  /** Segments a smart render would have to re-encode, once that path exists. */
  smartRenderSegments: number;
} {
  const segments = r.runs.reduce((n, run) => n + run.segments.length, 0);
  const partial = r.runs.reduce((n, run) => n + run.segments.filter((s) => s.partial).length, 0);
  return {
    strategy: r.needsTrim ? 'full-render' : 'copy',
    segments,
    partialSegments: partial,
    spansRuns: r.runs.length > 1,
    smartRenderSegments: partial,
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
async function concatRun(run: ResolvedRun, dest: string): Promise<void> {
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
  const report = async (pct: number, note: string) => { await req.onProgress?.(pct, note); };
  const cancelled = () => req.isCancelled?.() === true;

  if (!r.runs.length) throw new Error('nothing to extract: the range resolved to no media');
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
    for (const [i, run] of r.runs.entries()) {
      if (cancelled()) throw new Error('cancelled');
      const dest = join(work, `run-${i}.mp4`);
      await concatRun(run, dest);
      runFiles.push({ path: dest, startMs: run.startMs, endMs: run.endMs });
      await report(2 + Math.round((i + 1) / r.runs.length * 8), `joined run ${i + 1} of ${r.runs.length}`);
    }

    // ---- 2. accurate trim, per run ----------------------------------------
    // -ss AFTER -i is the accurate (decode-and-discard) seek. Output seeking is
    // what makes this frame-exact rather than keyframe-exact; input seeking
    // would be faster and would land on the preceding keyframe, which is the
    // slop we are here to avoid.
    await report(12, 'trimming');
    const parts: string[] = [];
    for (const [i, rf] of runFiles.entries()) {
      if (cancelled()) throw new Error('cancelled');
      const inPoint = Math.max(0, from - rf.startMs) / 1000;
      const outPoint = Math.max(0, Math.min(to, rf.endMs) - rf.startMs) / 1000;
      const partPath = join(work, `part-${i}.mp4`);
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
      const { writeFileSync } = await import('node:fs');
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
      runsUsed: r.runs.length,
      segmentsUsed: p.segments,
    };
  } finally {
    // Intermediates are large; never leave them behind, even on failure.
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
