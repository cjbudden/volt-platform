// ============================================================================
//  ENCODER THUMBNAILS API (docs/THUMBNAILS.md).
//
//  GET  /api/thumbnails/storyboard?stream[&from&to][&prime=1] sheets + tiles for hover previews (default: last hour)
//  GET  /api/thumbnails/vtt?stream&from&to                   WebVTT for any span, timed from `from`
//  GET  /api/thumbnails/recordings/:id.vtt                   a recording's WebVTT
//  GET  /api/thumbnails/vod/:id.vtt                          a clip's WebVTT (re-timed to the clip)
//  GET  /api/thumbnails/status?stream&from&to                which hours are built
//  POST /api/thumbnails/build {stream, from, to}             build (or finish) older hours now
//  GET  /api/thumbnails/sprites[?asset|stream&from&to]        the sprite inventory: files, bytes, and the rows asked for
//
//  All answers are scoped to the caller's account. Sheet URLs are signed image
//  service URLs, cached at the CDN; the VTTs are text and never cached long.
// ============================================================================
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound } from '../util/http';
import { config } from '../config';
import { buildRangeInBackground, layoutOf, sheetUrl, streamInfo, unitsFor } from '../services/thumbnails/builder';
import { clipPieces, recordingPieces, vttForRange } from '../services/thumbnails/clips';
import { fileVttFor } from '../services/thumbnails/fileSprites';
import { spriteUsage } from '../services/thumbnails/spriteStore';
import { query } from '../db';
import { signedImageUrl } from './images';
import { listRuns } from '../services/localRecordingIndex';

export const thumbnailsRouter = Router();
thumbnailsRouter.use(requireAuth);

const MAX_SPAN_MS = 48 * 3600_000;

function span(q: Record<string, string>, maxMs = MAX_SPAN_MS) {
  // Neither given: the last hour.
  if (q.from === undefined && q.to === undefined) { const now = Date.now(); return { from: now - 3600_000, to: now }; }
  const from = Number(q.from), to = Number(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw badRequest('from and to are epoch milliseconds, to > from');
  if (to - from > maxMs) throw badRequest(`at most ${Math.round(maxMs / 3600_000)} hours per request`);
  return { from, to };
}

async function ownStream(req: Request, id: string | undefined) {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('stream is a channel or event id');
  const s = await streamInfo(id);
  if (!s || s.accountId !== accountId(req)) throw notFound('No such channel or event');
  return s;
}

/** Sheets and filled tiles for hover previews over [from, to). */
thumbnailsRouter.get('/storyboard', asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const s = await ownStream(req, q.stream);
  const { from, to } = span(q);
  const units = await unitsFor(s.id, from, to);
  const l = layoutOf();
  const sheets = units.flatMap((u) => u.sheets.filter((sh) => sh.filled.length).map((sh) => ({
    url: sheetUrl(sh.key, sh.filled.length, u),
    startMs: sh.start_ms,
    endMs: Math.min(sh.start_ms + sh.slots * u.intervalMs, u.unitEnd),
    intervalMs: u.intervalMs, cols: u.cols, tileW: u.tileW, tileH: u.tileH,
    filled: sh.filled,
  }))).filter((sh) => sh.endMs > from && sh.startMs < to);

  // Hours with material and no storyboard yet (older than the scheduler's
  // look-back): build them in the background when asked to.
  let priming = false;
  if (q.prime === '1' && config.thumbnails.enabled) {
    const built = new Set(units.filter((u) => u.status === 'complete').map((u) => u.unitStart));
    const missing = units.length === 0 || units.some((u) => !built.has(u.unitStart));
    if (missing && listRuns(s.id).length) priming = buildRangeInBackground(s.id, from, to);
  }
  res.setHeader('Cache-Control', 'private, max-age=15');
  res.json({
    stream: s.id, from, to, tileW: l.tileW, tileH: l.tileH, intervalMs: l.intervalMs, priming,
    units: units.map((u) => ({ start: u.unitStart, end: u.unitEnd, status: u.status, folder: u.folder })),
    sheets,
  });
}));

function sendVtt(res: any, vtt: string) {
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.send(vtt);
}

thumbnailsRouter.get('/vtt', asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const s = await ownStream(req, q.stream);
  const { from, to } = span(q, 7 * 86400_000);
  sendVtt(res, (await vttForRange(s.id, [{ from, to, offset: 0 }])).vtt);
}));

