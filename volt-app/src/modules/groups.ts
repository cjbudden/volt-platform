import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, notFound } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { assertAllocationFits, assertGroupManager, groupUse } from '../services/plan';

/**
 * CHANNEL GROUPS (Admin > Channel groups, docs/PLAN_AND_GROUPS.md).
 *
 * A group ties channels, stations and events to an output profile (whose
 * workflow decides transcode or packaging) and is given a SHARE OF THE PLAN:
 * max_channels channels and stations, max_concurrent running at once. The
 * plan itself is the account's (accounts.max_channels, /api/plan); groups'
 * allocations add up to no more than it.
 *
 *   settings:manage          rename, pick another output profile of the same
 *                            workflow type
 *   account admin / owner,   create a group, change its allocation, make it
 *   system administrator     the default, remove it (not the default, and
 *                            only when nothing is in it)
 *
 * One group is the DEFAULT: new channels, stations and events start in it, and
 * it cannot be removed.
 */
export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const SELECT = `
  SELECT g.id, g.name, g.is_default, g.max_channels, g.max_concurrent, g.output_profile_id, g.created_at,
         p.name AS profile_name, p.workflow_type, p.packaging, p.rungs,
         p.codec_backend, p.captions_enabled, p.caption_targets, p.caption_source_lang,
         a.captions_provider,
         (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id) AS channel_count,
         (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id AND c.kind = 'radio') AS radio_count,
         (SELECT count(*)::int FROM events e WHERE e.group_id = g.id) AS event_count
    FROM groups g
    JOIN accounts a ON a.id = g.account_id
    LEFT JOIN output_profiles p ON p.id = g.output_profile_id`;

const byId = (id: string) => one<any>(`${SELECT} WHERE g.id = $1`, [id]);

groupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await query(`${SELECT} WHERE g.account_id = $1 ORDER BY g.is_default DESC, g.name`, [accountId(req)]));
  })
);

const DEFAULT_LADDER = [{ height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 2800 }, { height: 480, bitrate_kbps: 1200 }];
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  workflowType: z.enum(['transcode', 'package_only']),
  /** an existing output profile of that workflow type; omitted = a new one with the default ladder */
  outputProfileId: z.string().uuid().optional(),
  maxChannels: z.number().int().min(1).max(10000),
  maxConcurrent: z.number().int().min(1).max(5000).default(1),
  makeDefault: z.boolean().optional(),
});

async function assertNameFree(acc: string, name: string, except?: string) {
  const clash = await one(`SELECT 1 FROM groups WHERE account_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3)`, [acc, name, except ?? null]);
  if (clash) throw badRequest(`There is already a group called "${name}"`);
}

groupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    await assertGroupManager(req);
    const b = createSchema.parse(req.body ?? {});
    const acc = accountId(req);
    await assertNameFree(acc, b.name);
    await assertAllocationFits(acc, null, b.maxChannels, b.maxConcurrent);
    if (b.outputProfileId) {
      const p = await one<any>(`SELECT workflow_type FROM output_profiles WHERE id=$1 AND account_id=$2`, [b.outputProfileId, acc]);
      if (!p) throw badRequest('Unknown output profile');
      if (p.workflow_type && p.workflow_type !== b.workflowType) throw badRequest('That output profile is a different workflow type');
    }
    const id = await tx(async (c) => {
      const profileId = b.outputProfileId ?? (await c.query(
        `INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
        [acc, `${b.name} (${b.workflowType === 'transcode' ? 'transcode' : 'packaging'})`, JSON.stringify(DEFAULT_LADDER), b.workflowType])).rows[0].id;
      const none = (await c.query(`SELECT 1 FROM groups WHERE account_id=$1 AND is_default`, [acc])).rowCount === 0;
      if (b.makeDefault) await c.query(`UPDATE groups SET is_default=false WHERE account_id=$1 AND is_default`, [acc]);
      const g = (await c.query(
        `INSERT INTO groups(account_id, name, output_profile_id, max_channels, max_concurrent, is_default)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [acc, b.name, profileId, b.maxChannels, b.maxConcurrent, !!b.makeDefault || none])).rows[0];
      const who = actor(req);
      await writeAudit(c, { accountId: acc, userId: who.userId, label: who.label, action: 'create', entityType: 'group', entityId: g.id,
        snapshot: { name: b.name, workflow: b.workflowType, max_channels: b.maxChannels, max_concurrent: b.maxConcurrent } });
      return g.id as string;
    });
    res.status(201).json(await byId(id));
  })
);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  outputProfileId: z.string().uuid().optional(),
  maxChannels: z.number().int().min(1).max(10000).optional(),
  maxConcurrent: z.number().int().min(1).max(5000).optional(),
  isDefault: z.literal(true).optional(),
});

