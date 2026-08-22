/**
 * USER MANAGEMENT (tenant admin surface). List the account's users, add users
 * with a role, change roles, disable/enable. Guard rails:
 *  - admin+ only (enforced both by the central matrix and explicitly here)
 *  - the LAST ACTIVE OWNER can never be demoted or disabled
 *  - only an owner can grant or revoke the owner role
 *  - disabling a user (or changing their role) revokes their refresh tokens,
 *    so the change takes effect at the next access-token expiry (≤15 min)
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { requireMinRole, ROLE_RANK, invalidateAccess } from '../auth/roles';
import { hashPassword } from '../auth/password';
import { asyncHandler, notFound, badRequest, forbidden } from '../util/http';

export const usersRouter = Router();
usersRouter.use(requireAuth, requireMinRole('admin'));

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT u.id, u.email, u.role, u.status, u.platform_role IS NOT NULL AS is_platform,
              u.user_group_id, g.name AS user_group_name, u.created_at
         FROM users u LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE u.account_id=$1 ORDER BY u.created_at`,
      [accountId(req)]
    );
    res.json(rows);
  })
);

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['viewer', 'operator', 'admin', 'owner']).default('operator'),
  userGroupId: z.string().uuid().nullable().optional(),
});

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const b = createSchema.parse(req.body);
    if (b.role === 'owner' && String(req.auth!.role) !== 'owner') {
      throw forbidden('Only an owner can create another owner');
    }
    const dupe = await one('SELECT id FROM users WHERE email=$1', [b.email]);
    if (dupe) throw badRequest('That email is already registered');
    if (b.userGroupId) {
      const grp = await one(`SELECT id FROM user_groups WHERE id=$1 AND account_id=$2`, [b.userGroupId, accountId(req)]);
      if (!grp) throw badRequest('Unknown user group');
    }
    const row = await one<any>(
      `INSERT INTO users(account_id, email, password_hash, role, status, user_group_id)
       VALUES ($1,$2,$3,$4::user_role,'active',$5) RETURNING id, email, role, status, user_group_id, created_at`,
      [accountId(req), b.email, await hashPassword(b.password), b.role, b.userGroupId ?? null]
    );
    res.status(201).json(row);
  })
);

const patchSchema = z.object({
  role: z.enum(['viewer', 'operator', 'admin', 'owner']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  userGroupId: z.string().uuid().nullable().optional(),
});

usersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = patchSchema.parse(req.body);
    const target = await one<any>(
      `SELECT id, role, status FROM users WHERE id=$1 AND account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!target) throw notFound('User not found');

    const meRole = String(req.auth!.role);
    // touching an owner (or granting owner) is an owner-only action
    if ((target.role === 'owner' || b.role === 'owner') && meRole !== 'owner') {
      throw forbidden('Only an owner can change owner roles');
    }
    // an admin cannot raise anyone above their own rank
    if (b.role && ROLE_RANK[b.role] > ROLE_RANK[meRole]) {
      throw forbidden('You cannot grant a role above your own');
    }
    // the last active owner is untouchable
    const demoting = (b.role && b.role !== 'owner' && target.role === 'owner')
      || (b.status === 'disabled' && target.role === 'owner');
    if (demoting) {
      const owners = await one<any>(
        `SELECT count(*)::int AS n FROM users WHERE account_id=$1 AND role='owner' AND status='active' AND id<>$2`,
        [accountId(req), target.id]
      );
      if (!owners || owners.n === 0) throw badRequest('The account must keep at least one active owner');
    }
    if (b.userGroupId) {
      const grp = await one(`SELECT id FROM user_groups WHERE id=$1 AND account_id=$2`, [b.userGroupId, accountId(req)]);
      if (!grp) throw badRequest('Unknown user group');
    }
    const hasGroup = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'userGroupId');
    const row = await one<any>(
      `UPDATE users SET role=COALESCE($3::user_role, role), status=COALESCE($4::user_status, status),
              user_group_id=CASE WHEN $5 THEN $6::uuid ELSE user_group_id END
        WHERE id=$1 AND account_id=$2 RETURNING id, email, role, status, user_group_id, created_at`,
      [target.id, accountId(req), b.role ?? null, b.status ?? null, hasGroup, b.userGroupId ?? null]
    );
    invalidateAccess(target.id);
    // sessions pick the change up at the next refresh
    await query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [target.id]);
    res.json(row);
  })
);
