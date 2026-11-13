// ============================================================================
//  FRAME INDEXES AND EXACT STILLS, ON DISK AND IN THE DATABASE (build queue
//  3.2 (a) and (b)). The pure parts are frameIndex.ts, fmp4.ts and
//  exactFrame.ts; this file finds the media, keeps the results and serves them.
//
//  ON-DEMAND ASSETS get a stored index (asset_frame_indexes), made from the
//  rendition players get, after every build (clip.extract, vod.encode) and by
//  a sweep for media made before this existed. Frame N needs the frame counts
//  of every segment before it, so working that out per request would mean
//  reading every segment of the asset; stored, it is one row and a binary
//  search.
//
//  RECORDINGS are not indexed into a table. A recording is a window on a
//  stream's capture runs, and the per-run segment scan
//  (localRecordingIndex.ts) already places every segment on the wall clock from
//  its tfdt. The frame inside a segment comes from that segment's own fragment
//  boxes, read when asked. A 24x7 channel writes 21,600 segments a day, so a
//  second, stored index of them would cost a database write per segment and
//  buy nothing the scan does not already give (the cost rule, 27 Oct).
//  On AWS the runs are in the bucket, not on this disk: bucket.ts finds the
//  segment there on the clips' placement (build queue 2.3c-11), and from the
//  segment on everything is the same.
//
//  STILLS are JPEGs in the image store under derived/<account>/frames/, one
//  per frame asked for. Each is recorded in frame_stills with the bucket and
//  folder it went to, and each folder is a media object with its full address,
//  so the retention sweep and the TTL prune both find them (folders.ts says
//  which rules apply). An asset's stills sit under its index build time, so a
//  re-encode never serves a frame of the old file.
// ============================================================================
import { posix, join } from 'node:path';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { one, query } from '../../db';
import { imageStore } from '../imageStore';
import { clipsPathOfMaster, readClipsFile } from '../companions/serve';
import { listRuns, pickRenditions, scanRun, type LocalSegment } from '../localRecordingIndex';
import { originBaseFor } from '../liveOrigin';
import { readFragments, readInit } from './fmp4';
import {
  buildIndex, locateFrame, msOfFrame, parseMediaPlaylist, parseRate, pickVideoVariant, rateFromDurations,
  type FrameIndex, type Located, type Rate, type SegmentFrames,
} from './frameIndex';
import { extractFrame, extractFrameAt, FrameError, probeTsSegment } from './exactFrame';
import { frameFolderObject, refreshFolderBytes, retireFrameFolders, type FrameFolder } from './folders';
import { resolvesFromBucket } from '../clips/resolveBucket';
import { bucketSegmentAt, readBucketSegment, type BucketSegment } from './bucket';

// ------------------------------------------------------------- asset index

export interface StoredIndex {
  state: 'ready' | 'none' | 'failed';
  error: string | null;
  builtAt: string;
  version: string;
  index: FrameIndex | null;
}

/**
 * Build the index of an asset from the media players get. Writes the row and
 * returns it. An asset with no playable HLS yet, or with no video (radio,
 * podcasts), gets state 'none' and a reason, not a failure.
 */
