import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict } from '../util/http';
import { orchestrator } from '../services/orchestrator';
import { validateEntityMetadata } from './metadataSchemas';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const CHANNEL_EDITABLE = ['name', 'enabled', 'recording_retention_days', 'schema_id', 'metadata'];

/** List channels for the tenant (scoped via group -> account). */
channelsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT c.*, g.name AS group_name
         FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1
        ORDER BY c.created_at DESC`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

channelsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(
      `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Channel not found');
    const inputs = await query('SELECT * FROM stream_inputs WHERE channel_id = $1', [req.params.id]);
    const instances = await query('SELECT * FROM instances WHERE channel_id = $1 AND terminated_at IS NULL', [req.params.id]);
    res.json({ ...row, inputs, instances });
  })
);

const createSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().min(1),
  purchasingMode: z.enum(['on_demand', 'reserved', 'spot_fallback']).default('reserved'),
  resilienceTier: z.enum(['standard', 'resilient_input', 'full_redundancy']).default('standard'),
  recordingRetentionDays: z.number().int().positive().nullable().optional(), // retention rule
});

/** Create a channel — enforces the group's max_channels entitlement. */
channelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const group = await one<any>('SELECT id, max_channels FROM groups WHERE id = $1 AND account_id = $2', [
      body.groupId,
      accountId(req),
    ]);
    if (!group) throw notFound('Group not found');
    const count = await one<any>('SELECT count(*)::int AS n FROM channels WHERE group_id = $1', [body.groupId]);
    if (count.n >= group.max_channels) throw conflict(`Channel limit reached (${group.max_channels})`);

    const who = actor(req);
    const row = await one<any>(
      `INSERT INTO channels(group_id, name, purchasing_mode, resilience_tier, recording_retention_days, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [body.groupId, body.name, body.purchasingMode, body.resilienceTier, body.recordingRetentionDays ?? null, who.userId]
    );
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'create', entityType: 'channel', entityId: row.id,
      snapshot: { name: row.name, group_id: row.group_id } });
    res.status(201).json(row);
  })
);

/**
 * Edit a channel. PATCH = partial (send only changed fields; null clears); PUT is
 * accepted as an alias. Optimistic concurrency: send the version you loaded via the
 * `If-Match` header (or a `version` field) and the write is rejected 409 if the row
 * changed underneath you. Every change is versioned + written to the audit log.
 */
const editSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  version: z.number().int().optional(),
});
const editChannel = asyncHandler(async (req, res) => {
  const body = editSchema.parse(req.body);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);

  const current = await one<any>(
    `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!current) throw notFound('Channel not found');

  const patch: Record<string, any> = {};
  if (has('name')) patch.name = body.name;
  if (has('enabled')) patch.enabled = body.enabled;
  if (has('recordingRetentionDays')) patch.recording_retention_days = body.recordingRetentionDays ?? null;
  const touchMeta = has('schemaId') || has('metadata');
  if (touchMeta) {
    const md = await validateEntityMetadata(accountId(req), body.schemaId ?? null,
      has('metadata') ? body.metadata : current.metadata, ['channel']);
    patch.schema_id = md.schemaId;
    patch.metadata = md.metadata;
  }

  const im = req.get('If-Match');
  const expectedVersion = im ? parseInt(im.replace(/"/g, ''), 10) : (has('version') ? Number(body.version) : null);
  const who = actor(req);
  try {
    const { row, changed } = await patchEntity({
      table: 'channels', id: req.params.id, accountId: accountId(req),
      current, patch, allowed: CHANNEL_EDITABLE, entityType: 'channel',
      userId: who.userId, label: who.label, expectedVersion,
    });
    res.set('ETag', String(row.version));
    res.json({ ...row, _changed: changed });
  } catch (e) {
    if (e instanceof VersionConflict) return res.status(409).json({ error: e.message, currentVersion: e.currentVersion });
    throw e;
  }
});
channelsRouter.patch('/:id', editChannel);
channelsRouter.put('/:id', editChannel);

/** Change history for one channel (who created / changed what, newest first). */
channelsRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const owned = await one(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id=$1 AND g.account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    res.json(await entityHistory(accountId(req), 'channel', req.params.id));
  })
);

channelsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // In production: terminate any running encoder first, then delete.
    const row = await one<any>(
      `DELETE FROM channels c USING groups g
        WHERE c.group_id = g.id AND c.id = $1 AND g.account_id = $2 RETURNING c.id, c.name`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Channel not found');
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'delete', entityType: 'channel', entityId: row.id, snapshot: { name: row.name } });
    res.status(204).end();
  })
);

/** Start / stop — the orchestrator provisions/terminates the encoder task. */
channelsRouter.post(
  '/:id/:action(start|stop)',
  asyncHandler(async (req, res) => {
    // enforce tenant ownership before the orchestrator (which loads by id)
    const owned = await one<any>(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    if (req.params.action === 'start') await orchestrator.startStream('channel', req.params.id);
    else await orchestrator.stopStream('channel', req.params.id);
    const row = await one('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);
