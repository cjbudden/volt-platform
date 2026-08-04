/**
 * vod-extractor.ts
 * ---------------------------------------------------------------------------
 * Volt Streaming — Live Events & Channels Manager
 * Live-to-VOD extraction for live streams.
 *
 * Because we control the segment naming convention and write every segment to
 * S3 as it is produced, S3 becomes a TIME-ADDRESSABLE archive. This module:
 *
 *   1. resolveRange()      map [startTime, endTime] -> ordered segment list
 *                          (snapped to chunk boundaries; discontinuity-aware)
 *   2. buildVodManifest()  write a VOD HLS/DASH manifest over that subrange
 *                          -> ZERO media processing (just a text playlist)
 *   3. exportMp4()         stream-copy remux of the subrange to a flat MP4
 *                          -> cheap FFmpeg `-c copy`, only on explicit export
 *
 * No AWS media services (MediaConvert/MediaLive) are in this path — the work
 * runs on compute we already own, so the margin stays with us.
 *
 * Reference implementation: AWS/S3 and DB access are behind small interfaces so
 * the storage backend (RDS row-per-segment, or an S3 index object) is pluggable.
 * ---------------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ===========================================================================
// Naming convention (we own it)
// ---------------------------------------------------------------------------
// Media segment:
//   live/{streamId}/{renditionId}/{yyyy}/{mm}/{dd}/{startEpochMs}-{seq}.m4s
// Init (fMP4/CMAF) segment, one per rendition:
//   live/{streamId}/{renditionId}/init.mp4
//
// Embedding startEpochMs in the key means the key itself is self-describing,
// and the DVR index (below) lets us resolve a wall-clock range without probing.
// ===========================================================================

export interface SegmentRecord {
  seq: number;            // monotonic sequence within the stream
  s3Key: string;          // object key of the media segment
  startEpochMs: number;   // wall-clock start (from EXT-X-PROGRAM-DATE-TIME / PTS)
  durationMs: number;     // actual segment duration
  discontinuity?: boolean;// true if a timeline break precedes this segment
}

/** DVR index: append a row as each segment lands; query by time range.
 *  Back this with an RDS table (recommended) or an append-only S3 index object. */
export interface SegmentIndex {
  /** All segments for a stream+rendition that overlap [fromMs, toMs], ordered by seq. */
  query(streamId: string, renditionId: string, fromMs: number, toMs: number): Promise<SegmentRecord[]>;
  /** Init segment key for a rendition. */
  initKey(streamId: string, renditionId: string): string;
}

export interface Rendition {
  id: string;             // e.g. "1080p", "720p"
  bandwidthBps: number;   // for the HLS master STREAM-INF
  width: number;
  height: number;
  codecs: string;         // e.g. "avc1.640028,mp4a.40.2"
}

export interface ResolvedRange {
  streamId: string;
  segments: SegmentRecord[];   // [] if nothing in range
  startEpochMs: number;        // actual (snapped) start = first segment start
  endEpochMs: number;          // actual (snapped) end = last segment end
  requestedStartMs: number;
  requestedEndMs: number;
  durationMs: number;
}

const CDN_BASE = process.env.CDN_BASE_URL ?? 'https://cdn.example.com';

/** A single VOD asset is capped in length (default 12h). Configurable per
 *  account/group so limits can be sold as part of the plan. Once the user picks
 *  a start time on the slider, the end is bounded to start + this. */
export const DEFAULT_MAX_ASSET_MS = 12 * 60 * 60 * 1000;

export function assertWithinMax(requestedStartMs: number, requestedEndMs: number, maxMs: number): void {
  if (Number.isNaN(requestedStartMs) || Number.isNaN(requestedEndMs)) {
    throw new RangeError('startTime and endTime must be valid ISO timestamps');
  }
  if (requestedEndMs <= requestedStartMs) {
    throw new RangeError('endTime must be after startTime');
  }
  if (requestedEndMs - requestedStartMs > maxMs) {
    throw new RangeError(`Requested range exceeds the ${Math.round(maxMs / 3_600_000)}h maximum for a single asset`);
  }
}

// ===========================================================================
// 1. Resolve a time range to a chunk-aligned segment list
// ===========================================================================
export async function resolveRange(
  index: SegmentIndex,
  streamId: string,
  renditionId: string,
  requestedStartMs: number,
  requestedEndMs: number,
): Promise<ResolvedRange> {
  if (requestedEndMs <= requestedStartMs) {
    throw new Error('endTime must be after startTime');
  }

  const raw = await index.query(streamId, renditionId, requestedStartMs, requestedEndMs);

  // Keep any segment that overlaps the requested window. Because cuts land on
  // chunk boundaries, this is a pure selection — no re-encode needed. Trims are
  // therefore accurate to segment length (e.g. ~2-4s), not frame-accurate.
  const segments = raw
    .filter(s => s.startEpochMs + s.durationMs > requestedStartMs && s.startEpochMs < requestedEndMs)
    .sort((a, b) => a.seq - b.seq);

  const startEpochMs = segments.length ? segments[0].startEpochMs : requestedStartMs;
  const lastSeg = segments[segments.length - 1];
  const endEpochMs = lastSeg ? lastSeg.startEpochMs + lastSeg.durationMs : requestedEndMs;

  return {
    streamId,
    segments,
    startEpochMs,
    endEpochMs,
    requestedStartMs,
    requestedEndMs,
    durationMs: Math.max(0, endEpochMs - startEpochMs),
  };
}

