// ============================================================================
//  TIMELINE & COVERAGE API
//
//  One call returns everything the three-lane timeline draws: what media exists
//  (and where it does not), which broadcast days the window crosses, which
//  daypart strips label it, and what was on air. Drawn from one response the
//  lanes cannot disagree with each other about where a boundary is — which they
//  would if each fetched separately and one of them was a request behind.
//
//  Bounded on purpose. A 24/7 channel with a long retention rule holds tens of
//  thousands of programmes; the lane is drawn for the VISIBLE window, and the
//  window is capped, so zooming out cannot turn into an unbounded query.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { resolveRange, assessRange, segmentCount } from '../services/clips/resolve';
import { plan } from '../services/clips/extract';
import { isAudioOnly, recordingSpans } from '../services/localRecordingIndex';
import { containersInRange, daysForChannel } from '../services/containers';
import { waveform, primeWaveformCache, isPriming } from '../services/waveform';
import {
  DAYPART_PRESETS, applyPreset, getDayparts, setDayparts, validateDayparts,
  stripsInRange, channelDayConfig, presetById,
} from '../services/dayparts';

export const timelineRouter = Router();
timelineRouter.use(requireAuth);

/** The widest window the timeline will answer for: 32 days. */
const MAX_WINDOW_MS = 32 * 86_400_000;

