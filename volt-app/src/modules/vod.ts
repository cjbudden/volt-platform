import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { validateMetadata, SchemaField } from '../services/metadataValidator';
import { videoObjectFromAsset } from '../services/schemaOrg';
import { traceClip } from '../services/clips/provenance';
import { enqueueClipBuild } from '../services/clips';
import { decide, historyOf as reviewHistory, publishGate, queue as reviewQueue, IllegalReview } from '../services/review';
import { qcFindings } from '../services/qc';
import { enqueue } from '../services/jobs/queue';
import { CLIP_EXTRACT } from '../services/jobs/handlers/clipExtract';
import { resolveRange, assessRange, segmentCount } from '../services/clips/resolve';
import { isAudioOnly } from '../services/localRecordingIndex';
import type { OutputFormat } from '../services/clips/extract';
import { QC_RUN } from '../services/jobs/handlers/qcRun';
import { originBaseFor } from '../services/liveOrigin';
import { actorId, actorLabel } from '../util/actor';
import { actor, writeAudit } from '../services/audit';
import { publish, withdraw, republish, NotPublishable } from '../services/availability';
import { resolveForAsset } from '../services/publishingRules';
import { cleanSettings } from './publishingRules';

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
      `SELECT v.*, ms.name AS schema_name, COALESCE(c.name, e.name) AS source_name,
              -- Whether the copy that went out is still the copy that is here.
              -- Computed in the list because it is a thing you filter on, and a
              -- library that cannot answer "what did I publish that has since
              -- changed" is a library you have to check by hand.
              EXISTS (SELECT 1 FROM publications p
                       WHERE p.vod_asset_id = v.id AND p.stale) AS has_stale_publication,
              (SELECT count(*) FROM publications p WHERE p.vod_asset_id = v.id)::int AS publication_count
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
    // The full publication row, not a summary: what was approved when it went
    // out, and whether the copy out there is still that one, are the two things
    // anyone asks about a published asset.
    const pubs = await query(
      `SELECT platform, external_url, views, published_at, status, stale,
              published_build_at, published_review_state, published_qc_state,
              published_by, published_duration_ms
         FROM publications WHERE vod_asset_id = $1
        ORDER BY published_at DESC NULLS LAST`, [req.params.id]);
    // WHAT KIND OF THING THIS IS, so the library can put up the right player.
    // The stream it was cut from knows (a radio station has no video
    // rendition); an uploaded file with no stream is judged by the files it
    // produced. Asked here, once, rather than guessed from a black rectangle.
    const streamId = row.channel_id ?? row.event_id;
    const audioOnly = streamId
      ? isAudioOnly(streamId)
      : !!(row.export_mp3_key || row.export_m4a_key) && !row.progressive_key;
    res.json({ ...row, audioOnly, schema, publications: pubs, jsonld: videoObjectFromAsset(row, pubs as any) });
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
      // THROUGH THE ONE DOOR. `published: true` used to flip a flag and mark
      // portal visibility; it now runs the asset's publishing plan (the
      // ladder), which creates the publications and the window as well.
      try { await publish(asset.id, await actorLabel(req)); }
      catch (e: any) { if (e instanceof NotPublishable) throw badRequest(e.message); throw e; }
      body.published = undefined;
    }
    if (body.published === false && asset.published) {
      await withdraw(asset.id, await actorLabel(req), 'unpublished from the library');
      body.published = undefined;
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
/** The extractor's format list for an output kind. Mirrors the clip route. */
function outputFormats(outputKind: string, audio: boolean): OutputFormat[] {
  const formats: OutputFormat[] = [];
  if (outputKind !== 'progressive') formats.push('hls');
  if (outputKind !== 'manifest') formats.push('mp4');
  if (!formats.length) formats.push('mp4');
  if (audio) formats.push('mp3', 'm4a');
  return formats;
}

vodRouter.patch(
  '/:id/trim',
  asyncHandler(async (req, res) => {
    const b = z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
      // Same escape hatch the clip route offers: a re-cut across an encoder
      // restart is a thing an editor legitimately asks for.
      acceptGapsMs: z.number().int().nonnegative().max(600_000).default(0),
    }).parse(req.body);
    if (b.endMs <= b.startMs) throw badRequest('endMs must be after startMs');
    const asset = await fetchOwned(req.params.id, accountId(req));
    if (!asset) throw notFound('VOD asset not found');
    if (asset.kind !== 'clip') throw badRequest('only clips can be re-trimmed');
    // REFUSE A RANGE THE MEDIA CANNOT COVER, before promising anything. The
    // same rule creation applies: a row naming files nobody can write is how
    // an operator finds out at playback time instead of now.
    const streamId = asset.channel_id ?? asset.event_id;
    const kind = isAudioOnly(streamId) ? 'audio' : 'video';
    const resolution = resolveRange(streamId, b.startMs, b.endMs, kind);
    const verdict = assessRange(resolution, { maxGapMs: b.acceptGapsMs });
    if (!verdict.ok) throw badRequest(verdict.message);

    // THE KEY IS REWRITTEN, NOT PATCHED. The old regexp_replace only matched a
    // key already shaped `clip-<a>-<b>`, so a clip built by compose-clip (whose
    // key is `vod/compose-<ts>/…`) silently kept pointing at the OLD media
    // while the row advertised the new range. Building the key from the range
    // is the same thing createClipVod does, and it cannot miss.
    const stem = `clip-${b.startMs}-${b.endMs}`;
    const row = await one<any>(
      `UPDATE vod_assets SET
         start_epoch_ms=$3::bigint, end_epoch_ms=$4::bigint, duration_ms=$4::bigint-$3::bigint,
         master_key = 'clips/' || id::text || '/' || $5::text || '/master.m3u8',
         progressive_key = CASE WHEN progressive_key IS NULL THEN NULL
                                ELSE 'clips/' || id::text || '/' || $5::text || '/clip.mp4' END,
         export_mp4_key = NULL,           -- stale export invalidated
         export_mp3_key = NULL, export_m4a_key = NULL,
         thumb_status='processing',       -- re-derive keyscreens
         -- A RE-CUT IS NEW MEDIA, SO IT IS UNREVIEWED MEDIA.
         -- These four columns were left alone, which meant an approved clip
         -- could be re-trimmed to a completely different range and still
         -- publish carrying its old approval and its old QC pass, stamped
         -- against footage nobody had looked at. services/review.ts says this
         -- in its own header as the thing that must not happen.
         review_state = 'draft'::review_state,
         reviewed_by = NULL, reviewed_at = NULL,
         qc_state = NULL, qc_at = NULL,
         built_at = NULL,
         updated_at = now()
       WHERE id=$1 AND EXISTS (SELECT 1 ${OWNED} WHERE v.id=$1 AND g.account_id=$2)
       RETURNING *`,
      [req.params.id, accountId(req), b.startMs, b.endMs, stem]
    );
    if (!row) throw notFound('VOD asset not found');

    // The QC findings belong to media that no longer exists.
    await query(`DELETE FROM qc_events WHERE vod_asset_id = $1`, [row.id]);

    // Anywhere this asset is already published is now serving an older cut
    // than the row describes. That is precisely what `stale` is for.
    await query(`UPDATE publications SET stale = true WHERE vod_asset_id = $1`, [row.id]);

    // AND ACTUALLY BUILD IT. This line used to be a comment saying the
    // extractor should be re-enqueued. Nothing was, so every re-trim left the
    // asset at thumb_status 'processing' forever, pointing at a manifest that
    // would never be written.
    // Through the shared helper, so the three callers that build a clip cannot
    // disagree about formats or dedupe key again.
    const job = await enqueueClipBuild({
      vodAssetId: row.id, streamId, fromMs: b.startMs, toMs: b.endMs,
      outputKind: row.output_kind,
      channelId: asset.channel_id, eventId: asset.event_id,
      acceptGapsMs: b.acceptGapsMs,
    });

    res.json({
      ...row,
      jobId: job.id,
      state: job.state,
      resolution: {
        coveragePct: resolution.coveragePct,
        gaps: resolution.gaps.length,
        segments: segmentCount(resolution),
      },
    });
  })
);

/**
 * AVAILABILITY. The asset's own rung of the ladder, the resolved plan (what a
 * publish would do and why), and the three actions: publish through the
 * plan (optionally to a subset of its targets for this one publish),
 * withdraw (remove access, keep the asset), republish.
 */
vodRouter.get('/:id/availability', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const plan = await resolveForAsset(accountId(req), asset);
  const pubs = await query(
    `SELECT p.id, p.platform, p.status, p.external_url, p.published_at, p.app_id, a.name AS app_name, t.name AS target_name
       FROM publications p LEFT JOIN apps a ON a.id = p.app_id LEFT JOIN publish_targets t ON t.id = p.target_id
      WHERE p.vod_asset_id = $1 ORDER BY p.created_at DESC`, [asset.id]);
  res.json({
    state: asset.availability_state ?? 'draft',
    availableFrom: asset.available_from, availableUntil: asset.available_until,
    withdrawnAt: asset.withdrawn_at, withdrawnBy: asset.withdrawn_by,
    applied: asset.availability ?? null, appliedSources: asset.availability_sources ?? null,
    override: asset.availability_override ?? {},
    plan, publications: pubs,
  });
}));

vodRouter.patch('/:id/availability', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  // The asset's rung: replace it wholesale (an empty object = back to the ladder).
  const override = await cleanSettings(accountId(req), req.body?.override ?? req.body ?? {});
  await query(`UPDATE vod_assets SET availability_override = $2::jsonb, updated_at = now() WHERE id = $1`, [asset.id, JSON.stringify(override)]);
  // A published asset re-applies its plan so the change takes effect now.
  let outcome: any = null;
  if (['available', 'scheduled'].includes(asset.availability_state)) {
    try { outcome = await publish(asset.id, await actorLabel(req)); }
    catch (e: any) { if (e instanceof NotPublishable) throw badRequest(e.message); throw e; }
    await query(`DELETE FROM publications WHERE vod_asset_id = $1 AND status = 'published' AND id <> ALL($2::uuid[])`,
      [asset.id, outcome.publications.map((p: any) => p.id)]).catch(() => {});
  }
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'vod_asset', entityId: asset.id,
    changes: { availability_override: { from: asset.availability_override ?? {}, to: override } } }).catch(() => {});
  res.json({ override, reapplied: !!outcome, state: outcome?.state ?? asset.availability_state });
}));

vodRouter.post('/:id/publish', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const b = z.object({ targets: z.array(z.any()).optional() }).parse(req.body ?? {});
  const targets = b.targets ? (await cleanSettings(accountId(req), { targets: b.targets })).targets : undefined;
  try {
    const out = ['withdrawn', 'expired'].includes(asset.availability_state)
      ? await republish(asset.id, await actorLabel(req))
      : await publish(asset.id, await actorLabel(req), { targets });
    res.status(201).json({ state: out.state, asset: out.asset, publications: out.publications, sources: out.plan.sources });
  } catch (e: any) {
    if (e instanceof NotPublishable) return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
}));

vodRouter.post('/:id/withdraw', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const row = await withdraw(asset.id, await actorLabel(req), reason);
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'vod_asset', entityId: asset.id,
    changes: { availability_state: { from: asset.availability_state, to: 'withdrawn' } }, snapshot: { reason } }).catch(() => {});
  res.json(row);
}));

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
