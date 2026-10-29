// ============================================================================
//  CLIP-AWARE REMOVAL OF A RECORDED RUN. docs/RETENTION.md.
//
//  When retention (or the cleanup script) removes a recording's media, the parts
//  clips were cut from stay and everything else goes to the bin:
//
//    segments   for each clip block (clip_segments: run, first and last segment) the
//               segments it used plus one either side, in EVERY rendition of the run,
//               with the run's init segments and playlists. The clip itself is already
//               its own file; what is kept is its source, so it can be re-cut, re-trimmed
//               or checked against the original. The rest of the run goes, including the
//               renditions retention never registered (the 720p beside the 1080p).
//    stills     the Image Library's encoder stills of the stream inside the removed time,
//               rows and files, unless a poster uses one.
//    sprites    storyboard sheets wholly inside the removed time, with their sprite_sheets rows;
//               a storyboard hour left with no sheets goes too.
//
//  With nothing kept the whole run directory moves to the bin and its media objects are
//  marked deleted. With something kept they stay readable, on hold, the hold reason
//  saying what was kept and why: retention leaves held media alone.
// ============================================================================
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../../db';
import { originBaseFor } from '../liveOrigin';
import { invalidateRunScan, pickRenditions, scanRun } from '../localRecordingIndex';
import { BinItem, snapshotDelete } from './trash';
import { transition } from './objects';

/** Segments either side of a clip's own that are kept with it. */
export const CLIP_MARGIN_SEGMENTS = 1;

export interface PruneResult {
  runId: string; keptSegments: number; removedSegments: number; clips: number;
  stills: number; sheets: number; binId: string | null; whole: boolean;
}

type Win = [number, number];
const overlaps = (a: Win, b: Win) => a[0] < b[1] && b[0] < a[1];
const inside = (a: Win, b: Win) => a[0] >= b[0] && a[1] <= b[1];

