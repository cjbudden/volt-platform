// ============================================================================
//  RECORDINGS WAIT FOR THEIR ARCHIVE FILE (build queue H3-5c; (3) of H3-5,
//  decided by Christian on 11 Nov 2026).
//
//  A channel or event whose copy rule says `on: ['recording']` has its
//  recordings joined into consolidated files (one per programme or clock
//  hour, services/archive/recordings.ts) and copied to the account's storage
//  targets. Retention's delete rung for such a recording (the rule's, or an
//  expiry set by hand) must not take the only copy: it waits until every
//  archive file covering the recording is verified at its target, and the
//  reason it waits is written on the recording for the console.
//
//  What counts as covering: the `archive_copies` rows with `what =
//  'recording'` of the stream whose range overlaps the recording, at the
//  rule's targets. A file not made yet (the stretch has not closed, its job
//  is queued or failed, the pass has not reached it) also keeps it.
//
//  Outside it, unchanged: a stream with no such rule or no licence, and the
//  part of a recording from before the rule first handed recordings on
//  (`archive_recording_cursors.archived_from`; the pass does not reach back,
//  so that part was never going to be archived).
// ============================================================================
import { one, query } from '../../db';

export interface RecordingWait { code: 'not_made' | 'making' | 'make_failed' | 'no_file' | 'copying' | 'copy_bad'; message: string }

const STATE_WORDS: Record<string, string> = { queued: 'waiting to be copied', copying: 'being copied', copied: 'copied and waiting to be checked', failed: 'failed', corrupt: 'corrupt', missing: 'missing' };

/**
 * Why this recording's delete must wait for the archive, or null when it need
 * not. With `write`, the reason is stored on the recording (and cleared when
 * there is none), so the console says it.
 */
export async function recordingArchiveWait(recordingId: string, opts: { write?: boolean } = {}): Promise<RecordingWait | null> {
  const w = await judge(recordingId).catch((e) => {
    // Unsure is a reason to keep it: the delete is retried at the next pass.
    console.warn(`[archive] recording ${recordingId}: archive cover not judged:`, e?.message ?? e);
    return { code: 'not_made', message: `Its archive cover could not be checked (${String(e?.message ?? e).slice(0, 200)}); it is kept until it can.` } as RecordingWait;
  });
  if (opts.write) {
    await query(
      `UPDATE recordings SET archive_wait_code = $2, archive_wait = $3, archive_checked_at = now()
        WHERE id = $1 AND (archive_wait_code IS DISTINCT FROM $2 OR archive_wait IS DISTINCT FROM $3 OR $2 IS NOT NULL)`,
      [recordingId, w?.code ?? null, w?.message ?? null]);
  }
  return w;
}

async function judge(recordingId: string): Promise<RecordingWait | null> {
  const r = await one<any>(
    `SELECT r.id, r.channel_id, r.event_id, r.start_epoch_ms, r.end_epoch_ms, COALESCE(gc.account_id, ge.account_id) AS account_id,
            'mirror_archive' = ANY(COALESCE(a.licences, '{}')) AS licensed
       FROM recordings r LEFT JOIN channels c ON c.id = r.channel_id LEFT JOIN groups gc ON gc.id = c.group_id
       LEFT JOIN events e ON e.id = r.event_id LEFT JOIN groups ge ON ge.id = e.group_id
       LEFT JOIN accounts a ON a.id = COALESCE(gc.account_id, ge.account_id)
      WHERE r.id = $1`, [recordingId]);
  if (!r || !r.account_id || !r.licensed || r.end_epoch_ms == null) return null;
  const streamId: string = r.channel_id ?? r.event_id;
  if (!streamId) return null;
  const { resolveForAsset } = await import('../publishingRules');
  const rule = (await resolveForAsset(r.account_id, r.channel_id ? { channel_id: r.channel_id } : { event_id: r.event_id })).settings.archive as any;
  const wanted: string[] = (rule?.copies ?? []).filter((c: any) => (c.on ?? []).includes('recording')).map((c: any) => String(c.targetId));
  if (!wanted.length) return null;

  const cur = await one<any>(`SELECT done_until, archived_from FROM archive_recording_cursors WHERE stream_id = $1`, [streamId]);
  const first = await one<any>(`SELECT min(range_start) AS at FROM archive_copies WHERE stream_id = $1 AND what = 'recording'`, [streamId]);
  const fromAt = cur?.archived_from ?? first?.at ?? null;
  const endMs = Number(r.end_epoch_ms);
  // The rule has not handed anything on yet: what ended before the pass last
  // looked was never going to be archived; what ended after it waits for it.
  if (!fromAt) {
    if (cur && endMs <= new Date(cur.done_until).getTime()) return null;
    return { code: 'not_made', message: 'Its archive file is not made yet: recordings are handed to the archive a few minutes after each programme or hour ends.' };
  }
  const startMs = Math.max(Number(r.start_epoch_ms), new Date(fromAt).getTime());
  if (endMs <= startMs) return null;   // all of it from before the rule

  if (!cur || new Date(cur.done_until).getTime() < endMs) {
    return { code: 'not_made', message: 'Its archive file is not made yet: recordings are handed to the archive a few minutes after each programme or hour ends.' };
  }
  const jobs = await query<any>(
    `SELECT id, state, last_error, (payload->>'startMs')::bigint AS start_ms FROM jobs
      WHERE type = 'archive.recording' AND payload->>'streamId' = $1
        AND (payload->>'startMs')::bigint < $3 AND (payload->>'endMs')::bigint > $2
      ORDER BY created_at DESC`, [streamId, startMs, endMs]);
  if (jobs.some((j) => j.state === 'queued' || j.state === 'running')) {
    return { code: 'making', message: 'Its archive file is being made; it is deleted once the file is copied and verified at your storage target.' };
  }
  const copies = await query<any>(
    `SELECT c.state, c.file_name, c.range_start, c.target_id::text AS target_id, t.name AS target_name, t.status AS target_status
       FROM archive_copies c JOIN archive_targets t ON t.id = c.target_id
      WHERE c.stream_id = $1 AND c.what = 'recording' AND c.range_start < $3 AND c.range_end > $2
      ORDER BY c.range_start`, [streamId, new Date(startMs), new Date(endMs)]);
  const made = new Set(copies.map((c) => new Date(c.range_start).getTime()));
  const failed = jobs.find((j) => j.state === 'failed' && !made.has(Number(j.start_ms)));
  if (failed) {
    return { code: 'make_failed', message: `Making its archive file failed: ${String(failed.last_error ?? 'no reason given').slice(0, 300)}. It is kept until the file is made.` };
  }
  if (!copies.length) {
    return { code: 'no_file', message: 'No archive file covers it yet, so it is kept: deleting it would remove the only copy.' };
  }
  const open = copies.filter((c) => wanted.includes(c.target_id) && c.state !== 'verified');
  const bad = open.find((c) => c.state === 'failed' || c.state === 'corrupt' || c.state === 'missing');
  if (bad) {
    return { code: 'copy_bad', message: `Its archive file ${bad.file_name} is ${STATE_WORDS[bad.state] ?? bad.state} at ${bad.target_name}. Copy it again; the recording is kept until that copy is verified.` };
  }
  if (open.length) {
    const c = open[0];
    const off = c.target_status !== 'active' ? ` (the target ${c.target_name} is disabled)` : '';
    return { code: 'copying', message: `Its archive file ${c.file_name} is ${STATE_WORDS[c.state] ?? c.state} at ${c.target_name}${off}; the recording is deleted once that copy is verified.` };
  }
  return null;
}
