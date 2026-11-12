// ============================================================================
//  SKIP MARKERS IN THE BUCKET'S PLAYLISTS (build queue 2.1a-2b-6).
//
//  Intro, recap and credits markers are written into an asset's playlists as
//  a player asks for them, by the API's /clips route (vodMarkers.ts
//  annotateHls / annotateMpd, wired in server.ts). On an S3 deployment an
//  encode's master_key is the bucket key vod/<id>/master.m3u8 and players
//  fetch it, its media playlists and its MPD from the CDN, so that route is
//  never asked and viewers got no Skip button.
//
//  Same choice as the caption tracks (companions/bucketTracks.ts): write the
//  markers into the bucket copy at each change rather than answer playlists
//  through the API, so every playlist request stays on the CDN. Markers change
//  rarely (detection after a build, or a person moving one) while playlists
//  are fetched on every play. The cost is the playlists' 60 s max-age: a moved
//  marker reaches viewers within a minute.
//
//  What is written, in place, with the same annotation the /clips route uses:
//    every media playlist the master names (variants and audio renditions):
//      EXT-X-DATERANGE per active marker, plus the PROGRAM-DATE-TIME a
//      DATERANGE needs; removing the last marker leaves the PDT (harmless)
//    manifest.mpd: an EventStream per Period
//  The master carries no markers (a DATERANGE belongs in a media playlist),
//  and caption and I-frame playlists are left alone. Suggested markers stay
//  out, as on /clips. A repackaged title's files one folder down are the ones
//  written (bucketBaseOf).
//
//  Runs after every marker set, accept and delete, after detection writes
//  markers (for each asset it wrote), and after an encode lands in the bucket
//  (its new playlists have none). Anything not an encode in the bucket (the
//  Mac, clips) is left alone: /clips serves those with their markers already.
//  FAILS OPEN: a failure is logged and reported, never thrown at the caller.
// ============================================================================
import { one, query } from '../db';
import { config } from '../config';

const PLAYLIST_CACHE = 'public, max-age=60';

export interface MarkerSyncResult { written: string[]; skipped?: string; error?: string }

/**
 * The media playlists a master names, as bucket keys under `base`. Relative
 * URIs only: anything absolute, outside the asset's folder, a caption track or
 * an I-frame playlist is left out.
 */
export function mediaPlaylistKeys(master: string, base: string): string[] {
  const uris: string[] = [];
  const lines = master.split('\n').map((l) => l.trim());
  lines.forEach((l, i) => {
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (next) uris.push(next);
    } else if (l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l)) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) uris.push(m[1]);
    }
  });
  const out = new Set<string>();
  for (const u of uris) {
    if (/^[a-z][a-z0-9+.-]*:|^\//i.test(u)) continue;          // absolute: not ours to write
    const path = u.split(/[?#]/)[0];
    if (!path.endsWith('.m3u8') || path.includes('.iframes.') || path.startsWith('subs/')) continue;
    const parts: string[] = [];
    let bad = false;
    for (const p of path.split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') { if (!parts.length) { bad = true; break; } parts.pop(); continue; }
      parts.push(p);
    }
    if (bad || !parts.length) continue;
    out.add(`${base}/${parts.join('/')}`);
  }
  return [...out];
}

async function put(key: string, body: string, type: string) {
  const { mediaS3Client } = await import('./media/s3Driver');
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  await (await mediaS3Client(config.aws.region)).send(new PutObjectCommand({
    Bucket: config.aws.s3Bucket, Key: key, Body: Buffer.from(body, 'utf8'), ContentType: type, CacheControl: PLAYLIST_CACHE,
  }));
}

/** Bring the bucket copy of an encode's playlists in line with its skip markers. */
export async function syncBucketMarkers(assetId: string): Promise<MarkerSyncResult> {
  const { onAssetChain } = await import('./companions/bucketTracks');
  return onAssetChain(assetId, () => doSync(assetId));
}

async function doSync(assetId: string): Promise<MarkerSyncResult> {
  const out: MarkerSyncResult = { written: [] };
  try {
    const a = await one<any>(`SELECT id, master_key, start_epoch_ms FROM vod_assets WHERE id = $1`, [assetId]);
    const { bucketBaseOf } = await import('./companions/bucketTracks');
    const base = a ? bucketBaseOf(a.id, a.master_key) : null;
    if (!base) return { ...out, skipped: 'not an encode in the bucket' };
    const { readObjectText } = await import('./media/clipsStore');
    const master = await readObjectText(`${base}/master.m3u8`);
    if (master == null) return { ...out, skipped: 'the bucket has no master yet' };
    // Read fresh, not through listMarkers' cache: this runs right after an edit.
    const { annotateHls, annotateMpd, anchorFor } = await import('./vodMarkers');
    const markers = (await query<any>(`SELECT kind, start_ms, end_ms, status FROM vod_markers WHERE vod_asset_id = $1 ORDER BY start_ms`, [a.id]))
      .map((r) => ({ kind: r.kind, startMs: Number(r.start_ms), endMs: Number(r.end_ms), status: r.status, source: 'auto', confidence: null, detail: {}, updatedAt: '' }) as any);
    const anchor = anchorFor(a);
    for (const key of mediaPlaylistKeys(master, base)) {
      const text = await readObjectText(key);
      if (text == null) continue;
      const next = annotateHls(text, markers, anchor, a.id);
      if (next !== text) { await put(key, next, 'application/vnd.apple.mpegurl'); out.written.push(key); }
    }
    const mpd = await readObjectText(`${base}/manifest.mpd`);
    if (mpd != null) {
      const next = annotateMpd(mpd, markers, a.id);
      if (next !== mpd) { await put(`${base}/manifest.mpd`, next, 'application/dash+xml'); out.written.push(`${base}/manifest.mpd`); }
    }
    return out;
  } catch (e: any) {
    console.warn(`[markers] ${assetId}: bucket playlists not updated`, e);
    return { ...out, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** For the marker routes and detection: never fails the caller. */
export async function syncBucketMarkersQuietly(assetIds: Iterable<string>): Promise<void> {
  for (const id of new Set(assetIds)) {
    try { await syncBucketMarkers(id); } catch { /* fails open */ }
  }
}