/** Remove one run's media, keeping what clips were cut from. Idempotent. */
export async function pruneRun(o: {
  streamId: string; runId: string; accountId: string | null; recordingId?: string | null;
  reason: string; actor: string; label?: string;
}): Promise<PruneResult> {
  const runDir = join(originBaseFor(o.streamId), 'runs', o.runId);
  const res: PruneResult = { runId: o.runId, keptSegments: 0, removedSegments: 0, clips: 0, stills: 0, sheets: 0, binId: null, whole: false };
  const objects = await query<any>(`SELECT id, state FROM media_objects WHERE logical_key LIKE $1 AND state NOT IN ('deleted')`, [`run/${o.runId}/%`]);

  // What clips used, by segment number and by wall clock.
  const blocks = await query<any>(
    `SELECT DISTINCT cs.vod_asset_id, cs.first_seq, cs.last_seq, cs.source_from_ms, cs.source_to_ms
       FROM clip_segments cs JOIN vod_assets v ON v.id = cs.vod_asset_id WHERE cs.run_id = $1`, [o.runId]);
  res.clips = new Set(blocks.map((b: any) => b.vod_asset_id)).size;
  const keepSeq: Win[] = blocks.map((b: any) => [b.first_seq - CLIP_MARGIN_SEGMENTS, b.last_seq + CLIP_MARGIN_SEGMENTS + 1]);

  // The run's span and segment length, measured before anything moves.
  const pick = existsSync(runDir) ? pickRenditions(o.streamId, o.runId) : { video: null, audio: false };
  const segs = pick.video ? scanRun(o.streamId, o.runId, pick.video) : pick.audio ? scanRun(o.streamId, o.runId, 'audio') : [];
  const span: Win | null = segs.length ? [segs[0].startMs, segs[segs.length - 1].startMs + segs[segs.length - 1].durMs] : null;
  const segMs = segs.length ? Math.max(1000, Math.round(segs.reduce((a, s) => a + s.durMs, 0) / segs.length)) : 4000;
  const keepTime: Win[] = blocks.map((b: any) => [Number(b.source_from_ms) - CLIP_MARGIN_SEGMENTS * segMs, Number(b.source_to_ms) + CLIP_MARGIN_SEGMENTS * segMs]);

  const owner = await one<any>(`SELECT COALESCE(c.name, e.name) AS name FROM (SELECT $1::uuid AS id) x
      LEFT JOIN channels c ON c.id = x.id LEFT JOIN events e ON e.id = x.id`, [o.streamId]);
  const when = span ? new Date(span[0]).toISOString().slice(0, 16).replace('T', ' ') : o.runId;
  const bin = await BinItem.open({ accountId: o.accountId, kind: 'recording_media', subjectId: o.recordingId ?? null,
    label: o.label ?? `${owner?.name ?? 'Recording'} · ${when} UTC${blocks.length ? ` (kept what ${res.clips} clip${res.clips === 1 ? '' : 's'} used)` : ''}`,
    reason: o.reason, createdBy: o.actor });
  const deletedObjects: string[] = [];

  if (existsSync(runDir)) {
    if (!keepSeq.length) {
      // Nothing to keep: the whole run, every rendition and sidecar.
      for (const r of readdirSync(runDir)) {
        const p = join(runDir, r);
        if (statSync(p).isDirectory()) res.removedSegments += readdirSync(p).filter((f) => /^seg_\d+\.m4s$/.test(f)).length;
      }
      bin.file(runDir, 'run');
      res.whole = true;
    } else {
      const out: string[] = [];
      for (const r of readdirSync(runDir)) {
        const dir = join(runDir, r);
        if (!statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) {
          const m = f.match(/^seg_(\d+)\.m4s$/);
          if (!m) continue;
          const seq = parseInt(m[1], 10);
          if (keepSeq.some((w) => seq >= w[0] && seq < w[1])) res.keptSegments++;
          else { out.push(join(dir, f)); res.removedSegments++; }
        }
      }
      bin.filesUnder(runDir, out, 'run');
    }
    invalidateRunScan(o.streamId, o.runId);
  }

  // Media objects: deleted with the run, or held for the clips.
  for (const obj of objects) {
    if (res.whole || !existsSync(runDir)) {
      await transition(obj.id, 'deleting', { action: 'delete', actor: o.actor, detail: o.reason }).catch(() => {});
      await query(`UPDATE media_locations SET present = false, removed_at = now() WHERE object_id = $1`, [obj.id]);
      await transition(obj.id, 'deleted', { action: 'delete', actor: o.actor, detail: `${o.reason}; in the bin ${bin.id}` }).catch(async () => {
        await query(`UPDATE media_objects SET state = 'deleted', updated_at = now() WHERE id = $1`, [obj.id]);
      });
      deletedObjects.push(obj.id);
    } else {
      const reason = `kept ${res.keptSegments} segment${res.keptSegments === 1 ? '' : 's'} that ${res.clips} clip${res.clips === 1 ? '' : 's'} were cut from`;
      await query(`UPDATE media_objects SET hold = true, hold_reason = $2, updated_at = now() WHERE id = $1`, [obj.id, reason]);
      await query(`INSERT INTO media_events (object_id, from_state, to_state, action, actor, detail) VALUES ($1, $2::media_state, $2::media_state, 'pruned', $3, $4)`,
        [obj.id, obj.state, o.actor, `${o.reason}: ${res.removedSegments} segments to the bin ${bin.id}, ${reason}`]).catch(() => {});
    }
  }

  // Stills and sprite sheets of the removed time.
  const sheetRows: { id: string; sheets: any }[] = [];
  // Folders images left this pass: emptied ones are removed after (libraryMoves.ts pruneEmptyFolders).
  const emptied: { account_id: string; folder: string }[] = [];
  if (span) {
    const removed = (w: Win) => inside(w, span) && !keepTime.some((k) => overlaps(w, k));
    const stills = await query<any>(
      `SELECT * FROM media_files WHERE source = 'encoder' AND channel_id = $1 AND kind = 'keyframe'
          AND captured_at >= $2 AND captured_at < $3`, [o.streamId, new Date(span[0]), new Date(span[1])]);
    // A still an asset uses as an image (its main image, or one of its typed images) stays.
    const posters = await query<any>(`SELECT poster_key AS k FROM vod_assets WHERE poster_key IS NOT NULL
                                        UNION SELECT poster_key FROM recordings WHERE poster_key IS NOT NULL
                                        UNION SELECT image_key FROM vod_asset_images`).catch(() => query<any>(`SELECT poster_key AS k FROM vod_assets WHERE poster_key IS NOT NULL
                                        UNION SELECT poster_key FROM recordings WHERE poster_key IS NOT NULL`));
    const used = (key: string) => posters.some((p: any) => String(p.k).endsWith(key));
    const go = stills.filter((s: any) => { const t = new Date(s.captured_at).getTime(); return removed([t, t + 1]) && !used(s.store_key); });
    if (go.length) {
      for (const s of go) await bin.image(s.store_key, Number(s.size_bytes ?? 0));
      await snapshotDelete(bin, 'media_files', go.map((s: any) => s.id));
      await query(`DELETE FROM media_files WHERE id = ANY($1::uuid[])`, [go.map((s: any) => s.id)]);
      emptied.push(...go.map((s: any) => ({ account_id: s.account_id, folder: s.folder })));
      res.stills = go.length;
    }
    const boards = await query<any>(`SELECT * FROM storyboards WHERE stream_id = $1 AND unit_end > $2 AND unit_start < $3`,
      [o.streamId, new Date(span[0]), new Date(span[1])]);
    for (const sb of boards) {
      const keep: any[] = [], drop: any[] = [];
      for (const sh of sb.sheets ?? []) {
        const w: Win = [Number(sh.start_ms), Number(sh.start_ms) + Number(sh.slots ?? 60) * Number(sb.interval_ms)];
        (removed(w) ? drop : keep).push(sh);
      }
      if (!drop.length) continue;
      for (const sh of drop) await bin.image(sh.key);
      // Their rows in the sprite inventory (thumbnails/spriteStore.ts) go into the bin with them;
      // sheets from before the sprite store may still have an Image Library row.
      const sprites = await query<any>(`SELECT id FROM sprite_sheets WHERE store_key = ANY($1::text[])`, [drop.map((d) => d.key)]);
      if (sprites.length) {
        await snapshotDelete(bin, 'sprite_sheets', sprites.map((f: any) => f.id));
        await query(`DELETE FROM sprite_sheets WHERE id = ANY($1::uuid[])`, [sprites.map((f: any) => f.id)]);
      }
      const sheetFiles = await query<any>(`SELECT id, account_id, folder FROM media_files WHERE account_id = $1 AND store_key = ANY($2::text[])`, [sb.account_id, drop.map((d) => d.key)]);
      emptied.push(...sheetFiles.map((f: any) => ({ account_id: f.account_id, folder: f.folder })));
      if (sheetFiles.length) {
        await snapshotDelete(bin, 'media_files', sheetFiles.map((f: any) => f.id));
        await query(`DELETE FROM media_files WHERE id = ANY($1::uuid[])`, [sheetFiles.map((f: any) => f.id)]);
      }
      if (!keep.length) {
        if (sb.vtt_key) await bin.image(sb.vtt_key);
        await snapshotDelete(bin, 'storyboards', [sb.id]);
        await query(`DELETE FROM storyboards WHERE id = $1`, [sb.id]);
      } else {
        sheetRows.push({ id: sb.id, sheets: sb.sheets });
        await query(`UPDATE storyboards SET sheets = $2::jsonb, updated_at = now() WHERE id = $1`, [sb.id, JSON.stringify(keep)]);
      }
      res.sheets += drop.length;
    }
  }

  if (!bin.isEmpty || deletedObjects.length) {
    res.binId = await bin.save({ streamId: o.streamId, runId: o.runId, recordingId: o.recordingId ?? null, objects: deletedObjects, storyboards: sheetRows });
  }
  // The folders those images were in, when nothing is left in them (a restore puts them back with the images).
  if (emptied.length) {
    const { pruneEmptyFolders } = await import('./libraryMoves');
    for (const acc of [...new Set(emptied.map((e) => e.account_id))])
      await pruneEmptyFolders(acc, emptied.filter((e) => e.account_id === acc).map((e) => e.folder)).catch((e) => console.warn('[prune] empty folders not removed', e));
  }
  return res;
}

