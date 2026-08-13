import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { asyncHandler } from '../util/http';
import { probeSource } from '../services/sourceProbe';

export const sourcesRouter = Router();
sourcesRouter.use(requireAuth);

const ProbeBody = z.object({ url: z.string().min(1), protocol: z.string().optional() });

// POST /api/sources/probe  { url, protocol } -> received broadcast details
sourcesRouter.post('/probe', asyncHandler(async (req, res) => {
  const b = ProbeBody.parse(req.body);
  res.json(await probeSource(b.url, b.protocol));
}));
