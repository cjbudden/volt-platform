import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../util/http';
import { probeSource, probeUrlProblem } from '../services/sourceProbe';
import { inspectHls } from '../services/hlsMaster';
import { validateSource } from '../services/sourceValidate';

export const sourcesRouter = Router();
sourcesRouter.use(requireAuth);

const ProbeBody = z.object({ url: z.string().min(1), protocol: z.string().optional() });

// POST /api/sources/probe  { url, protocol } -> received broadcast details
sourcesRouter.post('/probe', asyncHandler(async (req, res) => {
  const b = ProbeBody.parse(req.body);
  res.json(await probeSource(b.url, b.protocol));
}));

// POST /api/sources/validate  { url, protocol } -> is it playable as it is?
// Icecast, HLS and DASH are answered from the protocol itself over plain HTTP
// (no ffprobe): connect, read the playlist or manifest, fetch the start of a
// segment or a few KB of audio and recognise it. Icecast also returns the
// station's own ICY metadata. See services/sourceValidate.ts.
sourcesRouter.post('/validate', asyncHandler(async (req, res) => {
  const b = z.object({ url: z.string().min(1).max(4000), protocol: z.string().max(32).optional() }).parse(req.body);
  res.json(await validateSource(b.url, b.protocol));
}));

// POST /api/sources/hls  { url } -> the HLS playlist at that address: master
// (variants and renditions, to choose one) or media, and any redirect. Reads
// the playlist text only, so it is quick enough to run as the URL is typed.
let hlsInFlight = 0;
sourcesRouter.post('/hls', asyncHandler(async (req, res) => {
  const b = z.object({ url: z.string().min(1).max(4000) }).parse(req.body);
  const problem = probeUrlProblem(b.url);
  if (problem) { res.json({ ok: false, error: problem }); return; }
  if (!/^https?:/i.test(b.url.trim())) { res.json({ ok: false, error: 'HLS playlists are read over http or https.' }); return; }
  if (hlsInFlight >= 8) { res.json({ ok: false, error: 'Several playlists are being read already. Try again in a moment.' }); return; }
  hlsInFlight++;
  try { res.json(await inspectHls(b.url)); } finally { hlsInFlight--; }
}));
