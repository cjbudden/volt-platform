// ============================================================================
//  MEDIA LIFECYCLE API  (mounted at /api/storage)
//
//  What media exists, where it lives, whether it can be read right now, and what
//  the retention ladder is going to do to it next.
//
//  The endpoint that matters most is the plainest: /capabilities. It says what
//  THIS deployment can actually do, and everything else — the rule editor, the
//  restore button, the validator — reads from it rather than each deciding for
//  itself. On local storage there is one tier and no archive, and saying so once
//  is what stops the UI offering an archive that would never happen.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { capabilities, type StorageTier } from '../services/media/storage';
import {
  historyOf, locationsOf, readability, requestRestore, setHold,
} from '../services/media/objects';
import {
  defaultLadder, listRules, ruleFor, saveRule, sweep, validateStages,
  type RetentionStage,
} from '../services/media/retention';
import { reconcileStream } from '../services/media/reconcile';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { actorLabel } from '../util/actor';

export const storageRouter = Router();
storageRouter.use(requireAuth);

/** What this deployment can do. Read by the rule editor and the restore flow. */
storageRouter.get('/capabilities', asyncHandler(async (_req, res) => {
  const caps = capabilities();
  res.json({ ...caps, defaultLadder: defaultLadder() });
}));

/** Media objects owned by the caller's account, newest first. */
// THE LIST STANDARD (util/listQuery.ts). channel_id filters on the owning
// channel whether the object or its recording carries it, as before; it is
// not sortable because the row shows the object's own column.
const objectsList = defineList({
  path: '/api/storage/objects',
  fields: {
    id: { sql: 'o.id', type: 'uuid' },
    logical_key: { sql: 'o.logical_key', type: 'string' },
    kind: { sql: 'o.kind', type: 'string', doc: 'run_rendition, clip_output or export' },
    rendition: { sql: 'o.rendition', type: 'string' },
    state: { sql: 'o.state', type: 'enum', values: ['pending', 'writing', 'available', 'archiving', 'archived', 'restoring', 'restored', 'deleting', 'deleted'] },
    bytes: { sql: 'o.bytes', type: 'number' },
    duration_ms: { sql: 'o.duration_ms', type: 'number' },
    segment_count: { sql: 'o.segment_count', type: 'number' },
    hold: { sql: 'o.hold', type: 'boolean' },
    retain_until: { sql: 'o.retain_until', type: 'timestamp' },
    recording_id: { sql: 'o.recording_id', type: 'uuid' },
    vod_asset_id: { sql: 'o.vod_asset_id', type: 'uuid' },
    channel_id: { sql: 'COALESCE(o.channel_id, r.channel_id)', type: 'uuid', sort: false },
    event_id: { sql: 'COALESCE(o.event_id, r.event_id)', type: 'uuid', sort: false },
    recording_title: { sql: 'r.title', type: 'string' },
    source_name: { sql: 'COALESCE(c.name, e.name)', type: 'string' },
    created_at: { sql: 'o.created_at', type: 'timestamp' },
    updated_at: { sql: 'o.updated_at', type: 'timestamp', notNull: true },
  },
  search: ['logical_key', 'rendition', 'recording_title', 'source_name'],
  defaultSort: '-updated_at',
  defaultLimit: 100,
  maxLimit: 500,
  aliases: { channelId: 'channel_id', recordingId: 'recording_id', eventId: 'event_id', vodAssetId: 'vod_asset_id' },
});

