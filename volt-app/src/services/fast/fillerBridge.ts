// ============================================================================
//  SLATES & LOOPS AS FAST FILLER.
//
//  Loops & Fillers holds the slates (images) and loops (short videos) a live
//  channel shows when its source goes away. A FAST channel needs filler too:
//  the slate under ad breaks nobody sold and in gaps, and a loop in place of
//  the slate. But a FAST playout plays PACKAGED library media (splice-aligned
//  1 s segments, loudness normalised: prepare.ts), and a filler asset is a raw
//  image or video file. So the first time a filler asset is used on a FAST
//  channel it is rendered once into a broadcast-shaped MP4 (1920x1080, 25 fps,
//  stereo AAC; a still slate becomes 10 s of picture with silence, a loop up
//  to 2 min, given silence if it has no audio) and becomes a library asset
//  marked fastFiller, hidden from the Media Library. The channel's prepare
//  then packages it like any slate or loop. Every channel using the same
//  filler asset shares that one library asset.
// ============================================================================
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { one } from '../../db';
import { config } from '../../config';
import { fillerPath } from '../uploads';

const SLATE_SEC = 10;
const LOOP_MAX_SEC = 120;
const SCALE = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p';

function run(args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(config.clips.ffmpegBin, args);
    let err = '';
    p.stderr.on('data', (b) => { err += String(b); if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', (e) => resolve({ code: -1, err: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? -1, err }));
  });
}

/** Does the file carry an audio stream? (ffmpeg's own banner, so no ffprobe is needed.) */
async function hasAudio(src: string): Promise<boolean> {
  const r = await run(['-hide_banner', '-i', src]);
  return /Stream #\d+:\d+.*Audio:/.test(r.err);
}

/** The original file of a filler asset on this server, or null. */
export function fillerSource(fa: { id: string; account_id: string; filename?: string | null; source_key?: string | null }): string | null {
  const cands = [fillerPath(fa.account_id, fa.id, fa.filename ?? undefined), fillerPath(fa.account_id, fa.id, fa.source_key ?? undefined)];
  if (fa.source_key) cands.push(join(dirname(config.uploads.fillerDir), fa.source_key), join(config.uploads.fillerDir, fa.source_key.replace(/^filler\//, '')));
  return cands.find((p) => existsSync(p)) ?? null;
}

export class FillerError extends Error { constructor(message: string, public status = 409) { super(message); } }

/**
 * The library asset that carries this filler asset on FAST channels, made on
 * first use. Returns its id; the caller prepares it (1 s segments) for air.
 */
export async function vodForFiller(accountId: string, fillerId: string): Promise<{ assetId: string; created: boolean; name: string; kind: 'slate' | 'loop' }> {
  const fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1 AND account_id = $2`, [fillerId, accountId]);
  if (!fa) throw new FillerError('That slate or loop is not in this account.', 404);
  if (fa.status !== 'ready') throw new FillerError(`"${fa.name}" is not ready yet (${fa.status}).`);
  const existing = await one<any>(`SELECT id FROM vod_assets WHERE account_id = $1 AND metadata->>'fillerAssetId' = $2 ORDER BY created_at DESC LIMIT 1`, [accountId, fillerId]);
  if (existing) return { assetId: String(existing.id), created: false, name: fa.name, kind: fa.kind };

  const src = fillerSource(fa);
  if (!src) throw new FillerError(`The file behind "${fa.name}" is not on this server. Upload it again under Loops & Fillers.`);
  const out = join(config.uploads.fillerDir, accountId, `${fa.id}.fast.mp4`);
  await mkdir(dirname(out), { recursive: true });
  const still = fa.kind === 'slate' || /\.(png|jpe?g|webp|gif|bmp)$/i.test(src);
  const silence = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  const enc = ['-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart'];
  const args = still
    ? ['-y', '-v', 'error', '-loop', '1', '-framerate', '25', '-i', src, ...silence, '-t', String(SLATE_SEC), '-vf', SCALE, '-map', '0:v:0', '-map', '1:a:0', ...enc, '-shortest', out]
    : (await hasAudio(src))
      ? ['-y', '-v', 'error', '-i', src, '-t', String(LOOP_MAX_SEC), '-vf', SCALE, '-map', '0:v:0', '-map', '0:a:0', ...enc, out]
      : ['-y', '-v', 'error', '-i', src, ...silence, '-t', String(LOOP_MAX_SEC), '-vf', SCALE, '-map', '0:v:0', '-map', '1:a:0', ...enc, '-shortest', out];
  const r = await run(args);
  if (r.code !== 0 || !existsSync(out)) throw new FillerError(`Could not render "${fa.name}" for the channel: ${r.err.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `ffmpeg exited ${r.code}`}`, 500);
  const bytes = (await stat(out)).size;
  const durMs = still ? SLATE_SEC * 1000 : Math.min(LOOP_MAX_SEC * 1000, Number(fa.duration_ms) || LOOP_MAX_SEC * 1000);
  const title = `${fa.name} (${fa.kind === 'slate' ? 'slate' : 'loop'})`;
  const row = await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, kind, title, source_key, source_bytes, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status, metadata)
     VALUES ($1, 'upload', 'clip', $2, $3, $4, 0, $5, $5, 'processing', $6::jsonb) RETURNING id`,
    [accountId, title, out, bytes, durMs, JSON.stringify({ title, fillerAssetId: fa.id, fillerKind: fa.kind, fastFiller: true })]);
  return { assetId: String(row.id), created: true, name: fa.name, kind: fa.kind };
}
