import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { createClipVod, formatsFor } from '../services/clips';
import { resolveRange, assessRange, segmentCount } from '../services/clips/resolve';
import { plan, type OutputFormat } from '../services/clips/extract';
import { clipsFromRecording } from '../services/clips/provenance';
import { enqueue } from '../services/jobs/queue';
import { CLIP_EXTRACT } from '../services/jobs/handlers/clipExtract';
import { recordingSpans, rangeMediaPlaylist, rangeMasterPlaylist, listRuns, pickRenditions, isAudioOnly } from '../services/localRecordingIndex';
import { transcriptForStream, searchTranscript, transcriptMatches } from '../services/recordingSearch';
import { waveform, primeWaveformCache } from '../services/waveform';

/**
 * Recordings library — the raw captures. An event recording is one bounded run;
 * a continuous channel is sliced per calendar day (one row per channel per day).
 * The live segments ARE the recording, so rows are created by the orchestrator
 * at start (event) / at first-segment-of-day (channel) and closed on end.
 *
 * From a recording you PUBLISH the whole thing to VOD or CLIP a time-range —
 * both create rows in vod_assets (see modules/vod.ts) referencing this recording.
 */
export const recordingsRouter = Router();
recordingsRouter.use(requireAuth);

// tenant-scoped fetch: recording -> (channel|event) -> group -> account
const OWNED = `
  FROM recordings r
  LEFT JOIN channels c ON c.id = r.channel_id
  LEFT JOIN events   e ON e.id = r.event_id
  JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
`;

