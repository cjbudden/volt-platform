// ============================================================================
//  TRICK-PLAY FOR ON-DEMAND ASSETS (build queue 3.2b): which assets have it,
//  making their I-frame playlists, and serving them. iframes.ts is the pure
//  part.
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
import { posix } from 'node:path';
import { one, query } from '../../db';
import { clipsPathOfMaster, readClipsFile } from '../companions/serve';
import { readInit } from '../frames/fmp4';
import { buildIframePlaylist, iframeUriFor, keyframeRanges, mediaSegments, videoVariants, withIframeStreams, type IframeStream } from './iframes';

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
    const init = readInit((await readClipsFile(posix.join(dir, mapUri))) ?? Buffer.alloc(0));
    if (!init || !init.isVideo) { notes.push(`${v.uri}: no video track`); continue; }
    const withKeys = [];
    for (const s of segs) {
      const b = await readClipsFile(posix.join(dir, s.uri));
      if (!b) throw new Error(`missing media file ${posix.join(dir, s.uri)}`);
      withKeys.push({ ...s, keyframes: keyframeRanges(b, init) });
    }
    const pl = buildIframePlaylist(withKeys, init.timescale);
    if (!pl) { notes.push(`${v.uri}: no keyframes found`); continue; }
    await query(
      `INSERT INTO vod_iframe_playlists (vod_asset_id, variant_uri, playlist, bandwidth, average_bandwidth, resolution, codecs, entries, source, built_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (vod_asset_id, variant_uri) DO UPDATE SET playlist = EXCLUDED.playlist, bandwidth = EXCLUDED.bandwidth,
         average_bandwidth = EXCLUDED.average_bandwidth, resolution = EXCLUDED.resolution, codecs = EXCLUDED.codecs,
         entries = EXCLUDED.entries, source = EXCLUDED.source, built_at = EXCLUDED.built_at`,
      [assetId, v.uri, pl.text, pl.bandwidth, pl.averageBandwidth, v.resolution, v.codecs, pl.entries, a.master_key]);
    made++;
  }
  // Renditions the master no longer lists (a re-encode with another ladder).
  await query(`DELETE FROM vod_iframe_playlists WHERE vod_asset_id = $1 AND NOT (variant_uri = ANY($2::text[]))`, [assetId, variants.map((v) => v.uri)]);
  try { (await import('../../scale/cache')).invalidateTag(`asset:${assetId}`); } catch { /* the 60 s cache catches up */ }
  return { state: made ? 'ready' : 'none', note: notes.length ? notes.join('; ') : null, renditions: made };
}

/** The stored I-frame streams of an asset made from its current master. */
async function storedStreams(assetId: string): Promise<{ streams: IframeStream[]; stale: boolean }> {
  const rows = await query<any>(
    `SELECT p.variant_uri, p.bandwidth, p.average_bandwidth, p.resolution, p.codecs, p.source IS NOT DISTINCT FROM v.master_key AS current
       FROM vod_iframe_playlists p JOIN vod_assets v ON v.id = p.vod_asset_id WHERE p.vod_asset_id = $1 ORDER BY p.bandwidth`, [assetId]);
  const current = rows.filter((r) => r.current);
  return {
    streams: current.map((r) => ({ variantUri: r.variant_uri, bandwidth: r.bandwidth, averageBandwidth: r.average_bandwidth, resolution: r.resolution, codecs: r.codecs })),
    stale: rows.length > current.length || !rows.length,
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
export async function withTrickPlay(master: string, assetId: string): Promise<string> {
  try {
    if (!/#EXT-X-STREAM-INF/.test(master)) return master;
    if (!(await trickPlayOnCached(assetId))) return master;
    const { streams, stale } = await storedStreams(assetId);
    if (stale) void queueTrickPlay(assetId);
    return withIframeStreams(master, streams);
  } catch (e) {
    console.warn(`[trickplay] ${assetId}: master served without I-frame streams`, e);
    return master;
  }
}

/**
 * The I-frame playlist at a path under /clips (<variant dir>/iframes.m3u8
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
