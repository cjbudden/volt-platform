import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';

export const profilesRouter = Router();
profilesRouter.use(requireAuth);

profilesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query('SELECT * FROM output_profiles WHERE account_id = $1 ORDER BY created_at DESC', [accountId(req)]);
    res.json(rows);
  })
);

const rung = z.object({
  height: z.number(),
  bitrate_kbps: z.number(),
  fps: z.number().default(30),
  codec: z.string().default('h264'),
});

const createSchema = z.object({
  name: z.string().min(1),
  rungs: z.array(rung).min(1),
  packaging: z.enum(['hls', 'dash', 'both']).default('both'),
  workflowType: z.enum(['transcode', 'package_only']).default('transcode'),
  codecBackend: z.enum(['x264', 'nvenc']).default('nvenc'),
  segmentDur: z.number().default(4),
  dvrWindowSec: z.number().default(300),
  retentionDays: z.number().default(30),
  captionOffsetSec: z.number().default(0),
  drmEnabled: z.boolean().default(false),
  overlays: z.array(z.any()).default([]),
});

profilesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    const row = await one(
      `INSERT INTO output_profiles
         (account_id, name, rungs, packaging, workflow_type, codec_backend,
          segment_dur, dvr_window_sec, retention_days, caption_offset_sec, drm_enabled, overlays)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        accountId(req), b.name, JSON.stringify(b.rungs), b.packaging, b.workflowType, b.codecBackend,
        b.segmentDur, b.dvrWindowSec, b.retentionDays, b.captionOffsetSec, b.drmEnabled, JSON.stringify(b.overlays),
      ]
    );
    res.status(201).json(row);
  })
);

profilesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one('DELETE FROM output_profiles WHERE id = $1 AND account_id = $2 RETURNING id', [
      req.params.id,
      accountId(req),
    ]);
    if (!row) throw notFound('Profile not found');
    res.status(204).end();
  })
);