/** Owned recording row or 404 (tenant scoped). */
async function ownedRecording(req: any): Promise<any> {
  const row = await one<any>(
    `SELECT r.*, COALESCE(c.name, e.name) AS source_name,
            CASE WHEN c.radio_config IS NOT NULL THEN 'radio'
                 WHEN c.id IS NOT NULL THEN 'channel' ELSE 'event' END AS source_type ${OWNED}
      WHERE r.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!row) throw notFound('Recording not found');
  return row;
}

/**
 * TIMELINE of a recording: the real on-disk coverage (per-run spans, so the UI
 * can draw the scrubbable range with gaps), clamped to the recording's window.
 * Built from the LOCAL per-run segment index: measured wall-clock placement per
 * segment, exact media durations from the fMP4 boxes.
 */
recordingsRouter.get(
  '/:id/timeline',
  asyncHandler(async (req, res) => {
    const r = await ownedRecording(req);
    const streamId = r.channel_id ?? r.event_id;
    const spans = recordingSpans(streamId)
      .filter((s) => s.endMs > Number(r.start_epoch_ms)
        && (r.end_epoch_ms == null || s.startMs < Number(r.end_epoch_ms)));
    const hasAudio = listRuns(streamId).some((run) => pickRenditions(streamId, run).audio);
    const hasVideo = listRuns(streamId).some((run) => pickRenditions(streamId, run).video);
    res.json({
      recordingId: r.id,
      streamId,
      kind: r.kind,
      sourceName: r.source_name,
      startMs: Number(r.start_epoch_ms),
      endMs: r.end_epoch_ms != null ? Number(r.end_epoch_ms) : null,
      live: r.status === 'recording',
      hasAudio,
      audioOnly: hasAudio && !hasVideo,   // radio: player shows the visualiser
      spans,
    });
  })
);

/**
 * WAVEFORM for the clipping timeline: the audio envelope over [from..to] in
 * `buckets` columns. Cheap and bounded by design (see services/waveform.ts):
 * short windows are decoded exactly, wide ones are sampled per bucket, and
 * every decoded segment is cached per run so panning and zooming reuse work.
 * `pending > 0` means "ask again to fill the rest" rather than a long block.
 */
const waveQuery = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
  buckets: z.coerce.number().int().min(16).max(1200).default(600),
});
recordingsRouter.get(
  '/:id/waveform',
  asyncHandler(async (req, res) => {
    const r = await ownedRecording(req);
    const q = waveQuery.parse(req.query);
    if (q.to <= q.from) throw badRequest('to must be after from');
    const streamId = r.channel_id ?? r.event_id;
    // measure the whole recording once in the background: after that every zoom
    // level is instant, which is what makes a multi-day capture workable
    primeWaveformCache(streamId, Number(r.start_epoch_ms),
      r.end_epoch_ms != null ? Number(r.end_epoch_ms) : Date.now());
    res.json(await waveform(streamId, q.from, q.to, q.buckets));
  })
);

/**
 * RANGE PLAYBACK manifests. master.m3u8 references the video/audio media
 * playlists (same query carried through); media playlists reference the public
 * /origin segments directly, spanning runs with DISCONTINUITY + per-run MAP.
 * Auth: these are admin console endpoints (bearer via the player's xhrSetup);
 * the segments themselves are the already-public origin.
 */
const rangeQuery = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
});
recordingsRouter.get(
  '/:id/range/master.m3u8',
  asyncHandler(async (req, res) => {
    const r = await ownedRecording(req);
    const { from, to } = rangeQuery.parse(req.query);
    if (to <= from) throw badRequest('to must be after from');
    const streamId = r.channel_id ?? r.event_id;
    const hasAudio = listRuns(streamId).some((run) => pickRenditions(streamId, run).audio);
    const hasVideo = listRuns(streamId).some((run) => pickRenditions(streamId, run).video);
    const qs = `?from=${from}&to=${to}`;
    res.type('application/vnd.apple.mpegurl').send(
      rangeMasterPlaylist(streamId, hasAudio, hasVideo ? `video.m3u8${qs}` : null, `audio.m3u8${qs}`));
  })
);
recordingsRouter.get(
  '/:id/range/:kind(video|audio).m3u8',
  asyncHandler(async (req, res) => {
    const r = await ownedRecording(req);
    const { from, to } = rangeQuery.parse(req.query);
    if (to <= from) throw badRequest('to must be after from');
    const streamId = r.channel_id ?? r.event_id;
    const pl = rangeMediaPlaylist(streamId, req.params.kind as 'video' | 'audio', from, to);
    if (!pl) throw notFound('no recorded segments in that range');
    res.type('application/vnd.apple.mpegurl').send(pl);
  })
);

recordingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
    // sourceId matches EITHER owner column: the Recordings section is grouped by
    // source, and a source is a channel, a radio station (also a channel) or an
    // event. The caller should not have to know which column applies.
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    // With a search term, a recording matches when its own title/source matches,
    // when an EPG programme AIRING INSIDE ITS WINDOW matches (find content by
    // what was on air), or — checked after SQL, on disk — when its transcript
    // contains the words (find content by what was SAID).
    const rows = await query(
      `SELECT r.*, COALESCE(c.name, e.name) AS source_name,
              -- WHAT THE SOURCE IS, not how the capture is sliced. r.kind is
              -- 'channel_day' for radio too, which is why radio stations used to
              -- list as "CHANNEL DAY".
              CASE WHEN c.radio_config IS NOT NULL THEN 'radio'
                   WHEN c.id IS NOT NULL THEN 'channel' ELSE 'event' END AS source_type,
              (SELECT count(*)::int FROM vod_assets v WHERE v.recording_id = r.id) AS vod_count,
              CASE WHEN $4::text IS NULL THEN NULL
                   WHEN r.title ILIKE '%'||$4||'%' OR COALESCE(c.name, e.name) ILIKE '%'||$4||'%' THEN 'title'
                   WHEN r.channel_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM programmes p WHERE p.channel_id = r.channel_id
                       AND p.title ILIKE '%'||$4||'%'
                       AND p.span && tstzrange(to_timestamp(r.start_epoch_ms/1000.0),
                             to_timestamp(COALESCE(r.end_epoch_ms, (extract(epoch from now())*1000)::bigint)/1000.0), '[)')
                   ) THEN 'programme'
                   ELSE NULL END AS matched_by
       ${OWNED}
       WHERE g.account_id = $1
         AND ($2::text IS NULL OR r.kind = $2::recording_kind)
         AND ($3::uuid IS NULL OR r.channel_id = $3)
         AND ($5::uuid IS NULL OR r.channel_id = $5 OR r.event_id = $5)
       ORDER BY r.start_epoch_ms DESC`,
      [accountId(req), kind, channelId, q || null, sourceId]
    );
    if (!q) return res.json(rows);
    const out: any[] = [];
    let scanned = 0;
    for (const r of rows) {
      if (r.matched_by) { out.push(r); continue; }
      // transcript scan is a disk read — bound it to the most recent recordings
      if (scanned >= 50) continue;
      scanned++;
      const endMs = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : Date.now();
      if (transcriptMatches(r.channel_id ?? r.event_id, q, Number(r.start_epoch_ms), endMs)) {
        out.push({ ...r, matched_by: 'transcript' });
      }
    }
    res.json(out);
  })
);

/**
 * TRANSCRIPT of a recording — the searchable "what was said, when" index.
 * Without q: the languages present + entry count (cheap capability probe);
 * add from/to (epoch ms) to also get the cues in that window (the detail
 * page's live transcript side panel follows the loaded player range).
 * With q: matching cues (all words, any order) inside the recording window,
 * each with its wall-clock time — the UI jumps the player there.
 */
recordingsRouter.get(
  '/:id/transcript',
  asyncHandler(async (req, res) => {
    const r = await ownedRecording(req);
    const streamId = r.channel_id ?? r.event_id;
    const fromMs = Number(r.start_epoch_ms);
    const toMs = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : Date.now();
    const all = transcriptForStream(streamId).filter((e) => e.endMs >= fromMs && e.startMs <= toMs);
    const languages = [...new Set(all.map((e) => e.lang))].sort();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const lang = typeof req.query.lang === 'string' && req.query.lang ? req.query.lang : undefined;
    const toRow = (e: any) => ({ tMs: e.startMs, endMs: e.endMs, lang: e.lang, text: e.text, approx: e.approx === true });
    if (!q) {
      const wFrom = Number(req.query.from), wTo = Number(req.query.to);
      const entries = Number.isFinite(wFrom) && Number.isFinite(wTo)
        ? all.filter((e) => e.endMs >= wFrom && e.startMs <= wTo)
            .filter((e) => !lang || e.lang === lang).slice(0, 3000).map(toRow)
        : [];
      return res.json({ recordingId: r.id, languages, entries: all.length, matches: entries });
    }
    const matches = searchTranscript(all, q, lang).slice(0, 200).map(toRow);
    res.json({ recordingId: r.id, languages, entries: all.length, matches });
  })
);

/**
 * EPG programmes that aired inside this recording's window — content-aware
 * navigation: click a programme, get its exact time slice to review or clip.
 * Prefers the as-run times (actual_start/actual_end) when the airing was
 * observed; falls back to the scheduled span.
 */
recordingsRouter.get(
  '/:id/programmes',
  asyncHandler(async (req, res) => {
    const r = await ownedRecording(req);
    if (!r.channel_id) return res.json({ programmes: [] });   // events carry their own identity
    // The lane is drawn for the VISIBLE window, not the whole recording: a 24x7
    // channel with a long retention rule can hold tens of thousands of entries
    // (every radio now-playing change is one), so the client passes its zoom.
    const recStart = Number(r.start_epoch_ms);
    const recEnd = r.end_epoch_ms != null ? Number(r.end_epoch_ms) : Date.now();
    const q = z.object({
      from: z.coerce.number().int().nonnegative().optional(),
      to: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(4000).default(1500),
    }).parse(req.query);
    const fromMs = Math.max(recStart, q.from ?? recStart);
    const toMs = Math.min(recEnd, q.to ?? recEnd);
    const rows = await query(
      `SELECT id, title, starts_at, ends_at, actual_start, actual_end, status,
              metadata->>'class' AS class, metadata->>'source' AS source
         FROM programmes
        WHERE channel_id = $1
          AND span && tstzrange(to_timestamp($2::bigint/1000.0), to_timestamp($3::bigint/1000.0), '[)')
        ORDER BY starts_at LIMIT $4`,
      [r.channel_id, fromMs, toMs, q.limit]
    );
    res.json({
      window: { from: fromMs, to: toMs },
      programmes: rows.map((p: any) => ({
        id: p.id,
        title: p.title,
        startMs: new Date(p.actual_start ?? p.starts_at).getTime(),
        endMs: new Date(p.actual_end ?? p.ends_at).getTime(),
        asRun: p.actual_start != null,
        status: p.status,
        // radio now-playing entries carry a class (song/ad/content); EPG rows do not
        class: p.class ?? null,
        source: p.source ?? 'epg',
      })),
    });
  })
);

/**
 * SOURCES — the top level of the Recordings section.
 *
 * Recordings are grouped by the thing that produced them, and there is NO
 * parent row in the database for that grouping: a channel, a radio station and
 * an event ARE the container, and `recordings.channel_id` / `recordings.event_id`
 * already carry the link (both indexed). Inventing a parent recording row would
 * duplicate identity that already exists, add a write path that can drift (create
 * a channel, forget the parent) and need its own retention lifecycle. A GROUP BY
 * gives the same answer and cannot get out of step.
 *
 * TYPE is derived here, not read from `recordings.kind`. `kind` records how the
 * capture is sliced (`event` = one bounded run, `channel_day` = per calendar day)
 * which is storage truth and says nothing about what the source IS. A radio
 * station is a channel with a radio_config, so its recordings are `channel_day`
 * and the old list showed radio stations as "CHANNEL DAY". The source knows what
 * it is; ask the source.
 *
 * STATUS is derived from what is RUNNING, never from the stored flag alone. See
 * reconcileStreamStatus() in the orchestrator: `channels.status` is a cache of a
 * live process and goes stale on a crash, so a row can claim 'live' with nothing
 * behind it. Here we ask the pipeline directly, so the badge is true even in the
 * seconds before reconciliation catches up.
 *
 * Sort and filter are server-side because the counts and the available range are
 * computed in SQL: sorting the page in the browser would sort one page of rows
 * by numbers the browser would have to recompute.
 */
const sourcesQuery = z.object({
  type: z.string().optional(),                    // csv: channel,radio,event
  q: z.string().optional(),
  sort: z.enum(['name', 'recorded', 'created', 'count', 'duration']).default('recorded'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  recordedFrom: z.coerce.number().int().nonnegative().optional(),
  recordedTo: z.coerce.number().int().positive().optional(),
  createdFrom: z.coerce.number().int().nonnegative().optional(),
  createdTo: z.coerce.number().int().positive().optional(),
  recordingNow: z.enum(['1', '0']).optional(),    // only sources capturing right now
});

recordingsRouter.get(
  '/sources',
  asyncHandler(async (req, res) => {
    const q = sourcesQuery.parse(req.query);
    const types = (q.type ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const wantAll = types.length === 0;
    const rows = await query<any>(
      `WITH src AS (
         SELECT c.id, c.name, c.created_at, c.group_id, c.status AS src_status,
                CASE WHEN c.radio_config IS NOT NULL THEN 'radio' ELSE 'channel' END AS type,
                c.brand_ref, c.recording_enabled, c.recording_retention_days AS retention_days,
                'channel'::text AS owner_kind
           FROM channels c
         UNION ALL
         SELECT e.id, e.name, e.created_at, e.group_id, e.status AS src_status,
                'event'::text AS type, NULL::text AS brand_ref, true AS recording_enabled,
                NULL::int AS retention_days, 'event'::text AS owner_kind
           FROM events e
       )
       SELECT s.id, s.name, s.type, s.owner_kind, s.brand_ref, s.created_at, s.src_status,
              s.recording_enabled, s.retention_days,
              count(r.id)::int                              AS recordings,
              min(r.start_epoch_ms)                         AS first_start_ms,
              max(COALESCE(r.end_epoch_ms, r.start_epoch_ms)) AS last_end_ms,
              max(r.start_epoch_ms)                         AS last_start_ms,
              COALESCE(sum(COALESCE(r.duration_ms, 0)), 0)  AS total_duration_ms,
              count(*) FILTER (WHERE r.status = 'recording')::int AS open_rows,
              min(r.expires_at) FILTER (WHERE r.expires_at IS NOT NULL) AS next_expiry
         FROM src s
         JOIN groups g ON g.id = s.group_id
         LEFT JOIN recordings r
                ON (s.owner_kind = 'channel' AND r.channel_id = s.id)
                OR (s.owner_kind = 'event'   AND r.event_id   = s.id)
        WHERE g.account_id = $1
          AND ($2::text IS NULL OR s.name ILIKE '%'||$2||'%')
          AND ($3::bigint IS NULL OR s.created_at >= to_timestamp($3::bigint/1000.0))
          AND ($4::bigint IS NULL OR s.created_at <= to_timestamp($4::bigint/1000.0))
        GROUP BY s.id, s.name, s.type, s.owner_kind, s.brand_ref, s.created_at,
                 s.src_status, s.recording_enabled, s.retention_days
       HAVING count(r.id) > 0
          AND ($5::bigint IS NULL OR max(COALESCE(r.end_epoch_ms, r.start_epoch_ms)) >= $5)
          AND ($6::bigint IS NULL OR min(r.start_epoch_ms) <= $6)`,
      [accountId(req), q.q?.trim() || null,
       q.createdFrom ?? null, q.createdTo ?? null, q.recordedFrom ?? null, q.recordedTo ?? null]
    );

    // LIVE TRUTH, per source. Radio runs in this process; anything else is only
    // capturing while it still holds an un-terminated instance.
    const { isRadioRunning } = await import('../services/radio/pipeline');
    const liveInstances = new Set(
      (await query<any>(
        `SELECT COALESCE(channel_id, event_id) AS id FROM instances WHERE terminated_at IS NULL`
      )).map((i: any) => i.id)
    );
    const out = rows
      .filter((r) => wantAll || types.includes(r.type))
      .map((r) => {
        const capturing = r.type === 'radio' ? isRadioRunning(r.id) : liveInstances.has(r.id);
        return {
          id: r.id,
          name: r.name,
          type: r.type as 'channel' | 'radio' | 'event',
          brandRef: r.brand_ref ?? null,
          createdAt: r.created_at,
          recordings: r.recordings,
          firstStartMs: r.first_start_ms != null ? Number(r.first_start_ms) : null,
          lastEndMs: r.last_end_ms != null ? Number(r.last_end_ms) : null,
          lastStartMs: r.last_start_ms != null ? Number(r.last_start_ms) : null,
          totalDurationMs: Number(r.total_duration_ms),
          // The badge. `open_rows` alone is the stale flag that produced
          // "RECORDING" on a dead station, so it only counts when something is
          // genuinely running.
          capturing,
          state: capturing ? 'recording' : (r.recording_enabled === false ? 'off' : 'idle'),
          retentionDays: r.retention_days ?? null,
          nextExpiry: r.next_expiry ?? null,
        };
      })
      .filter((r) => q.recordingNow !== '1' || r.capturing);

    const dir = q.dir === 'asc' ? 1 : -1;
    const key = (r: any) => {
      switch (q.sort) {
        case 'name': return r.name.toLowerCase();
        case 'created': return new Date(r.createdAt).getTime();
        case 'count': return r.recordings;
        case 'duration': return r.totalDurationMs;
        default: return r.lastEndMs ?? r.lastStartMs ?? 0;      // 'recorded'
      }
    };
    out.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka === kb) return a.name.localeCompare(b.name);
      return ka > kb ? dir : -dir;
    });
    res.json({ sources: out, counts: {
      all: out.length,
      channel: out.filter((r) => r.type === 'channel').length,
      radio: out.filter((r) => r.type === 'radio').length,
      event: out.filter((r) => r.type === 'event').length,
      capturing: out.filter((r) => r.capturing).length,
    } });
  })
);

/**
 * Channel roll-up for the Recordings > Channels tab: one row per channel that
 * has recordings, with the recording count, latest recording, and the channel's
 * retention rule. The admin drills into GET /?channelId=... from here.
 */
recordingsRouter.get(
  '/channels',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT c.id AS channel_id, c.name, c.recording_retention_days,
              count(r.id)::int AS recording_count,
              max(r.start_epoch_ms) AS last_recording_ms,
              min(r.expires_at) FILTER (WHERE r.expires_at IS NOT NULL) AS next_expiry
         FROM channels c
         JOIN groups g ON g.id = c.group_id
         LEFT JOIN recordings r ON r.channel_id = c.id
        WHERE g.account_id = $1
        GROUP BY c.id, c.name, c.recording_retention_days
       HAVING count(r.id) > 0
        ORDER BY c.name`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

async function fetchOwned(id: string, acct: string) {
  return one<any>(
    `SELECT r.*, COALESCE(c.name, e.name) AS source_name,
            CASE WHEN c.radio_config IS NOT NULL THEN 'radio'
                 WHEN c.id IS NOT NULL THEN 'channel' ELSE 'event' END AS source_type
     ${OWNED} WHERE r.id = $1 AND g.account_id = $2`, [id, acct]);
}

recordingsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('Recording not found');
    const vods = await query('SELECT * FROM vod_assets WHERE recording_id = $1 ORDER BY created_at', [
      req.params.id,
    ]);
    res.json({ ...row, vod_assets: vods });
  })
);

