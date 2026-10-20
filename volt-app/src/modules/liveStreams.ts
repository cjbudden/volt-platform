/**
 * THE STREAM AGGREGATE, read-only (services/streamModel.ts):
 *   GET /api/live-streams/presets                     the presets (origin x lifecycle)
 *   GET /api/live-streams/:kind/:id                   production + distribution planes, preset, provider tiers
 *   GET /api/live-streams/:kind/:id/schema.org        VideoObject + BroadcastEvent (+ SportsEvent) JSON-LD
 *   GET /api/live-streams/:kind/:id/provider          the source-provider contract, per tier
 * kind is channel or event. Tenant-scoped: another account's id is a 404.
 */
import { Router } from 'express';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { composeStream, PRESETS } from '../services/streamModel';

export const liveStreamsRouter = Router();
liveStreamsRouter.use(requireAuth);

liveStreamsRouter.get('/presets', (_req, res) => { res.json(PRESETS); });

const kindOf = (k: string) => {
  if (k !== 'channel' && k !== 'event') throw badRequest('kind must be channel or event');
  return k as 'channel' | 'event';
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(req: any) {
  const kind = kindOf(String(req.params.kind));
  if (!ID.test(String(req.params.id))) throw notFound('Stream not found');
  const s = await composeStream(kind, String(req.params.id), accountId(req));
  if (!s) throw notFound('Stream not found');
  return s;
}

liveStreamsRouter.get('/:kind/:id', asyncHandler(async (req, res) => { res.json(await load(req)); }));
liveStreamsRouter.get('/:kind/:id/schema.org', asyncHandler(async (req, res) => {
  res.type('application/ld+json').json((await load(req)).distribution.video_object);
}));
liveStreamsRouter.get('/:kind/:id/provider', asyncHandler(async (req, res) => { res.json((await load(req)).provider); }));