/** Remove every run of a recording (the cleanup script, a manual expiry that has passed). */
export async function pruneRecording(recordingId: string, o: { reason: string; actor: string }): Promise<PruneResult[]> {
  const rec = await one<any>(
    `SELECT r.*, COALESCE(gc.account_id, ge.account_id) AS account_id FROM recordings r
       LEFT JOIN channels c ON c.id = r.channel_id LEFT JOIN groups gc ON gc.id = c.group_id
       LEFT JOIN events e ON e.id = r.event_id LEFT JOIN groups ge ON ge.id = e.group_id WHERE r.id = $1`, [recordingId]);
  if (!rec) return [];
  const runs = await query<any>(`SELECT DISTINCT split_part(logical_key, '/', 2) AS run FROM media_objects
                                  WHERE recording_id = $1 AND logical_key LIKE 'run/%' AND state <> 'deleted'`, [recordingId]);
  const out: PruneResult[] = [];
  for (const r of runs) {
    out.push(await pruneRun({ streamId: rec.channel_id ?? rec.event_id, runId: r.run, accountId: rec.account_id, recordingId, reason: o.reason, actor: o.actor }));
  }
  const left = await one<any>(`SELECT count(*)::int AS n FROM media_objects WHERE recording_id = $1 AND state <> 'deleted'`, [recordingId]);
  await query(`UPDATE recordings SET storage_state = $2::media_state WHERE id = $1`, [recordingId, left?.n ? 'available' : 'deleted']);
  return out;
}
