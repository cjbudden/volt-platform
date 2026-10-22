// ============================================================================
//  SPRITE SHEETS FOR AN UPLOADED FILE (docs/ASSET_IMAGES.md, THUMBNAILS.md).
//
//  A recording-derived asset borrows its stream's hourly storyboards. An
//  uploaded file has no stream, so its sheets are made from the file itself
//  while the encode job still has it on disk: one ffmpeg pass, frames at a
//  fixed interval, tiled into sheets in the same layout as the live ones
//  (config.thumbnails: tile size, columns, rows), stored in the Image Library
//  under thumbnails/files/<asset>/ and served through the signed image service.
//
//  The interval follows the file: about 200 previews whatever its length (one
//  a second for a short clip, one every 36 s for a two-hour film), never
//  closer than a second.
//  The WebVTT is made on request from vod_assets.sprite (the layout), because
//  sheet URLs are signed for the asking account.
// ============================================================================
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, one } from '../../db';
import { imageStore } from '../imageStore';
import { upsertMediaRow } from '../mediaLibrary';
import { layoutOf } from './builder';
import { signedImageUrl } from '../../modules/images';

const run = promisify(execFile);
const TARGET_TILES = 200;

export interface FileSprite { folder: string; intervalMs: number; tileW: number; tileH: number; cols: number; rows: number; durationMs: number; sheets: { key: string; from: number; tiles: number }[] }

/** The interval for a file of this length: ~TARGET_TILES previews, whole seconds, at least one second. */
export function spriteInterval(durationMs: number): number {
  return Math.max(1000, Math.ceil(durationMs / TARGET_TILES / 1000) * 1000);
}

/** Build and store the sheets; record the layout on the asset. Returns null for a file with no video. */
export async function buildFileSprites(assetId: string, acct: string, input: string, durationMs: number | null): Promise<FileSprite | null> {
  const L = layoutOf();
  const dur = durationMs && durationMs > 0 ? durationMs : null;
  if (!dur) return null;
  const intervalMs = spriteInterval(dur);
  const perSheet = L.cols * L.rows;
  const dir = await mkdtemp(join(tmpdir(), 'volt-sprite-'));
  try {
    const vf = [`fps=1000/${intervalMs}`,
      `scale=${L.tileW}:${L.tileH}:force_original_aspect_ratio=decrease`,
      `pad=${L.tileW}:${L.tileH}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `tile=${L.cols}x${L.rows}`].join(',');
    await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-an', '-vf', vf, '-q:v', '4', join(dir, 'sheet-%03d.jpg')], { timeout: 15 * 60_000 });
    const files = (await readdir(dir)).filter((f) => /^sheet-\d+\.jpg$/.test(f)).sort();
    if (!files.length) return null;
    const total = Math.max(1, Math.ceil(dur / intervalMs));
    const folder = `thumbnails/files/${assetId}`;
    const sheets: FileSprite['sheets'] = [];
    for (const [i, f] of files.entries()) {
      const buf = await readFile(join(dir, f));
      const name = `sheet-${String(i).padStart(3, '0')}.jpg`;
      const key = `library/${acct}/${folder}/${name}`;
      await imageStore().put(key, buf, 'image/jpeg');
      await upsertMediaRow({ accountId: acct, kind: 'storyboard', path: `${folder}/${name}`, folder, name, storeKey: key, sizeBytes: buf.length,
        contentType: 'image/jpeg', tags: ['auto', 'storyboard'], source: 'auto', facts: { width: L.cols * L.tileW, height: L.rows * L.tileH } as any, extra: { assetId, intervalMs } });
      sheets.push({ key, from: i * perSheet * intervalMs, tiles: Math.min(perSheet, total - i * perSheet) });
    }
    const sprite: FileSprite = { folder, intervalMs, tileW: L.tileW, tileH: L.tileH, cols: L.cols, rows: L.rows, durationMs: dur, sheets: sheets.filter((s) => s.tiles > 0) };
    await query(`UPDATE vod_assets SET sprite = $2::jsonb, storyboard_key = $3, thumb_status = 'ready', updated_at = now() WHERE id = $1`,
      [assetId, JSON.stringify(sprite), sprite.sheets[0]?.key ?? null]);
    return sprite;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const ts = (ms: number) => {
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), x = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};

/** The WebVTT for a file's sprites: one cue per tile, pointing into its signed sheet. */
export function fileSpriteVtt(sp: FileSprite, sign: (key: string, spec: string) => string = signedImageUrl): string {
  const out = ['WEBVTT', ''];
  const spec = `${sp.cols * sp.tileW}x${sp.rows * sp.tileH},fill,fmt=jpeg,q=85`;
  for (const sh of sp.sheets) {
    const url = sign(sh.key, spec);
    for (let i = 0; i < sh.tiles; i++) {
      const from = sh.from + i * sp.intervalMs;
      if (from >= sp.durationMs) break;
      const to = Math.min(sp.durationMs, from + sp.intervalMs);
      const x = (i % sp.cols) * sp.tileW, y = Math.floor(i / sp.cols) * sp.tileH;
      out.push(`${ts(from)} --> ${ts(to)}`, `${url}#xywh=${x},${y},${sp.tileW},${sp.tileH}`, '');
    }
  }
  return out.join('\n');
}

/** An uploaded asset's VTT, or null when it has no file sprites. */
export async function fileVttFor(assetId: string, accountId: string): Promise<string | null> {
  const a = await one<any>(
    `SELECT v.sprite FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [assetId, accountId]);
  return a?.sprite?.sheets?.length ? fileSpriteVtt(a.sprite) : null;
}
