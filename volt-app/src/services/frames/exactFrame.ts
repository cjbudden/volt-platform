// ============================================================================
//  ONE EXACT FRAME FROM ONE SEGMENT (build queue 3.2 (b)).
//
//  Every segment Volt writes opens on a keyframe with a closed GOP, so a frame
//  is: read that one segment (with its init for CMAF), decode forward from its
//  start, keep the k-th picture in presentation order. Nothing before the
//  segment is read, which is what makes stepping through a two-hour film as
//  cheap as stepping through a two-minute clip.
//
//  The still is a high-quality JPEG at the source's own size; the signed image
//  service (services/images) makes every width from it and caches those, so a
//  frame is decoded once however many sizes are asked for.
// ============================================================================
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFragments, readInit } from './fmp4';

const run = promisify(execFile);

export class FrameError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * The k-th frame (presentation order, 0-based) of a segment as a JPEG.
 * `init` is the CMAF init segment, or null for a self-contained MPEG-TS segment.
 */
export async function extractFrame(init: Buffer | null, segment: Buffer, k: number, opts: { ffmpeg?: string; timeoutMs?: number } = {}): Promise<Buffer> {
  if (!Number.isInteger(k) || k < 0) throw new FrameError(400, 'frame offset must be a whole number from 0');
  // A segment that does not start on a keyframe would hand the decoder frames
  // it cannot draw, and "the k-th picture out" would no longer be frame k.
  // Volt never writes one; refuse rather than return a neighbour.
  if (init) {
    const facts = readInit(init);
    const frag = facts ? readFragments(segment, facts) : null;
    if (frag && !frag.startsWithSync) throw new FrameError(422, 'this segment does not start on a keyframe, so its frames cannot be read on their own');
    if (frag && k >= frag.pts.length) throw new FrameError(404, `the segment holds ${frag.pts.length} frames, not ${k + 1}`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'volt-frame-'));
  try {
    const src = join(dir, init ? 'seg.mp4' : 'seg.ts');
    await writeFile(src, init ? Buffer.concat([init, segment]) : segment);
    const out = join(dir, 'frame.jpg');
    // select by output frame number: the decoder emits pictures in
    // presentation order, so n is the frame's place in the segment.
    await run(opts.ffmpeg ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', src, '-an', '-sn',
      '-vf', `select=eq(n\\,${k})`, '-fps_mode', 'passthrough', '-frames:v', '1',
      '-q:v', '2', out,
    ], { timeout: opts.timeoutMs ?? 30_000 });
    const { readFile } = await import('node:fs/promises');
    const jpg = await readFile(out).catch(() => null);
    if (!jpg?.length) throw new FrameError(404, `no frame ${k} in that segment`);
    return jpg;
  } catch (e: any) {
    if (e instanceof FrameError) throw e;
    throw new FrameError(500, `the frame could not be decoded: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The picture at `seconds` into a whole file, as a JPEG: for a title whose
 * packaged segments are encrypted (build queue P4-5), read from its original.
 * Accurate seek (`-ss` after `-i` would decode from the start; before it,
 * ffmpeg seeks to the keyframe and decodes forward to the time), so the
 * picture is the one on screen at that time.
 */
export async function extractFrameAt(path: string, seconds: number, opts: { ffmpeg?: string; timeoutMs?: number } = {}): Promise<Buffer> {
  if (!Number.isFinite(seconds) || seconds < 0) throw new FrameError(400, 'the time must be zero or more seconds');
  const dir = await mkdtemp(join(tmpdir(), 'volt-frame-'));
  try {
    const out = join(dir, 'frame.jpg');
    await run(opts.ffmpeg ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', seconds.toFixed(6), '-i', path, '-an', '-sn', '-frames:v', '1', '-q:v', '2', out,
    ], { timeout: opts.timeoutMs ?? 30_000 });
    const { readFile } = await import('node:fs/promises');
    const jpg = await readFile(out).catch(() => null);
    if (!jpg?.length) throw new FrameError(404, `no picture at ${seconds.toFixed(3)} s in the original`);
    return jpg;
  } catch (e: any) {
    if (e instanceof FrameError) throw e;
    throw new FrameError(500, `the frame could not be decoded: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Frame count and first presentation time of an MPEG-TS segment (one ffprobe packet scan). */
export async function probeTsSegment(path: string, ffprobe = 'ffprobe'): Promise<{ frames: number; firstPts: number; timescale: number; rate: string | null }> {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=time_base,r_frame_rate:packet=pts',
    '-of', 'json', path,
  ], { timeout: 30_000, maxBuffer: 16 << 20 });
  const j = JSON.parse(stdout);
  const st = j.streams?.[0] ?? {};
  const tb = /^1\/(\d+)$/.exec(String(st.time_base ?? ''));
  const pts = (j.packets ?? []).map((p: any) => Number(p.pts)).filter((x: number) => Number.isFinite(x));
  return { frames: pts.length, firstPts: pts.length ? Math.min(...pts) : 0, timescale: tb ? Number(tb[1]) : 90000, rate: st.r_frame_rate ?? null };
}