async function ownedChannel(req: any): Promise<any> {
  const row = await one<any>(
    `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!row) throw notFound('Channel not found');
  return row;
}

const windowQuery = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
});

function checkWindow(from: number, to: number) {
  if (to <= from) throw badRequest('`to` must be after `from`');
  if (to - from > MAX_WINDOW_MS) {
    throw badRequest(`Window too wide: ${Math.round((to - from) / 86_400_000)} days. ` +
                     `The timeline answers up to ${MAX_WINDOW_MS / 86_400_000} days at a time.`);
  }
}

/**
 * COVERAGE — what media actually exists across a window, and what does not.
 *
 * This is the question the clip flow asks before it promises anything, and the
 * one the timeline draws as gaps. It reports real spans measured from disk, not
 * the recording rows' declared windows: a row can claim an hour that a crash
 * meant was never written, and drawing the claim rather than the media is how
 * an operator ends up trimming into nothing.
 */
timelineRouter.get('/:id/coverage', asyncHandler(async (req, res) => {
  const ch = await ownedChannel(req);
  const q = windowQuery.parse(req.query);
  checkWindow(q.from, q.to);

  const kind = isAudioOnly(ch.id) ? 'audio' : 'video';
  const resolution = resolveRange(ch.id, q.from, q.to, kind);
  const verdict = assessRange(resolution);

  res.json({
    channelId: ch.id,
    window: { from: q.from, to: q.to, ms: q.to - q.from },
    coveragePct: resolution.coveragePct,
    coveredMs: resolution.coveredMs,
    effectiveFromMs: resolution.effectiveFromMs,
    effectiveToMs: resolution.effectiveToMs,
    runs: resolution.blocks.map((b) => ({
      runId: b.runId, blockIndex: b.blockIndex, rendition: b.rendition,
      startMs: b.startMs, endMs: b.endMs, segments: b.segments.length,
    })),
    runCount: resolution.runCount,
    gaps: resolution.gaps,
    segments: segmentCount(resolution),
    clippable: verdict.ok,
    reason: verdict.ok ? null : { code: verdict.code, message: verdict.message },
    strategy: plan(resolution).strategy,
  });
}));

/**
 * TIMELINE — the three lanes in one response.
 *
 * Lane 1 (media): run spans and gaps.
 * Lane 2 (time):  broadcast days and daypart strips, in the channel's own clock.
 * Lane 3 (what):  programmes that aired, as-run times preferred over scheduled.
 */
timelineRouter.get('/:id/timeline', asyncHandler(async (req, res) => {
  const ch = await ownedChannel(req);
  const q = windowQuery.parse(req.query);
  checkWindow(q.from, q.to);

  const cfg = await channelDayConfig(ch.id);
  const kind = isAudioOnly(ch.id) ? 'audio' : 'video';

  // ---- lane 1: media ------------------------------------------------------
  const resolution = resolveRange(ch.id, q.from, q.to, kind);

  // ---- lane 2: days and strips -------------------------------------------
  const days = await daysForChannel(ch.id, q.from, q.to);
  const defs = await getDayparts(ch.id);
  const strips = stripsInRange(days, defs, q.from, q.to);
  const containers = await containersInRange('channel', ch.id, q.from, q.to);

  // ---- lane 3: what was on ------------------------------------------------
  // Capped: a long window on a radio station can hold thousands of now-playing
  // rows, and the lane only needs what fits on screen.
  const programmes = await query<any>(
    `SELECT id, title, starts_at, ends_at, actual_start, actual_end, status,
            metadata->>'class' AS class, metadata->>'source' AS source
       FROM programmes
      WHERE channel_id = $1
        AND span && tstzrange(to_timestamp($2::bigint/1000.0), to_timestamp($3::bigint/1000.0), '[)')
      ORDER BY starts_at
      LIMIT 2000`,
    [ch.id, q.from, q.to]
  );

  res.json({
    channelId: ch.id,
    name: ch.name,
    window: { from: q.from, to: q.to, ms: q.to - q.from },
    clock: { tz: cfg.tz, anchorHour: cfg.anchorHour, presetId: cfg.presetId },
    kind,
    media: {
      coveragePct: resolution.coveragePct,
      runs: resolution.blocks.map((b) => ({
        runId: b.runId, blockIndex: b.blockIndex,
        startMs: b.startMs, endMs: b.endMs, segments: b.segments.length,
      })),
      runCount: resolution.runCount,
      gaps: resolution.gaps,
    },
    days: days.map((d) => ({
      day: d.day, startMs: d.startMs, endMs: d.endMs, hours: d.hours,
      // Surfaced so the UI can label a clock-change day rather than silently
      // drawing an hour that is not there.
      clockChange: d.hours !== 24 ? (d.hours === 23 ? 'forward' : 'back') : null,
    })),
    containers: containers.map((c) => ({
      id: c.id, day: c.broadcast_day, startMs: c.startsAtMs, endMs: c.endsAtMs,
      recordings: c.recordings, recordedMs: c.recordedMs, coveragePct: c.coveragePct,
      state: c.state,
    })),
    dayparts: strips,
    programmes: programmes.map((p) => ({
      id: p.id, title: p.title,
      startMs: new Date(p.actual_start ?? p.starts_at).getTime(),
      endMs: new Date(p.actual_end ?? p.ends_at).getTime(),
      asRun: p.actual_start != null,
      status: p.status, class: p.class ?? null, source: p.source ?? 'epg',
    })),
  });
}));

/**
 * WAVEFORM for an arbitrary window on a channel's timeline.
 *
 * For an audio source this IS the media lane. A flat block tells you a recording
 * exists; the waveform tells you where the speech stops and the song starts,
 * which is the whole job when you are looking for a clipping point.
 *
 * Per CHANNEL rather than per recording, because the timeline spans containers
 * and a capture boundary must not interrupt the picture. The underlying service
 * already works on a stream id and already spans runs.
 *
 * Bucket count follows the pixels the caller is drawing into, so it never
 * decodes more detail than can be seen. The service picks EXACT mode for a
 * window under fifteen minutes and a sampled pass beyond that, with a per-run
 * peak cache behind both.
 */
timelineRouter.get('/:id/waveform', asyncHandler(async (req, res) => {
  const ch = await ownedChannel(req);
  const q = windowQuery.extend({
    buckets: z.coerce.number().int().min(16).max(1200).default(600),
    prime: z.enum(['0', '1']).optional(),
  }).parse(req.query);
  checkWindow(q.from, q.to);

  const wf = await waveform(ch.id, q.from, q.to, q.buckets);

  // A wide window answers from whatever the cache holds and reports what is
  // still missing, rather than blocking the request until every segment has
  // been decoded. The client redraws when the priming pass lands.
  if (q.prime === '1' && !wf.complete) primeWaveformCache(ch.id, q.from, q.to);

  res.json({
    channelId: ch.id,
    from: wf.from, to: wf.to, bucketMs: wf.bucketMs,
    mode: wf.mode, complete: wf.complete, pending: wf.pending,
    priming: isPriming(ch.id),
    buckets: wf.buckets,
  });
}));

// ---------------------------------------------------------------- dayparts
timelineRouter.get('/:id/dayparts', asyncHandler(async (req, res) => {
  const ch = await ownedChannel(req);
  const cfg = await channelDayConfig(ch.id);
  res.json({
    channelId: ch.id,
    presetId: cfg.presetId,
    tz: cfg.tz,
    anchorHour: cfg.anchorHour,
    dayparts: await getDayparts(ch.id),
  });
}));

const daypartsBody = z.object({
  presetId: z.string().optional(),
  dayparts: z.array(z.object({
    name: z.string().min(1),
    startsLocal: z.string(),
    daysMask: z.number().int().min(0).max(127).optional(),
  })).optional(),
  tz: z.string().optional(),
  anchorHour: z.number().int().min(0).max(23).optional(),
});

timelineRouter.put('/:id/dayparts', asyncHandler(async (req, res) => {
  const ch = await ownedChannel(req);
  const body = daypartsBody.parse(req.body);

  if (body.tz || body.anchorHour != null) {
    // Changing these affects only FUTURE containers: existing ones carry their
    // own frozen copy, so history does not reshuffle under an edit.
    await query(
      `UPDATE channels SET tz = COALESCE($2, tz),
              broadcast_anchor_hour = COALESCE($3, broadcast_anchor_hour),
              updated_at = now()
        WHERE id = $1`,
      [ch.id, body.tz ?? null, body.anchorHour ?? null]
    );
  }

  if (body.presetId) {
    if (!presetById(body.presetId)) throw badRequest(`Unknown preset: ${body.presetId}`);
    const applied = await applyPreset(ch.id, body.presetId);
    return res.json({ channelId: ch.id, presetId: body.presetId, dayparts: applied });
  }
  if (body.dayparts) {
    const v = validateDayparts(body.dayparts);
    if (!v.ok) throw badRequest(v.message);
    const saved = await setDayparts(ch.id, body.dayparts, undefined);
    return res.json({ channelId: ch.id, presetId: null, dayparts: saved });
  }
  res.json({ channelId: ch.id, dayparts: await getDayparts(ch.id) });
}));

/** The presets themselves, for the settings form. Not channel-scoped. */
export const daypartPresetsRouter = Router();
daypartPresetsRouter.use(requireAuth);
daypartPresetsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ presets: DAYPART_PRESETS });
}));