export async function buildAssetFrameIndex(assetId: string): Promise<StoredIndex> {
  const a = await one<any>(`SELECT id, master_key FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) throw new FrameError(404, 'asset not found');
  let index: FrameIndex | null = null, state: StoredIndex['state'] = 'ready', error: string | null = null;
  try {
    const r = await indexFromMaster(a.master_key);
    if ('none' in r) { state = 'none'; error = r.none; } else index = r.index;
  } catch (e: any) {
    state = 'failed'; error = String(e?.message ?? e).slice(0, 400);
  }
  const row = await one<any>(
    `INSERT INTO asset_frame_indexes (vod_asset_id, state, error, source, rate_num, rate_den, total_frames, duration_ms, index, built_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, clock_timestamp())
     ON CONFLICT (vod_asset_id) DO UPDATE SET state = EXCLUDED.state, error = EXCLUDED.error, source = EXCLUDED.source,
       rate_num = EXCLUDED.rate_num, rate_den = EXCLUDED.rate_den, total_frames = EXCLUDED.total_frames,
       duration_ms = EXCLUDED.duration_ms, index = EXCLUDED.index, built_at = EXCLUDED.built_at
     RETURNING built_at, (extract(epoch from built_at) * 1000)::bigint AS v`,
    [assetId, state, error, a.master_key ?? null, index?.rate.num ?? null, index?.rate.den ?? null,
      index?.totalFrames ?? null, index?.durationMs ?? null, index ? JSON.stringify(index) : null]);
  // The stills of an older build show frames of a file that is no longer
  // there: retire their folders now rather than wait for the TTL.
  await retireFrameFolders({
    vodAssetId: assetId, logicalLike: `frames/assets/${assetId}/%`,
    exceptLogicalKey: assetFolderKey(assetId, String(row.v)), reason: 'frame index rebuilt',
  }).catch((e) => console.warn(`[frames] old stills of ${assetId} not retired`, e));
  return { state, error, builtAt: new Date(row.built_at).toISOString(), version: String(row.v), index };
}

/** The stored index of an asset, or null when none has been made. */
export async function loadAssetFrameIndex(assetId: string): Promise<StoredIndex | null> {
  const r = await one<any>(
    `SELECT state, error, built_at, (extract(epoch from built_at) * 1000)::bigint AS v, index
       FROM asset_frame_indexes WHERE vod_asset_id = $1`, [assetId]);
  if (!r) return null;
  return { state: r.state, error: r.error, builtAt: new Date(r.built_at).toISOString(), version: String(r.v), index: r.index ?? null };
}

async function readRel(rel: string): Promise<Buffer> {
  const b = await readClipsFile(rel);
  if (!b) throw new Error(`missing media file ${rel}`);
  return b;
}

/** Index the video rendition behind a master_key (pure reads; no database). */
export async function indexFromMaster(masterKey: string | null | undefined): Promise<{ index: FrameIndex } | { none: string }> {
  const masterRel = clipsPathOfMaster(masterKey);
  if (!masterRel) return { none: 'no packaged HLS to index yet' };
  const master = (await readRel(masterRel)).toString('utf8');
  const variant = pickVideoVariant(master);
  if (variant == null && !/#EXTINF:/.test(master)) return { none: 'no video rendition (audio only)' };
  const playlistRel = variant ? posix.join(posix.dirname(masterRel), variant) : masterRel;
  const pl = parseMediaPlaylist((await readRel(playlistRel)).toString('utf8'));
  if (!pl.segments.length) return { none: 'the playlist lists no segments' };
  const dir = posix.dirname(playlistRel);
  const playlist = posix.relative(posix.dirname(masterRel), playlistRel) || posix.basename(playlistRel);
  const parts: SegmentFrames[] = [];
  if (pl.init) {
    const init = readInit(await readRel(posix.join(dir, pl.init)));
    if (!init) throw new Error('the init segment has no track');
    if (!init.isVideo) return { none: 'no video rendition (audio only)' };
    const durations: number[] = [];
    for (const s of pl.segments) {
      const f = readFragments(await readRel(posix.join(dir, s.uri)), init);
      if (!f) throw new Error(`segment ${s.uri} has no fragment for the video track`);
      parts.push({ uri: s.uri, frames: f.pts.length, firstPts: f.pts[0] });
      durations.push(...f.durations);
    }
    const rate = rateFromDurations(durations, init.timescale);
    if (!rate) throw new Error('no frame rate in the fragments');
    return { index: buildIndex({ playlist, init: pl.init, container: 'fmp4', timescale: init.timescale, rate, segments: parts }) };
  }
  // MPEG-TS: one ffprobe packet scan per segment (older clips and imports).
  const tmp = await mkdtemp(join(tmpdir(), 'volt-fidx-'));
  try {
    let rate: Rate | null = null, timescale = 90000;
    for (const s of pl.segments) {
      const p = join(tmp, 'seg.ts');
      await writeFile(p, await readRel(posix.join(dir, s.uri)));
      const f = await probeTsSegment(p);
      if (!f.frames) {
        if (parts.length) throw new Error(`segment ${s.uri} has no video`);
        return { none: 'no video rendition (audio only)' };
      }
      rate = rate ?? parseRate(f.rate);
      timescale = f.timescale;
      parts.push({ uri: s.uri, frames: f.frames, firstPts: f.firstPts });
    }
    if (!rate) throw new Error('no frame rate in the segments');
    return { index: buildIndex({ playlist, init: null, container: 'ts', timescale, rate, segments: parts }) };
  } finally { await rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

// ------------------------------------------------------------- stills

const flights = new Map<string, Promise<void>>();

/**
 * Make the still `name` in `folder` once, however many requests arrive for it
 * together. The folder's address is registered as a media object BEFORE the
 * first byte is written, so a crash between the two can only leave a record
 * with nothing in it, never bytes with no record.
 */
async function ensureStill(accountId: string, folder: FrameFolder, name: string, make: () => Promise<Buffer>): Promise<{ key: string; cache: 'cached' | 'made' }> {
  const key = `${folder.key}/${name}`;
  if (await imageStore().exists(key)) return { key, cache: 'cached' };
  let f = flights.get(key);
  if (!f) {
    f = (async () => {
      const jpg = await make();
      const obj = await frameFolderObject(folder);
      await imageStore().put(key, jpg, 'image/jpeg');
      await query(
        `INSERT INTO frame_stills (store_key, account_id, bucket, folder, bytes, media_object_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (store_key) DO UPDATE SET created_at = now(), bucket = EXCLUDED.bucket, folder = EXCLUDED.folder,
           bytes = EXCLUDED.bytes, media_object_id = EXCLUDED.media_object_id`,
        [key, accountId, obj.address.bucket, folder.key, jpg.length, obj.id]);
      await refreshFolderBytes(obj.id);
    })().finally(() => flights.delete(key));
    flights.set(key, f);
  }
  await f;
  return { key, cache: 'made' };
}

export interface AssetStill { key: string; located: Located; index: FrameIndex; cache: 'cached' | 'made' }

/** The still of frame n of an asset, made if needed. */
export async function assetFrameStill(accountId: string, assetId: string, stored: StoredIndex, n: number): Promise<AssetStill> {
  const index = stored.index;
  if (!index) throw new FrameError(409, stored.error ?? 'this asset has no frame index');
  const located = locateFrame(index, n);
  if (!located) throw new FrameError(404, `frame ${n} is outside the asset (0 to ${index.totalFrames - 1})`);
  const a = await one<any>(`SELECT master_key, source_key, policy_snapshot, encode_result FROM vod_assets WHERE id = $1`, [assetId]);
  const masterRel = clipsPathOfMaster(a?.master_key);
  // AN ENCRYPTED TITLE (build queue P4-5): its segments decode to noise
  // without the content key, which Volt does not keep. The frame index
  // itself is fine (it reads box headers, which cbcs leaves in the clear);
  // the picture is read from the original at that frame's time.
  const { packagedOf } = await import('../encodePolicy');
  const encrypted = !!a && packagedOf(a).drm;
  // Owned by the asset alone (no channel), so deleting the asset leaves the
  // folder ownerless and the retention sweep reclaims it.
  const folder: FrameFolder = {
    key: `derived/${accountId}/frames/assets/${assetId}/${stored.version}`,
    logicalKey: assetFolderKey(assetId, stored.version), vodAssetId: assetId,
  };
  const { key, cache } = await ensureStill(accountId, folder, `${n}.jpg`, async () => {
    if (encrypted) {
      const { fetchVodSource } = await import('../media/vodSource');
      const src = await fetchVodSource(a.source_key).catch(() => null);
      if (!src) throw new FrameError(409, 'its files are encrypted (DRM) and its original is not on this server, so no frame can be drawn');
      try { return await extractFrameAt(src.path, msOfFrame(index.rate, n) / 1000); }
      finally { await src.release(); }
    }
    if (!masterRel) throw new FrameError(409, 'the asset has no packaged media any more');
    const dir = posix.dirname(posix.join(posix.dirname(masterRel), index.playlist));
    const seg = await readClipsFile(posix.join(dir, located.segment.uri));
    const init = index.init ? await readClipsFile(posix.join(dir, index.init)) : null;
    if (!seg || (index.init && !init)) throw new FrameError(410, 'the segment holding that frame is no longer stored');
    return extractFrame(init, seg, located.localFrame);
  });
  return { key, located, index, cache };
}

// ------------------------------------------------------------- recordings

export interface StreamFrame {
  runId: string;
  rendition: string;
  seq: number;
  /** Frame inside the segment, presentation order. */
  localFrame: number;
  /** Wall-clock start of that frame. */
  wallMs: number;
  rate: Rate;
  timescale: number;
}

interface SegFrames { init: Buffer; seg: Buffer; pts: number[]; rate: Rate; timescale: number }

async function segmentFrames(streamId: string, s: LocalSegment | BucketSegment): Promise<SegFrames> {
  let init: Buffer | null, seg: Buffer | null;
  if ('src' in s && s.src) ({ init, seg } = await readBucketSegment(s));
  else {
    const dir = join(originBaseFor(streamId), 'runs', s.runId, s.rendition);
    init = await readFile(join(dir, 'init.mp4')).catch(() => null);
    seg = await readFile(join(dir, s.file)).catch(() => null);
  }
  if (!init || !seg) throw new FrameError(410, 'the segment holding that moment is no longer stored');
  const facts = readInit(init);
  const frag = facts ? readFragments(seg, facts) : null;
  if (!facts || !frag) throw new FrameError(422, 'the recording at that moment is not readable frame by frame');
  const rate = rateFromDurations(frag.durations, facts.timescale);
  if (!rate) throw new FrameError(422, 'no frame rate in that segment');
  return { init, seg, pts: frag.pts, rate, timescale: facts.timescale };
}

/** The video segment of a stream covering wall time `ms`, or null in a hole. */
export function streamSegmentAt(streamId: string, ms: number): LocalSegment | null {
  for (const runId of listRuns(streamId)) {
    const video = pickRenditions(streamId, runId).video;
    if (!video) continue;
    const segs = scanRun(streamId, runId, video);
    if (!segs.length || ms < segs[0].startMs || ms >= segs[segs.length - 1].startMs + segs[segs.length - 1].durMs) continue;
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ms < segs[mid].startMs) hi = mid - 1;
      else if (ms >= segs[mid].startMs + segs[mid].durMs) lo = mid + 1;
      else return segs[mid];
    }
  }
  return null;
}

/** The frame of a stream's capture on screen at wall time `ms` (null in a hole). */
export async function streamFrameAt(streamId: string, ms: number): Promise<StreamFrame | null> {
  // The disk when it holds the stream's runs (the Mac), else the bucket (AWS).
  const s = resolvesFromBucket(streamId) ? await bucketSegmentAt(streamId, ms) : streamSegmentAt(streamId, ms);
  if (!s) return null;
  const f = await segmentFrames(streamId, s);
  // The segment's wall-clock start is its first frame; the rest follow by
  // their presentation times (measured, so a dropped or doubled frame in the
  // capture moves the frames after it, as it did on air).
  const at = (k: number) => s.startMs + ((f.pts[k] - f.pts[0]) * 1000) / f.timescale;
  let k = 0;
  while (k + 1 < f.pts.length && at(k + 1) <= ms + 1e-6) k++;
  return { runId: s.runId, rendition: s.rendition, seq: s.seq, localFrame: k, wallMs: at(k), rate: f.rate, timescale: f.timescale };
}

/** The folder a stream's stills of one run and rendition go in. */
async function streamFolder(accountId: string, streamId: string, runId: string, rendition: string): Promise<FrameFolder> {
  // Owned by the stream, like the run it was taken from, so it follows the
  // stream's recording rule and goes with the run (services/media/prune.ts).
  const isChannel = !!(await one(`SELECT 1 FROM channels WHERE id = $1`, [streamId]));
  return {
    key: `derived/${accountId}/frames/streams/${streamId}/${runId}/${rendition}`,
    logicalKey: runFolderKey(runId, rendition),
    channelId: isChannel ? streamId : null, eventId: isChannel ? null : streamId,
  };
}

/**
 * Where a still of a stream's segment is, or would be, kept: the image store
 * key. The timeline filmstrip on AWS (services/thumbs.ts, 2.3c-13) keeps its
 * pictures here rather than in the run folder on the task's disk (a run
 * folder there would make the stream read from the disk).
 */
export const streamStillKey = (accountId: string, streamId: string, runId: string, rendition: string, name: string) =>
  `derived/${accountId}/frames/streams/${streamId}/${runId}/${rendition}/${name}`;

/**
 * A picture of a stream's segment, kept as a frame still: same folder, record,
 * TTL and removal with the run as the exact frames (folders.ts). `make` is
 * called once however many requests ask together.
 */
export async function streamSegmentStill(accountId: string, streamId: string, runId: string, rendition: string, name: string,
  make: () => Promise<Buffer>): Promise<{ key: string; cache: 'cached' | 'made' }> {
  return ensureStill(accountId, await streamFolder(accountId, streamId, runId, rendition), name, make);
}

/** The still of the stream frame `fr` (from streamFrameAt), made if needed. */
export async function streamFrameStill(accountId: string, streamId: string, fr: StreamFrame): Promise<{ key: string; cache: 'cached' | 'made' }> {
  const folder = await streamFolder(accountId, streamId, fr.runId, fr.rendition);
  return ensureStill(accountId, folder, `${fr.seq}-${fr.localFrame}.jpg`, async () => {
    let s: LocalSegment | BucketSegment | null | undefined;
    if (resolvesFromBucket(streamId)) {
      // The lookup that made `fr` kept this segment's window and bytes.
      const b = await bucketSegmentAt(streamId, fr.wallMs);
      s = b && b.runId === fr.runId && b.seq === fr.seq ? b : null;
    } else s = scanRun(streamId, fr.runId, fr.rendition).find((x) => x.seq === fr.seq);
    if (!s) throw new FrameError(410, 'the segment holding that moment is no longer stored');
    const f = await segmentFrames(streamId, s);
    return extractFrame(f.init, f.seg, fr.localFrame);
  });
}

/** Logical keys of frame folders (media_objects.logical_key). */
export const assetFolderKey = (assetId: string, version: string) => `frames/assets/${assetId}/${version}`;
export const runFolderKey = (runId: string, rendition: string) => `frames/run/${runId}/${rendition}`;

// ------------------------------------------------------------- upkeep

/** Remove stills older than the TTL, a batch at a time. Returns how many went. */
export async function pruneFrameStills(ttlDays = Number(process.env.FRAME_STILL_TTL_DAYS ?? 7), batch = 500): Promise<number> {
  const rows = await query<{ store_key: string; media_object_id: string | null }>(
    `SELECT store_key, media_object_id FROM frame_stills WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2`,
    [Math.max(0, ttlDays), batch]);
  const folders = new Set<string>();
  for (const r of rows) {
    await imageStore().delete(r.store_key).catch(() => {});
    await query(`DELETE FROM frame_stills WHERE store_key = $1`, [r.store_key]);
    if (r.media_object_id) folders.add(r.media_object_id);
  }
  for (const id of folders) await refreshFolderBytes(id).catch(() => {});
  return rows.length;
}

/** Assets with packaged media and no index yet, oldest first. */
export async function assetsWithoutFrameIndex(limit = 20): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT v.id FROM vod_assets v
       LEFT JOIN asset_frame_indexes f ON f.vod_asset_id = v.id
      WHERE f.vod_asset_id IS NULL AND v.master_key IS NOT NULL AND v.master_key <> ''
      ORDER BY v.created_at LIMIT $1`, [limit]);
  return rows.map((r) => r.id);
}