thumbnailsRouter.get('/recordings/:id.vtt', asyncHandler(async (req, res) => {
  const r = await recordingPieces(req.params.id, accountId(req));
  if (!r) throw notFound('No such recording');
  sendVtt(res, (await vttForRange(r.streamId, r.pieces)).vtt);
}));

thumbnailsRouter.get('/vod/:id.vtt', asyncHandler(async (req, res) => {
  // An uploaded file: its own sprite sheets (services/thumbnails/fileSprites.ts).
  const own = await fileVttFor(req.params.id, accountId(req));
  if (own) return sendVtt(res, own);
  const c = await clipPieces(req.params.id, accountId(req));
  if (!c) throw notFound('No such VOD asset');
  sendVtt(res, (await vttForRange(c.streamId, c.pieces)).vtt);
}));

thumbnailsRouter.get('/status', asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const s = await ownStream(req, q.stream);
  const to = Number(q.to) || Date.now(), from = Number(q.from) || to - 24 * 3600_000;
  const units = await unitsFor(s.id, from, to);
  res.json({
    stream: s.id, folder: `thumbnails/${s.slug}`, tz: s.tz,
    hours: units.map((u) => ({
      start: u.unitStart, end: u.unitEnd, status: u.status, folder: u.folder,
      tiles: u.sheets.reduce((n, x) => n + x.filled.length, 0),
      gaps: u.sheets.reduce((n, x) => n + (x.skipped?.length ?? 0), 0), sheets: u.sheets.length,
    })),
  });
}));

const buildSchema = z.object({ stream: z.string().uuid(), from: z.number(), to: z.number() });

thumbnailsRouter.post('/build', asyncHandler(async (req, res) => {
  const b = buildSchema.parse(req.body);
  const s = await ownStream(req, b.stream);
  if (b.to <= b.from || b.to - b.from > 7 * 86400_000) throw badRequest('from..to must be a forward span of at most 7 days');
  const started = buildRangeInBackground(s.id, b.from, b.to);
  res.status(202).json({ started, alreadyRunning: !started, stream: s.id, from: b.from, to: b.to });
}));

/**
 * The sprite inventory (sprite_sheets, migration 0112). Sprite sheets are not in the Image
 * Library; this is where they are counted and listed. No filter: the account's totals by owner.
 * `asset`: that asset's sheets and VTT. `stream` (with from/to, default the last day): its hours' files.
 */
thumbnailsRouter.get('/sprites', asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const acct = accountId(req);
  const usage = await spriteUsage(acct);
  const totals = { files: usage.reduce((n, u) => n + u.files, 0), bytes: usage.reduce((n, u) => n + u.bytes, 0) };
  let rows: any[] = [];
  if (q.asset) {
    if (!/^[0-9a-f-]{36}$/i.test(q.asset)) throw badRequest('asset is a VOD asset id');
    rows = await query(`SELECT * FROM sprite_sheets WHERE account_id = $1 AND vod_asset_id = $2 ORDER BY kind, start_ms NULLS LAST, store_key`, [acct, q.asset]);
  } else if (q.stream) {
    const s = await ownStream(req, q.stream);
    const to = Number(q.to) || Date.now(), from = Number(q.from) || to - 24 * 3600_000;
    if (to <= from || to - from > 7 * 86400_000) throw badRequest('from..to must be a forward span of at most 7 days');
    rows = await query(`SELECT * FROM sprite_sheets WHERE account_id = $1 AND stream_id = $2 AND start_ms >= $3 AND start_ms < $4
                         ORDER BY start_ms, kind LIMIT 2000`, [acct, s.id, from, to]);
  }
  res.setHeader('Cache-Control', 'private, max-age=15');
  res.json({
    usage, totals,
    items: rows.map((r) => ({
      id: r.id, ownerKind: r.owner_kind, kind: r.kind, key: r.store_key,
      streamId: r.stream_id, storyboardId: r.storyboard_id, assetId: r.vod_asset_id,
      startMs: r.start_ms == null ? null : Number(r.start_ms), intervalMs: r.interval_ms, tiles: r.tiles,
      width: r.width, height: r.height, bytes: Number(r.size_bytes), updatedAt: r.updated_at,
      url: r.kind === 'sheet' && r.width && r.height ? signedImageUrl(r.store_key, `${r.width}x${r.height},fill,fmt=jpeg,q=85,v=${r.tiles}`) : null,
    })),
  });
}));
