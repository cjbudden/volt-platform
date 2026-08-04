import { one } from '../db';

/**
 * Create a VOD asset from a range of a recording. A clip can be delivered as ABR
 * manifests (HLS+DASH off the existing CMAF chunks — a cheap remux, no re-encode)
 * and/or a single progressive MP4 (concatenated from the same chunks). The
 * `formats` map records which exist; the VOD extractor builds the actual outputs.
 * Used by the manual clip route and by the orchestrator's scheduled-clip firing.
 */
export type OutputKind = 'manifest' | 'progressive' | 'both';

export function formatsFor(kind: OutputKind) {
  return {
    hls: kind !== 'progressive',
    dash: kind !== 'progressive',
    progressive: kind !== 'manifest',
  };
}

/**
 * Auto-VOD harvest: on an EVENT recording completing, derive a full-event VOD and
 * HARVEST the event's metadata (schema_id + values) into it — define metadata once
 * at the event, reap it on the VOD (and thence schema.org / publishing). Called by
 * the orchestrator's finalizeRecording. No-op for channel_day recordings.
 */
export async function deriveEventVod(rec: any) {
  if (!rec?.event_id) return null;
  const ev = await one<any>(`SELECT name, schema_id, metadata FROM events WHERE id=$1`, [rec.event_id]);
  if (!ev) return null;
  const dur = Number(rec.duration_ms ?? 0);
  return one(
    `INSERT INTO vod_assets(event_id, recording_id, kind, title, master_key,
                            start_epoch_ms, end_epoch_ms, duration_ms,
                            output_kind, formats, schema_id, metadata, thumb_status)
     VALUES ($1,$2,'full_event',$3,$4,0,$5,$5,'manifest',$6::jsonb,$7,$8::jsonb,'processing')
     RETURNING *`,
    [rec.event_id, rec.id, ev.name ?? 'Event recording', `${rec.master_key}/master.m3u8`, dur,
     JSON.stringify(formatsFor('manifest')), ev.schema_id ?? null, JSON.stringify(ev.metadata ?? {})]
  );
}

export async function createClipVod(opts: {
  ownerCol: 'channel_id' | 'event_id';
  ownerId: string;
  recordingId: string;
  title: string;
  startMs: number;
  endMs: number;
  outputKind: OutputKind;
  masterKeyBase: string; // e.g. the recording's master_key prefix
}) {
  const { ownerCol, ownerId, recordingId, title, startMs, endMs, outputKind, masterKeyBase } = opts;
  const base = `${masterKeyBase}/clip-${startMs}-${endMs}`;
  const progressiveKey = outputKind !== 'manifest' ? `${base}/progressive.mp4` : null;
  const row = await one(
    `INSERT INTO vod_assets(${ownerCol}, recording_id, kind, title, master_key,
                            start_epoch_ms, end_epoch_ms, duration_ms,
                            output_kind, formats, progressive_key, thumb_status)
     VALUES ($1,$2,'clip',$3,$4,$5,$6,$7,$8::clip_output_kind,$9::jsonb,$10,'processing')
     RETURNING *`,
    [
      ownerId,
      recordingId,
      title,
      `${base}/master.m3u8`,
      startMs,
      endMs,
      endMs - startMs,
      outputKind,
      JSON.stringify(formatsFor(outputKind)),
      progressiveKey,
    ]
  );
  // The vod-extractor (services/vod-extractor-job.ts, entrypoint tools/extract-clip.ts)
  // builds the actual outputs from the recording's CMAF segments: trimmed HLS/DASH
  // manifests (manifest kind) and/or a progressive MP4 (progressive kind), honouring
  // multi-recording clip_spec. In cloud it runs as a CPU task the orchestrator
  // launches (like the thumbnailer); the task uploads job.outDir to S3 and flips
  // thumb_status→ready. Proven end-to-end by e2e/extractor-test.sh (real ffmpeg/Shaka).
  return row;
}