/** Publish the whole recording as a VOD asset (kind = full_event). */
recordingsRouter.post(
  '/:id/publish',
  asyncHandler(async (req, res) => {
    const body = z.object({ title: z.string().optional() }).parse(req.body);
    const rec = await fetchOwned(req.params.id, accountId(req));
    if (!rec) throw notFound('Recording not found');
    if (rec.end_epoch_ms == null) throw badRequest('Recording is still in progress');
    const owner = rec.event_id
      ? { col: 'event_id', id: rec.event_id }
      : { col: 'channel_id', id: rec.channel_id };
    const row = await one(
      `INSERT INTO vod_assets(${owner.col}, recording_id, kind, title, master_key,
                              start_epoch_ms, end_epoch_ms, duration_ms,
                              poster_key, storyboard_key, thumbs_vtt_key, thumb_status)
       VALUES ($1,$2,'full_event',$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::asset_media_status,'ready'))
       RETURNING *`,
      [
        owner.id,
        rec.id,
        body.title ?? rec.title ?? 'Full recording',
        rec.master_key ?? '',
        rec.start_epoch_ms,
        rec.end_epoch_ms,
        rec.duration_ms ?? rec.end_epoch_ms - rec.start_epoch_ms,
        rec.poster_key,
        rec.storyboard_key,
        rec.thumbs_vtt_key,
        rec.thumb_status,
      ]
    );
    res.status(201).json(row);
  })
);

