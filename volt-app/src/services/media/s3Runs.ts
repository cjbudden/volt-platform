// ============================================================================
//  RECORDED RUNS IN THE BUCKET: the retention ladder for recordings on AWS
//  (build queue 2.3).
//
//  On the Mac a stream's runs sit on the control plane's disk
//  (<origin>/<id>/runs/<runId>/<rendition>/) and reconcile.ts registers each
//  one as a media object, so the ladder can cool, archive, restore and delete
//  it. On AWS the encoder is a task of its own and uploads each run under
//  s3://<bucket>/<kind>/<id>/runs/<runId>/ (build queue 2.2); the control
//  plane's disk holds none of it. So the ladder governed nothing there: every
//  recorded segment of every channel stayed in S3 Standard for ever, which is
//  the single largest line on the storage bill of a 24/7 channel.
//
//  This file is the bucket side of the same model:
//
//    BUCKET -> ROWS  each rendition folder of each run is registered as a
//                    media object whose location is that folder as a prefix
//                    (s3://b/channel/x/runs/R/720p/), so the existing S3
//                    driver cools, archives, restores and deletes exactly the
//                    keys under it and nothing beside it.
//    ROWS -> BUCKET  a run that is no longer in the bucket loses its location,
//                    and an object with no copy left is marked deleted.
//
//  What it must never touch: the stream root (the stable playlists and
//  current_run.txt the CDN serves), another run, and the run the pointer names
//  while it is still being written. A run is `writing` while its playlists
//  are still being rewritten, and the sweep does not look at `writing`.
//
//  COST. Listing is billed per thousand keys, and a 24/7 channel writes about
//  130,000 segment keys a day across its renditions. So a closed run is listed
//  in full exactly once, when it closes (for its size); after that only the
//  list of run folders is read, which is one short call per stream. A run
//  still being written is judged by the few playlists at its own root, which
//  the uploader rewrites on every pass. And the whole pass runs at most every
//  few minutes per stream (MEDIA_S3_RECONCILE_MS), not on every tick.
// ============================================================================
import { one, query } from '../../db';
import { config } from '../../config';
import { registerObject, transition, locationsOf, type MediaObject } from './objects';
import { parseS3Uri, STORAGE_CLASS, mediaS3Client, type S3Api } from './s3Driver';
import type { StorageTier } from './storage';
import type { PruneResult } from './prune';
import { CLIP_MARGIN_SEGMENTS } from './prune';

/** A run whose playlists changed this recently is still being written. The
 *  uploader writes every couple of seconds; a slow pass can take a minute. */
const LIVE_WINDOW_MS = () => Number(process.env.MEDIA_S3_LIVE_WINDOW_MS ?? 5 * 60_000);
/** At most one bucket pass per stream this often from the tick. */
const RECONCILE_EVERY_MS = () => Number(process.env.MEDIA_S3_RECONCILE_MS ?? 5 * 60_000);

/** Folders of a run that are not renditions: they go with the run, not on their own. */
const NOT_RENDITIONS = new Set(['thumbs', 'filler', 'subtitles', 'id3', 'captions']);
const SEGMENT = /\/seg_(\d+)\.(m4s|ts|aac|mp4|m4a|vtt)$/;
const RUN_ID = /^[A-Za-z0-9._-]+$/;

let apiOverride: S3Api | null = null;
/** Tests hand in a stand-in S3 client (the same seam setStorageDriver gives the driver). */
export function setS3RunsApi(api: S3Api | null): void { apiOverride = api; }
async function s3(): Promise<S3Api> { return apiOverride ?? mediaS3Client(config.aws.region); }
/** The client this file uses (the stand-in in tests), for the readers of runs (s3RecordingSource.ts). */
export const runsApi = s3;
const sdk = () => import('@aws-sdk/client-s3');

/** True when this deployment's recordings live in the bucket. */
export function bucketRecordings(): boolean {
  return config.mediaStore.driver === 's3' && !!config.aws.s3Bucket;
}

/** s3://<bucket>/<kind>/<id>/ : where the encoder writes (jobConfig.ts `s3.prefix`). */
export function streamRootUri(kind: 'channel' | 'event', id: string): string {
  return `s3://${config.aws.s3Bucket}/${kind}/${id}/`;
}

