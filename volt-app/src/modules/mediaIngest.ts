import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { asyncHandler, notFound } from '../util/http';
import { requireIngestToken } from './status';

/**
 * Media ingest — the CPU thumbnailer job POSTs here (ingest-token auth, not a
 * user JWT) to register the keyscreen / storyboard / WebVTT it produced for a
 * recording or a VOD asset, once the outputs are in S3.
 */
export const mediaIngestRouter = Router();
mediaIngestRouter.use(requireIngestToken);

const thumbSchema = z.object({
  target: z.enum(['recording', 'vod']),
  id: z.string().uuid(),
  poster_key: z.string().optional(),
  storyboard_key: z.string().optional(),
  thumbs_vtt_key: z.string().optional(),
  status: z.enum(['processing', 'ready', 'error']).default('ready'),
});

mediaIngestRouter.post(
  '/thumbnails',
  asyncHandler(async (req, res) => {
    const b = thumbSchema.parse(req.body);
    const table = b.target === 'recording' ? 'recordings' : 'vod_assets';
    const rows = await query(
      `UPDATE ${table} SET
         poster_key     = COALESCE($2, poster_key),
         storyboard_key = COALESCE($3, storyboard_key),
         thumbs_vtt_key = COALESCE($4, thumbs_vtt_key),
         thumb_status   = $5
       WHERE id = $1 RETURNING id`,
      [b.id, b.poster_key ?? null, b.storyboard_key ?? null, b.thumbs_vtt_key ?? null, b.status]
    );
    if (rows.length === 0) throw notFound('Unknown media target');
    res.status(202).json({ ok: true });
  })
);
