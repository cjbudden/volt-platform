import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict, badRequest } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { orchestrator } from '../services/orchestrator';
import { checkVideoSources } from './channels';
import { cleanParams } from '../services/ingestProtocols';
import { validateEntityMetadata } from './metadataSchemas';
import { defaultTypeId } from '../services/contentTypes';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';
import { scheduleFillerPrep, FILLER_FIELDS, runFillerPrep, fillerStatus } from '../services/fillerPrep';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

const EVENT_EDITABLE = ['graphics', 'name', 'scheduled_start', 'scheduled_end', 'server_start', 'server_stop',
  'public_start', 'public_end', 'recording_enabled', 'recording_retention_days', 'recording_retention_sec',
  'auto_vod', 'input_failover_enabled', 'auto_failback', 'input_loss_behavior', 'filler_slate_ref',
  'schema_id', 'metadata',
  // AUTO CONNECT after a reboot. Separate from the event's SCHEDULE, which
  // still decides when the event runs: this answers only "it was started and
  // nobody stopped it, so put it back".
  'auto_connect'];

/** Same source shape the channel forms use — events share the core workflow. */
const sourceSchema = z.object({
  role: z.enum(['primary', 'backup']).default('primary'),
  protocol: z.string().min(1),
  ingestUrl: z.string().optional(),
  streamKey: z.string().optional(),
  renditionLabel: z.string().optional(),
  renditionBitrateKbps: z.number().int().positive().optional(),
  params: z.record(z.union([z.string(), z.number()])).optional(),
});

async function replaceEventInputs(eventId: string, sources: z.infer<typeof sourceSchema>[]) {
  await query('DELETE FROM stream_inputs WHERE event_id = $1', [eventId]);
  for (const s of sources) {
    await query(
      `INSERT INTO stream_inputs(event_id, role, protocol, ingest_url, stream_key, rendition_label, rendition_bitrate_kbps, params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [eventId, s.role ?? 'primary', s.protocol, s.ingestUrl ?? null, s.streamKey ?? null,
       s.renditionLabel ?? null, s.renditionBitrateKbps ?? null, JSON.stringify(cleanParams(s.protocol, s.params))]
    );
  }
}

// The list standard (util/listQuery.ts). Without a limit the list still comes
// back whole (up to 1000), as the console expects until it pages.
const eventList = defineList({
  path: '/api/events',
  fields: {
    id: { sql: 'e.id', type: 'uuid' },
    name: { sql: 'e.name', type: 'string' },
    status: { sql: 'e.status', type: 'enum', values: ['scheduled', 'provisioning', 'testing', 'live', 'stopping', 'ended', 'error'] },
    group_id: { sql: 'e.group_id', type: 'uuid' },
    scheduled_start: { sql: 'e.scheduled_start', type: 'timestamp', notNull: true },
    scheduled_end: { sql: 'e.scheduled_end', type: 'timestamp' },
    public_start: { sql: 'e.public_start', type: 'timestamp' },
    public_end: { sql: 'e.public_end', type: 'timestamp' },
    actual_start: { sql: 'e.actual_start', type: 'timestamp' },
    actual_end: { sql: 'e.actual_end', type: 'timestamp' },
    auto_vod: { sql: 'e.auto_vod', type: 'boolean' },
    auto_connect: { sql: 'e.auto_connect', type: 'boolean' },
    recording_enabled: { sql: 'e.recording_enabled', type: 'boolean' },
    resilience_tier: { sql: 'e.resilience_tier', type: 'enum', values: ['standard', 'resilient_input', 'full_redundancy'] },
    desired_state: { sql: 'e.desired_state', type: 'string' },
    expected_viewers: { sql: 'e.expected_viewers', type: 'number' },
    xmltv_id: { sql: 'e.xmltv_id', type: 'string' },
    created_at: { sql: 'e.created_at', type: 'timestamp' },
    updated_at: { sql: 'e.updated_at', type: 'timestamp' },
  },
  search: ['name', 'xmltv_id'],
  defaultSort: '-scheduled_start',
  unpagedLimit: 1000,
  aliases: { groupId: 'group_id', scheduledStart: 'scheduled_start', scheduledEnd: 'scheduled_end', createdAt: 'created_at' },
});

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const base: unknown[] = [accountId(req)];
    const params = [...base];
    const pl = parseList(eventList, req.query, params);
    const from = `FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = $1${whereSql(pl)}`;
    const rows = await query<any>(`SELECT e.* ${from} ${pageSql(pl)}`, params);
    const cParams = [...base];
    const cWhere = pl.count ? whereSql(parseList(eventList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
    const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = $1${cWhere}`, cParams))?.n : undefined;
    res.json(finishPage(req, res, pl, rows, total));
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
    recordingEnabled: z.boolean().optional(),               // keep run segments as the event recording
    recordingRetentionDays: z.number().int().positive().nullable().optional(), // retention rule
    recordingRetentionSec: z.number().int().positive().nullable().optional(),
    autoVod: z.boolean().optional(),                        // derive a full-event VOD on recording close
    autoConnect: z.boolean().optional(),                    // put back on air after a control-plane reboot
    sources: z.array(sourceSchema).optional(),              // same shape as channel sources
    inputFailoverEnabled: z.boolean().optional(),
    autoFailback: z.boolean().optional(),
    inputLossBehavior: z.enum(['none', 'slate', 'vod_loop', 'last_frame', 'black']).optional(),
    fillerSlateRef: z.string().nullable().optional(),
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
    checkVideoSources(b.sources);
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

    // AN EVENT IS GIVEN A TYPE AT SETUP. The type decides what is captured
    // against it and against everything derived from it. None chosen = the
    // generic Broadcast event.
    const typeId = b.schemaId ?? await defaultTypeId(accountId(req), 'event');
    const md = await validateEntityMetadata(accountId(req), typeId,
      // THE METADATA NAME IS THE EVENT'S NAME, always; it wins over any `name`
      // sent inside metadata (see channels.ts).
      { ...(b.metadata ?? {}), name: b.name }, ['event']);
    const who = actor(req);
    const row = await one<any>(
      `INSERT INTO events(group_id, name, scheduled_start, scheduled_end,
                          server_start, server_stop, public_start, public_end,
                          purchasing_mode, resilience_tier,
                          recording_enabled, recording_retention_days, recording_retention_sec, auto_vod,
                          input_failover_enabled, auto_failback, input_loss_behavior, filler_slate_ref,
                          schema_id, metadata, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$21) RETURNING *`,
      [
        b.groupId, b.name, b.scheduledStart, b.scheduledEnd,
        b.serverStart ?? b.scheduledStart, b.serverStop ?? b.scheduledEnd,
        b.publicStart ?? b.scheduledStart, b.publicEnd ?? b.scheduledEnd,
        b.purchasingMode, b.resilienceTier,
        b.recordingEnabled ?? true, b.recordingRetentionDays ?? null, b.recordingRetentionSec ?? null,
        b.autoVod ?? true,
        b.inputFailoverEnabled ?? false, b.autoFailback ?? true, b.inputLossBehavior ?? 'none',
        b.fillerSlateRef ?? null,
        md.schemaId, JSON.stringify(md.metadata), who.userId,
      ]
    );
    if (b.sources?.length) await replaceEventInputs(row.id, b.sources);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'create', entityType: 'event', entityId: row.id, snapshot: { name: row.name } });
    void scheduleFillerPrep('event', row.id, 'created');
    res.status(201).json(row);
  })
);

