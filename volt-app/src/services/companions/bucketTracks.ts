// ============================================================================
//  CAPTION TRACKS IN THE BUCKET'S PLAYLISTS (build queue 2.1a-2b-4 (b)).
//
//  On an S3 deployment an encode's master_key is the bucket key
//  vod/<id>/master.m3u8 and players fetch it, its variants and its segments
//  from the CDN. The API's /clips playlist route, which writes caption tracks
//  in as it answers (serve.ts withTracks), is never asked, so encodes played
//  on AWS had no subtitle tracks at all.
//
//  WHY WRITE THE TRACKS INTO THE BUCKET, NOT ANSWER MASTERS THROUGH THE API.
//  Tracks change rarely (someone adds, edits or switches off a caption file)
//  while masters are asked for on every play. Writing them in at the change
//  keeps every request on the CDN, as cheap as the rest of the media, and adds
//  no API load or latency per play; answering masters through the API would
//  put a request on the control plane for every viewer start, for every
//  asset, to cover the few that have captions. The cost is a short delay: the
//  CDN may hold the old master for its max-age (60 s, the playlists' own).
//
//  What is written, beside the master like the /clips route serves it:
//    vod/<id>/master.m3u8         the tracks as #EXT-X-MEDIA (or none)
//    vod/<id>/manifest.mpd        a text AdaptationSet per track (or none)
//    vod/<id>/subs/<file>.m3u8    each track's one-segment playlist
//    vod/<id>/subs/<file>.vtt     its WebVTT with X-TIMESTAMP-MAP from the
//                                 encode's own first segment
//    vod/<id>/subs/<file>.dash.vtt  the same cues for DASH (no map)
//  Track files first, playlists last, so a playlist never names a missing file.
//  A disabled or deleted track's three files are removed from the bucket (they
//  are copies; the caption file itself stays in the image store).
//
//  Runs after every add, change and delete of a caption file and after an
//  encode lands in the bucket (a new encode writes a master with no tracks).
//  Anything that is not an encode in the bucket (the Mac, clips, live
//  recordings) is left alone: those are served through /clips already.
//  FAILS OPEN: a failure is logged and reported, never thrown at the caller.
// ============================================================================
import { one, query } from '../../db';
import { config } from '../../config';
import { imageStore } from '../imageStore';
import { withHlsSubtitles, withoutHlsSubtitles, withDashSubtitles, subtitlePlaylist } from './delivery';

const PLAYLIST_CACHE = 'public, max-age=60';

export interface SyncResult { written: string[]; removed: string[]; skipped?: string; error?: string }

/** vod/<id>/ when the asset's master is an encode in the bucket, else null. */
export function bucketBaseOf(assetId: string, masterKey: string | null | undefined): string | null {
  const k = String(masterKey ?? '');
  const m = /^vod\/([0-9a-f-]{36})\/master\.m3u8$/i.exec(k);
  return m && m[1].toLowerCase() === String(assetId).toLowerCase() ? `vod/${m[1]}` : null;
}

async function s3() {
  const { mediaS3Client } = await import('../media/s3Driver');
  return mediaS3Client(config.aws.region);
}

async function put(key: string, body: string, type: string) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new PutObjectCommand({ Bucket: config.aws.s3Bucket, Key: key, Body: Buffer.from(body, 'utf8'), ContentType: type, CacheControl: PLAYLIST_CACHE }));
}