storageRouter.get('/objects', asyncHandler(async (req, res) => {
  const from = `FROM media_objects o
       LEFT JOIN recordings r ON r.id = o.recording_id
       LEFT JOIN channels c ON c.id = COALESCE(o.channel_id, r.channel_id)
       LEFT JOIN events   e ON e.id = COALESCE(o.event_id, r.event_id)
       LEFT JOIN groups  gc ON gc.id = c.group_id
       LEFT JOIN groups  ge ON ge.id = e.group_id
      WHERE COALESCE(gc.account_id, ge.account_id) = $1`;
  const params: unknown[] = [accountId(req)];
  const pl = parseList(objectsList, req.query, params);
  const rows = await query<any>(
    `SELECT o.*,
            r.title AS recording_title,
            COALESCE(c.name, e.name) AS source_name,
            (SELECT json_agg(json_build_object('tier', l.tier, 'uri', l.uri, 'bytes', l.bytes))
               FROM media_locations l WHERE l.object_id = o.id AND l.present) AS locations
       ${from}${whereSql(pl)}
      ${pageSql(pl)}`,
    params
  );
  let total: number | undefined;
  if (pl.count) {
    const cp: unknown[] = [accountId(req)];
    const cpl = parseList(objectsList, { ...req.query, cursor: undefined, offset: undefined }, cp);
    total = Number((await one<any>(`SELECT count(*)::int AS n ${from}${whereSql(cpl)}`, cp))?.n ?? 0);
  }
  const page = finishPage(req, res, pl, rows, total);
  // `count` is the number of rows on this page, as it always was. The total
  // is X-Total-Count, with count=true.
  res.json({ objects: page, count: page.length });
}));

async function ownedObject(req: any) {
  const row = await one<any>(
    `SELECT o.* FROM media_objects o
       LEFT JOIN recordings r ON r.id = o.recording_id
       LEFT JOIN channels c ON c.id = COALESCE(o.channel_id, r.channel_id)
       LEFT JOIN events   e ON e.id = COALESCE(o.event_id, r.event_id)
       LEFT JOIN groups  gc ON gc.id = c.group_id
       LEFT JOIN groups  ge ON ge.id = e.group_id
      WHERE o.id = $1 AND COALESCE(gc.account_id, ge.account_id) = $2`,
    [req.params.id, accountId(req)]
  );
  if (!row) throw notFound('Media object not found');
  return row;
}

/** One object: where it is, whether it can be read, and everything that has
 *  happened to it. */
storageRouter.get('/objects/:id', asyncHandler(async (req, res) => {
  const obj = await ownedObject(req);
  res.json({
    ...obj,
    locations: await locationsOf(obj.id),
    readability: await readability(obj.id),
    history: await historyOf(obj.id, 50),
  });
}));

/**
 * Ask for an archived object to be made readable.
 *
 * Answers with the EXPECTATION, not a promise: archive tiers publish a window,
 * not a guarantee, and the difference is the whole reason this endpoint exists
 * rather than playback simply blocking.
 */
storageRouter.post('/objects/:id/restore', asyncHandler(async (req, res) => {
  const obj = await ownedObject(req);
  const body = z.object({
    speed: z.enum(['expedited', 'standard', 'bulk']).optional(),
  }).parse(req.body ?? {});
  const out = await requestRestore(obj.id, body.speed, `user:${await actorLabel(req)}`);
  if (!out.ok) throw badRequest(out.message);
  res.status(202).json({
    object: out.object,
    readability: await readability(obj.id),
  });
}));

/** A hold outranks every retention rule, for a legal hold or an investigation. */
storageRouter.post('/objects/:id/hold', asyncHandler(async (req, res) => {
  const obj = await ownedObject(req);
  const body = z.object({ hold: z.boolean(), reason: z.string().max(500).optional() }).parse(req.body ?? {});
  if (body.hold && !body.reason) throw badRequest('A hold needs a reason.');
  const out = await setHold(obj.id, body.hold, body.reason ?? null, `user:${await actorLabel(req)}`);
  res.json(out);
}));

// ------------------------------------------------------------------ retention
const stageSchema = z.object({
  afterDays: z.number().int().min(0),
  action: z.enum(['keep', 'to_cold', 'to_archive', 'delete']),
  targetTier: z.string().optional(),
});

