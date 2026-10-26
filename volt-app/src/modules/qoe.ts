/**
 * PLAYBACK EXPERIENCE (QoE) REPORTS, for the console (QOE_REPORTING.md 4 to 8).
 * Mounted under the tenant analytics router: /api/analytics/qoe/...
 *
 *   GET  /overview     reports 1 to 10 and 12 for a window and filters
 *   GET  /sessions     the views behind the numbers, newest first (?problem=)
 *   GET  /sessions/:sid  report 11: one viewer's session, every report in order
 *   GET  /series       trend lines from the minute aggregates
 *   GET  /breakdown    worst segments: one dimension ranked by one measure
 *   GET  /dimensions   the values seen for every filter
 *   GET  /definitions  the definitions the numbers use (section 4)
 *   GET  /journeys     report 28: journey to play, app open to first frame as a funnel
 *   GET  /discovery    report 29: plays, watch time, completion and QoE by entry point (?by=detail per row)
 *   GET  /collector    what the collector holds in memory and its write health
 *   POST /replay       rebuild days from the raw reports (analytics manage)
 *
 * Window: ?from&to (ISO) or ?hours or ?days (default 1 day). Filters: any of
 * content_id, stream_type (live|vod), device_model, device_class, os,
 * os_version, browser, browser_version, app_name, app_version, sdk_version,
 * player_version, codec, cdn, country, region, asn, network, entry_point
 * (row, search, deeplink, push, epg, continue, related, other) and
 * session_depth (`2`, `3-5`, `6+`); values comma separated, `__none` for
 * "not reported". The journey reports take the app's own dimensions
 * (app_name, app_version, os, browser, device_class, country) and entry_point.
 *
 * Everything here reads the analytics database, except two small lookups in
 * the control plane's: content names, and the stitcher's server-side ad
 * beacons (ad_beacons, report 9 and the session timeline), both by index.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../util/http';
import { accountId } from '../auth/middleware';
import { query } from '../db';
import { breakdown, dimensionValues, FILTERS, listViews, MEASURES, overview, parseQuery, series, type BeaconSummary, type FilterName, type Measure, type ReportQuery } from '../services/qoe/reports';
import { sessionTimeline, type BeaconRow } from '../services/qoe/timeline';
import { replayRange } from '../services/qoe/replay';
import { collectorState } from '../services/qoe/collector';
import { DEFINITIONS_VERSION } from '../services/qoe/views';
import { discovery, journeyState, journeyToPlay } from '../services/qoe/journeys';

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

/**
 * What the stitcher's server-side beacons recorded for the account's channels
 * in the window (build queue 1.11): the server's side of report 9. Content
 * filters apply; viewer dimensions cannot (a beacon is not a view row).
 */
async function beaconSummary(acct: string, q: ReportQuery): Promise<BeaconSummary> {
  const p: unknown[] = [acct, q.from.toISOString(), q.to.toISOString()];
  let extra = '';
  const ids = (q.filters.content_id ?? []).filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (q.filters.content_id?.length) { p.push(ids); extra = ` AND b.channel_id = ANY($${p.length}::uuid[])`; }
  const r = await query<any>(
    `SELECT count(*) FILTER (WHERE b.event = 'impression' AND b.ok) AS impressions, count(*) FILTER (WHERE b.event = 'start' AND b.ok) AS starts,
       count(*) FILTER (WHERE b.event = 'firstQuartile' AND b.ok) AS q1, count(*) FILTER (WHERE b.event = 'midpoint' AND b.ok) AS mid,
       count(*) FILTER (WHERE b.event = 'thirdQuartile' AND b.ok) AS q3, count(*) FILTER (WHERE b.event = 'complete' AND b.ok) AS complete,
       count(*) FILTER (WHERE b.ok IS FALSE) AS failed, count(DISTINCT b.session_id) AS sessions
     FROM ad_beacons b JOIN channels c ON c.id = b.channel_id JOIN groups g ON g.id = c.group_id
     WHERE g.account_id = $1 AND b.created_at >= $2 AND b.created_at < $3${extra}`, p);
  const x = r[0] ?? {};
  return { impressions: Number(x.impressions ?? 0), starts: Number(x.starts ?? 0), firstQuartile: Number(x.q1 ?? 0), midpoint: Number(x.mid ?? 0),
    thirdQuartile: Number(x.q3 ?? 0), complete: Number(x.complete ?? 0), failed: Number(x.failed ?? 0), sessions: Number(x.sessions ?? 0) };
}

/** The beacons the stitcher sent for one viewer: its session is named <sid>_<random> (services/fast/delivery.ts). */
async function beaconsFor(acct: string, sid: string): Promise<BeaconRow[]> {
  const like = sid.replace(/[\\%_]/g, (c) => '\\' + c) + '\\_%';
  const rows = await query<any>(
    `SELECT b.due_at, b.event, b.ad_id, b.pod_index, b.ok, b.status, b.break_id
     FROM ad_beacons b JOIN channels c ON c.id = b.channel_id JOIN groups g ON g.id = c.group_id
     WHERE g.account_id = $1 AND (b.session_id = $2 OR b.session_id LIKE $3) ORDER BY b.due_at, b.id LIMIT 500`, [acct, sid, like]);
  return rows.map((b) => ({ at: new Date(b.due_at).toISOString(), event: b.event, adId: b.ad_id, podIndex: Number(b.pod_index), ok: b.ok, status: b.status, breakId: b.break_id }));
}