async function remove(key: string) {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await (await s3()).send(new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
}

// One sync at a time per asset in this task, so two quick edits cannot write
// their playlists out of order. Each sync reads the tracks fresh, so the last
// one to run writes the current state.
const chains = new Map<string, Promise<unknown>>();

/**
 * Bring the bucket copy of an encode's playlists in line with its caption
 * tracks. `removed`: ids of caption files just deleted (their rows are gone).
 */
export function syncBucketTracks(assetId: string, opts: { removed?: string[] } = {}): Promise<SyncResult> {
  const prev = chains.get(assetId) ?? Promise.resolve();
  const run = prev.catch(() => null).then(() => doSync(assetId, opts));
  chains.set(assetId, run);
  run.finally(() => { if (chains.get(assetId) === run) chains.delete(assetId); }).catch(() => null);
  return run;
}

async function doSync(assetId: string, opts: { removed?: string[] }): Promise<SyncResult> {
  const out: SyncResult = { written: [], removed: [] };
  try {
    const a = await one<any>(`SELECT id, master_key, duration_ms FROM vod_assets WHERE id = $1`, [assetId]);
    const base = a ? bucketBaseOf(a.id, a.master_key) : null;
    if (!base) return { ...out, skipped: 'not an encode in the bucket' };
    const { readObjectText } = await import('../media/clipsStore');
    const master = await readObjectText(`${base}/master.m3u8`);
    if (master == null) return { ...out, skipped: 'the bucket has no master yet' };
    const mpd = await readObjectText(`${base}/manifest.mpd`);

    const { activeTracks, timestampMapFor } = await import('./serve');
    const tracks = await activeTracks(a.id);
    const keys = new Map((await query<any>(`SELECT id, vtt_key FROM vod_asset_files WHERE asset_id = $1 AND kind = 'captions'`, [a.id]))
      .map((r) => [r.id as string, r.vtt_key as string | null]));
    // The clock is the encode's own first segment, read through the bucket copy.
    const map = tracks.length ? await timestampMapFor(`/${base}/master.m3u8`).catch(() => null) : null;

    const live = new Set<string>();
    for (const t of tracks) {
      const buf = await imageStore().get(keys.get(t.id) ?? '');
      if (!buf) continue;                                    // its WebVTT is missing: leave it out
      const vtt = buf.toString('utf8');
      await put(`${base}/subs/${t.id}.dash.vtt`, vtt, 'text/vtt; charset=utf-8');
      await put(`${base}/subs/${t.id}.vtt`, map ? vtt.replace(/^WEBVTT[^\n]*\n/, (h) => `${h}${map}\n`) : vtt, 'text/vtt; charset=utf-8');
      await put(`${base}/subs/${t.id}.m3u8`, subtitlePlaylist(t.id, Number(a.duration_ms) || 1000), 'application/vnd.apple.mpegurl');
      out.written.push(`${base}/subs/${t.id}.m3u8`, `${base}/subs/${t.id}.vtt`, `${base}/subs/${t.id}.dash.vtt`);
      live.add(t.id);
    }
    const shown = tracks.filter((t) => live.has(t.id));
    await put(`${base}/master.m3u8`, shown.length ? withHlsSubtitles(master, shown) : withoutHlsSubtitles(master), 'application/vnd.apple.mpegurl');
    out.written.push(`${base}/master.m3u8`);
    if (mpd != null) {
      await put(`${base}/manifest.mpd`, withDashSubtitles(mpd, shown, ''), 'application/dash+xml');
      out.written.push(`${base}/manifest.mpd`);
    }
    // Playlists no longer name them: take the copies of switched-off and deleted tracks out.
    const gone = [...new Set([...keys.keys(), ...(opts.removed ?? [])])].filter((id) => !live.has(id));
    for (const id of gone) for (const ext of ['m3u8', 'vtt', 'dash.vtt']) {
      await remove(`${base}/subs/${id}.${ext}`).catch(() => null);
      out.removed.push(`${base}/subs/${id}.${ext}`);
    }
    // The API's /clips route reads the same master: drop its cached tracks too.
    try { (await import('../../scale/cache')).invalidateTag(`asset:${a.id}`); } catch { /* no cache */ }
    return out;
  } catch (e: any) {
    console.warn(`[subs] ${assetId}: bucket playlists not updated`, e);
    return { ...out, error: String(e?.message ?? e).slice(0, 300) };
  }
}
