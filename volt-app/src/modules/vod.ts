import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { validateMetadata, SchemaField } from '../services/metadataValidator';
import { videoObjectFromAsset } from '../services/schemaOrg';
import { traceClip } from '../services/clips/provenance';
import { decide, historyOf as reviewHistory, publishGate, queue as reviewQueue, IllegalReview } from '../services/review';
import { qcFindings } from '../services/qc';
import { enqueue } from '../services/jobs/queue';
import { QC_RUN } from '../services/jobs/handlers/qcRun';
import { originBaseFor } from '../services/liveOrigin';
import { actorId, actorLabel } from '../util/actor';

/**
 * VOD Library — assets DERIVED from a recording (auto-published, clips, exports).
 * Carries publishing state, keyscreen/storyboard, and custom metadata validated
 * against an assigned named schema (modules/metadataSchemas.ts).
 */
export const vodRouter = Router();
vodRouter.use(requireAuth);

const OWNED = `
  FROM vod_assets v
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN events   e ON e.id = v.event_id
  JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
`;

vodRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const published =
      req.query.published === 'true' ? true : req.query.published === 'false' ? false : null;
    const rows = await query(
      `SELECT v.*, ms.name AS schema_name, COALESCE(c.name, e.name) AS source_name
       ${OWNED}
       LEFT JOIN metadata_schemas ms ON ms.id = v.schema_id
       WHERE g.account_id = $1 AND ($2::boolean IS NULL OR v.published = $2)
       ORDER BY v.created_at DESC`,
      [accountId(req), published]
    );
    res.json(rows);
  })
);

async function fetchOwned(id: string, acct: string) {
  return one<any>(`SELECT v.* ${OWNED} WHERE v.id = $1 AND g.account_id = $2`, [id, acct]);
}

vodRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    let schema = null;
    if (row.schema_id) {
      schema = await one('SELECT id, name, fields FROM metadata_schemas WHERE id = $1', [
        row.schema_id,
      ]);
    }
    const pubs = await query('SELECT platform, external_url, views, published_at, status FROM publications WHERE vod_asset_id=$1', [req.params.id]);
    res.json({ ...row, schema, publications: pubs, jsonld: videoObjectFromAsset(row, pubs as any) });
  })
);

/**
 * PROVENANCE — what this asset was actually built from.
 *
 * The chain outward: clip -> contiguous blocks of source media -> the runs and
 * segment ranges on disk -> the recordings and broadcast days they belonged to.
 * It reports what is STILL PRESENT as well as what was used, because a clip
 * whose sources have been pruned cannot be re-cut at a different length and the
 * operator should learn that here, not from a job that fails an hour later.
 */
vodRouter.get(
  '/:id/provenance',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const trace = await traceClip(req.params.id, originBaseFor);
    if (!trace) throw notFound('VOD asset not found');
    res.json({
      ...trace,
      // A chain with no rows is not the same as a chain that says "no sources":
      // assets built before provenance existed have nothing recorded, and saying
      // so is more useful than reporting zero blocks as though it were a fact.
      recorded: trace.blocks.length > 0,
      note: trace.blocks.length > 0 ? null
        : 'This asset was produced before its sources were recorded. Re-cut it to establish the chain.',
    });
  })
);


/**
 * THE REVIEW QUEUE — what is waiting for somebody.
 *
 * Deliberately not "all clips filtered by state": the queue is a place of work,
 * ordered oldest first, carrying the QC counts so a reviewer can see what needs
 * attention before opening anything.
 */
vodRouter.get(
  '/review/queue',
  asyncHandler(async (req, res) => {
    const rows = await reviewQueue(accountId(req));
    res.json({ queue: rows, count: rows.length });
  })
);

/** A clip's review history, its QC findings, and whether it may be published. */
vodRouter.get(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    res.json({
      assetId: row.id,
      state: row.review_state ?? 'draft',
      reviewedAt: row.reviewed_at,
      qc: { state: row.qc_state ?? null, at: row.qc_at ?? null, findings: await qcFindings(row.id) },
      history: await reviewHistory(row.id),
      gate: await publishGate(row.id),
    });
  })
);

/**
 * Move a clip through review.
 *
 * The reason is required for anything that is not an approval, because a
 * rejection with no reason is a rejection somebody has to come and ask about.
 */
vodRouter.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const body = z.object({
      to: z.enum(['draft', 'in_review', 'changes_requested', 'approved', 'rejected']),
      note: z.string().max(2000).optional(),
    }).parse(req.body);

    if (body.to !== 'approved' && body.to !== 'in_review' && !body.note?.trim()) {
      throw badRequest(`Say why: a decision of "${body.to.replace('_', ' ')}" needs a note.`);
    }
    try {
      const updated = await decide({
        assetId: row.id, to: body.to,
        actorId: actorId(req),
        actorLabel: await actorLabel(req),
        note: body.note ?? null,
      });
      res.json({
        ...updated,
        history: await reviewHistory(row.id),
        gate: await publishGate(row.id),
      });
    } catch (e: any) {
      if (e instanceof IllegalReview) throw badRequest(e.message);
      throw e;
    }
  })
);

/** Run QC again, on the queue. Used after a re-cut, or when a check was added. */
vodRouter.post(
  '/:id/qc',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const job = await enqueue({
      type: QC_RUN,
      payload: { vodAssetId: row.id },
      channelId: row.channel_id, eventId: row.event_id,
      dedupeKey: `qc.run:${row.id}`,
      priority: 40,
    });
    res.status(202).json({ jobId: job.id, state: job.state });
  })
);

