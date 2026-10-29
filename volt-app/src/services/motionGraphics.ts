// ============================================================================
//  ALPHA VIDEO IN THE IMAGE LIBRARY: animated bugs, logo stings, loops with
//  transparency, for graphics templates (the Corner bug's "Alpha video" field).
//
//  In:  a .mov (ProRes 4444, QuickTime Animation, PNG in MOV), a .webm (VP8/VP9
//       with alpha) or anything else ffmpeg reads, with or without an alpha channel.
//  Out: three objects in the image store, one Image Library row (kind 'bug' unless asked
//       otherwise; metadata.motion marks it as a video):
//         <name>.webm         VP9 with alpha (yuva420p): what templates play. Chromium,
//                             Chrome, Edge and Firefox play its transparency, and so does
//                             the burn-in renderer (headless Chromium).
//         <name>.png          the first frame, transparent: the row's store_key, so every
//                             thumbnail, picker and grid shows it like any image, and the
//                             still a template falls back to where WebM alpha does not play
//                             (Safari).
//         <name>.source.<ext> the file as uploaded, kept for a later re-encode.
//  The row's metadata.motion says where each is and what the file was; graphics
//  bindings resolve a motion item to its .webm (services/graphics/runtime.ts).
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config';
import { imageStore } from './imageStore';
import { insertMediaRow } from './mediaLibrary';

const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe';
export const MOTION_MAX_BYTES = 500 * 1024 * 1024;
export const MOTION_MAX_SECONDS = 300;

export class MotionError extends Error { constructor(m: string, public status = 400) { super(m); } }

export const isMotionFile = (name: string, type?: string | null) =>
  /^video\//i.test(type ?? '') || /\.(mov|webm|mp4|m4v|mkv|avi|mxf)$/i.test(name);

interface Probe { codec: string; pixFmt: string; width: number; height: number; fps: number | null; durationSec: number | null; alphaTag: boolean }

function probe(path: string): Probe {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,pix_fmt,width,height,r_frame_rate:stream_tags=alpha_mode,ALPHA_MODE:format=duration', '-of', 'json', path], { encoding: 'utf8', timeout: 30_000 });
  if (r.error) throw new MotionError(`ffprobe could not run (${r.error.message}); is ffmpeg installed?`, 500);
  let j: any; try { j = JSON.parse(r.stdout || '{}'); } catch { j = {}; }
  const s = j.streams?.[0];
  if (!s) throw new MotionError('That file has no video in it.');
  const [n, d] = String(s.r_frame_rate ?? '').split('/').map(Number);
  const tags = s.tags ?? {};
  return { codec: s.codec_name, pixFmt: s.pix_fmt ?? '', width: s.width, height: s.height, fps: n && d ? Math.round((n / d) * 100) / 100 : null,
    durationSec: j.format?.duration ? Number(j.format.duration) : null, alphaTag: String(tags.alpha_mode ?? tags.ALPHA_MODE ?? '') === '1' };
}

const hasAlphaPixFmt = (p: string) => /^(yuva|gbrap|ya\d|rgba|argb|bgra|abgr|rgba64|bgra64|pal8)/i.test(p);

function ffmpeg(args: string[], what: string): void {
  const r = spawnSync(config.clips.ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', timeout: 600_000 });
  if (r.error) throw new MotionError(`ffmpeg could not run (${r.error.message})`, 500);
  if (r.status !== 0) throw new MotionError(`${what} failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`.slice(0, 400), 422);
}

export async function ingestMotion(o: { accountId: string; folder: string; name: string; data: Buffer; userId?: string | null; kind?: string; ad?: Record<string, string> }) {
  if (!o.data.length) throw new MotionError('The upload was empty.');
  if (o.data.length > MOTION_MAX_BYTES) throw new MotionError(`That file is ${(o.data.length / 1e6).toFixed(0)} MB; the limit is ${MOTION_MAX_BYTES / 1e6} MB.`, 413);
  const ext = (o.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'mov').toLowerCase();
  const base = o.name.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '_').trim() || 'motion';
  const work = mkdtempSync(join(tmpdir(), 'volt-motion-'));
  try {
    const src = join(work, `in.${ext}`); writeFileSync(src, o.data);
    const p = probe(src);
    if (p.durationSec != null && p.durationSec > MOTION_MAX_SECONDS) throw new MotionError(`That video is ${Math.round(p.durationSec)} s long; graphics videos are limited to ${MOTION_MAX_SECONDS} s.`);
    const vpx = p.codec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : p.codec === 'vp8' ? ['-c:v', 'libvpx'] : [];
    // VP8/VP9 keep alpha in a side channel only libvpx decodes; the probe's pix_fmt says
    // yuv420p for them, so the container tag is what tells.
    const alpha = hasAlphaPixFmt(p.pixFmt) || p.alphaTag;
    const webm = join(work, 'out.webm');
    if (p.codec === 'vp9' && ext === 'webm' && (p.alphaTag || !alpha)) writeFileSync(webm, o.data);
    else {
      ffmpeg([...vpx, '-i', src, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-b:v', '0', '-crf', '30',
        '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-auto-alt-ref', '0', '-metadata:s:v:0', `alpha_mode=${alpha ? 1 : 0}`, webm], 'Converting to WebM');
    }
    const poster = join(work, 'poster.png');
    ffmpeg(['-c:v', 'libvpx-vp9', '-i', webm, '-frames:v', '1', poster], 'Taking the first frame');
    if (!existsSync(poster)) throw new MotionError('The first frame could not be read.', 422);

    const folder = o.folder;
    const at = (n: string) => `library/${o.accountId}/${folder ? folder + '/' : ''}${n}`;
    const keys = { video: at(`${base}.webm`), poster: at(`${base}.png`), source: at(`${base}.source.${ext}`) };
    const store = imageStore();
    for (const k of Object.values(keys)) if (await store.exists(k)) throw new MotionError(`Something is already at ${k.split('/').slice(2).join('/')}. Rename the file or pick another folder.`, 409);
    await store.put(keys.video, readFileSync(webm), 'video/webm');
    await store.put(keys.poster, readFileSync(poster), 'image/png');
    await store.put(keys.source, o.data, 'application/octet-stream');
    const path = `${folder ? folder + '/' : ''}${base}.webm`;
    const row = await insertMediaRow({
      accountId: o.accountId, kind: o.kind ?? 'bug', path, folder, name: `${base}.webm`, storeKey: keys.poster,
      sizeBytes: statSync(webm).size, contentType: 'video/webm', tags: ['motion', ...(alpha ? ['alpha'] : [])], userId: o.userId ?? null, source: 'upload',
      facts: { width: p.width, height: p.height, contentType: 'video/webm' },
      extra: { ...(o.ad && Object.keys(o.ad).length ? { ad: o.ad } : {}), motion: { video: keys.video, poster: keys.poster, source: keys.source, alpha, durationSec: p.durationSec, fps: p.fps,
        width: p.width, height: p.height, codec: 'vp9', sourceCodec: p.codec, sourcePixFmt: p.pixFmt, sourceBytes: o.data.length } },
    });
    return { row, alpha, warning: alpha ? null : 'This video has no transparency (alpha channel), so it will show as a solid rectangle. Export ProRes 4444, QuickTime Animation or WebM with alpha.' };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
