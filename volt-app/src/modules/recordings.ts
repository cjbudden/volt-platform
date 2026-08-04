import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { createClipVod, formatsFor } from '../services/clips';

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

recordingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
    const rows = await query(
      `SELECT r.*, COALESCE(c.name, e.name) AS source_name,
              (SELECT count(*)::int FROM vod_assets v WHERE v.recording_id = r.id) AS vod_count
       ${OWNED}
       WHERE g.account_id = $1
         AND ($2::text IS NULL OR r.kind = $2::recording_kind)
         AND ($3::uuid IS NULL OR r.channel_id = $3)
       ORDER BY r.start_epoch_ms DESC`,
      [accountId(req), kind, channelId]
    );
    res.json(rows);
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
  return one<any>(`SELECT r.* ${OWNED} WHERE r.id = $1 AND g.account_id = $2`, [id, acct]);
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
    res.status(201).json(row);
  })
);

/**
 * Download a recording. Returns a URL to the MP4 export (presign stubbed here;
 * wire to S3 in the orchestrator). A large recording is exported to MP4
 * asynchronously; if no export exists yet we report that so the UI can poll.
 */
recordingsRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const rec = await fetchOwned(req.params.id, accountId(req));
    if (!rec) throw notFound('Recording not found');
    const key = rec.export_mp4_key ?? null;
    if (!key) {
      return res.status(202).json({
        status: 'exporting',
        message: 'MP4 export queued; poll this endpoint until a url is returned.',
      });
    }
    const url = `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;
    res.json({ status: 'ready', url });
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
