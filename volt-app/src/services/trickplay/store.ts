// ============================================================================
//  TRICK-PLAY FOR ON-DEMAND ASSETS (build queue 3.2b, DASH 3.2b-2): which
//  assets have it, making their I-frame playlists and DASH trick-mode facts,
//  and serving them. iframes.ts is the pure part.
//
//  WHICH SWITCH APPLIES. The switch is on the output profile. An asset follows
//  the output profile it was made with: a clip or full recording, the profile
//  of its channel's or event's group; an upload or watch-folder file, the live
//  profile its encoding ladder mirrors. An asset with neither (a ladder of its
//  own, or no ladder) follows the account's default for new profiles.
//
//  WHEN THEY ARE MADE. After every build (the frames.index job queues this one
//  when the switch is on), and the first time a master is asked for with the
//  switch on and nothing made yet: so turning the switch on later covers the
//  existing library without a re-encode, at the cost of reading box headers.
//  With the switch off nothing is made, and anything made before is not
//  listed or served (it is kept, so turning it on again costs nothing).
// ============================================================================
import { createHash } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { config } from '../../config';
import { one, query } from '../../db';
import { clipsPathOfMaster, readClipsFile } from '../companions/serve';
import { readInit } from '../frames/fmp4';
import { buildIframePlaylist, dashEntries, iframeUriFor, initIvSize, keyframeFragment, keyframeRanges, mediaSegments, videoVariants, withDashTrickMode, withIframeStreams, type DashTrick, type IframeStream } from './iframes';

const SWITCH_SQL = `
  SELECT COALESCE(
    (SELECT op.trick_play FROM groups g JOIN output_profiles op ON op.id = g.output_profile_id
      WHERE g.id = COALESCE((SELECT c.group_id FROM channels c WHERE c.id = v.channel_id),
                            (SELECT e.group_id FROM events e WHERE e.id = v.event_id))),
    (SELECT op.trick_play FROM encode_ladder_groups l JOIN output_profiles op ON op.id = l.tracks_output_profile_id
      WHERE l.id = v.ladder_group_id),
    (SELECT a.trick_play_default FROM accounts a WHERE a.id = v.account_id),
    false) AS on
  FROM vod_assets v WHERE v.id = $1`;

/** Is trick-play on for this asset, by the rule above. False for an unknown asset. */
export async function trickPlayOn(assetId: string): Promise<boolean> {
  const r = await one<{ on: boolean }>(SWITCH_SQL, [assetId]);
  return !!r?.on;
}

/** Cached for a minute: masters are asked for often, and the switch rarely changes. */
async function trickPlayOnCached(assetId: string): Promise<boolean> {
  const { cached } = await import('../../scale/cache');
  return cached(`trickplay:${assetId}`, { ttlSec: 60, tags: [`asset:${assetId}`] }, () => trickPlayOn(assetId));
}

async function readText(rel: string): Promise<string> {
  const b = await readClipsFile(rel);
  if (!b) throw new Error(`missing media file ${rel}`);
  return b.toString('utf8');
}

export interface TrickPlayBuild { state: 'ready' | 'off' | 'none'; note: string | null; renditions: number }

/**
 * Make the I-frame playlist of every video rendition of an asset and store
 * them. Only CMAF renditions can have one this way (older MPEG-TS clips say
 * so and get none). Nothing is made when the switch is off.
 */