async function ownGroup(req: Request) {
  const g = await one<any>(
    `SELECT g.*, p.workflow_type FROM groups g LEFT JOIN output_profiles p ON p.id=g.output_profile_id
      WHERE g.id=$1 AND g.account_id=$2`, [req.params.id, accountId(req)]);
  if (!g) throw notFound('Group not found');
  return g;
}

groupsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = patchSchema.parse(req.body ?? {});
    const acc = accountId(req);
    const g = await ownGroup(req);
    // Sharing out the plan and choosing the default are administrator decisions.
    if (b.maxChannels != null || b.maxConcurrent != null || b.isDefault) await assertGroupManager(req);
    if (b.name && b.name.toLowerCase() !== g.name.toLowerCase()) await assertNameFree(acc, b.name, g.id);
    if (b.outputProfileId && b.outputProfileId !== g.output_profile_id) {
      const p = await one<any>(`SELECT workflow_type FROM output_profiles WHERE id=$1 AND account_id=$2`, [b.outputProfileId, acc]);
      if (!p) throw badRequest('Unknown output profile');
      if (g.workflow_type && p.workflow_type !== g.workflow_type) {
        throw badRequest('That profile is a different workflow type. Create a new group for it instead.');
      }
    }
    if (b.maxChannels != null || b.maxConcurrent != null) {
      await assertAllocationFits(acc, g.id, b.maxChannels ?? g.max_channels, b.maxConcurrent ?? null);
    }
    await tx(async (c) => {
      if (b.isDefault && !g.is_default) await c.query(`UPDATE groups SET is_default=false WHERE account_id=$1 AND is_default`, [acc]);
      await c.query(
        `UPDATE groups SET name=COALESCE($2, name), output_profile_id=COALESCE($3, output_profile_id),
                max_channels=COALESCE($4, max_channels), max_concurrent=COALESCE($5, max_concurrent),
                is_default = is_default OR $6 WHERE id=$1`,
        [g.id, b.name ?? null, b.outputProfileId ?? null, b.maxChannels ?? null, b.maxConcurrent ?? null, !!b.isDefault]);
      const changes: Record<string, { from: any; to: any }> = {};
      if (b.name && b.name !== g.name) changes.name = { from: g.name, to: b.name };
      if (b.outputProfileId && b.outputProfileId !== g.output_profile_id) changes.output_profile_id = { from: g.output_profile_id, to: b.outputProfileId };
      if (b.maxChannels != null && b.maxChannels !== g.max_channels) changes.max_channels = { from: g.max_channels, to: b.maxChannels };
      if (b.maxConcurrent != null && b.maxConcurrent !== g.max_concurrent) changes.max_concurrent = { from: g.max_concurrent, to: b.maxConcurrent };
      if (b.isDefault && !g.is_default) changes.is_default = { from: false, to: true };
      if (Object.keys(changes).length) {
        const who = actor(req);
        await writeAudit(c, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'group', entityId: g.id, changes });
      }
    });
    res.json(await byId(g.id));
  })
);

/** What is in a group, and why it cannot be removed (if it cannot). */
groupsRouter.get(
  '/:id/usage',
  asyncHandler(async (req, res) => {
    const g = await ownGroup(req);
    res.json(await groupUse(g.id));
  })
);

/**
 * REMOVE A GROUP. Not the default group, and not while anything is in it:
 * removing a group would take its channels, stations and events with it, so
 * they are moved or removed first. A refusal answers 409 with the counts.
 */
groupsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await assertGroupManager(req);
    const g = await ownGroup(req);
    const use = (await groupUse(g.id))!;
    if (use.blocker) {
      res.status(409).json({ error: use.blocker, code: use.isDefault ? 'default_group' : 'group_in_use', counts: use.counts });
      return;
    }
    await query('DELETE FROM groups WHERE id=$1', [g.id]);
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'delete', entityType: 'group', entityId: g.id,
      snapshot: { name: g.name, max_channels: g.max_channels, max_concurrent: g.max_concurrent } });
    res.status(204).end();
  })
);

