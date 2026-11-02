// ============================================================================
//  FRAME-ACCURATE ACCESS (build queue 3.2 (a) and (b)). services/frames/.
//
//  GET /api/vod/{id}/frame-index         the asset's frame index: rate, frame
//                                        count, first and last timecode
//  GET /api/vod/{id}/frame               one exact frame: ?n= | ?tc= | ?ms=
//  GET /api/recordings/{id}/frame        one exact frame: ?n= | ?ms= | ?at=
//
//  Under the vod and recordings prefixes on purpose: the permission map
//  (auth/roles.ts) then gives them Media library: view and Recordings: view,
//  the same as playing the asset or the recording.
//
//  A frame answer names the frame, its timecode and time, where it sits (the
//  segment and the frame inside it), and a signed image URL at the width asked
//  for (?w=, default 640). The still behind the URL is decoded once and kept
//  (services/frames/store.ts); every width comes from the image service and is
//  cached there. ?redirect=1 answers 302 to the image instead, for an <img>.
//
// ============================================================================
import { Router, type Request, type Response } from 'express';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { one } from '../db';
import { signedImageUrl } from './images';
import {
  assetFrameStill, buildAssetFrameIndex, loadAssetFrameIndex, streamFrameAt, streamFrameStill, type StoredIndex,
} from '../services/frames/store';
import { frameAtMs, isDropFrame, msOfFrame, parseTimecode, timecode, fps, type Rate } from '../services/frames/frameIndex';
import { FrameError } from '../services/frames/exactFrame';

export const vodFramesRouter = Router();
vodFramesRouter.use(requireAuth);
export const recordingFramesRouter = Router();
recordingFramesRouter.use(requireAuth);

const MAX_W = 4096;

function width(req: Request): number {
  const w = req.query.w == null ? 640 : Number(req.query.w);
  if (!Number.isInteger(w) || w < 16 || w > MAX_W) throw badRequest(`w must be a whole number of pixels from 16 to ${MAX_W}`);
  return w;
}

function imageFor(key: string, w: number) {
  return { width: w, url: signedImageUrl(key, { width: w, fit: 'inside', format: 'jpeg', quality: 90 }) };
}

function rateOut(r: Rate) {
  return { num: r.num, den: r.den, fps: Math.round(fps(r) * 1000) / 1000, dropFrame: isDropFrame(r) };
}

function send(req: Request, res: Response, body: any) {
  if (req.query.redirect === '1' || req.query.redirect === 'true') { res.redirect(302, body.image.url); return; }
  res.json(body);
}

/** FrameError carries its own status; everything else is the usual 500. */
function framesHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return asyncHandler(async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof FrameError) { res.status(e.status).json({ error: e.message }); return; }
      throw e;
    }
  });
}

async function ownedAsset(req: Request): Promise<{ id: string; account_id: string; title: string | null }> {
  const a = await one<any>(
    `SELECT v.id, v.title, COALESCE(g.account_id, v.account_id) AS account_id
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id::text = $1 AND COALESCE(g.account_id, v.account_id) = $2`,
    [String(req.params.id), accountId(req)]);
  if (!a) throw notFound('Asset not found');
  return a;
}

/** The stored index, or a 409 that says it is being made (and queues it). */
async function readyIndex(assetId: string): Promise<StoredIndex> {
  const s = await loadAssetFrameIndex(assetId);
  if (!s) {
    await (await import('../services/jobs/handlers/frameIndex')).queueFrameIndex(assetId);
    throw new FrameError(409, 'the frame index is being made; ask again in a few seconds');
  }
  if (s.state !== 'ready' || !s.index) throw new FrameError(409, s.error ?? 'this asset has no frame index');
  return s;
}

function indexSummary(s: StoredIndex) {
  const i = s.index;
  return {
    state: s.state, note: s.error, builtAt: s.builtAt,
    ...(i ? {
      rate: rateOut(i.rate), totalFrames: i.totalFrames, durationMs: i.durationMs,
      firstTimecode: timecode(i.rate, 0), lastTimecode: timecode(i.rate, Math.max(0, i.totalFrames - 1)),
      segments: i.segments.length, container: i.container,
    } : {}),
  };
}

