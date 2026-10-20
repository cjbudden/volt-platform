// ============================================================================
//  WHAT A VIEWER OF A FAST CHANNEL IS GIVEN.
//
//  Called by the public /live redirect and the player's play gate
//  (modules/publicLive.ts resolveLiveManifest) for a channel that is public.
//
//    not a FAST channel             null (the live path carries on)
//    playout not heartbeating       503 no_valid_content, never a dead manifest
//    ads stitched, HLS              a NEW viewer session on the stitcher
//                                   (/fast/<id>/s/<session>/master.m3u8), marked
//                                   perViewer so no cache shares it
//    otherwise                      the channel's own playlists (CDN in production)
//
//  DASH viewers of a stitched channel get the channel's own MPD, with its
//  house-spot breaks: the stitcher is HLS only for now.
// ============================================================================
import { randomBytes } from 'node:crypto';
import { one } from '../../db';
import { config } from '../../config';
import { channelPlaylistUrl, fastConfig } from './media';
import { playoutFresh } from './playoutRunner';

const kindCache = new Map<string, { at: number; playlist: boolean; stitched: boolean }>();

async function kindOf(id: string) {
  const hit = kindCache.get(id);
  if (hit && Date.now() - hit.at < 5000) return hit;
  const r = await one<any>(
    `SELECT c.origin, COALESCE(a.mode, 'off') AS mode FROM channels c LEFT JOIN channel_ads a ON a.channel_id = c.id WHERE c.id = $1`, [id]).catch(() => null);
  const v = { at: Date.now(), playlist: r?.origin === 'playlist', stitched: r?.mode === 'stitched' };
  kindCache.set(id, v);
  return v;
}

export async function fastManifest(id: string, file: 'master.m3u8' | 'manifest.mpd'):
  Promise<null | { ok: true; url: string; perViewer?: boolean } | { ok: false; status: 503; reason: string }> {
  const k = await kindOf(id);
  if (!k.playlist) return null;
  if (!(await playoutFresh(id))) return { ok: false, status: 503, reason: 'no_valid_content' };
  if (k.stitched && file === 'master.m3u8') {
    const session = randomBytes(12).toString('base64url');
    const base = fastConfig.cdn ? config.publicBaseUrl.replace(/\/$/, '') : '';
    return { ok: true, url: `${base}/fast/${id}/s/${session}/master.m3u8`, perViewer: true };
  }
  return { ok: true, url: channelPlaylistUrl(id, file) };
}