storageRouter.get('/retention', asyncHandler(async (req, res) => {
  res.json({
    rules: await listRules(accountId(req)),
    capabilities: capabilities(),
    defaultLadder: defaultLadder(),
  });
}));

/** Which rule governs a channel, resolved the way the sweep resolves it. */
storageRouter.get('/retention/effective', asyncHandler(async (req, res) => {
  const q = z.object({
    channelId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
  }).parse(req.query);
  const rule = await ruleFor({
    channelId: q.channelId ?? null, eventId: q.eventId ?? null, accountId: accountId(req),
  });
  res.json({
    rule,
    // Saying WHERE the rule came from matters: "no rule" and "the account
    // default" produce very different expectations about what happens next.
    scope: rule ? (rule.channel_id ? 'channel' : rule.event_id ? 'event' : 'account') : null,
  });
}));

storageRouter.put('/retention', asyncHandler(async (req, res) => {
  const body = z.object({
    ruleId: z.string().uuid().optional(),
    channelId: z.string().uuid().nullish(),
    eventId: z.string().uuid().nullish(),
    accountScope: z.boolean().optional(),
    name: z.string().min(1),
    appliesTo: z.enum(['recording', 'asset', 'both']).optional(),
    enabled: z.boolean().optional(),
    stages: z.array(stageSchema).min(1),
  }).parse(req.body);

  const stages: RetentionStage[] = body.stages.map((s) => ({
    afterDays: s.afterDays, action: s.action,
    targetTier: (s.targetTier as StorageTier | undefined) ?? null,
  }));
  const v = validateStages(stages);
  if (!v.ok) throw badRequest(v.message);

  // A rule scoped to a channel or event carries account_id NULL and reaches
  // its account through that owner, so an unchecked owner id plants a rule
  // inside somebody else's scope and the sweep then honours it against their
  // media. Confirm the owner belongs to the caller before saving anything.
  if (body.channelId) {
    const owned = await one<any>(
      `SELECT 1 FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`, [body.channelId, accountId(req)]);
    if (!owned) throw notFound('Channel not found');
  }
  if (body.eventId) {
    const owned = await one<any>(
      `SELECT 1 FROM events e JOIN groups g ON g.id = e.group_id
        WHERE e.id = $1 AND g.account_id = $2`, [body.eventId, accountId(req)]);
    if (!owned) throw notFound('Event not found');
  }

  const rule = await saveRule({
    ruleId: body.ruleId,
    actingAccountId: accountId(req),
    accountId: body.accountScope || (!body.channelId && !body.eventId) ? accountId(req) : null,
    channelId: body.channelId ?? null,
    eventId: body.eventId ?? null,
    name: body.name,
    appliesTo: body.appliesTo,
    enabled: body.enabled,
    stages,
  });
  res.json(rule);
}));

/**
 * What the sweep WOULD do, without doing it.
 *
 * A retention ladder deletes things. Being able to see the effect before it
 * happens is not a convenience, it is the difference between a policy someone
 * is willing to switch on and one that sits disabled forever.
 */
storageRouter.post('/retention/preview', asyncHandler(async (req, res) => {
  // Scoped to the caller. Unscoped, this reported how much media every OTHER
  // customer on the platform was about to lose.
  res.json({ dryRun: true, ...(await sweep({ dryRun: true, limit: 1000, accountId: accountId(req) })) });
}));

/** Re-read what is on disk for a stream and bring the lifecycle rows in line. */
storageRouter.post('/reconcile', asyncHandler(async (req, res) => {
  const body = z.object({ streamId: z.string().uuid() }).parse(req.body);
  const owned = await one<any>(
    `SELECT 1 FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2
      UNION
     SELECT 1 FROM events e JOIN groups g ON g.id = e.group_id
      WHERE e.id = $1 AND g.account_id = $2`,
    [body.streamId, accountId(req)]
  );
  if (!owned) throw notFound('Stream not found');
  res.json(await reconcileStream(body.streamId, { actor: `user:${await actorLabel(req)}` }));
}));