/** schema.org VideoObject (JSON-LD) — for the portal, SEO, and social metadata. */
vodRouter.get(
  '/:id/schema.org',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const pubs = await query('SELECT platform, external_url, views, published_at, status FROM publications WHERE vod_asset_id=$1', [req.params.id]);
    res.type('application/ld+json').json(videoObjectFromAsset(row, pubs as any));
  })
);

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  published: z.boolean().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

/**
 * Update a VOD asset. When metadata (or a schema change) is supplied, the values
 * are validated against the assigned schema before they are stored.
 */
vodRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const asset = await fetchOwned(req.params.id, accountId(req));
    if (!asset) throw notFound('VOD asset not found');

    // Resolve the schema in effect (new one if provided, else the current one).
    const schemaId = body.schemaId !== undefined ? body.schemaId : asset.schema_id;
    let cleanMeta: Record<string, any> | undefined;
    if (body.metadata !== undefined || body.schemaId !== undefined) {
      const values = body.metadata ?? asset.metadata ?? {};
      if (schemaId) {
        const schema = await one<{ fields: SchemaField[] }>(
          'SELECT fields FROM metadata_schemas WHERE id = $1 AND account_id = $2',
          [schemaId, accountId(req)]
        );
        if (!schema) throw badRequest('Assigned schema not found');
        cleanMeta = validateMetadata(schema.fields, values);
      } else {
        // no schema assigned -> metadata must be empty (strict)
        if (Object.keys(values).length > 0)
          throw badRequest('Assign a metadata schema before setting metadata');
        cleanMeta = {};
      }
    }

    // THE PUBLISH GATE. Both blocking rules are per account and both default to
    // off, so this changes nothing for a deployment that has not asked for it.
    // Where it IS on, publishing over a QC finding is still allowed and is
    // recorded on the review trail: a check that blocks outright is a check
    // people learn to route around.
    if (body.published === true && !asset.published) {
      const gate = await publishGate(asset.id);
      if (!gate.allowed) throw badRequest(gate.message);
      if (gate.wouldOverride) {
        await query(
          `INSERT INTO asset_reviews
             (vod_asset_id, actor_id, actor_label, from_state, to_state, note,
              overrode_qc, qc_state_at_decision)
           VALUES ($1,$2,$3,$4::review_state,$4::review_state,$5,true,$6)`,
          [asset.id, actorId(req), await actorLabel(req),
           asset.review_state ?? 'draft',
           `Published with QC ${gate.qcState}.`, gate.qcState]
        );
      }
    }

    const row = await one(
      `UPDATE vod_assets SET
         title = COALESCE($3, title),
         published = COALESCE($4, published),
         schema_id = $5,
         metadata = COALESCE($6::jsonb, metadata),
         updated_at = now()
       WHERE id = $1
         AND EXISTS (SELECT 1 ${OWNED} WHERE v.id = $1 AND g.account_id = $2)
       RETURNING *`,
      [
        req.params.id,
        accountId(req),
        body.title ?? null,
        body.published ?? null,
        schemaId,
        cleanMeta !== undefined ? JSON.stringify(cleanMeta) : null,
      ]
    );
    if (!row) throw notFound('VOD asset not found');
    res.json(row);
  })
);

/**
 * Non-destructive RE-TRIM of a clip. Updates the clip's in/out (and its manifest
 * key + duration) and marks it for re-derivation — the full source recording is
 * untouched, so a clip can be re-edited any number of times. Only clips.
 */
vodRouter.patch(
  '/:id/trim',
  asyncHandler(async (req, res) => {
    const b = z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }).parse(req.body);
    if (b.endMs <= b.startMs) throw badRequest('endMs must be after startMs');
    const asset = await fetchOwned(req.params.id, accountId(req));
    if (!asset) throw notFound('VOD asset not found');
    if (asset.kind !== 'clip') throw badRequest('only clips can be re-trimmed');
    const row = await one(
      `UPDATE vod_assets SET
         start_epoch_ms=$3::bigint, end_epoch_ms=$4::bigint, duration_ms=$4::bigint-$3::bigint,
         master_key = regexp_replace(master_key, 'clip-[0-9]+-[0-9]+', 'clip-' || $3::text || '-' || $4::text),
         progressive_key = CASE WHEN progressive_key IS NULL THEN NULL
                                ELSE regexp_replace(progressive_key, 'clip-[0-9]+-[0-9]+', 'clip-' || $3::text || '-' || $4::text) END,
         export_mp4_key = NULL,           -- stale export invalidated
         thumb_status='processing',       -- re-derive keyscreens
         updated_at = now()
       WHERE id=$1 AND EXISTS (SELECT 1 ${OWNED} WHERE v.id=$1 AND g.account_id=$2)
       RETURNING *`,
      [req.params.id, accountId(req), b.startMs, b.endMs]
    );
    if (!row) throw notFound('VOD asset not found');
    // re-enqueue the vod-extractor for the new range (like createClipVod).
    res.json(row);
  })
);

vodRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(
      `DELETE FROM vod_assets v USING groups g
        WHERE (v.channel_id IN (SELECT id FROM channels WHERE group_id = g.id)
            OR v.event_id   IN (SELECT id FROM events   WHERE group_id = g.id))
          AND v.id = $1 AND g.account_id = $2
        RETURNING v.id`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('VOD asset not found');
    res.status(204).end();
  })
);
