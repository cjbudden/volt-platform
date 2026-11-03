// ============================================================================
//  THUMBNAILS FOR SLATES AND LOOPS (migration 0120, docs/THUMBNAILS.md).
//
//  What an uploaded media asset gets, made from the slate or loop's own file:
//
//    LOOP   a dozen frames spread over it (5% to 95%), scored like asset frames
//           (frameScore.ts: exposure, contrast, sharpness, colour, bars), the
//           best one the thumbnail; sprite sheets in the asset layout for hover
//           and scrub previews, with a WebVTT made on request.
//    SLATE  the image itself, scaled to 1280 wide, is the thumbnail. A still has
//           no timeline, so no frames to choose from and no sprites.
//
//  The size and length are read from the file at the same time (width, height,
//  duration), because nothing measured them for an upload before.
//
//  Everything lands in the image store under derived/<account>/filler/<id>/
//  (sheets under derived/<account>/sprites/filler/<id>/, indexed in
//  sprite_sheets), served by the signed image service like an asset's. The
//  source comes from the filler store, so on AWS it is a scratch copy of the
//  bucket object (fillerStore.localCopy).
//
//  A thumbnail a person chose (poster_source 'manual') is kept by a rebuild
//  while that frame still exists.
// ============================================================================
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, one } from '../../db';
import { imageStore } from '../imageStore';
import { localCopy } from './fillerStore';
import { frameStats, scoreFrame, type Candidate } from './frameScore';
import { layoutOf } from '../thumbnails/builder';
import { spriteRoot, recordSprite, deleteSprites } from '../thumbnails/spriteStore';
import { spriteInterval, fileSpriteVtt, type FileSprite } from '../thumbnails/fileSprites';

const run = promisify(execFile);
const FRAMES = 12;

export const fillerFolder = (acct: string, id: string) => `derived/${acct}/filler/${id}`;
const fillerSpriteKey = (acct: string, id: string, name: string) => `${spriteRoot(acct)}/filler/${id}/${name}`;

/** The file as delivered: what the details page shows under "As uploaded". */
export interface FillerProbe {
  container: string | null; bitrateKbps: number | null;
  video: null | { codec: string; profile: string | null; level: string | null; width: number; height: number; fps: number | null;
    scan: 'progressive' | 'interlaced' | null; pixFmt: string | null; colour: string | null; bitDepth: number | null; bitrateKbps: number | null; still: boolean };
  audio: null | { codec: string; profile: string | null; channels: number | null; layout: string | null; sampleRate: number | null; bitrateKbps: number | null; tracks: number };
}
interface Probe { width: number | null; height: number | null; durationMs: number | null; hasVideo: boolean; facts: FillerProbe }

const kbps = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null; };
const rate = (r: unknown) => { const [a, b] = String(r ?? '').split('/').map(Number); return a && b ? Math.round((a / b) * 1000) / 1000 : null; };
const LEVEL = (codec: string, l: unknown) => { const n = Number(l); if (!Number.isFinite(n) || n <= 0) return null; return codec === 'hevc' ? String(n / 30) : codec === 'h264' ? String(n / 10) : String(n); };

/**
 * The container as people name it. ffprobe names families, not files: every
 * MP4, MOV and M4V is "QuickTime / MOV", and a PNG is a "piped png sequence".
 * A still has no container worth naming beside its codec.
 */
const CONTAINER: Record<string, string> = { mp4: 'MP4', m4v: 'M4V', mov: 'QuickTime MOV', mxf: 'MXF', ts: 'MPEG-TS', m2ts: 'MPEG-TS', mkv: 'Matroska', webm: 'WebM', avi: 'AVI', flv: 'FLV', gif: 'GIF' };
export function containerName(path: string, formatName?: string | null, longName?: string | null, still = false): string | null {
  if (still) return null;
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(path)?.[1] ?? '').toLowerCase();
  const fam = String(formatName ?? '').split(',');
  if (CONTAINER[ext] && (fam.includes(ext) || fam.includes('mov') || fam.includes('matroska') || fam.includes('mpegts'))) return CONTAINER[ext];
  if (fam.includes('mxf')) return 'MXF';
  if (fam.includes('mpegts')) return 'MPEG-TS';
  return longName ?? formatName ?? null;
}