vodFramesRouter.get('/:id/frame-index', framesHandler(async (req, res) => {
  const a = await ownedAsset(req);
  let s = await loadAssetFrameIndex(a.id);
  // ?build=1 makes it now (the console's "Index now"; a few seconds for a film).
  if (req.query.build === '1' || req.query.build === 'true') s = await buildAssetFrameIndex(a.id);
  if (!s) {
    await (await import('../services/jobs/handlers/frameIndex')).queueFrameIndex(a.id);
    res.json({ assetId: a.id, state: 'queued' });
    return;
  }
  res.json({ assetId: a.id, ...indexSummary(s) });
}));

vodFramesRouter.get('/:id/frame', framesHandler(async (req, res) => {
  const a = await ownedAsset(req);
  const w = width(req);
  const s = await readyIndex(a.id);
  const rate = s.index!.rate;
  let n: number | null;
  if (req.query.n != null) n = Number(req.query.n);
  else if (req.query.tc != null) {
    n = parseTimecode(rate, String(req.query.tc));
    if (n == null) throw badRequest(`tc must be HH:MM:SS${isDropFrame(rate) ? ';' : ':'}FF at ${rateOut(rate).fps} fps`);
  } else if (req.query.ms != null) {
    const ms = Number(req.query.ms);
    if (!Number.isFinite(ms) || ms < 0) throw badRequest('ms must be a time from 0');
    n = frameAtMs(rate, ms);
  } else throw badRequest('say which frame: n (frame number), tc (timecode) or ms (time)');
  if (!Number.isInteger(n)) throw badRequest('n must be a whole frame number');
  const still = await assetFrameStill(a.account_id, a.id, s, n!);
  send(req, res, {
    assetId: a.id, frame: n, timecode: timecode(rate, n!), ms: Math.round(msOfFrame(rate, n!) * 1000) / 1000,
    totalFrames: s.index!.totalFrames, rate: rateOut(rate),
    segment: { index: still.located.segmentIndex, uri: still.located.segment.uri, frame: still.located.localFrame },
    cache: still.cache, image: imageFor(still.key, w),
  });
}));

recordingFramesRouter.get('/:id/frame', framesHandler(async (req, res) => {
  const r = await one<any>(
    `SELECT r.id, r.channel_id, r.event_id, r.start_epoch_ms, r.end_epoch_ms, g.account_id
       FROM recordings r
       LEFT JOIN channels c ON c.id = r.channel_id
       LEFT JOIN events   e ON e.id = r.event_id
       JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE r.id::text = $1 AND g.account_id = $2`, [String(req.params.id), accountId(req)]);
  if (!r) throw notFound('Recording not found');
  const w = width(req);
  const streamId = r.channel_id ?? r.event_id;
  const start = Number(r.start_epoch_ms);
  const end = r.end_epoch_ms == null ? null : Number(r.end_epoch_ms);
  // A recording's frames are counted from its start at the capture's rate,
  // so the rate is read first from the frame at the start.
  let at: number;
  if (req.query.at != null) at = Number(req.query.at);
  else if (req.query.ms != null) at = start + Number(req.query.ms);
  else if (req.query.n != null) {
    const n = Number(req.query.n);
    if (!Number.isInteger(n) || n < 0) throw badRequest('n must be a whole frame number from 0');
    const first = await streamFrameAt(streamId, start);
    if (!first) throw new FrameError(404, 'the recording has no picture at its start to count frames from');
    at = start + msOfFrame(first.rate, n);
  } else throw badRequest('say which frame: n (frame number from the start), ms (time from the start) or at (wall clock, epoch ms)');
  if (!Number.isFinite(at)) throw badRequest('the time must be a number');
  if (at < start || (end != null && at >= end)) throw new FrameError(404, 'that moment is outside the recording');
  const fr = await streamFrameAt(streamId, at);
  if (!fr) throw new FrameError(404, 'the recording has no picture at that moment (a gap in the capture)');
  const still = await streamFrameStill(r.account_id, streamId, fr);
  const n = frameAtMs(fr.rate, fr.wallMs - start);
  send(req, res, {
    recordingId: r.id, frame: n, timecode: timecode(fr.rate, n), ms: Math.round((fr.wallMs - start) * 1000) / 1000,
    wallMs: Math.round(fr.wallMs * 1000) / 1000, rate: rateOut(fr.rate),
    segment: { run: fr.runId, rendition: fr.rendition, seq: fr.seq, frame: fr.localFrame },
    cache: still.cache, image: imageFor(still.key, w),
  });
}));