/** Clip a time-range of the recording into a VOD asset (kind = clip). */
recordingsRouter.post(
  '/:id/clip',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        outputKind: z.enum(['manifest', 'progressive', 'both']).default('manifest'),
      })
      .parse(req.body);
    if (body.endMs <= body.startMs) throw badRequest('endMs must be after startMs');
    const rec = await fetchOwned(req.params.id, accountId(req));
    if (!rec) throw notFound('Recording not found');
    if (body.startMs < rec.start_epoch_ms || (rec.end_epoch_ms && body.endMs > rec.end_epoch_ms))
      throw badRequest('Clip range is outside the recording');
    const streamId = rec.channel_id ?? rec.event_id;

    // RESOLVE BEFORE PROMISING. The old path inserted a row naming files nobody
    // would write, so an impossible range still returned 201 and the operator
    // discovered the problem when the player failed. Now the range is checked
    // against the media on disk first and a bad one is refused here.
    const kind = isAudioOnly(streamId) ? 'audio' : 'video';
    const resolution = resolveRange(streamId, body.startMs, body.endMs, kind);
    const verdict = assessRange(resolution);
    if (!verdict.ok) throw badRequest(verdict.message);

    const row = await createClipVod({
      ownerCol: rec.event_id ? 'event_id' : 'channel_id',
      ownerId: rec.event_id ?? rec.channel_id,
      recordingId: rec.id,
      title: body.title,
      startMs: body.startMs,
      endMs: body.endMs,
      outputKind: body.outputKind,
      masterKeyBase: rec.master_key ?? 'vod',
    });

    // Formats follow the requested output kind, plus MP3 for audio-only sources
    // where a listener download is the obvious thing to want.
    const formats: OutputFormat[] = [];
    if (body.outputKind !== 'progressive') formats.push('hls');
    if (body.outputKind !== 'manifest') formats.push('mp4');
    if (!formats.length) formats.push('mp4');
    if (kind === 'audio') formats.push('mp3');

    const job = await enqueue({
      type: CLIP_EXTRACT,
      payload: { vodAssetId: row.id, streamId, fromMs: body.startMs, toMs: body.endMs, formats, kind },
      channelId: rec.channel_id, eventId: rec.event_id,
      // One clip per asset: a retried request returns the running job rather
      // than extracting the same range twice.
      dedupeKey: `clip.extract:${row.id}`,
      priority: 50,
    });

    res.status(202).json({
      ...row,
      jobId: job.id,
      state: job.state,
      resolution: {
        coveragePct: resolution.coveragePct,
        runs: resolution.runCount,
        blocks: resolution.blocks.length,
        segments: segmentCount(resolution),
        strategy: plan(resolution).strategy,
      },
    });
  })
);