// ===========================================================================
// 2. Build a VOD manifest over the subrange (no media processing)
// ===========================================================================

/** Per-rendition VOD media playlist (fMP4/CMAF). */
export function buildHlsMediaPlaylist(index: SegmentIndex, streamId: string, range: ResolvedRange, renditionId: string): string {
  const targetDur = Math.ceil(Math.max(1, ...range.segments.map(s => s.durationMs / 1000)));
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${targetDur}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${CDN_BASE}/${index.initKey(streamId, renditionId)}"`,
  ];

  let prevSeq: number | null = null;
  for (const seg of range.segments) {
    // Insert a discontinuity if the segment is flagged, or if the sequence
    // isn't contiguous (an encoder restart / Spot failover happened here).
    if (seg.discontinuity || (prevSeq !== null && seg.seq !== prevSeq + 1)) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(seg.startEpochMs).toISOString()}`);
    lines.push(`#EXTINF:${(seg.durationMs / 1000).toFixed(3)},`);
    lines.push(`${CDN_BASE}/${seg.s3Key}`);
    prevSeq = seg.seq;
  }

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** HLS master playlist tying the per-rendition VOD playlists together (ABR). */
export function buildHlsMaster(renditions: Rendition[], mediaPlaylistUrlFor: (r: Rendition) => string): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const r of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidthBps},RESOLUTION=${r.width}x${r.height},CODECS="${r.codecs}"`);
    lines.push(mediaPlaylistUrlFor(r));
  }
  return lines.join('\n') + '\n';
}

export interface VodAsset {
  vodId: string;
  masterKey: string;
  masterUrl: string;
  startEpochMs: number;
  endEpochMs: number;
  durationMs: number;
}

/**
 * Create a VOD asset (HLS master + per-rendition media playlists) over the
 * requested window. Pure manifest generation — the media never moves, so this
 * is effectively free and returns an immediately playable URL.
 */
export async function buildVodManifest(
  s3: S3Client,
  bucket: string,
  index: SegmentIndex,
  streamId: string,
  renditions: Rendition[],
  vodId: string,
  requestedStartMs: number,
  requestedEndMs: number,
): Promise<VodAsset> {
  const prefix = `vod/${streamId}/${vodId}`;
  let master: ResolvedRange | null = null;

  for (const r of renditions) {
    const range = await resolveRange(index, streamId, r.id, requestedStartMs, requestedEndMs);
    if (!range.segments.length) continue;
    if (!master) master = range;

    const media = buildHlsMediaPlaylist(index, streamId, range, r.id);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}/${r.id}.m3u8`,
      Body: media,
      ContentType: 'application/vnd.apple.mpegurl',
      CacheControl: 'public, max-age=31536000, immutable', // VOD manifests are immutable
    }));
  }

  if (!master) throw new Error('No segments found in the requested time range');

  const masterBody = buildHlsMaster(renditions, r => `${r.id}.m3u8`);
  const masterKey = `${prefix}/master.m3u8`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: masterKey,
    Body: masterBody,
    ContentType: 'application/vnd.apple.mpegurl',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return {
    vodId,
    masterKey,
    masterUrl: `${CDN_BASE}/${masterKey}`,
    startEpochMs: master.startEpochMs,
    endEpochMs: master.endEpochMs,
    durationMs: master.durationMs,
  };
}

// ===========================================================================
// 3. Export a fixed MP4 (stream-copy remux — no re-encode)
// ===========================================================================

/**
 * Remux the VOD manifest to a single MP4. Runs `ffmpeg -c copy` (container
 * flip only, no transcode) against the VOD master we already built, so it is
 * cheap CPU work on our own box — no MediaConvert. `+faststart` moves the moov
 * atom to the front for progressive download.
 *
 * Frame accuracy: cuts are chunk-aligned. For a frame-accurate export you would
 * re-encode only the two boundary segments — an optional "precise" mode.
 */
export function exportMp4(vodMasterUrl: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', vodMasterUrl,
      '-map', '0:v:0', '-map', '0:a:0?', // highest variant video + audio if present
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', outputPath,
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  });
}

