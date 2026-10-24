/**
 * PLAYBACK EXPERIENCE (QoE) REPORTS, for the console (QOE_REPORTING.md 4 to 8).
 * Mounted under the tenant analytics router: /api/analytics/qoe/...
 *
 *   GET  /overview     reports 1, 2, 3, 4, 10 and 12 for a window and filters
 *   GET  /series       trend lines from the minute aggregates
 *   GET  /breakdown    worst segments: one dimension ranked by one measure
 *   GET  /dimensions   the values seen for every filter
 *   GET  /definitions  the definitions the numbers use (section 4)
 *   GET  /collector    what the collector holds in memory and its write health
 *   POST /replay       rebuild days from the raw reports (analytics manage)
 *
 * Window: ?from&to (ISO) or ?hours or ?days (default 1 day). Filters: any of
 * content_id, stream_type (live|vod), device_model, device_class, os,
 * os_version, browser, browser_version, app_name, app_version, sdk_version,
 * player_version, codec, cdn, country, region, asn, network; values comma
 * separated, `__none` for "not reported".
 *
 * Everything here reads the analytics database, never the control plane's.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../util/http';
import { accountId } from '../auth/middleware';
import { query } from '../db';
import { breakdown, dimensionValues, FILTERS, MEASURES, overview, parseQuery, series, type FilterName, type Measure } from '../services/qoe/reports';
import { replayRange } from '../services/qoe/replay';
import { collectorState } from '../services/qoe/collector';
import { DEFINITIONS_VERSION } from '../services/qoe/views';

export const qoeRouter = Router();

/** Names for content ids: the account's channels, events and library assets. */
async function contentNames(acct: string, ids: string[]): Promise<Record<string, string>> {
  const uuids = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (!uuids.length) return {};
  const rows = await query<{ id: string; name: string }>(
    `SELECT c.id::text, c.name FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND c.id = ANY($2::uuid[])
     UNION ALL
     SELECT e.id::text, e.name FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = $1 AND e.id = ANY($2::uuid[])
     UNION ALL
     SELECT v.id::text, COALESCE(v.title, 'Untitled') FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id) WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.id = ANY($2::uuid[])`,
    [acct, uuids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

qoeRouter.get('/overview', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  res.json(await overview(acct, parseQuery(req.query as any), (ids) => contentNames(acct, ids)));
}));

qoeRouter.get('/series', asyncHandler(async (req, res) => {
  res.json(await series(accountId(req), parseQuery(req.query as any)));
}));

qoeRouter.get('/breakdown', asyncHandler(async (req, res) => {
  const by = String(req.query.by ?? 'device_model') as FilterName;
  const measure = String(req.query.measure ?? 'failure') as Measure;
  if (!(FILTERS as readonly string[]).includes(by)) throw badRequest(`by must be one of ${FILTERS.join(', ')}`);
  if (!(measure in MEASURES)) throw badRequest(`measure must be one of ${Object.keys(MEASURES).join(', ')}`);
  const minViews = Math.min(100_000, Math.max(1, Number(req.query.minViews ?? 20) || 20));
  const acct = accountId(req);
  const out = await breakdown(acct, parseQuery(req.query as any), by, measure, minViews);
  const names = by === 'content_id' ? await contentNames(acct, out.rows.map((r) => r.value).filter(Boolean) as string[]) : {};
  res.json({ ...out, rows: out.rows.map((r) => ({ ...r, name: r.value ? names[r.value] ?? null : null })) });
}));

qoeRouter.get('/dimensions', asyncHandler(async (req, res) => {
  res.json(await dimensionValues(accountId(req), parseQuery(req.query as any)));
}));

qoeRouter.get('/definitions', (_req, res) => {
  res.json({
    version: DEFINITIONS_VERSION,
    document: 'QOE_REPORTING.md section 4',
    view: 'A play attempt, opened when the viewer presses play (or autoplay begins), before entitlement. Closed at the end, on quit, on a fatal error, or after 60 s without reports; reports within 60 minutes resume it.',
    windows: 'Experience reports count a view by when it ended; engagement by when it started.',
    states: 'Every millisecond between two reports is one of: playing, rebuffering (involuntary stall), seeking, paused, backgrounded (wins over the others), or not counted (starting, preloading, ended). A gap over 60 s is not counted.',
    measures: {
      startupSuccess: 'views that reached a first frame / play attempts',
      startupFailure: 'attempts ending in a fatal error before the first frame / play attempts',
      ebff: 'attempts the viewer left before the first frame without an error / play attempts, split by how long they waited',
      failureAfterStart: 'views with a fatal error after the first frame / views that started',
      startupTime: 'play pressed to the first presented frame (the player\'s msd), started views only; its spans (entitlement, manifest, DRM licence, first segment, decode, other) add up to it',
      rebufferRatio: 'rebuffering time / (playing time + rebuffering time)',
      stallsPerHour: 'stalls / hours of playing time; a stall is an entry into rebuffering after the first frame',
      viewsWithStalls: 'started views with at least one stall / started views',
      timeToFirstStall: 'first stall minus first frame',
      timeWeightedBitrate: 'sum(kbps x playing ms) / playing ms with a known bitrate',
      oscillation: 'a bitrate switch that reverses the previous one within 10 s',
      exitAfterStallOrError: 'views the viewer left (quit or went quiet, not a natural end) within 30 s of a stall or a non-fatal error',
      eventLoss: 'reports missing from each session\'s sequence numbers / reports expected',
      percentiles: 'nearest rank: the value at rank ceil(q x n), with the number of views behind it',
      viewers: 'counted as sessions (one per play attempt id); counting signed-in people is an open decision',
    },
  });
});

qoeRouter.get('/collector', (_req, res) => { res.json(collectorState()); });

qoeRouter.post('/replay', asyncHandler(async (req, res) => {
  const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
  const to = b.to ?? b.day;
  if (Date.parse(to) - Date.parse(b.day) > 31 * 86_400_000) throw badRequest('replay at most 31 days at a time');
  res.json({ results: await replayRange(b.day, to, accountId(req)) });
}));