export async function buildAssetTrickPlay(assetId: string, opts: { force?: boolean } = {}): Promise<TrickPlayBuild> {
  const a = await one<any>(`SELECT id, master_key FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) return { state: 'none', note: 'asset not found', renditions: 0 };
  if (!opts.force && !(await trickPlayOn(assetId))) return { state: 'off', note: 'trick-play is off for this asset', renditions: 0 };
  const masterRel = clipsPathOfMaster(a.master_key);
  if (!masterRel) return { state: 'none', note: 'no packaged HLS yet', renditions: 0 };
  const master = await readText(masterRel);
  const variants = videoVariants(master);
  if (!variants.length) return { state: 'none', note: 'no video rendition', renditions: 0 };
  let made = 0;
  const notes: string[] = [];
  for (const v of variants) {
    const plRel = posix.join(posix.dirname(masterRel), v.uri);
    const segs = mediaSegments(await readText(plRel));
    const mapUri = segs[0]?.map ? /URI="([^"]+)"/.exec(segs[0].map)?.[1] : null;
    if (!mapUri) { notes.push(`${v.uri}: not CMAF`); continue; }
    const dir = posix.dirname(plRel);
    const initBuf = (await readClipsFile(posix.join(dir, mapUri))) ?? Buffer.alloc(0);
    const init = readInit(initBuf);
    if (!init || !init.isVideo) { notes.push(`${v.uri}: no video track`); continue; }
    const withKeys = [];
    for (const s of segs) {
      const b = await readClipsFile(posix.join(dir, s.uri));
      if (!b) throw new Error(`missing media file ${posix.join(dir, s.uri)}`);
      withKeys.push({ ...s, keyframes: keyframeRanges(b, init) });
    }
    const pl = buildIframePlaylist(withKeys, init.timescale);
    if (!pl) { notes.push(`${v.uri}: no keyframes found`); continue; }
    const dash = await dashTrickFor(v.uri, plRel, masterRel, mapUri, initBuf, init, withKeys);
    if ('none' in dash) notes.push(`${v.uri}: no DASH trick-mode (${dash.none})`);
    await query(
      `INSERT INTO vod_iframe_playlists (vod_asset_id, variant_uri, playlist, bandwidth, average_bandwidth, resolution, codecs, entries, source, dash, built_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (vod_asset_id, variant_uri) DO UPDATE SET playlist = EXCLUDED.playlist, bandwidth = EXCLUDED.bandwidth,
         average_bandwidth = EXCLUDED.average_bandwidth, resolution = EXCLUDED.resolution, codecs = EXCLUDED.codecs,
         entries = EXCLUDED.entries, source = EXCLUDED.source, dash = EXCLUDED.dash, built_at = EXCLUDED.built_at`,
      [assetId, v.uri, pl.text, pl.bandwidth, pl.averageBandwidth, v.resolution, v.codecs, pl.entries, a.master_key, JSON.stringify(dash)]);
    made++;
  }
  // Renditions the master no longer lists (a re-encode with another ladder).
  await query(`DELETE FROM vod_iframe_playlists WHERE vod_asset_id = $1 AND NOT (variant_uri = ANY($2::text[]))`, [assetId, variants.map((v) => v.uri)]);
  try { (await import('../../scale/cache')).invalidateTag(`asset:${assetId}`); } catch { /* the 60 s cache catches up */ }
  return { state: made ? 'ready' : 'none', note: notes.length ? notes.join('; ') : null, renditions: made };
}

/** The stored I-frame streams of an asset made from its current master. */
async function storedStreams(assetId: string): Promise<{ streams: IframeStream[]; stale: boolean; dash: { trick: DashTrick; bandwidth: number }[] }> {
  const rows = await query<any>(
    `SELECT p.variant_uri, p.bandwidth, p.average_bandwidth, p.resolution, p.codecs, p.dash, p.source IS NOT DISTINCT FROM v.master_key AS current
       FROM vod_iframe_playlists p JOIN vod_assets v ON v.id = p.vod_asset_id WHERE p.vod_asset_id = $1 ORDER BY p.bandwidth`, [assetId]);
  const current = rows.filter((r) => r.current);
  return {
    streams: current.map((r) => ({ variantUri: r.variant_uri, bandwidth: r.bandwidth, averageBandwidth: r.average_bandwidth, resolution: r.resolution, codecs: r.codecs })),
    // A row made before DASH trick-mode existed (dash NULL) is rebuilt too.
    stale: rows.length > current.length || !rows.length || current.some((r) => r.dash == null),
    dash: current.filter((r) => r.dash && !('none' in r.dash)).map((r) => ({ trick: r.dash as DashTrick, bandwidth: Number(r.bandwidth) })),
  };
}

export async function queueTrickPlay(assetId: string): Promise<void> {
  try {
    const { enqueue } = await import('../jobs/queue');
    await enqueue({ type: 'trickplay.build', payload: { vodAssetId: assetId }, dedupeKey: `trickplay.build:${assetId}`, priority: 75, maxAttempts: 2 });
  } catch (e) {
    console.error(`[trickplay] ${assetId}: not queued:`, e);
  }
}

/**
 * A master as served: with its I-frame streams when the asset's switch is on.
 * FAILS OPEN: any problem here leaves the master as it was. A master with the
 * switch on and nothing made yet queues the build and is served without them.
 */
export async function withTrickPlay(master: string, assetId: string, rel?: string): Promise<string> {
  try {
    if (!/#EXT-X-STREAM-INF/.test(master)) return master;
    if (!(await trickPlayOnCached(assetId))) return master;
    // Only the asset's own master: a FAST ladder's master under the same asset
    // (ladders/...) has other renditions, and these URIs would not resolve.
    if (rel != null && !(await isBesideMaster(assetId, rel))) return master;
    const { streams, stale } = await storedStreams(assetId);
    if (stale) void queueTrickPlay(assetId);
    return withIframeStreams(master, streams);
  } catch (e) {
    console.warn(`[trickplay] ${assetId}: master served without I-frame streams`, e);
    return master;
  }
}

/** Is this path under /clips in the folder of the asset's own master? */
async function isBesideMaster(assetId: string, rel: string): Promise<boolean> {
  const a = await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [assetId]);
  const masterRel = clipsPathOfMaster(a?.master_key);
  return !!masterRel && posix.dirname(posix.normalize(rel)) === posix.dirname(masterRel);
}

/**
 * The DASH trick-mode facts of one rendition (see iframes.ts). The MPD names
 * the init segment by its path from the master's folder, so that is what is
 * stored. Checked by making the first trick segment: a layout the rewrite does
 * not know is found here, not by a player.
 */
async function dashTrickFor(variantUri: string, plRel: string, masterRel: string, mapUri: string, initBuf: Buffer, init: { trackId: number; timescale: number },
  segs: { uri: string; durSec: number; keyframes: import('./iframes').Keyframe[] }[]): Promise<DashTrick | { none: string }> {
  const fromMaster = (u: string) => posix.relative(posix.dirname(masterRel), posix.join(posix.dirname(plRel), u));
  const ivSize = initIvSize(initBuf);
  if (ivSize === -1) return { none: 'encrypted, IV size not readable' };
  const entries = dashEntries(segs.map((s) => ({ ...s, uri: fromMaster(s.uri) })), init.timescale);
  if (!entries.length) return { none: 'no keyframes' };
  const e0 = entries[0];
  const range = await readClipsRange(posix.join(posix.dirname(masterRel), e0.uri), e0.start, e0.end);
  if (!range || !keyframeFragment(range, init.trackId, e0.dur, ivSize)) return { none: 'fragment layout not supported (sample groups or no senc)' };
  return {
    init: fromMaster(mapUri), timescale: init.timescale, trackId: init.trackId, ivSize,
    key: createHash('sha1').update(variantUri).digest('hex').slice(0, 8), entries,
  };
}

/**
 * Bytes [start, end) of a file under /clips: from this task's disk, else a
 * ranged read of the bucket copy (a trick segment needs about a tenth of its
 * media segment, so the rest is not fetched).
 */
export async function readClipsRange(rel: string, start: number, end: number): Promise<Buffer | null> {
  if (!(end > start) || start < 0) return null;
  const n = posix.normalize(`/${String(rel).replace(/^\/+/, '')}`);
  const root = resolve(config.clips.dir);
  const file = resolve(join(root, n));
  if (!file.startsWith(root + sep)) return null;
  const fh = await openFile(file, 'r').catch(() => null);
  if (fh) {
    try {
      const b = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(b, 0, b.length, start);
      return bytesRead === b.length ? b : null;
    } finally { await fh.close(); }
  }
  const { readThroughKey, openObject } = await import('../media/clipsStore');
  const key = await readThroughKey(n);
  const o = key ? await openObject(key, `bytes=${start}-${end - 1}`) : null;
  if (!o) return null;
  const chunks: Buffer[] = [];
  for await (const c of o.body) chunks.push(Buffer.from(c));
  const b = Buffer.concat(chunks);
  return b.length === end - start ? b : null;
}

/**
 * An MPD as served: with a trick-mode AdaptationSet per video set when the
 * asset's switch is on and its renditions are built. FAILS OPEN like the
 * master. `rel` is the MPD's path under /clips: only the asset's own MPD
 * (beside its master) gets them.
 */
export async function withDashTrickPlay(mpd: string, assetId: string, rel: string): Promise<string> {
  try {
    if (!(await trickPlayOnCached(assetId))) return mpd;
    if (!(await isBesideMaster(assetId, rel))) return mpd;
    const { dash, stale } = await storedStreams(assetId);
    if (stale) void queueTrickPlay(assetId);
    const bw = new Map(dash.map((d) => [d.trick.key, d.bandwidth]));
    return withDashTrickMode(mpd, dash.map((d) => d.trick), (t) => bw.get(t.key) ?? 1);
  } catch (e) {
    console.warn(`[trickplay] ${assetId}: MPD served without trick-mode`, e);
    return mpd;
  }
}

/**
 * Trick segment n (from 1) of the rendition with this key, at
 * <master folder>/trick/<key>/<n>.m4s, or null (switch off, not built, a
 * re-encode's older build, no such entry): the route answers 404.
 */
export async function trickSegment(assetId: string, rel: string, key: string, n: number): Promise<Buffer | null> {
  if (!(await trickPlayOnCached(assetId))) return null;
  const a = await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [assetId]);
  const masterRel = clipsPathOfMaster(a?.master_key);
  if (!masterRel) return null;
  if (posix.normalize(rel) !== posix.join(posix.dirname(masterRel), 'trick', key, `${n}.m4s`)) return null;
  const row = await one<any>(
    `SELECT p.dash FROM vod_iframe_playlists p JOIN vod_assets v ON v.id = p.vod_asset_id
      WHERE p.vod_asset_id = $1 AND p.source IS NOT DISTINCT FROM v.master_key AND p.dash->>'key' = $2`, [assetId, key]);
  const t = row?.dash as DashTrick | undefined;
  const e = t?.entries?.[n - 1];
  if (!t || !e) return null;
  const range = await readClipsRange(posix.join(posix.dirname(masterRel), e.uri), e.start, e.end);
  return range ? keyframeFragment(range, t.trackId, e.dur, t.ivSize) : null;
}

/**
 * The I-frame playlist at a path under /clips (<variant>.iframes.m3u8
 * beside an asset's media playlist), or null (switch off, not made, or no such
 * rendition): the route answers 404.
 */
export async function iframePlaylistForPath(assetId: string, rel: string): Promise<string | null> {
  if (!(await trickPlayOnCached(assetId))) return null;
  const a = await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [assetId]);
  const masterRel = clipsPathOfMaster(a?.master_key);
  if (!masterRel) return null;
  const relFromMaster = posix.relative(posix.dirname(masterRel), posix.normalize(rel));
  if (relFromMaster.startsWith('..')) return null;
  const rows = await query<any>(
    `SELECT p.variant_uri, p.playlist FROM vod_iframe_playlists p JOIN vod_assets v ON v.id = p.vod_asset_id
      WHERE p.vod_asset_id = $1 AND p.source IS NOT DISTINCT FROM v.master_key`, [assetId]);
  const hit = rows.find((r) => iframeUriFor(r.variant_uri) === relFromMaster);
  return hit ? hit.playlist : null;
}