/**
 * WHAT CAME OUT OF THIS RECORDING.
 *
 * The reverse of a clip's provenance, and the question retention has to ask
 * before it prunes anything: what did this capture produce that is still
 * published? Answered from the provenance chain rather than from the recording,
 * so it keeps working after the media itself is gone.
 */
recordingsRouter.get(
  '/:id/derived',
  asyncHandler(async (req, res) => {
    const rec = await fetchOwned(req.params.id, accountId(req));
    if (!rec) throw notFound('Recording not found');
    const assets = await clipsFromRecording(rec.id);
    res.json({
      recordingId: rec.id,
      assets,
      counts: {
        total: assets.length,
        published: assets.filter((a) => a.published).length,
      },
      // The line an operator needs before agreeing to a deletion.
      safeToPrune: assets.every((a) => !a.published),
    });
  })
);

/**
 * Download a recording as MP4.
 *
 * This endpoint could never succeed before: it read `rec.export_mp4_key`, a
 * column that does not exist on `recordings` (it is on `vod_assets`), so the
 * value was always undefined and the answer was always 202 "exporting" with
 * nothing exporting. The UI polled forever.
 *
 * A recording is not itself a file — it is a window over segments on disk — so
 * downloading one means extracting that window, which is exactly a clip. We
 * queue a real job and hand back its id to poll.
 */
recordingsRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const rec = await fetchOwned(req.params.id, accountId(req));
    if (!rec) throw notFound('Recording not found');
    const streamId = rec.channel_id ?? rec.event_id;

    // An export of this recording is a vod_asset over its whole window.
    const existing = await one<any>(
      `SELECT * FROM vod_assets
        WHERE recording_id = $1 AND kind = 'export'
        ORDER BY created_at DESC LIMIT 1`, [rec.id]
    );
    if (existing?.export_mp4_key) {
      return res.json({ status: 'ready', url: existing.export_mp4_key, assetId: existing.id });
    }

    const fromMs = Number(rec.start_epoch_ms);
    const toMs = rec.end_epoch_ms != null ? Number(rec.end_epoch_ms) : Date.now();
    const kind = isAudioOnly(streamId) ? 'audio' : 'video';
    const resolution = resolveRange(streamId, fromMs, toMs, kind);
    const verdict = assessRange(resolution, { maxGapMs: 30_000 });
    if (!verdict.ok) {
      return res.status(409).json({ status: 'unavailable', code: verdict.code, message: verdict.message });
    }

    const asset = existing ?? await one<any>(
      `INSERT INTO vod_assets(${rec.event_id ? 'event_id' : 'channel_id'}, recording_id, kind, title,
                              master_key, start_epoch_ms, end_epoch_ms, duration_ms,
                              output_kind, formats, thumb_status)
       VALUES ($1,$2,'export',$3,'',$4,$5,$6,'progressive',
               '{"hls":false,"dash":false,"progressive":true}'::jsonb,'processing')
       RETURNING *`,
      [rec.event_id ?? rec.channel_id, rec.id, rec.title ?? 'Export',
       fromMs, toMs, toMs - fromMs]
    );

    const job = await enqueue({
      type: CLIP_EXTRACT,
      payload: { vodAssetId: asset.id, streamId, fromMs, toMs,
                 formats: kind === 'audio' ? ['mp3', 'mp4'] : ['mp4'], kind },
      channelId: rec.channel_id, eventId: rec.event_id,
      dedupeKey: `clip.extract:${asset.id}`,
      priority: 80,
    });
    res.status(202).json({
      status: 'exporting', assetId: asset.id, jobId: job.id,
      message: 'Export queued. Poll /api/jobs/{jobId} for progress, then this endpoint for the URL.',
    });
  })
);