/** The run's start from its id (encoder.py: %Y%m%dT%H%M%SZ), or null. */
export function runStartMs(runId: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(runId);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Which Volt tier an S3 storage class is. */
export function tierOfClass(cls: string | undefined): StorageTier {
  const hit = (Object.entries(STORAGE_CLASS) as [StorageTier, string][]).find(([, c]) => c === (cls || 'STANDARD'));
  return hit ? hit[0] : 's3_standard';
}

interface Listed { key: string; bytes: number; lastModified: number; storageClass: string }

/** One level under a prefix: the files there and the folders below it. */
export async function listLevel(api: S3Api, bucket: string, prefix: string): Promise<{ files: Listed[]; folders: string[] }> {
  const { ListObjectsV2Command } = await sdk();
  const files: Listed[] = []; const folders: string[] = [];
  let token: string | undefined;
  do {
    const r = await api.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
    for (const o of r.Contents ?? []) files.push(listed(o));
    for (const p of r.CommonPrefixes ?? []) if (p.Prefix) folders.push(p.Prefix);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return { files, folders };
}

/** Every key under a prefix. Used once per closed run, and by the clip-aware prune. */
export async function listAll(api: S3Api, bucket: string, prefix: string): Promise<Listed[]> {
  const { ListObjectsV2Command } = await sdk();
  const out: Listed[] = [];
  let token: string | undefined;
  do {
    const r = await api.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push(listed(o));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function listed(o: any): Listed {
  return { key: o.Key, bytes: Number(o.Size ?? 0), lastModified: o.LastModified ? new Date(o.LastModified).getTime() : 0, storageClass: o.StorageClass ?? 'STANDARD' };
}

/** The run current_run.txt names at the stream root, or null (none, or unreadable). */
export async function pointerRun(api: S3Api, bucket: string, rootKey: string): Promise<string | null> {
  const { GetObjectCommand } = await sdk();
  try {
    const r = await api.send(new GetObjectCommand({ Bucket: bucket, Key: `${rootKey}current_run.txt` }));
    const t = String(await r.Body?.transformToString?.() ?? '').trim();
    return RUN_ID.test(t) && !t.includes('..') ? t : null;
  } catch { return null; }
}

async function deleteKeys(api: S3Api, bucket: string, keys: string[]): Promise<void> {
  const { DeleteObjectsCommand } = await sdk();
  for (let i = 0; i < keys.length; i += 1000) {
    const r = await api.send(new DeleteObjectsCommand({
      Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
    if (r.Errors?.length) {
      const e = r.Errors[0];
      throw new Error(`S3 refused to delete ${r.Errors.length} object(s), first ${e.Key}: ${e.Code} ${e.Message ?? ''}`.trim());
    }
  }
}

export interface S3ReconcileResult { registered: number; updated: number; missing: number; recordingsTouched: number; skipped?: boolean }

const lastPass = new Map<string, number>();

/**
 * Register the stream's runs in the bucket, and retire what has gone from it.
 * `throttle` (the tick) skips a stream passed within MEDIA_S3_RECONCILE_MS.
 */
export async function reconcileStreamS3(streamId: string, opts: { actor?: string; throttle?: boolean } = {}): Promise<S3ReconcileResult> {
  const res: S3ReconcileResult = { registered: 0, updated: 0, missing: 0, recordingsTouched: 0 };
  if (!bucketRecordings()) return res;
  if (opts.throttle) {
    const at = lastPass.get(streamId) ?? 0;
    if (Date.now() - at < RECONCILE_EVERY_MS()) return { ...res, skipped: true };
  }
  lastPass.set(streamId, Date.now());
  const actor = opts.actor ?? 'reconcile';

  const owner = await one<any>(
    `SELECT (SELECT id FROM channels WHERE id = $1) AS channel_id,
            (SELECT id FROM events   WHERE id = $1) AS event_id`, [streamId]);
  if (!owner?.channel_id && !owner?.event_id) return res;
  const kind: 'channel' | 'event' = owner.channel_id ? 'channel' : 'event';
  const root = parseS3Uri(streamRootUri(kind, streamId))!;
  const api = await s3();

  const runsLevel = await listLevel(api, root.bucket, `${root.key}runs/`);
  const runIds = runsLevel.folders.map((p) => p.slice(`${root.key}runs/`.length).replace(/\/$/, '')).filter((r) => RUN_ID.test(r));

  const recs = await query<any>(
    `SELECT id, start_epoch_ms, end_epoch_ms FROM recordings WHERE channel_id = $1 OR event_id = $1 ORDER BY start_epoch_ms`, [streamId]);
  // What is already known of this stream's runs in the bucket, by run.
  const known = await query<any>(
    `SELECT o.id, o.state, o.logical_key, l.uri
       FROM media_objects o JOIN media_locations l ON l.object_id = o.id AND l.present
      WHERE (o.channel_id = $1 OR o.event_id = $1) AND l.uri LIKE $2`,
    [streamId, `s3://${root.bucket}/${root.key}runs/%`]);
  const byRun = new Map<string, any[]>();
  for (const k of known) {
    const r = /^run\/([^/]+)\//.exec(k.logical_key)?.[1];
    if (r) byRun.set(r, [...(byRun.get(r) ?? []), k]);
  }
  const touched = new Set<string>();

  for (const runId of runIds) {
    const objs = byRun.get(runId) ?? [];
    // A closed run is listed once. Nothing about it changes again except by
    // the ladder itself, which keeps its own rows.
    if (objs.length && objs.every((o) => o.state !== 'writing' && o.state !== 'pending')) continue;

    const runKey = `${root.key}runs/${runId}/`;
    const level = await listLevel(api, root.bucket, runKey);
    const rendFolders = level.folders.filter((f) => !NOT_RENDITIONS.has(f.slice(runKey.length).replace(/\/$/, '')));
    // The run's own playlists are rewritten on every upload pass while it runs.
    let newest = Math.max(0, ...level.files.map((f) => f.lastModified));
    const startMs = runStartMs(runId);
    const live = newest > 0 ? Date.now() - newest < LIVE_WINDOW_MS() : false;

    for (const folder of rendFolders) {
      const rendition = folder.slice(runKey.length).replace(/\/$/, '');
      let bytes: number | null = null, segments: number | null = null, endMs = newest, firstMs = 0;
      let cls = 'STANDARD';
      if (!live) {
        // Closed: size it, once.
        const all = await listAll(api, root.bucket, folder);
        const segs = all.filter((o) => SEGMENT.test('/' + o.key.slice(folder.length)));
        if (!segs.length) continue;   // not media (a folder of notes, say): it goes with the run
        bytes = all.reduce((n, o) => n + o.bytes, 0);
        segments = segs.length;
        endMs = Math.max(...segs.map((s) => s.lastModified));
        firstMs = Math.min(...segs.map((s) => s.lastModified));
        if (!newest) newest = endMs;
        // A bucket lifecycle rule may already have moved it; say where it is.
        cls = segs[0].storageClass;
      }
      const begin = startMs ?? (firstMs || endMs);
      const rec = recs.find((r: any) => Number(r.start_epoch_ms) <= begin && (r.end_epoch_ms == null || Number(r.end_epoch_ms) >= begin));
      const logicalKey = `run/${runId}/${rendition}`;
      const before = objs.find((o) => o.logical_key === logicalKey);
      const obj = await registerObject({
        recordingId: rec?.id ?? null,
        channelId: owner.channel_id ?? null,
        eventId: owner.event_id ?? null,
        logicalKey, kind: 'run_rendition', rendition,
        tier: tierOfClass(cls),
        uri: `s3://${root.bucket}/${folder}`,
        bytes, segmentCount: segments,
        durationMs: endMs && begin ? Math.max(0, Math.round(endMs - begin)) : null,
        state: live ? 'writing' : 'available',
        actor,
      });
      if (before) res.updated++; else res.registered++;
      if (!live && obj.state === 'writing') {
        await transition(obj.id, 'available', { action: 'close', actor, detail: 'the run stopped growing in the bucket' });
      }
      if (rec) touched.add(rec.id);
    }
  }

  // ROWS -> BUCKET: a run folder that is no longer there.
  const present = new Set(runIds);
  for (const [runId, objs] of byRun) {
    if (present.has(runId)) continue;
    for (const k of objs) {
      await query(`UPDATE media_locations SET present = false, removed_at = now() WHERE object_id = $1 AND uri = $2`, [k.id, k.uri]);
      const st = (await one<any>(`SELECT state FROM media_objects WHERE id = $1`, [k.id]))?.state;
      await query(
        `INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail)
         VALUES ($1, $2::media_state, $2::media_state, 'missing', $3, $4)`, [k.id, st, actor, `nothing is left under ${k.uri}`]);
      if (!(await locationsOf(k.id)).length && st && st !== 'deleted' && st !== 'deleting') {
        await transition(k.id, 'deleted', { action: 'missing', actor, detail: 'no copy remains in the bucket' }).catch(async () => {
          await query(`UPDATE media_objects SET state = 'deleted', updated_at = now() WHERE id = $1`, [k.id]);
        });
      }
      res.missing++;
    }
  }

  if (touched.size) {
    const { refreshNextAction } = await import('./retention');
    for (const id of touched) await refreshNextAction(id).catch(() => { /* a cache */ });
  }
  res.recordingsTouched = touched.size;
  return res;
}

/** The run folder (s3://b/<kind>/<id>/runs/<runId>/) a rendition location sits in, or null. */
export function runFolderOf(uri: string): { bucket: string; rootKey: string; runId: string; runKey: string } | null {
  const loc = parseS3Uri(uri);
  if (!loc) return null;
  const m = /^((?:channel|event)\/[^/]+\/)runs\/([^/]+)\/[^/]+\/?$/.exec(loc.key);
  if (!m || !RUN_ID.test(m[2])) return null;
  return { bucket: loc.bucket, rootKey: m[1], runId: m[2], runKey: `${m[1]}runs/${m[2]}/` };
}

/**
 * After a rendition of a bucket run is deleted: when it was the run's last
 * rendition still held, the rest of the run (its playlists, thumbnails, the
 * loop copy, caption cues) describes nothing, so it goes too. Never the run
 * the pointer names (the stable playlists at the root point into it), and
 * never when the pointer cannot be read. Returns the bytes removed.
 */
export async function reclaimS3RunLeftovers(uri: string): Promise<number> {
  const run = runFolderOf(uri);
  if (!run) return 0;
  const still = await one<any>(
    `SELECT count(*)::int AS n FROM media_locations l JOIN media_objects o ON o.id = l.object_id
      WHERE l.present AND o.state <> 'deleted' AND l.uri LIKE $1`, [`s3://${run.bucket}/${run.runKey}%`]);
  if (still?.n) return 0;
  try {
    const api = await s3();
    const { GetObjectCommand } = await sdk();
    let pointer: string | null = null;
    try {
      const r = await api.send(new GetObjectCommand({ Bucket: run.bucket, Key: `${run.rootKey}current_run.txt` }));
      pointer = String(await r.Body?.transformToString?.() ?? '').trim();
    } catch (e: any) {
      // No pointer at all is a stream with no live run: fine. Anything else
      // (the bucket did not answer) is not a reason to delete.
      if (!(e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404)) return 0;
    }
    if (pointer === run.runId) return 0;
    const left = await listAll(api, run.bucket, run.runKey);
    if (!left.length) return 0;
    await deleteKeys(api, run.bucket, left.map((o) => o.key));
    return left.reduce((n, o) => n + o.bytes, 0);
  } catch (e) {
    // The media itself is already correctly gone; leftovers are retried by the next delete.
    console.warn('[retention] run leftovers in the bucket not removed for', uri, e);
    return 0;
  }
}

/**
 * Remove a recording's run from the bucket, keeping what clips were cut from
 * (the same rule as prune.ts on the Mac, docs/RETENTION.md): for each clip
 * block the segments it used and one either side, in every rendition, with
 * the init segments and playlists. Nothing kept: every key of the run goes
 * and its objects are tombstoned. Something kept: the rest goes and the
 * objects stay readable, on hold, saying why.
 *
 * Deleted at once, not through the restore bin: on S3 the bin is a copy of
 * every byte (build queue 2.3b asks Christian whether recordings should go
 * through it here as they do on the Mac).
 */
export async function pruneS3Run(o: { uri: string; streamId: string; recordingId?: string | null; reason: string; actor: string }): Promise<PruneResult | null> {
  const run = runFolderOf(o.uri);
  if (!run) return null;
  const res: PruneResult = { runId: run.runId, keptSegments: 0, removedSegments: 0, clips: 0, stills: 0, sheets: 0, binId: null, whole: false };
  const api = await s3();
  const pointer = await pointerRun(api, run.bucket, run.rootKey);

  const blocks = await query<any>(
    `SELECT DISTINCT cs.vod_asset_id, cs.first_seq, cs.last_seq, cs.source_from_ms, cs.source_to_ms FROM clip_segments cs
       JOIN vod_assets v ON v.id = cs.vod_asset_id
      WHERE cs.run_id = $1 AND (v.channel_id = $2 OR v.event_id = $2 OR cs.recording_id = $3)`,
    [run.runId, o.streamId, o.recordingId ?? null]).catch(() => [] as any[]);
  res.clips = new Set(blocks.map((b: any) => b.vod_asset_id)).size;
  const keep: [number, number][] = blocks.map((b: any) => [Number(b.first_seq) - CLIP_MARGIN_SEGMENTS, Number(b.last_seq) + CLIP_MARGIN_SEGMENTS + 1]);

  // Every object of this run of this stream: the run goes as a whole.
  const objects = await query<any>(
    `SELECT DISTINCT o.id, o.state FROM media_objects o JOIN media_locations l ON l.object_id = o.id
      WHERE o.state <> 'deleted' AND l.uri LIKE $1`, [`s3://${run.bucket}/${run.runKey}%`]);

  const all = await listAll(api, run.bucket, run.runKey);
  const go: string[] = [];
  for (const k of all) {
    const m = SEGMENT.exec('/' + k.key.slice(run.runKey.length));
    if (!keep.length) {
      // The live run's root playlists stay with the pointer; its media may go.
      if (pointer === run.runId && !k.key.slice(run.runKey.length).includes('/')) continue;
      go.push(k.key); if (m) res.removedSegments++;
      continue;
    }
    if (!m) continue;   // init segments, playlists, sidecars stay with what is kept
    const seq = parseInt(m[1], 10);
    if (keep.some((w) => seq >= w[0] && seq < w[1])) res.keptSegments++;
    else { go.push(k.key); res.removedSegments++; }
  }
  if (go.length) await deleteKeys(api, run.bucket, go);
  res.whole = !keep.length;

  for (const obj of objects) {
    if (res.whole) {
      await transition(obj.id, 'deleting', { action: 'delete', actor: o.actor, detail: o.reason }).catch(() => {});
      await query(`UPDATE media_locations SET present = false, removed_at = now() WHERE object_id = $1`, [obj.id]);
      await transition(obj.id, 'deleted', { action: 'delete', actor: o.actor, detail: `${o.reason}; removed from the bucket` }).catch(async () => {
        await query(`UPDATE media_objects SET state = 'deleted', updated_at = now() WHERE id = $1`, [obj.id]);
      });
    } else {
      const why = `kept ${res.keptSegments} segment${res.keptSegments === 1 ? '' : 's'} that ${res.clips} clip${res.clips === 1 ? '' : 's'} were cut from`;
      await query(`UPDATE media_objects SET hold = true, hold_reason = $2, updated_at = now() WHERE id = $1`, [obj.id, why]);
      await query(`INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail) VALUES ($1, $2::media_state, $2::media_state, 'pruned', $3, $4)`,
        [obj.id, obj.state, o.actor, `${o.reason}: ${res.removedSegments} segments removed from the bucket, ${why}`]).catch(() => {});
    }
  }

  // Exact-frame stills of the run are derived: they go whatever was kept.
  {
    const { retireFrameFolders } = await import('../frames/folders');
    await retireFrameFolders({ streamId: o.streamId, logicalLike: `frames/run/${run.runId}/%`, reason: `${o.reason}; the run was removed`, actor: o.actor })
      .catch((e) => console.warn('[prune] frame stills of the run not removed', e));
  }

  // The library stills and storyboard sheets of the run's time (2.3c-12), as
  // on the Mac (prune.ts removeDerivedImages): they are in the image store, not
  // the media bucket, so they go to the restore bin there, except what clips
  // were cut from. The run's time is from its id (the encoder's clock at
  // start) to its last segment's upload; the segment length from the
  // rendition with the most segments.
  await removeRunImages(o, run, all, blocks, res).catch((e) => console.warn('[prune] stills and sheets of the bucket run not removed', e));
  return res;
}

async function removeRunImages(o: { streamId: string; recordingId?: string | null; reason: string; actor: string },
  run: { runId: string; runKey: string }, all: Listed[], blocks: any[], res: PruneResult): Promise<void> {
  const perRendition = new Map<string, { n: number; last: number; first: number }>();
  for (const k of all) {
    const rest = k.key.slice(run.runKey.length);
    if (!SEGMENT.test('/' + rest) || !rest.includes('/')) continue;
    const r = rest.slice(0, rest.indexOf('/'));
    const x = perRendition.get(r) ?? { n: 0, last: 0, first: Infinity };
    x.n++; x.last = Math.max(x.last, k.lastModified); x.first = Math.min(x.first, k.lastModified);
    perRendition.set(r, x);
  }
  const most = [...perRendition.values()].sort((a, b) => b.n - a.n)[0];
  if (!most) return;
  const start = runStartMs(run.runId) ?? most.first;
  const end = Math.max(...[...perRendition.values()].map((x) => x.last));
  if (!(end > start)) return;
  const segMs = Math.max(1000, Math.round((end - start) / most.n));
  const keepTime: [number, number][] = blocks
    .filter((b: any) => b.source_from_ms != null && b.source_to_ms != null)
    .map((b: any) => [Number(b.source_from_ms) - CLIP_MARGIN_SEGMENTS * segMs, Number(b.source_to_ms) + CLIP_MARGIN_SEGMENTS * segMs]);
  const owner = await one<any>(`SELECT COALESCE(c.name, e.name) AS name, COALESCE(gc.account_id, ge.account_id) AS account_id
      FROM (SELECT $1::uuid AS id) x LEFT JOIN channels c ON c.id = x.id LEFT JOIN groups gc ON gc.id = c.group_id
      LEFT JOIN events e ON e.id = x.id LEFT JOIN groups ge ON ge.id = e.group_id`, [o.streamId]);
  const { BinItem } = await import('./trash');
  const { removeDerivedImages } = await import('./prune');
  const when = new Date(start).toISOString().slice(0, 16).replace('T', ' ');
  const bin = await BinItem.open({ accountId: owner?.account_id ?? null, kind: 'recording_media', subjectId: o.recordingId ?? null,
    label: `${owner?.name ?? 'Recording'} · ${when} UTC: stills and storyboard sheets (the media was removed from the bucket)`,
    reason: o.reason, createdBy: o.actor });
  const d = await removeDerivedImages({ streamId: o.streamId, span: [start, end], keepTime, bin });
  res.stills = d.stills; res.sheets = d.sheets;
  if (!bin.isEmpty) {
    res.binId = await bin.save({ streamId: o.streamId, runId: run.runId, recordingId: o.recordingId ?? null, objects: [], storyboards: d.sheetRows });
  }
  if (d.emptied.length) {
    const { pruneEmptyFolders } = await import('./libraryMoves');
    for (const acc of [...new Set(d.emptied.map((e) => e.account_id))])
      await pruneEmptyFolders(acc, d.emptied.filter((e) => e.account_id === acc).map((e) => e.folder)).catch((e) => console.warn('[prune] empty folders not removed', e));
  }
}

/** Every stream's runs in the bucket, throttled per stream (the tick). */
export async function reconcileAllS3(opts: { actor?: string } = {}): Promise<S3ReconcileResult> {
  const total: S3ReconcileResult = { registered: 0, updated: 0, missing: 0, recordingsTouched: 0 };
  if (!bucketRecordings()) return total;
  const streams = await query<any>(`SELECT id FROM channels UNION SELECT id FROM events`);
  for (const s of streams) {
    try {
      const r = await reconcileStreamS3(s.id, { actor: opts.actor, throttle: true });
      total.registered += r.registered; total.updated += r.updated; total.missing += r.missing; total.recordingsTouched += r.recordingsTouched;
    } catch (e) {
      console.error('[media] bucket reconcile failed for', s.id, e);
    }
  }
  return total;
}

export type { MediaObject };
