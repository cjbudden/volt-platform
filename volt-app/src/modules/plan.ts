// ============================================================================
//  PLAN & LIMITS (Admin > Plan & limits, docs/PLAN_AND_GROUPS.md).
//
//  GET   /api/plan   the plan, what is used, how it is shared out between the
//                    groups, and whether the caller may change it
//  PATCH /api/plan   {planTier?, maxChannels?, maxConcurrent?}
//                    system administrators; the account owner in a
//                    single-client deployment (VOLT_DEPLOYMENT=single)
//
//  The plan cannot go below what is in use, or below what the groups have
//  been given (lower a group's allocation first).
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, conflict, forbidden } from '../util/http';
import { config } from '../config';
import { planUsage, planEditor, groupManager } from '../services/plan';
import { actor, writeAudit } from '../services/audit';

export const planRouter = Router();
planRouter.use(requireAuth);

async function view(req: any) {
  const acc = accountId(req);
  const [u, editor, gm, groups] = await Promise.all([
    planUsage(acc), planEditor(req), groupManager(req),
    query(`SELECT g.id, g.name, g.is_default, g.max_channels, g.max_concurrent,
                  (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id) AS used,
                  (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id AND c.kind = 'radio') AS radio
             FROM groups g WHERE g.account_id = $1 ORDER BY g.is_default DESC, g.name`, [acc]),
  ]);
  return { ...u, deployment: config.deployment, canEdit: editor.ok, editReason: editor.ok ? null : editor.why, canManageGroups: gm, groups };
}

planRouter.get('/', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await view(req));
}));

const patchSchema = z.object({
  planTier: z.string().trim().min(1).max(60).optional(),
  maxChannels: z.number().int().min(1).max(10000).optional(),
  maxConcurrent: z.number().int().min(1).max(5000).optional(),
});

planRouter.patch('/', asyncHandler(async (req, res) => {
  const b = patchSchema.parse(req.body ?? {});
  const ed = await planEditor(req);
  if (!ed.ok) throw forbidden(ed.why);
  const acc = accountId(req);
  const u = await planUsage(acc);
  if (b.maxChannels != null) {
    if (b.maxChannels < u.used.total) {
      throw conflict(`${u.used.total} channels and stations exist, so the plan needs at least ${u.used.total}. Remove some first.`);
    }
    if (b.maxChannels < u.allocated) {
      throw conflict(`The groups are given ${u.allocated} channels and stations between them, so the plan needs at least ${u.allocated}. Lower a group's allocation first.`);
    }
  }
  if (b.maxConcurrent != null) {
    const top = (await query<{ m: number }>(`SELECT COALESCE(max(max_concurrent),0)::int AS m FROM groups WHERE account_id = $1`, [acc]))[0]?.m ?? 0;
    if (b.maxConcurrent < top) throw conflict(`A group is allowed ${top} running at once, so the plan needs at least ${top}. Lower that group first.`);
  }
  await query(
    `UPDATE accounts SET plan_tier = COALESCE($2, plan_tier), max_channels = COALESCE($3, max_channels),
            max_concurrent_sources = COALESCE($4, max_concurrent_sources), updated_at = now() WHERE id = $1`,
    [acc, b.planTier ?? null, b.maxChannels ?? null, b.maxConcurrent ?? null]);
  const changes: Record<string, { from: any; to: any }> = {};
  if (b.planTier != null && b.planTier !== u.planTier) changes.plan_tier = { from: u.planTier, to: b.planTier };
  if (b.maxChannels != null && b.maxChannels !== u.maxChannels) changes.max_channels = { from: u.maxChannels, to: b.maxChannels };
  if (b.maxConcurrent != null && b.maxConcurrent !== u.maxConcurrent) changes.max_concurrent = { from: u.maxConcurrent, to: b.maxConcurrent };
  const who = actor(req);
  if (Object.keys(changes).length) {
    await writeAudit(null, { accountId: acc, userId: who.userId, label: who.label, action: 'update', entityType: 'plan', entityId: acc, changes });
  }
  res.json(await view(req));
}));
