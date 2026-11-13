// ============================================================================
//  THE FULL-RECORDING TITLE PLAYS (build queue 2.3c-4, first piece).
//
//  Publish full VOD (POST /api/recordings/:id/publish) and an event's
//  automatic replay (clips.ts deriveEventVod) made a title whose `master_key`
//  was the recording's own key: `channel/<id>/<day>` or `event/<id>`. That is
//  the layout from before runs existed, and nothing writes it: on the Mac the
//  origin is <origin>/<id>/runs/<runId>/, on AWS s3://<bucket>/<kind>/<id>/
//  runs/<runId>/ (2.2). So the title said "ready", was published by its rules,
//  and played nothing anywhere.
//
//  This writes the title its own playlists, beside a clip's under /clips:
//
//    /clips/<asset>/master.m3u8   the master: the video variant with the audio
//                                 group, or the audio alone for a station
//    /clips/<asset>/video.m3u8    VOD playlists over the recording's segments,
//    /clips/<asset>/audio.m3u8    a discontinuity and the run's own init
//                                 between runs
//
//  No media is copied: the playlists point at the segments the recording
//  already holds, so a day's replay costs three small text files, not a second
//  copy of the day (the cost rule, 27 Oct). Being under /clips/<asset>/ the
//  existing route serves them with the title's skip markers, captions and
//  trick-play, and on AWS reads the bucket copy from any task (clipsStore.ts).
//
//  WHERE THE SEGMENTS ARE
//    The disk first: the Mac, or a task that still holds the run. The same
//    range playlists the recording page plays (localRecordingIndex.ts), so the
//    segments are /origin/<id>/runs/... and carry measured durations and
//    PROGRAM-DATE-TIME.
//    Then the bucket, when recordings live there: every run that started
//    inside the recording's window (s3RecordingSource.ts, the thumbnailer's
//    rule), the recording's top rendition and `audio`, addressed through the
//    CDN (<cdn>/<kind>/<id>/runs/<runId>/<rendition>/seg_N.m4s), which serves
//    the run folders the stable playlists already point into.
//
//  Nothing found (a recording with no media, as in a test database): null, and
//  the caller keeps the title as it was.
// ============================================================================
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config';
import { rangeMasterPlaylist, rangeMediaPlaylist } from '../localRecordingIndex';
import { bucketRecordings, runsApi } from './s3Runs';
import { buildRecordingSource, type RecordingLike } from './s3RecordingSource';
import { clipsInBucket } from './clipsStore';

export interface FullRecordingPackage {
  master: string;
  video: string | null;
  audio: string | null;
  /** Where the segments were found. */
  from: 'disk' | 'bucket';
}

const cdnBase = () => String(config.aws.cdnBaseUrl ?? '').replace(/\/$/, '');

/** The title's playlists over the recording, or null when no segment is found. */
export async function buildFullRecordingPackage(rec: RecordingLike, opts: { now?: number; segmentSeconds?: number } = {}): Promise<FullRecordingPackage | null> {
  const streamId = rec.channel_id ?? rec.event_id;
  if (!streamId) return null;
  const fromMs = Number(rec.start_epoch_ms);
  const toMs = rec.end_epoch_ms != null ? Number(rec.end_epoch_ms) : (opts.now ?? Date.now());
  let from: 'disk' | 'bucket' = 'disk';
  let video = rangeMediaPlaylist(streamId, 'video', fromMs, toMs);
  let audio = rangeMediaPlaylist(streamId, 'audio', fromMs, toMs);
  if (!video && !audio && bucketRecordings()) {
    from = 'bucket';
    const base = cdnBase();
    const segmentUri = (_bucket: string, key: string) => `${base}/${key}`;
    const top = rec.hi_res_rendition && rec.hi_res_rendition !== 'audio' ? rec.hi_res_rendition : null;
    const o = { now: opts.now, segmentSeconds: opts.segmentSeconds, segmentUri };
    video = top ? (await buildRecordingSource(rec, { ...o, rendition: top }))?.text ?? null : null;
    audio = (await buildRecordingSource(rec, { ...o, rendition: 'audio' }))?.text ?? null;
  }
  if (!video && !audio) return null;
  // Relative names: the master and its media playlists sit in one folder.
  const master = rangeMasterPlaylist(streamId, !!audio, video ? 'video.m3u8' : null, 'audio.m3u8');
  return { master, video, audio, from };
}

/** The title's master under /clips (what `master_key` holds for a clip too). */
export function fullRecordingMasterKey(assetId: string): string {
  return `/clips/${assetId}/master.m3u8`;
}

/**
 * Build and keep the title's playlists: on this task's disk under CLIPS_DIR,
 * and in the bucket under clips/<asset>/ when clips go there, so any task
 * serves them. Returns the master_key to store, or null when there is nothing
 * to point at.
 */
export async function writeFullRecordingPackage(assetId: string, rec: RecordingLike, opts: { now?: number; segmentSeconds?: number } = {}): Promise<{ masterKey: string; from: 'disk' | 'bucket'; files: string[] } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return null;
  const pkg = await buildFullRecordingPackage(rec, opts);
  if (!pkg) return null;
  const files: [string, string][] = [['master.m3u8', pkg.master]];
  if (pkg.video) files.push(['video.m3u8', pkg.video]);
  if (pkg.audio) files.push(['audio.m3u8', pkg.audio]);
  const dir = join(config.clips.dir, assetId);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of files) await writeFile(join(dir, name), text);
  if (clipsInBucket() && config.aws.s3Bucket) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const api = await runsApi();
    for (const [name, text] of files) {
      await api.send(new PutObjectCommand({
        Bucket: config.aws.s3Bucket, Key: `clips/${assetId}/${name}`, Body: text,
        ContentType: 'application/vnd.apple.mpegurl',
      }));
    }
  }
  return { masterKey: fullRecordingMasterKey(assetId), from: pkg.from, files: files.map(([n]) => n) };
}

/**
 * Give a just-made full-recording title its playlists and point it at them.
 * Never throws: a title that cannot be given playlists keeps what it had.
 */
export async function attachFullRecordingPackage(assetId: string, rec: RecordingLike): Promise<string | null> {
  try {
    const out = await writeFullRecordingPackage(assetId, rec);
    if (!out) {
      console.warn('full recording title', assetId, 'has no playlists: no segments found for recording', rec.id);
      return null;
    }
    const { query } = await import('../../db');
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [assetId, out.masterKey]);
    return out.masterKey;
  } catch (e) {
    console.error('full recording playlists failed for title', assetId, e);
    return null;
  }
}
