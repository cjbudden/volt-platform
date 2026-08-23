// ============================================================================
//  RECONCILIATION — make the lifecycle rows agree with what is on disk.
//
//  The lifecycle model is only worth anything if it describes the media that
//  actually exists. Two directions, and both matter:
//
//    DISK -> ROWS   every run rendition on disk gets a media_objects row, sized
//                   and placed. Without this the retention ladder governs an
//                   empty set while the disk fills.
//
//    ROWS -> DISK   an object whose bytes have vanished from every location is
//                   marked, not silently left claiming to be readable. Media
//                   disappears for reasons the control plane never sees: a
//                   volume was reattached, someone cleared a directory, a
//                   restore lapsed. An archive that reports what it wishes were
//                   there is worse than one that reports a loss.
//
//  Runs still being written are registered as `writing`, so the retention clock
//  does not start on media that is still growing.
// ============================================================================
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../../db';
import { originBaseFor } from '../liveOrigin';
import { listRuns, pickRenditions, scanRun } from '../localRecordingIndex';
import { registerObject, transition, locationsOf, type MediaObject } from './objects';
import { storageDriver } from './storage';
import { refreshNextAction } from './retention';

/** A run is still being written if its newest segment landed very recently. */
const LIVE_WINDOW_MS = 30_000;

export interface ReconcileResult {
  registered: number;
  updated: number;
  missing: number;
  recordingsTouched: number;
}

/**
 * Register every run rendition on disk for one stream.
 *
 * The logical key is `run/<runId>/<rendition>` — stable, readable, and
 * independent of where the bytes live, which is what makes it still meaningful
 * on a tombstone after every location has gone.
 */
export async function reconcileStream(streamId: string, opts: { actor?: string } = {}): Promise<ReconcileResult> {
  const res: ReconcileResult = { registered: 0, updated: 0, missing: 0, recordingsTouched: 0 };
  const base = originBaseFor(streamId);
  if (!existsSync(join(base, 'runs'))) return res;

  // Which recording covers a run, by time. A run with no recording row still
  // gets an object: bytes that nothing claims are exactly what a sweep must be
  // able to see.
  const recs = await query<any>(
    `SELECT id, channel_id, event_id, start_epoch_ms, end_epoch_ms
       FROM recordings WHERE channel_id = $1 OR event_id = $1
      ORDER BY start_epoch_ms`,
    [streamId]
  );
  const owner = await one<any>(
    `SELECT (SELECT id FROM channels WHERE id = $1) AS channel_id,
            (SELECT id FROM events   WHERE id = $1) AS event_id`,
    [streamId]
  );

  const touched = new Set<string>();
  const driver = storageDriver();

  for (const runId of listRuns(streamId)) {
    const pick = pickRenditions(streamId, runId);
    const rends = [pick.video, pick.audio ? 'audio' : null].filter(Boolean) as string[];
    for (const rendition of rends) {
      const dir = join(base, 'runs', runId, rendition);
      const segs = scanRun(streamId, runId, rendition);
      if (!segs.length) continue;

      const startMs = segs[0].startMs;
      const endMs = segs[segs.length - 1].startMs + segs[segs.length - 1].durMs;
      const live = Date.now() - endMs < LIVE_WINDOW_MS;
      const rec = recs.find((r: any) =>
        Number(r.start_epoch_ms) <= startMs
        && (r.end_epoch_ms == null || Number(r.end_epoch_ms) >= startMs));

      const stat = await driver.stat(dir);
      // Existence is checked by the SAME key rule registration uses: recording
      // when there is one, stream when there is not. Checking only the recording
      // made every orphaned run look newly registered on every pass, so a tick
      // that did nothing reported work.
      const logicalKey = `run/${runId}/${rendition}`;
      const before = await one<MediaObject>(
        rec
          ? `SELECT * FROM media_objects WHERE recording_id = $1 AND logical_key = $2`
          : `SELECT * FROM media_objects WHERE channel_id = $1 AND logical_key = $2
               AND recording_id IS NULL AND vod_asset_id IS NULL`,
        [rec ? rec.id : streamId, logicalKey]
      );

      const obj = await registerObject({
        recordingId: rec?.id ?? null,
        channelId: owner?.channel_id ?? null,
        eventId: owner?.event_id ?? null,
        logicalKey,
        kind: 'run_rendition',
        rendition,
        tier: 'local',
        uri: dir,
        bytes: stat?.bytes ?? null,
        // Segment placement comes from write times, which carry sub-millisecond
        // precision, so a span is fractional. The column is a bigint.
        durationMs: Math.round(endMs - startMs),
        segmentCount: segs.length,
        state: live ? 'writing' : 'available',
        actor: opts.actor ?? 'reconcile',
      });
      if (before) res.updated++; else res.registered++;

      // A run that has stopped growing is closed: the retention clock starts.
      if (!live && obj.state === 'writing') {
        await transition(obj.id, 'available', {
          action: 'close', actor: opts.actor ?? 'reconcile',
          detail: 'the run stopped growing',
        });
      }
      if (rec) touched.add(rec.id);
    }
  }

  // ROWS -> DISK. Anything claiming to be readable whose bytes are not there.
  const claimed = await query<MediaObject>(
    `SELECT o.* FROM media_objects o
      WHERE o.state IN ('available', 'writing', 'restored')
        AND (o.channel_id = $1 OR o.event_id = $1)`,
    [streamId]
  );
  for (const obj of claimed) {
    const locs = await locationsOf(obj.id);
    const localLoc = locs.find((l) => l.tier === 'local');
    if (!localLoc) continue;
    if (await driver.stat(localLoc.uri)) continue;
    // Only the LOCATION is retired here, never the object: a copy on another
    // tier may still be perfectly good, and readability is derived from the set
    // of locations rather than asserted.
    await query(
      `UPDATE media_locations SET present = false, removed_at = now() WHERE id = $1`, [localLoc.id]
    );
    await query(
      `INSERT INTO media_events (object_id, from_state, to_state, action, tier, actor, detail)
       VALUES ($1, $2::media_state, $2::media_state, 'missing', 'local', $3, $4)`,
      [obj.id, obj.state, opts.actor ?? 'reconcile', `bytes are gone from ${localLoc.uri}`]
    );
    const left = await locationsOf(obj.id);
    if (!left.length) {
      await transition(obj.id, 'deleted', {
        action: 'missing', actor: opts.actor ?? 'reconcile',
        detail: 'no copy remains on any tier',
      });
    }
    res.missing++;
  }

  for (const id of touched) {
    await refreshNextAction(id).catch(() => { /* the cache is an optimisation */ });
  }
  res.recordingsTouched = touched.size;
  return res;
}

/** Reconcile every stream that has media on disk. Runs at boot and on the tick. */
export async function reconcileAll(opts: { actor?: string } = {}): Promise<ReconcileResult> {
  const total: ReconcileResult = { registered: 0, updated: 0, missing: 0, recordingsTouched: 0 };
  const streams = await query<any>(
    `SELECT id FROM channels UNION SELECT id FROM events`
  );
  for (const s of streams) {
    try {
      const r = await reconcileStream(s.id, opts);
      total.registered += r.registered;
      total.updated += r.updated;
      total.missing += r.missing;
      total.recordingsTouched += r.recordingsTouched;
    } catch (e) {
      console.error('[media] reconcile failed for', s.id, e);
    }
  }
  if (total.registered || total.missing) {
    console.log(
      `[media] registered ${total.registered} object(s), ` +
      `${total.updated} updated, ${total.missing} missing`
    );
  }
  return total;
}
