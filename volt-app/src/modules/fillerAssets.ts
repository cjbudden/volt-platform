import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';

/**
 * Slates & Loops — uploaded filler assets, managed separately from VOD. A slate
 * is a still image; a loop is a short video. These are what a channel/event's
 * redundancy filler points at (channels/events.filler_asset_id) and what the
 * encoder encodes into the ladder on total input loss.
 *
 * Upload flow: POST / to register an asset and get a presigned S3 PUT URL, the
 * client uploads the bytes directly to S3, then PATCH status -> ready (in prod a
 * post-processing step probes dimensions/duration and produces a poster).
 */
export const fillerAssetsRouter = Router();
fillerAssetsRouter.use(requireAuth);

fillerAssetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const rows = await query(
      `SELECT * FROM filler_assets
        WHERE account_id = $1 AND ($2::text IS NULL OR kind = $2::filler_kind)
        ORDER BY created_at DESC`,
      [accountId(req), kind]
    );
    res.json(rows);
  })
);

const createSchema = z.object({
  kind: z.enum(['slate', 'loop']),
  name: z.string().min(1),
  contentType: z.string().default('application/octet-stream'),
});

/** Register a filler asset and return where to upload the bytes. */
fillerAssetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const row = await one<any>(
      `INSERT INTO filler_assets(account_id, kind, name, status) VALUES ($1,$2,$3,'uploading')
       RETURNING *`,
      [accountId(req), body.kind, body.name]
    );
    const sourceKey = `filler/${accountId(req)}/${row.id}`;
    await query('UPDATE filler_assets SET source_key = $2 WHERE id = $1', [row.id, sourceKey]);
    // presign is stubbed here; wire to S3 in the orchestrator layer.
    const uploadUrl = `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${sourceKey}`;
    res.status(201).json({ ...row, source_key: sourceKey, upload: { method: 'PUT', url: uploadUrl } });
  })
);

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['uploading', 'processing', 'ready', 'error']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
});

fillerAssetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = patchSchema.parse(req.body);
    const row = await one(
      `UPDATE filler_assets SET
         name = COALESCE($3, name),
         status = COALESCE($4, status),
         width = COALESCE($5, width),
         height = COALESCE($6, height),
         duration_ms = COALESCE($7, duration_ms),
         updated_at = now()
       WHERE id = $1 AND account_id = $2 RETURNING *`,
      [req.params.id, accountId(req), b.name ?? null, b.status ?? null, b.width ?? null, b.height ?? null, b.durationMs ?? null]
    );
    if (!row) throw notFound('Filler asset not found');
    res.json(row);
  })
);

fillerAssetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(
      `DELETE FROM filler_assets WHERE id = $1 AND account_id = $2 RETURNING id`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Filler asset not found');
    res.status(204).end();
  })
);
