// ============================================================================
//  Caption tracks on the playback routes (server.ts /clips; delivery.ts says
//  how). Both helpers FAIL OPEN: a problem here never stops the video playing.
//
//    withTracks(text, assetId, isMpd)        the master or MPD with the asset's tracks
//    serveSubs  /clips/<..>/subs/<id>.m3u8   a track's one-segment HLS playlist
//               /clips/<..>/subs/<id>.vtt    its WebVTT, with X-TIMESTAMP-MAP from
//                                            the delivered segments' own clock
//               /clips/<..>/subs/<id>.dash.vtt  the same cues for DASH (no map)
// ============================================================================
import type { Request, Response, NextFunction } from 'express';
import { readFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { one, query } from '../../db';
import { config } from '../../config';
import { imageStore } from '../imageStore';
import { withHlsSubtitles, withoutHlsSubtitles, withDashSubtitles, subtitlePlaylist, timestampMap, readTfdt, readTimescale, type Track } from './delivery';
import { languageName } from './formats';

/** The asset's caption files that play as tracks, in manifest order. Uncached. */
export async function activeTracks(assetId: string): Promise<Track[]> {
  return (await query<any>(`SELECT id, language, label, is_default, forced, sdh FROM vod_asset_files
                             WHERE asset_id = $1 AND kind = 'captions' AND enabled AND vtt_key IS NOT NULL
                             ORDER BY is_default DESC, forced, language NULLS LAST, created_at`, [assetId]))
    .map((r) => ({ id: r.id, language: r.language, label: r.label || languageName(r.language), isDefault: !!r.is_default, forced: !!r.forced, sdh: !!r.sdh }));
}

async function tracksFor(assetId: string): Promise<Track[]> {
  const { cached } = await import('../../scale/cache');
  return cached(`vodsubs:${assetId}`, { ttlSec: 300, tags: [`asset:${assetId}`] }, () => activeTracks(assetId));
}

export async function withTracks(text: string, assetId: string, isMpd: boolean): Promise<string> {
  try {
    const tracks = await tracksFor(assetId);
    // No tracks: still strip any the stored file carries. On S3 the bucket's
    // master and MPD hold the tracks written there (bucketTracks.ts), and a
    // failed write after the last one was disabled must not keep it listed.
    if (!tracks.length) return isMpd ? withDashSubtitles(text, [], '') : withoutHlsSubtitles(text);
    return isMpd ? withDashSubtitles(text, tracks, '') : withHlsSubtitles(text, tracks);
  } catch (e) { console.warn(`[subs] ${assetId}: tracks not added`, e); return text; }
}

const SUBS = /^\/clips\/(.+)\/subs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.dash)?\.(m3u8|vtt)$/i;

export async function serveSubs(req: Request, res: Response, next: NextFunction) {
  try {
    const m = SUBS.exec(decodeURIComponent(req.path));
    if (!m || m[1].includes('..')) return next();
    const fileId = m[2], dash = !!m[3], ext = m[4].toLowerCase();
    const r = await one<any>(`SELECT f.id, f.asset_id, f.vtt_key, f.enabled, v.duration_ms, v.master_key
                                FROM vod_asset_files f JOIN vod_assets v ON v.id = f.asset_id
                               WHERE f.id = $1 AND f.kind = 'captions'`, [fileId]);
    // The track must belong to the asset whose folder the path is in.
    if (!r || !r.enabled || !r.vtt_key || !m[1].toLowerCase().includes(String(r.asset_id).toLowerCase())) return res.status(404).end();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');
    if (ext === 'm3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(subtitlePlaylist(r.id, Number(r.duration_ms) || 1000));
    }
    const buf = await imageStore().get(r.vtt_key);
    if (!buf) return res.status(404).end();
    let text = buf.toString('utf8');
    if (!dash) {
      const map = await clockMap(r.asset_id, r.master_key).catch(() => null);
      if (map) text = text.replace(/^WEBVTT[^\n]*\n/, (h) => `${h}${map}\n`);
    }
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.end(text);
  } catch (e) { console.warn('[subs] not served', e); next(); }
}

/**
 * The path under /clips that an asset's master_key names: '/clips/...' on the
 * Mac and for clips, or the bare bucket key 'vod/<id>/master.m3u8' an encode
 * gets on an S3 deployment (services/fast/vodStore.ts), which is the same file
 * as /clips/vod/<id>/master.m3u8. Null for anything else (a URL, a live path).
 */
export function clipsPathOfMaster(masterKey: string | null | undefined): string | null {
  const k = String(masterKey ?? '');
  if (k.startsWith('/clips/')) return k.slice('/clips'.length);
  if (/^vod\/[0-9a-f-]{36}\/[^/]/i.test(k)) return `/${k}`;
  return null;
}

/**
 * A file under /clips by its path there: from this task's disk, or, when the
 * task does not hold it, from the bucket copy the job made (2.1a-2b-3; on AWS
 * the task that cut the clip or ran the encode is rarely this one). Paths are
 * normalised first and must stay inside CLIPS_DIR; the bucket side only maps
 * the clip and encode prefixes (clipsStore.readThroughKey), never originals.
 */
export async function readClipsFile(rel: string): Promise<Buffer | null> {
  const n = posix.normalize(`/${String(rel).replace(/^\/+/, '')}`);
  const root = resolve(config.clips.dir);
  const file = resolve(join(root, n));
  if (!file.startsWith(root + sep)) return null;
  const local = await readFile(file).catch(() => null);
  if (local) return local;
  const { readThroughKey, readObjectBuffer } = await import('../media/clipsStore');
  const key = await readThroughKey(n);
  return key ? readObjectBuffer(key) : null;
}

/**
 * X-TIMESTAMP-MAP for the asset: the first segment of the first variant of
 * its master, read from the files the player gets. Cached with the asset.
 */
async function clockMap(assetId: string, masterKey: string | null): Promise<string | null> {
  const masterRel = clipsPathOfMaster(masterKey);
  if (!masterRel) return null;
  const { cached } = await import('../../scale/cache');
  return cached(`vodsubclock:${assetId}`, { ttlSec: 3600, tags: [`asset:${assetId}`] }, () => timestampMapFor(masterRel));
}

/** The X-TIMESTAMP-MAP line for a master at this path under /clips, or null (not CMAF, or a file missing). */
export async function timestampMapFor(masterRel: string): Promise<string | null> {
  const text = async (rel: string) => (await readClipsFile(rel))?.toString('utf8') ?? null;
  const master = await text(masterRel);
  if (master == null) return null;
  const lines = master.split('\n').map((l) => l.trim());
  const vi = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:'));
  const variantRel = vi >= 0 ? lines.slice(vi + 1).find((l) => l && !l.startsWith('#')) : null;
  const variantPath = variantRel ? posix.join(posix.dirname(masterRel), variantRel) : masterRel;
  const variant = await text(variantPath);
  if (variant == null) return null;
  const media = variant.split('\n').map((l) => l.trim());
  const initRel = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(media.find((l) => l.startsWith('#EXT-X-MAP:')) ?? '')?.[1];
  const segRel = media.find((l) => l && !l.startsWith('#'));
  if (!initRel || !segRel) return null;                       // not CMAF: leave cue times as they are
  const init = await readClipsFile(posix.join(posix.dirname(variantPath), initRel));
  const seg = await readClipsFile(posix.join(posix.dirname(variantPath), segRel));
  if (!init || !seg) return null;
  const timescale = readTimescale(init);
  const tfdt = readTfdt(seg);
  return timescale && tfdt != null ? timestampMap(tfdt, timescale) : null;
}
