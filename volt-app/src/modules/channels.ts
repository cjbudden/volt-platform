import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict } from '../util/http';
import { orchestrator } from '../services/orchestrator';
import { validateEntityMetadata } from './metadataSchemas';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';
import { buildChannelDetail, DVR_MAX_SEC } from '../services/channelDetail';
import { startTestStream, stopTestStream, testStreamStatus, isTestStreamAvailable } from '../services/testStream';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const CHANNEL_EDITABLE = [
  'name', 'enabled', 'recording_retention_days', 'schema_id', 'metadata',
  'dvr_window_sec', 'dvr_mode', 'geo_mode', 'geo_countries',
];

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
    const instances = await query('SELECT * FROM instances WHERE channel_id = $1 AND terminated_at IS NULL', [req.params.id]);
    const detail = await buildChannelDetail(row, Date.now());
    const testStream = { available: isTestStreamAvailable(), ...testStreamStatus(req.params.id) };
    res.json({ ...row, instances, ...detail, testStream });
  })
);

const createSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().min(1),
  purchasingMode: z.enum(['on_demand', 'reserved', 'spot_fallback']).default('reserved'),
  resilienceTier: z.enum(['standard', 'resilient_input', 'full_redundancy']).default('standard'),
  recordingRetentionDays: z.number().int().positive().nullable().optional(), // retention rule
  dvrWindowSec: z.number().int().min(30).max(DVR_MAX_SEC).nullable().optional(), // ≤4h for 24x7
  dvrMode: z.enum(['sliding', 'event_start']).default('sliding'),
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
      `INSERT INTO channels(group_id, name, purchasing_mode, resilience_tier, recording_retention_days, dvr_window_sec, dvr_mode, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [body.groupId, body.name, body.purchasingMode, body.resilienceTier, body.recordingRetentionDays ?? null,
       body.dvrWindowSec ?? null, body.dvrMode, who.userId]
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
  // DVR: per-channel catch-up window. 24x7 sliding window is capped at 4h; events
  // scrub back to the event start (dvr_mode = 'event_start', no fixed cap needed).
  dvrWindowSec: z.number().int().min(30).max(DVR_MAX_SEC).nullable().optional(),
  dvrMode: z.enum(['sliding', 'event_start']).optional(),
  // source geo rules (edge-evaluated)
  geoMode: z.enum(['worldwide', 'allow', 'block']).optional(),
  geoCountries: z.array(z.string().length(2)).optional(),
  // sources (primary/backup ingest) — replaces this channel's inputs when provided
  sources: z.array(z.object({
    role: z.enum(['primary', 'backup']),
    protocol: z.enum(['srt', 'rtmp', 'rtp', 'hls', 'rist', 'zixi']),
    ingestUrl: z.string().optional(),
    streamKey: z.string().optional(),
  })).optional(),
  // subtitles / live captions (persisted to the group's shared output profile)
  captions: z.object({
    enabled: z.boolean().optional(),
    sourceLang: z.string().optional(),
    targets: z.array(z.string()).optional(),
  }).optional(),
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
  if (has('dvrWindowSec')) patch.dvr_window_sec = body.dvrWindowSec ?? null;
  if (has('dvrMode')) patch.dvr_mode = body.dvrMode;
  if (has('geoMode')) patch.geo_mode = body.geoMode;
  if (has('geoCountries')) patch.geo_countries = body.geoCountries ?? [];
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
      arrayColumns: ['geo_countries'],
    });

    // --- cross-entity side effects (audited separately) ---------------------
    // Sources: replace this channel's ingest inputs.
    if (has('sources') && body.sources) {
      await tx(async (c) => {
        await c.query('DELETE FROM stream_inputs WHERE channel_id = $1', [req.params.id]);
        for (const s of body.sources!) {
          await c.query(
            `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url, stream_key)
             VALUES ($1,$2,$3,$4,$5)`,
            [req.params.id, s.role, s.protocol, s.ingestUrl ?? null, s.streamKey ?? null]
          );
        }
      });
      await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
        action: 'update', entityType: 'channel', entityId: req.params.id,
        snapshot: { sources: body.sources.map((s) => `${s.role}:${s.protocol}`) } });
    }

    // Subtitles/captions live on the group's shared output profile.
    if (has('captions') && body.captions) {
      const grp = await one<any>(
        `SELECT g.output_profile_id FROM channels ch JOIN groups g ON g.id = ch.group_id WHERE ch.id = $1`,
        [req.params.id]
      );
      if (grp?.output_profile_id) {
        const cap = body.captions;
        const sets: string[] = []; const vals: any[] = [];
        if (cap.enabled !== undefined) { sets.push(`captions_enabled = $${sets.length + 1}`); vals.push(cap.enabled); }
        if (cap.sourceLang !== undefined) { sets.push(`caption_source_lang = $${sets.length + 1}`); vals.push(cap.sourceLang); }
        if (cap.targets !== undefined) { sets.push(`caption_targets = $${sets.length + 1}::jsonb`); vals.push(JSON.stringify(cap.targets)); }
        if (sets.length) {
          vals.push(grp.output_profile_id);
          await query(`UPDATE output_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
          await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
            action: 'update', entityType: 'output_profile', entityId: grp.output_profile_id,
            snapshot: { captions: cap } });
        }
      }
    }

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

/**
 * TEST BUILD — spin up a real local test stream (FFmpeg test card + live WebVTT)
 * for this channel and play it back in the app. GET returns playback URLs + state.
 */
channelsRouter.get(
  '/:id/test-stream',
  asyncHandler(async (req, res) => {
    const owned = await one<any>(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id=$1 AND g.account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    res.json({ available: isTestStreamAvailable(), ...testStreamStatus(req.params.id) });
  })
);

const testStreamSchema = z.object({
  action: z.enum(['start', 'stop']),
  langs: z.array(z.string()).optional(),
  dvrSec: z.number().int().min(0).max(DVR_MAX_SEC).optional(),
  dash: z.boolean().optional(),
});
channelsRouter.post(
  '/:id/test-stream',
  asyncHandler(async (req, res) => {
    const chan = await one<any>(
      `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id=$1 AND g.account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!chan) throw notFound('Channel not found');
    const body = testStreamSchema.parse(req.body);
    if (body.action === 'stop') { res.json(await stopTestStream(req.params.id)); return; }
    if (!isTestStreamAvailable()) throw conflict('Test stream generator not available (ffmpeg/encoder scripts missing on the API host)');
    const dvrSec = body.dvrSec ?? (chan.dvr_mode === 'event_start' ? 0 : (chan.dvr_window_sec ?? 60));
    const status = await startTestStream(req.params.id, chan.name, {
      langs: body.langs ?? ['en', 'ms', 'zh', 'ta'], dvrSec, dash: body.dash ?? false,
    });
    res.json(status);
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