qoeRouter.get('/overview', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const q = parseQuery(req.query as any);
  res.json(await overview(acct, q, (ids) => contentNames(acct, ids), () => beaconSummary(acct, q)));
}));

qoeRouter.get('/sessions', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const problem = String(req.query.problem ?? 'all');
  if (!['all', 'failed', 'error', 'stalled', 'ad', 'exited'].includes(problem)) throw badRequest('problem must be one of all, failed, error, stalled, ad, exited');
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const rows = await listViews(acct, parseQuery(req.query as any), problem, limit);
  const names = await contentNames(acct, rows.map((r) => r.contentId).filter(Boolean) as string[]);
  res.json({ problem, items: rows.map((r) => ({ ...r, contentName: r.contentId ? names[r.contentId] ?? null : null })) });
}));

qoeRouter.get('/sessions/:sid', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const sid = String(req.params.sid);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(sid)) throw badRequest('not a session id');
  const t = await sessionTimeline(acct, sid, { beacons: (s) => beaconsFor(acct, s) });
  if (!t) { res.status(404).json({ error: 'no reports for this session in your account' }); return; }
  const ids = [...new Set(t.views.map((v: any) => v.content_id).filter(Boolean))] as string[];
  const names = await contentNames(acct, ids);
  res.json({ ...t, contentNames: names });
}));

qoeRouter.get('/journeys', asyncHandler(async (req, res) => {
  const q = parseQuery(req.query as any);
  res.json({ from: q.from.toISOString(), to: q.to.toISOString(), filters: q.filters, ...await journeyToPlay(accountId(req), q) });
}));

qoeRouter.get('/discovery', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const q = parseQuery(req.query as any);
  const by = String(req.query.by ?? 'entry');
  if (by !== 'entry' && by !== 'detail') throw badRequest('by must be entry or detail');
  const out = await discovery(acct, q, { by, limit: Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20)) });
  const names = await contentNames(acct, out.neverPlayed.map((d) => d.contentId));
  res.json({ from: q.from.toISOString(), to: q.to.toISOString(), filters: q.filters, ...out,
    neverPlayed: out.neverPlayed.map((d) => ({ ...d, contentName: names[d.contentId] ?? null })) });
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
    states: 'Every millisecond between two reports is one of: playing, rebuffering (involuntary stall), seeking, paused, backgrounded (wins over the others), ad (an ad break is on), or not counted (starting, preloading, ended). A gap over 60 s is not counted.',
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
      droppedFrames: 'dropped frames per minute of playing time (the player reports its running total); backgrounded time is not playing time',
      decoderErrors: 'errors the player reported at the decode step',
      gateDecision: 'what the play gate answered for a session id and why (geo, rights window, payment, sign in, group, the app\'s restrictions), timed on the server',
      licence: 'the DRM licence span of the startup, and the player\'s reports on licence requests (time to the last byte, failures)',
      tokenError: 'an error after the first frame where the server answered 401 or 403: the playback token stopped being accepted mid-view',
      liveLatency: 'how far behind the live edge the player was (ltc); drift is the last reading of a view minus the first',
      catchUp: 'share of playing time at a playback rate above 1 (the player catching up to the live edge)',
      adBreak: 'from the player\'s ad break start to its end; playing, stalls and buffering inside a break are the ad\'s, not the programme\'s',
      adStartup: 'break start to the ad playing (0 when it was already playing)',
      returnToContent: 'break end to the programme playing (0 when it was already playing)',
      leftDuringAd: 'views the viewer left (quit or went quiet) while a break was on',
      journeyToPlay: 'app sessions that opened in the window as a funnel: open, browse (a home, browse or search screen, a search, or a select from a row), detail (a detail screen), play pressed, entitled (the gate did not refuse, or refused only for payment), paid (no paywall needed, or a purchase succeeded), first frame. A session has reached a step when it got to it or to a later one; times are ms after the app opened. The gate and first frame steps read the play\'s view, so a play still going counts there once its view closes (quit, the end, an error, or a minute without reports), as for reports 1 to 10',
      entryPoint: 'where the journey to a play started: row (with its name and position), search, deeplink, push, epg, continue (continue watching), related, other',
      sessionDepth: 'screens the viewer saw in the app session before pressing play',
      discovery: 'per entry point: journeys, the share that led to a play and to a first frame, watch time, completion (views played to the end / started views) and the startup and buffering of those plays; detail pages viewed in an app session and never played in it',
      sessionTimeline: 'every report one session sent, in the player\'s order, with the gate\'s decisions and the stitcher\'s ad beacons for it; missing sequence numbers are listed',
    },
  });
});

qoeRouter.get('/collector', (_req, res) => { res.json({ ...collectorState(), journeys: journeyState() }); });

qoeRouter.post('/replay', asyncHandler(async (req, res) => {
  const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
  const to = b.to ?? b.day;
  if (Date.parse(to) - Date.parse(b.day) > 31 * 86_400_000) throw badRequest('replay at most 31 days at a time');
  res.json({ results: await replayRange(b.day, to, accountId(req)) });
}));
