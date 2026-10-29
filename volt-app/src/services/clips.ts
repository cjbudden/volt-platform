import { one } from '../db';
import { inheritedMetadata } from './contentTypes';

/**
 * Create a VOD asset from a range of a recording. A clip can be delivered as ABR
 * manifests (HLS+DASH off the existing CMAF chunks — a cheap remux, no re-encode)
 * and/or a single progressive MP4 (concatenated from the same chunks). The
 * `formats` map records which exist; the VOD extractor builds the actual outputs.
 * Used by the manual clip route and by the orchestrator's scheduled-clip firing.
 */
export type OutputKind = 'manifest' | 'progressive' | 'both';

export function formatsFor(kind: OutputKind, audio = false) {
  // AUDIO: the downloadable file is an MP3 (with the AAC .m4a beside it), never
  // an audio-only .mp4. The clip dropdown on a radio recording said
  // "Downloadable MP4" and built one; it says MP3 now and builds that.
  if (audio) return { hls: kind !== 'progressive', dash: kind !== 'progressive', progressive: false, mp3: true, m4a: true };
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
  const row = await one<any>(
    `INSERT INTO vod_assets(event_id, recording_id, kind, title, master_key,
                            start_epoch_ms, end_epoch_ms, duration_ms,
                            output_kind, formats, schema_id, metadata, thumb_status)
     VALUES ($1,$2,'full_event',$3,$4,0,$5,$5,'manifest',$6::jsonb,$7,$8::jsonb,'processing')
     RETURNING *`,
    [rec.event_id, rec.id, ev.name ?? 'Event recording', `${rec.master_key}/master.m3u8`, dur,
     JSON.stringify(formatsFor('manifest')), ev.schema_id ?? null, JSON.stringify(ev.metadata ?? {})]
  );
  // The replay is the finished recording itself: there is no build to wait
  // for, so the publishing rules are asked now (build queue 1.14-G5a).
  if (row) await (await import('./assetReadiness')).setMediaState(row.id, 'ready');
  if (row) await (await import('./availability')).autoPublishWhenReady(row.id, 'full_event');
  return row;
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
  // A radio station (or any audio-only stream) gets an MP3 download, which the
  // extractor writes to export_mp3_key; there is no progressive MP4 to promise.
  const { isAudioOnly } = await import('./localRecordingIndex');
  const audio = isAudioOnly(ownerId);
  const progressiveKey = outputKind !== 'manifest' && !audio ? `${base}/progressive.mp4` : null;
  // THE CLIP CARRIES ITS OWNER'S TYPE. A cut from a sports match is sports
  // metadata; a cut from a station carries the station's identity. Copied at
  // creation so the asset can be edited on its own afterwards.
  const inh = await inheritedMetadata(ownerCol, ownerId);
  const row = await one(
    `INSERT INTO vod_assets(${ownerCol}, recording_id, kind, title, master_key,
                            start_epoch_ms, end_epoch_ms, duration_ms,
                            output_kind, formats, progressive_key, thumb_status, schema_id, metadata)
     VALUES ($1,$2,'clip',$3,$4,$5,$6,$7,$8::clip_output_kind,$9::jsonb,$10,'processing',$11,$12::jsonb)
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
      JSON.stringify(formatsFor(outputKind, audio)),
      progressiveKey,
      inh.schemaId,
      JSON.stringify(inh.metadata),
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

/**
 * ENQUEUE THE BUILD FOR A CLIP. One function, because there were three callers
 * and only one of them did it.
 *
 * createClipVod writes the ROW. Something has to write the MEDIA, and that is a
 * clip.extract job. The manual route on /api/recordings/:id/clip enqueued one;
 * the orchestrator's post-airing EPG auto-clip and its scheduled-clip firing
 * both created the asset, marked the programme `created` or the scheduled clip
 * `done`, and queued nothing. So a clip an operator cut by hand got media, and
 * the automation that exists precisely to do it unattended left an asset stuck
 * at thumb_status `processing`, pointing at a manifest that would never be
 * written, while the EPG page reported success.
 *
 * The fix is not to add the missing call twice. It is to make the enqueue part
 * of the same helper the row creation lives beside, so a fourth caller cannot
 * repeat the omission.
 */
/**
 * HOW MUCH MISSING RECORDING AN UNATTENDED BUILD ACCEPTS.
 *
 * The EPG auto-VOD and scheduled clips enqueued with a tolerance of zero, so a
 * single encoder restart inside a programme (26.3 s in Sorotan's case) refused
 * the whole build and left nothing. Nobody is there to say "accept the gap", so
 * the automation accepts a short one and lets QC say so: coverage below 100%
 * is a QC error, which keeps the asset out of FAST and loops until a person
 * approves it or re-cuts it. A long hole still refuses the build.
 */
export const AUTO_BUILD_ACCEPT_GAPS_MS = 60_000;

export async function enqueueClipBuild(opts: {
  vodAssetId: string;
  /** The channel or event whose segments are being cut. */
  streamId: string;
  fromMs: number;
  toMs: number;
  outputKind: OutputKind;
  channelId?: string | null;
  eventId?: string | null;
  /** Gap tolerance the range was ACCEPTED under; the worker re-assesses. */
  acceptGapsMs?: number;
}): Promise<{ id: string; state: string }> {
  const { enqueue } = await import('./jobs/queue');
  const { CLIP_EXTRACT } = await import('./jobs/handlers/clipExtract');
  const { isAudioOnly } = await import('./localRecordingIndex');

  const audio = isAudioOnly(opts.streamId);
  const formats: string[] = [];
  if (opts.outputKind !== 'progressive') formats.push('hls');
  // An audio clip's download is the two AUDIO files: MP3 for anywhere, M4A as
  // the AAC exactly as broadcast. No audio-only .mp4: "Downloadable" on a radio
  // recording means MP3. A video clip's download is the MP4.
  if (audio) formats.push('mp3', 'm4a');
  else if (opts.outputKind !== 'manifest') formats.push('mp4');
  if (!formats.length) formats.push('mp4');

  const job = await enqueue({
    type: CLIP_EXTRACT,
    payload: {
      vodAssetId: opts.vodAssetId, streamId: opts.streamId,
      fromMs: opts.fromMs, toMs: opts.toMs,
      formats, kind: audio ? 'audio' : 'video',
      acceptGapsMs: opts.acceptGapsMs ?? 0,
    },
    channelId: opts.channelId ?? null,
    eventId: opts.eventId ?? null,
    // THE RANGE IS PART OF THE KEY. A re-cut REPLACES the previous build, so it
    // must not be deduped against it, and a retried request for the same range
    // must return the running job rather than extracting twice.
    dedupeKey: `clip.extract:${opts.vodAssetId}:${opts.fromMs}-${opts.toMs}`,
    priority: 50,
  });
  // The asset is being built from now on; a previous failure no longer applies.
  const { setMediaState } = await import('./assetReadiness');
  await setMediaState(opts.vodAssetId, 'processing');
  return { id: job.id, state: job.state };
}
