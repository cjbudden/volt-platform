import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { config } from '../config';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';
import { defineList, parseList, whereSql, countWhereSql, countParams, pageSql, finishPage, onlyIdParam } from '../util/listQuery';

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

const FILLER_LIST = defineList({
  path: '/api/filler-assets',
  fields: {
    id: { sql: 'id', type: 'uuid' },
    name: { sql: 'name', type: 'string' },
    kind: { sql: 'kind', type: 'enum', values: ['slate', 'loop'] },
    status: { sql: 'status', type: 'enum', values: ['uploading', 'processing', 'ready', 'error'] },
    filename: { sql: 'filename', type: 'string' },
    content_type: { sql: 'content_type', type: 'string' },
    width: { sql: 'width', type: 'number' },
    height: { sql: 'height', type: 'number' },
    duration_ms: { sql: 'duration_ms', type: 'number' },
    bytes: { sql: 'bytes', type: 'number' },
    uploaded_at: { sql: 'uploaded_at', type: 'timestamp' },
    created_at: { sql: 'created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'updated_at', type: 'timestamp' },
  },
  search: ['name', 'filename'],
  defaultSort: '-created_at',
  unpagedLimit: 1000,
});

fillerAssetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params: unknown[] = [accountId(req)];
    const pl = parseList(FILLER_LIST, req.query, params);
    const where = `FROM filler_assets WHERE account_id = $1${whereSql(pl)}`;
    const whereCount = `FROM filler_assets WHERE account_id = $1${countWhereSql(pl)}`;  // totals ignore the cursor
    const rows = await query<any>(`SELECT * ${where} ${pageSql(pl)}`, params);
    const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${whereCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
    res.json(finishPage(req, res, pl, rows, total));
  })
);

/**
 * One item by id: the canonical "self" link that the JSON-LD + Hydra layer
 * (services/hypermedia.ts) gives every member, so a deep link resolves.
 * Same tenant scoping as the list. (20 Oct 2026)
 */
fillerAssetsRouter.get(
  '/:id',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const row = await one<any>(`SELECT * FROM filler_assets WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Filler asset not found');
    res.json(row);
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