// ===========================================================================
// API surface (Express handlers — illustrative)
// ---------------------------------------------------------------------------
//   POST /api/streams/:id/vod            { startTime, endTime }  -> playable URL (fast)
//   POST /api/streams/:id/vod/:vodId/export                      -> MP4 download URL (cheap job)
//   GET  /api/streams/:id/segments?from=&to=                     -> preview resolvable range
// ===========================================================================
export interface Deps {
  s3: S3Client;
  bucket: string;
  index: SegmentIndex;
  renditionsFor(streamId: string): Promise<Rendition[]>;
  newVodId(): string;
  /** Per-stream limits (max asset length etc.); defaults to 12h if omitted. */
  limitsFor?(streamId: string): Promise<{ maxAssetMs: number }>;
}

async function maxAssetMsFor(deps: Deps, streamId: string): Promise<number> {
  return deps.limitsFor ? (await deps.limitsFor(streamId)).maxAssetMs : DEFAULT_MAX_ASSET_MS;
}

export function registerVodRoutes(app: any, deps: Deps): void {
  // Create a VOD asset from a time window (manifest only — near-instant).
  app.post('/api/streams/:id/vod', async (req: any, res: any) => {
    try {
      const streamId = req.params.id;
      const startMs = Date.parse(req.body.startTime);
      const endMs = Date.parse(req.body.endTime);
      assertWithinMax(startMs, endMs, await maxAssetMsFor(deps, streamId)); // enforce the 12h cap
      const renditions = await deps.renditionsFor(streamId);
      const vodId = deps.newVodId();
      const asset = await buildVodManifest(deps.s3, deps.bucket, deps.index, streamId, renditions, vodId, startMs, endMs);
      res.status(201).json(asset);
    } catch (err: any) {
      const code = err instanceof RangeError ? 422 : err.message?.includes('No segments') ? 404 : 500;
      res.status(code).json({ error: err.message });
    }
  });

  // On-the-fly preview for the player as the slider moves. Generates the VOD
  // media playlist IN MEMORY and returns it directly — no S3 write, no asset
  // record. The player points at this URL; it re-resolves on each call, so
  // scrubbing is free. Debounce on the client (resolve on slider release).
  app.get('/api/streams/:id/preview.m3u8', async (req: any, res: any) => {
    try {
      const streamId = req.params.id;
      const fromMs = Date.parse(String(req.query.from));
      const toMs = Date.parse(String(req.query.to));
      assertWithinMax(fromMs, toMs, await maxAssetMsFor(deps, streamId));
      const renditions = await deps.renditionsFor(streamId);
      // A single mid-ladder rendition keeps the preview light; full ABR is only
      // materialised when the user commits the asset via POST /vod.
      const rid = String(req.query.rendition ?? renditions[Math.floor(renditions.length / 2)].id);
      const range = await resolveRange(deps.index, streamId, rid, fromMs, toMs);
      if (!range.segments.length) return res.status(404).type('text/plain').send('No segments in range');
      res.status(200)
        .set('Content-Type', 'application/vnd.apple.mpegurl')
        .set('Cache-Control', 'no-store')
        .send(buildHlsMediaPlaylist(deps.index, streamId, range, rid));
    } catch (err: any) {
      res.status(err instanceof RangeError ? 422 : 500).json({ error: err.message });
    }
  });

  // Export an existing VOD asset to a downloadable MP4 (stream-copy remux).
  app.post('/api/streams/:id/vod/:vodId/export', async (req: any, res: any) => {
    try {
      const { id: streamId, vodId } = req.params;
      const masterUrl = `${CDN_BASE}/vod/${streamId}/${vodId}/master.m3u8`;
      const localOut = `/tmp/${vodId}.mp4`;
      await exportMp4(masterUrl, localOut);
      // Upload the MP4 back to S3 for download via CloudFront (streamed in prod).
      const { createReadStream } = await import('node:fs');
      const key = `vod/${streamId}/${vodId}/export.mp4`;
      await deps.s3.send(new PutObjectCommand({
        Bucket: deps.bucket, Key: key, Body: createReadStream(localOut), ContentType: 'video/mp4',
      }));
      res.status(201).json({ downloadUrl: `${CDN_BASE}/${key}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Preview which segments a window resolves to (before committing to a VOD).
  app.get('/api/streams/:id/segments', async (req: any, res: any) => {
    try {
      const streamId = req.params.id;
      const fromMs = Date.parse(String(req.query.from));
      const toMs = Date.parse(String(req.query.to));
      assertWithinMax(fromMs, toMs, await maxAssetMsFor(deps, streamId));
      const renditions = await deps.renditionsFor(streamId);
      const range = await resolveRange(deps.index, streamId, renditions[0].id, fromMs, toMs);
      res.json({
        count: range.segments.length,
        snappedStart: new Date(range.startEpochMs).toISOString(),
        snappedEnd: new Date(range.endEpochMs).toISOString(),
        durationSec: Math.round(range.durationMs / 1000),
        maxAssetHours: Math.round((await maxAssetMsFor(deps, streamId)) / 3_600_000),
      });
    } catch (err: any) {
      res.status(err instanceof RangeError ? 422 : 500).json({ error: err.message });
    }
  });
}