async function probe(path: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { timeout: 30_000 });
  const j = JSON.parse(stdout || '{}');
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const auds = streams.filter((s) => s.codec_type === 'audio');
  const a = auds[0];
  const d = Number(j.format?.duration ?? v?.duration);
  const still = !!v && (['png', 'mjpeg', 'bmp', 'gif', 'webp', 'tiff'].includes(v.codec_name) && !(Number(v.nb_frames) > 1));
  const facts: FillerProbe = {
    container: containerName(path, j.format?.format_name, j.format?.format_long_name, still),
    bitrateKbps: kbps(j.format?.bit_rate),
    video: v ? {
      codec: v.codec_name, profile: v.profile ?? null, level: LEVEL(v.codec_name, v.level),
      width: v.width, height: v.height, fps: still ? null : rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
      scan: still ? null : v.field_order && v.field_order !== 'progressive' && v.field_order !== 'unknown' ? 'interlaced' : 'progressive',
      pixFmt: v.pix_fmt ?? null, colour: [v.color_primaries, v.color_transfer].filter((x: any) => x && x !== 'unknown').join(' / ') || null,
      bitDepth: Number(v.bits_per_raw_sample) || (/(10|12)le$/.exec(v.pix_fmt ?? '') ? Number(/(10|12)le$/.exec(v.pix_fmt)![1]) : null),
      bitrateKbps: kbps(v.bit_rate), still,
    } : null,
    audio: a ? {
      codec: a.codec_name, profile: a.profile ?? null, channels: Number(a.channels) || null, layout: a.channel_layout ?? null,
      sampleRate: Number(a.sample_rate) || null, bitrateKbps: kbps(a.bit_rate), tracks: auds.length,
    } : null,
  };
  return { width: v?.width ?? null, height: v?.height ?? null, hasVideo: !!v,
    durationMs: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null, facts };
}

