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
import { actorLabel } from '../util/actor';

export const storageRouter = Router();
storageRouter.use(requireAuth);

/** What this deployment can do. Read by the rule editor and the restore flow. */
storageRouter.get('/capabilities', asyncHandler(async (_req, res) => {
  const caps = capabilities();
  res.json({ ...caps, defaultLadder: defaultLadder() });
}));

/** Media objects owned by the caller's account, newest first. */
storageRouter.get('/objects', asyncHandler(async (req, res) => {
  const q = z.object({
    state: z.string().optional(),
    channelId: z.string().uuid().optional(),
    recordingId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);

  const rows = await query<any>(
    `SELECT o.*,
            r.title AS recording_title,
            COALESCE(c.name, e.name) AS source_name,
            (SELECT json_agg(json_build_object('tier', l.tier, 'uri', l.uri, 'bytes', l.bytes))
               FROM media_locations l WHERE l.object_id = o.id AND l.present) AS locations
       FROM media_objects o
       LEFT JOIN recordings r ON r.id = o.recording_id
       LEFT JOIN channels c ON c.id = COALESCE(o.channel_id, r.channel_id)
       LEFT JOIN events   e ON e.id = COALESCE(o.event_id, r.event_id)
       LEFT JOIN groups  gc ON gc.id = c.group_id
       LEFT JOIN groups  ge ON ge.id = e.group_id
      WHERE COALESCE(gc.account_id, ge.account_id) = $1
        AND ($2::text IS NULL OR o.state::text = $2)
        AND ($3::uuid IS NULL OR COALESCE(o.channel_id, r.channel_id) = $3)
        AND ($4::uuid IS NULL OR o.recording_id = $4)
      ORDER BY o.updated_at DESC
      LIMIT $5`,
    [accountId(req), q.state ?? null, q.channelId ?? null, q.recordingId ?? null, q.limit]
  );
  res.json({ objects: rows, count: rows.length });
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

  const rule = await saveRule({
    ruleId: body.ruleId,
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
storageRouter.post('/retention/preview', asyncHandler(async (_req, res) => {
  res.json({ dryRun: true, ...(await sweep({ dryRun: true, limit: 1000 })) });
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
