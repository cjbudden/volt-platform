import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict, badRequest } from '../util/http';
import { orchestrator } from '../services/orchestrator';
import { validateEntityMetadata } from './metadataSchemas';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

const EVENT_EDITABLE = ['name', 'scheduled_start', 'scheduled_end', 'public_start', 'public_end', 'recording_retention_days', 'schema_id', 'metadata'];

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT e.* FROM events e JOIN groups g ON g.id = e.group_id
        WHERE g.account_id = $1 ORDER BY e.scheduled_start DESC`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

eventsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(
      `SELECT e.* FROM events e JOIN groups g ON g.id = e.group_id
        WHERE e.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Event not found');
    const inputs = await query('SELECT * FROM stream_inputs WHERE event_id = $1', [req.params.id]);
    res.json({ ...row, inputs });
  })
);

const createSchema = z
  .object({
    groupId: z.string().uuid(),
    name: z.string().min(1),
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    // optional wider server window (billing) + public window (viewer gating)
    serverStart: z.string().datetime().optional(),
    serverStop: z.string().datetime().optional(),
    publicStart: z.string().datetime().optional(),
    publicEnd: z.string().datetime().optional(),
    purchasingMode: z.enum(['on_demand', 'reserved', 'spot_fallback']).default('spot_fallback'),
    resilienceTier: z.enum(['standard', 'resilient_input', 'full_redundancy']).default('standard'),
    recordingRetentionDays: z.number().int().positive().nullable().optional(), // retention rule
    schemaId: z.string().uuid().nullable().optional(),      // metadata schema (defined once, harvested to auto-VOD)
    metadata: z.record(z.any()).optional(),
  })
  .refine((v) => new Date(v.scheduledEnd) > new Date(v.scheduledStart), {
    message: 'scheduledEnd must be after scheduledStart',
  });

/** Create an event — enforces the group's max_concurrent overlap limit. */
eventsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    const group = await one<any>('SELECT id, max_concurrent FROM groups WHERE id = $1 AND account_id = $2', [
      b.groupId,
      accountId(req),
    ]);
    if (!group) throw notFound('Group not found');

    // concurrency check: how many events already overlap this window?
    const overlap = await one<any>(
      `SELECT count(*)::int AS n FROM events
        WHERE group_id = $1 AND status <> 'ended'
          AND scheduled_start < $3 AND scheduled_end > $2`,
      [b.groupId, b.scheduledStart, b.scheduledEnd]
    );
    if (overlap.n >= group.max_concurrent) throw conflict(`Concurrent event limit reached (${group.max_concurrent})`);

    const md = await validateEntityMetadata(accountId(req), b.schemaId ?? null, b.metadata, ['event']);
    const who = actor(req);
    const row = await one<any>(
      `INSERT INTO events(group_id, name, scheduled_start, scheduled_end,
                          server_start, server_stop, public_start, public_end,
                          purchasing_mode, resilience_tier, recording_retention_days,
                          schema_id, metadata, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$14) RETURNING *`,
      [
        b.groupId, b.name, b.scheduledStart, b.scheduledEnd,
        b.serverStart ?? b.scheduledStart, b.serverStop ?? b.scheduledEnd,
        b.publicStart ?? b.scheduledStart, b.publicEnd ?? b.scheduledEnd,
        b.purchasingMode, b.resilienceTier, b.recordingRetentionDays ?? null,
        md.schemaId, JSON.stringify(md.metadata), who.userId,
      ]
    );
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'create', entityType: 'event', entityId: row.id, snapshot: { name: row.name } });
    res.status(201).json(row);
  })
);

/** Edit an event. PATCH = partial (null clears); PUT = alias. Versioned + audited;
 *  optimistic concurrency via If-Match (or a `version` field). */
const editEventSchema = z.object({
  name: z.string().min(1).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  publicStart: z.string().datetime().optional(),
  publicEnd: z.string().datetime().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  version: z.number().int().optional(),
});
const editEvent = asyncHandler(async (req, res) => {
  const b = editEventSchema.parse(req.body);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  const current = await one<any>(
    `SELECT e.* FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!current) throw notFound('Event not found');

  const patch: Record<string, any> = {};
  if (has('name')) patch.name = b.name;
  if (has('scheduledStart')) patch.scheduled_start = b.scheduledStart;
  if (has('scheduledEnd')) patch.scheduled_end = b.scheduledEnd;
  if (has('publicStart')) patch.public_start = b.publicStart;
  if (has('publicEnd')) patch.public_end = b.publicEnd;
  if (has('recordingRetentionDays')) patch.recording_retention_days = b.recordingRetentionDays ?? null;
  if (has('schemaId') || has('metadata')) {
    const md = await validateEntityMetadata(accountId(req), b.schemaId ?? null,
      has('metadata') ? b.metadata : current.metadata, ['event']);
    patch.schema_id = md.schemaId;
    patch.metadata = md.metadata;
  }
  const im = req.get('If-Match');
  const expectedVersion = im ? parseInt(im.replace(/"/g, ''), 10) : (has('version') ? Number(b.version) : null);
  const who = actor(req);
  try {
    const { row, changed } = await patchEntity({
      table: 'events', id: req.params.id, accountId: accountId(req),
      current, patch, allowed: EVENT_EDITABLE, entityType: 'event',
      userId: who.userId, label: who.label, expectedVersion,
    });
    res.set('ETag', String(row.version));
    res.json({ ...row, _changed: changed });
  } catch (e) {
    if (e instanceof VersionConflict) return res.status(409).json({ error: e.message, currentVersion: e.currentVersion });
    throw e;
  }
});
eventsRouter.patch('/:id', editEvent);
eventsRouter.put('/:id', editEvent);

eventsRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const owned = await one(`SELECT e.id FROM events e JOIN groups g ON g.id=e.group_id WHERE e.id=$1 AND g.account_id=$2`, [req.params.id, accountId(req)]);
    if (!owned) throw notFound('Event not found');
    res.json(await entityHistory(accountId(req), 'event', req.params.id));
  })
);

eventsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one<any>(
      `DELETE FROM events e USING groups g
        WHERE e.group_id = g.id AND e.id = $1 AND g.account_id = $2 RETURNING e.id, e.name`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Event not found');
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'delete', entityType: 'event', entityId: row.id, snapshot: { name: row.name } });
    res.status(204).end();
  })
);

eventsRouter.post(
  '/:id/:action(start|stop)',
  asyncHandler(async (req, res) => {
    const owned = await one<any>(
      `SELECT e.id FROM events e JOIN groups g ON g.id = e.group_id
        WHERE e.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Event not found');
    if (req.params.action === 'start') await orchestrator.startStream('event', req.params.id);
    else await orchestrator.stopStream('event', req.params.id, `api:operator (user ${accountId(req)})`);
    const row = await one('SELECT * FROM events WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);