/** Edit an event. PATCH = partial (null clears); PUT = alias. Versioned + audited;
 *  optimistic concurrency via If-Match (or a `version` field). */
const editEventSchema = z.object({
  // In-stream graphic triggers (services/graphicTriggers.ts): overrides only.
  graphics: z.object({
    upNext: z.object({
      enabled: z.boolean().optional(),
      leadSec: z.number().int().min(15).max(900).optional(),
      durationSec: z.number().int().min(5).max(60).optional(),
    }).optional(),
  }).optional(),
  name: z.string().min(1).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
  serverStart: z.string().datetime().optional(),
  serverStop: z.string().datetime().optional(),
  publicStart: z.string().datetime().optional(),
  publicEnd: z.string().datetime().optional(),
  recordingEnabled: z.boolean().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  recordingRetentionSec: z.number().int().positive().nullable().optional(),
  autoVod: z.boolean().optional(),
  autoConnect: z.boolean().optional(),   // put back on air after a reboot
  sources: z.array(sourceSchema).optional(),
  inputFailoverEnabled: z.boolean().optional(),
  autoFailback: z.boolean().optional(),
  inputLossBehavior: z.enum(['none', 'slate', 'vod_loop', 'last_frame', 'black']).optional(),
  fillerSlateRef: z.string().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  version: z.number().int().optional(),
});
const editEvent = asyncHandler(async (req, res) => {
  const b = editEventSchema.parse(req.body);
  if (b.sources) checkVideoSources(b.sources);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  const current = await one<any>(
    `SELECT e.* FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!current) throw notFound('Event not found');

  const patch: Record<string, any> = {};
  // Graphics: merged over what is stored, so a partial change keeps the rest.
  // Not locked while running: the encoder re-reads triggers every few seconds.
  if (has('graphics') && b.graphics) {
    const cur = (current.graphics && typeof current.graphics === 'object') ? current.graphics : {};
    patch.graphics = { ...cur, ...(b.graphics.upNext ? { upNext: { ...(cur.upNext ?? {}), ...b.graphics.upNext } } : {}) };
  }
  if (has('name')) patch.name = b.name;
  if (has('scheduledStart')) patch.scheduled_start = b.scheduledStart;
  if (has('scheduledEnd')) patch.scheduled_end = b.scheduledEnd;
  if (has('serverStart')) patch.server_start = b.serverStart;
  if (has('serverStop')) patch.server_stop = b.serverStop;
  if (has('publicStart')) patch.public_start = b.publicStart;
  if (has('publicEnd')) patch.public_end = b.publicEnd;
  if (has('recordingEnabled')) patch.recording_enabled = b.recordingEnabled;
  if (has('recordingRetentionDays')) patch.recording_retention_days = b.recordingRetentionDays ?? null;
  if (has('recordingRetentionSec')) patch.recording_retention_sec = b.recordingRetentionSec ?? null;
  if (has('autoVod')) patch.auto_vod = b.autoVod;
  if (has('autoConnect')) patch.auto_connect = b.autoConnect;
  if (has('inputFailoverEnabled')) patch.input_failover_enabled = b.inputFailoverEnabled;
  if (has('autoFailback')) patch.auto_failback = b.autoFailback;
  if (has('inputLossBehavior')) patch.input_loss_behavior = b.inputLossBehavior;
  if (has('fillerSlateRef')) patch.filler_slate_ref = b.fillerSlateRef ?? null;
  if (has('schemaId') || has('metadata') || has('name')) {
    if (has('schemaId') && b.schemaId == null) throw badRequest('A content type is required. Choose another type instead of clearing it.');
    const md = await validateEntityMetadata(accountId(req), (has('schemaId') ? b.schemaId : current.schema_id) ?? null,
      { ...((has('metadata') ? b.metadata : current.metadata) ?? {}), name: has('name') ? b.name : current.name }, ['event']);
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
    if (has('sources') && b.sources) await replaceEventInputs(req.params.id, b.sources);
    if (FILLER_FIELDS.some((k) => has(k))) void scheduleFillerPrep('event', req.params.id, 'settings changed');
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
    const owned = await one<any>(
      `SELECT e.id, e.status FROM events e JOIN groups g ON g.id = e.group_id
        WHERE e.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Event not found');
    if (owned.status === 'live') throw badRequest('Stop the event before deleting it');
    // The instances table used to need clearing by hand right here: its FK was
    // ON DELETE SET NULL while its CHECK demanded an owner, so deleting an
    // event that had ever run aborted the whole statement. Migration 0013 made
    // both owner FKs CASCADE, so the database handles it — and the channel
    // delete path, which never carried this workaround and therefore 500'd on
    // every channel that had ever started, is fixed by the same change.
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
    else await orchestrator.stopStream('event', req.params.id, `api:operator (user ${accountId(req)})`, 'operator');
    const row = await one('SELECT * FROM events WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);

/**
 * AUTO CONNECT, BY HAND. `{ enabled: false }` stops the retry loop right now
 * and leaves the counters, the last error and the log exactly as they are, so
 * the operator can read why the stream fell over without it being relaunched
 * underneath them. `{ enabled: true }` puts it back; the stream still has to
 * be seen healthy before it is armed.
 */
eventsRouter.post(
  '/:id/auto-connect',
  asyncHandler(async (req, res) => {
    const owned = await one<any>(
      `SELECT o.id, o.auto_connect FROM events o JOIN groups g ON g.id = o.group_id
        WHERE o.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Event not found');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const { setAutoConnect } = await import('../services/orchestrator/resume');
    const who = actor(req);
    await setAutoConnect('event', req.params.id, enabled, who.label);
    await writeAudit(null, {
      accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'update', entityType: 'event', entityId: req.params.id,
      changes: { auto_connect: { from: owned.auto_connect, to: enabled } },
    }).catch(() => {});
    const row = await one('SELECT * FROM events WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);


/** What each source is (its stored probe) and the state of the pre-built fallback loop. */
eventsRouter.get(
  '/:id/filler',
  asyncHandler(async (req, res) => {
    const own = await one<any>(
      `SELECT o.id FROM events o JOIN groups g ON g.id = o.group_id WHERE o.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]);
    if (!own) throw notFound('Not found');
    const inputs = await query<any>(
      `SELECT id, role, protocol, rendition_label, ingest_url, probe, probed_at FROM stream_inputs WHERE event_id = $1 ORDER BY role`,
      [req.params.id]);
    res.json({ build: await fillerStatus('event', req.params.id), inputs });
  })
);

/** Probe the sources and (re)build the loop NOW, waiting for the result. */
eventsRouter.post(
  '/:id/filler',
  asyncHandler(async (req, res) => {
    const own = await one<any>(
      `SELECT o.id FROM events o JOIN groups g ON g.id = o.group_id WHERE o.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]);
    if (!own) throw notFound('Not found');
    res.json({ build: await runFillerPrep('event', req.params.id) });
  })
);