/**
 * Compose a clip from MULTIPLE recording ranges stitched into one timeline —
 * the multi-select timeline clipper in the admin. All segments must belong to
 * the same channel/event; the ordered ranges are stored as clip_spec for the
 * VOD extractor to stitch. Duration is the sum of the segment lengths.
 */
recordingsRouter.post(
  '/compose-clip',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string().min(1),
        outputKind: z.enum(['manifest', 'progressive', 'both']).default('manifest'),
        segments: z
          .array(
            z.object({
              recordingId: z.string().uuid(),
              startMs: z.number().int().nonnegative(),
              endMs: z.number().int().positive(),
            })
          )
          .min(1),
      })
      .parse(req.body);

    // load + authorise every referenced recording
    const recs = new Map<string, any>();
    for (const seg of body.segments) {
      if (seg.endMs <= seg.startMs) throw badRequest('each segment endMs must be after startMs');
      if (!recs.has(seg.recordingId)) {
        const r = await fetchOwned(seg.recordingId, accountId(req));
        if (!r) throw notFound(`Recording ${seg.recordingId} not found`);
        recs.set(seg.recordingId, r);
      }
      const r = recs.get(seg.recordingId);
      if (seg.startMs < r.start_epoch_ms || (r.end_epoch_ms && seg.endMs > r.end_epoch_ms))
        throw badRequest('a segment range is outside its recording');
    }
    // all segments must share one owner (channel or event)
    const owners = new Set(
      [...recs.values()].map((r) => r.channel_id ?? r.event_id)
    );
    if (owners.size !== 1) throw badRequest('all segments must come from the same channel/event');
    const first = recs.get(body.segments[0].recordingId);
    const owner = first.event_id
      ? { col: 'event_id', id: first.event_id }
      : { col: 'channel_id', id: first.channel_id };
    const duration = body.segments.reduce((a, s) => a + (s.endMs - s.startMs), 0);
    const spec = body.segments.map((s) => ({
      recording_id: s.recordingId,
      start_ms: s.startMs,
      end_ms: s.endMs,
    }));

    const base = `vod/compose-${Date.now()}`;
    const row = await one(
      `INSERT INTO vod_assets(${owner.col}, recording_id, kind, title, master_key,
                              start_epoch_ms, end_epoch_ms, duration_ms, clip_spec,
                              output_kind, formats, progressive_key, thumb_status)
       VALUES ($1,$2,'clip',$3,$4,$5,$6,$7,$8::jsonb,$9::clip_output_kind,$10::jsonb,$11,'processing') RETURNING *`,
      [
        owner.id,
        first.id,
        body.title,
        `${base}/master.m3u8`,
        body.segments[0].startMs,
        body.segments[body.segments.length - 1].endMs,
        duration,
        JSON.stringify(spec),
        body.outputKind,
        JSON.stringify(formatsFor(body.outputKind)),
        body.outputKind !== 'manifest' ? `${base}/progressive.mp4` : null,
      ]
    );
    // TODO: enqueue vod-extractor stitch job for the composed clip.
    res.status(201).json(row);
  })
);
