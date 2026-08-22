/**
 * USER GROUPS — named per-feature access sets (none / view / manage) that
 * members inherit. Admin-only surface; the access model is documented in
 * auth/roles.ts. Deleting a group detaches its members (they fall back to
 * their role's default access).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole, FEATURES, invalidateAccess } from '../auth/roles';
import { asyncHandler, notFound, badRequest } from '../util/http';

export const userGroupsRouter = Router();
userGroupsRouter.use(requireAuth, requireMinRole('admin'));

const levelSchema = z.enum(['none', 'view', 'manage']);
const permsSchema = z.record(levelSchema).refine(
  (p) => Object.keys(p).every((k) => (FEATURES as readonly string[]).includes(k)),
  { message: `permissions keys must be one of: ${FEATURES.join(', ')}` }
);

userGroupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT g.*, (SELECT count(*)::int FROM users u WHERE u.user_group_id=g.id) AS member_count
         FROM user_groups g WHERE g.account_id=$1 ORDER BY g.name`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: permsSchema.default({}),
});

userGroupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    const dupe = await one(`SELECT id FROM user_groups WHERE account_id=$1 AND name=$2`, [accountId(req), b.name]);
    if (dupe) throw badRequest('A group with that name already exists');
    const row = await one(
      `INSERT INTO user_groups(account_id, name, description, permissions)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [accountId(req), b.name, b.description ?? null, JSON.stringify(b.permissions)]
    );
    res.status(201).json(row);
  })
);

userGroupsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = z.object({
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      permissions: permsSchema.optional(),
    }).parse(req.body);
    const row = await one(
      `UPDATE user_groups SET
         name=COALESCE($3,name),
         description=CASE WHEN $4 THEN $5 ELSE description END,
         permissions=COALESCE($6::jsonb,permissions)
       WHERE id=$1 AND account_id=$2 RETURNING *`,
      [req.params.id, accountId(req), b.name ?? null,
       Object.prototype.hasOwnProperty.call(req.body ?? {}, 'description'), b.description ?? null,
       b.permissions ? JSON.stringify(b.permissions) : null]
    );
    if (!row) throw notFound('Group not found');
    invalidateAccess();   // members pick the change up within a request
    res.json(row);
  })
);

userGroupsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(`DELETE FROM user_groups WHERE id=$1 AND account_id=$2 RETURNING id`, [req.params.id, accountId(req)]);
    if (!row) throw notFound('Group not found');
    invalidateAccess();
    res.status(204).end();
  })
);