/** Frames spread over a loop, stored and scored, best first. */
async function loopFrames(acct: string, id: string, input: string, durMs: number | null): Promise<Candidate[]> {
  const at = durMs ? Array.from({ length: FRAMES }, (_, i) => Math.round(durMs * (0.05 + 0.9 * i / (FRAMES - 1)))) : [0, 1000, 3000];
  const dir = await mkdtemp(join(tmpdir(), 'volt-filler-frames-'));
  const out: Candidate[] = [];
  try {
    for (const [i, ms] of at.entries()) {
      const file = join(dir, `f${i}.jpg`);
      try {
        await run('ffmpeg', ['-loglevel', 'error', '-y', '-ss', (ms / 1000).toFixed(3), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', file], { timeout: 30_000 });
        const buf = await readFile(file);
        const key = `${fillerFolder(acct, id)}/frame-${String(i).padStart(2, '0')}.jpg`;
        await imageStore().put(key, buf, 'image/jpeg');
        let c: Candidate = { key, atMs: ms, origin: 'ingest' };
        try {
          const sc = scoreFrame(await frameStats(buf), durMs ? ms / durMs : null);
          c = { ...c, score: sc.score, notes: sc.notes, ...(sc.rejected ? { rejected: sc.rejected } : {}) };
        } catch { c = { ...c, score: 0, rejected: 'unreadable' }; }
        out.push(c);
      } catch { /* past the end, or a bad seek: fewer frames */ }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Sprite sheets for a loop, in the asset layout. */
async function loopSprites(acct: string, id: string, input: string, durMs: number): Promise<FileSprite | null> {
  const L = layoutOf();
  const intervalMs = spriteInterval(durMs);
  const perSheet = L.cols * L.rows;
  const dir = await mkdtemp(join(tmpdir(), 'volt-filler-sprite-'));
  try {
    const vf = [`fps=1000/${intervalMs}`, `scale=${L.tileW}:${L.tileH}:force_original_aspect_ratio=decrease`,
      `pad=${L.tileW}:${L.tileH}:(ow-iw)/2:(oh-ih)/2:color=black`, `tile=${L.cols}x${L.rows}`].join(',');
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-an', '-vf', vf, '-q:v', '4', join(dir, 'sheet-%03d.jpg')], { timeout: 10 * 60_000 });
    const files = (await readdir(dir)).filter((f) => /^sheet-\d+\.jpg$/.test(f)).sort();
    if (!files.length) return null;
    const total = Math.max(1, Math.ceil(durMs / intervalMs));
    const sheets: FileSprite['sheets'] = [];
    for (const [i, f] of files.entries()) {
      const from = i * perSheet * intervalMs, tiles = Math.min(perSheet, total - i * perSheet);
      if (tiles <= 0) continue;
      const buf = await readFile(join(dir, f));
      const key = fillerSpriteKey(acct, id, `sheet-${String(i).padStart(3, '0')}.jpg`);
      await imageStore().put(key, buf, 'image/jpeg');
      await recordSprite({ accountId: acct, ownerKind: 'filler', storeKey: key, fillerAssetId: id, startMs: from, intervalMs,
        tileW: L.tileW, tileH: L.tileH, cols: L.cols, rows: L.rows, tiles, width: L.cols * L.tileW, height: L.rows * L.tileH, sizeBytes: buf.length });
      sheets.push({ key, from, tiles });
    }
    return { folder: `sprites/filler/${id}`, intervalMs, tileW: L.tileW, tileH: L.tileH, cols: L.cols, rows: L.rows, durationMs: durMs, sheets };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Every derived object of a slate or loop: thumbnail, frames, sprite sheets. */
async function derivedKeys(acct: string, id: string): Promise<string[]> {
  const a = await imageStore().list(`${fillerFolder(acct, id)}/`).catch(() => []);
  const b = await imageStore().list(`${spriteRoot(acct)}/filler/${id}/`).catch(() => []);
  return [...a, ...b].map((o) => o.key);
}

export interface FillerThumbs { posterKey: string | null; frames: number; sheets: number; durationMs: number | null }

/** Make (or remake) a slate or loop's thumbnail, frames and sprites. Throws with a reason a person can read. */
export async function buildFillerThumbs(id: string): Promise<FillerThumbs> {
  const fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [id]);
  if (!fa) throw new Error('That slate or loop no longer exists');
  if (fa.status !== 'ready' || !fa.source_key) throw new Error(`It is ${fa.status}, with no file to read yet`);
  const acct: string = fa.account_id;
  const src = await localCopy(String(fa.source_key));
  if (!src) throw new Error('Its file is missing from the store');
  const p = await probe(src);
  if (!p.hasVideo) throw new Error('The file has no picture to make a thumbnail from');
  const before = await derivedKeys(acct, id);
  const made: string[] = [];
  let posterKey: string | null = null, frames: Candidate[] = [], sprite: FileSprite | null = null, source = 'auto';
  const still = fa.kind === 'slate' || !p.durationMs || p.durationMs < 1000;
  if (still) {
    // A slate: the image scaled, flattened onto black (a PNG with alpha would show as black anyway on air).
    const dir = await mkdtemp(join(tmpdir(), 'volt-filler-slate-'));
    try {
      const file = join(dir, 'poster.jpg');
      await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', file], { timeout: 30_000 });
      posterKey = `${fillerFolder(acct, id)}/poster-${Date.now().toString(36)}.jpg`;
      await imageStore().put(posterKey, await readFile(file), 'image/jpeg');
      made.push(posterKey);
    } finally { await rm(dir, { recursive: true, force: true }); }
  } else {
    frames = await loopFrames(acct, id, src, p.durationMs);
    made.push(...frames.map((f) => f.key));
    // A frame a person chose stays theirs while it was made again at the same place.
    const kept = fa.poster_source === 'manual' && fa.poster_key ? frames.find((f) => f.key === fa.poster_key) : undefined;
    const best = kept ?? frames.find((f) => !f.rejected) ?? frames[0];
    posterKey = best?.key ?? null;
    if (kept) source = 'manual';
    sprite = await loopSprites(acct, id, src, p.durationMs!);
    if (sprite) made.push(...sprite.sheets.map((s) => s.key));
  }
  await query(
    `UPDATE filler_assets SET poster_key = $2, poster_source = $3, poster_candidates = $4::jsonb, sprite = $5::jsonb,
            width = COALESCE($6, width), height = COALESCE($7, height), duration_ms = COALESCE($8, duration_ms),
            thumb_status = 'ready', thumb_error = NULL, thumbs_at = now(), probe = $9::jsonb, updated_at = now()
      WHERE id = $1`,
    [id, posterKey, posterKey ? source : null, frames.length ? JSON.stringify(frames) : null, sprite ? JSON.stringify(sprite) : null,
     p.width, p.height, still ? null : p.durationMs, JSON.stringify(p.facts)]);
  // What an earlier build left that this one did not make again (a longer file, an older thumbnail).
  const stale = before.filter((k) => !made.includes(k));
  if (stale.length) await deleteSprites(stale);
  return { posterKey, frames: frames.length, sheets: sprite?.sheets.length ?? 0, durationMs: still ? null : p.durationMs };
}

/** A person picks one of a loop's frames as its thumbnail. */
export async function setFillerPoster(id: string, acct: string, key: string): Promise<boolean> {
  const fa = await one<any>(`SELECT poster_candidates FROM filler_assets WHERE id = $1 AND account_id = $2`, [id, acct]);
  if (!fa || !(fa.poster_candidates ?? []).some((c: any) => c.key === key)) return false;
  await query(`UPDATE filler_assets SET poster_key = $2, poster_source = 'manual', updated_at = now() WHERE id = $1`, [id, key]);
  return true;
}

/** Back to the best-scoring frame. */
export async function autoFillerPoster(id: string, acct: string): Promise<boolean> {
  const fa = await one<any>(`SELECT poster_candidates FROM filler_assets WHERE id = $1 AND account_id = $2`, [id, acct]);
  const c: any[] = fa?.poster_candidates ?? [];
  const best = c.find((x) => !x.rejected) ?? c[0];
  if (!best) return false;
  await query(`UPDATE filler_assets SET poster_key = $2, poster_source = 'auto', updated_at = now() WHERE id = $1`, [id, best.key]);
  return true;
}

/** A loop's WebVTT for hover and scrub previews, or null for a slate or a loop not done yet. */
export async function fillerVtt(id: string, acct: string): Promise<string | null> {
  const fa = await one<any>(`SELECT sprite FROM filler_assets WHERE id = $1 AND account_id = $2`, [id, acct]);
  return fa?.sprite?.sheets?.length ? fileSpriteVtt(fa.sprite) : null;
}

/** Remove the derived files of a slate or loop being deleted (best effort). */
export async function deleteFillerThumbs(acct: string, id: string): Promise<void> {
  const keys = await derivedKeys(acct, id);
  if (keys.length) await deleteSprites(keys).catch(() => {});
}
