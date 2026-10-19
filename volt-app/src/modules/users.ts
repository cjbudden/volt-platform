/**
 * ADMIN USER MANAGEMENT (a client's staff). See ACCESS_CONTROL.md.
 *
 *   GET    /api/users               users:view
 *   GET    /api/users/:id           users:view    + roles and effective access
 *   POST   /api/users               users:manage  {email, password, roleIds[], tier?}
 *   PATCH  /api/users/:id           users:manage  {roleIds?, tier?, status?, displayName?}
 *   POST   /api/users/:id/password  users:manage  {password}  set a new password
 *   DELETE /api/users/:id           users:manage
 *   GET    /api/users/security-policy   users:view    {requireAdminMfa}
 *   PUT    /api/users/security-policy   users:manage + admin tier  {requireAdminMfa}
 *   POST   /api/users/:id/mfa/reset     users:manage  turn off a locked-out user's two-step sign-in
 *
 * A user's tier (users.role) follows their roles: Administrator makes them
 * `admin`, System Viewer `viewer`, anything else `operator`. An owner stays an
 * owner; only an owner can make or unmake one.
 *
 * GUARD RAILS (all server side; the console only mirrors them):
 *  - NO ESCALATION: the access a user would end up with must be covered by the
 *    access of the person granting it, feature by feature.
 *  - Nobody changes, disables or deletes a user whose current access they do
 *    not cover, or whose tier is above theirs; nobody changes their own access.
 *  - The last active owner cannot be demoted, disabled or deleted.
 *  - Any change to access or status revokes the user's refresh tokens, and the
 *    access cache is dropped by trigger, so it applies to the very next request.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { rankOf, effectivePerms, assertCovers, assertCanManageUser, cleanPerms, type Perms } from '../auth/roles';
import { hashPassword } from '../auth/password';
import { asyncHandler, notFound, badRequest, forbidden } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { writeAudit } from '../services/audit';
import { clearMfa, securitySummary } from '../auth/identity';

export const usersRouter = Router();
usersRouter.use(requireAuth);

type Tier = 'owner' | 'admin' | 'operator' | 'viewer';

interface RoleRow { id: string; name: string; role_key: string | null; tier: Tier; permissions: any; is_system: boolean }

async function rolesById(acct: string, ids: string[]): Promise<RoleRow[]> {
  if (!ids.length) return [];
  const rows = await query<RoleRow>(
    `SELECT id, name, role_key, tier, permissions, is_system FROM user_groups WHERE account_id=$1 AND id = ANY($2::uuid[])`,
    [acct, ids]);
  if (rows.length !== new Set(ids).size) throw badRequest('Unknown role');
  return rows;
}

/** The tier the roles imply (highest), unless an explicit owner/admin tier is asked for. */
function tierFor(roles: RoleRow[], asked?: Tier | null, current?: Tier | null): Tier {
  if (asked) return asked;
  if (current === 'owner') return 'owner';
  let t: Tier = roles.length ? 'viewer' : (current ?? 'operator');
  for (const r of roles) if (rankOf(r.tier) > rankOf(t)) t = r.tier;
  return t;
}

const accessOf = (tier: string, roles: RoleRow[]): Perms => effectivePerms(tier, roles.map((r) => r.permissions));

async function targetAccess(acct: string, id: string) {
  const u = await one<any>(`SELECT id, email, role, status FROM users WHERE id=$1 AND account_id=$2`, [id, acct]);
  if (!u) throw notFound('User not found');
  const roles = await query<RoleRow>(
    `SELECT g.id, g.name, g.role_key, g.tier, g.permissions, g.is_system
       FROM user_group_members m JOIN user_groups g ON g.id = m.group_id WHERE m.user_id=$1`, [id]);
  return { ...u, roles, perms: accessOf(u.role, roles) };
}

function shape(u: any, roles: { id: string; name: string; role_key?: string | null }[]) {
  return {
    id: u.id, email: u.email, displayName: u.display_name ?? null, role: u.role, tier: u.role, status: u.status,
    isPlatform: !!u.is_platform,
    ...(u.mfa_on !== undefined ? { mfa: !!u.mfa_on, emailVerified: !!u.email_verified } : {}),
    roles: roles.map((r) => ({ id: r.id, name: r.name, key: r.role_key ?? null })),
    // legacy fields the original console reads
    user_group_id: roles[0]?.id ?? null, user_group_name: roles[0]?.name ?? null, created_at: u.created_at,
  };
}

async function lastOwnerGuard(acct: string, targetId: string) {
  const owners = await one<any>(
    `SELECT count(*)::int AS n FROM users WHERE account_id=$1 AND role='owner' AND status='active' AND id<>$2`, [acct, targetId]);
  if (!owners || owners.n === 0) throw badRequest('The account must keep at least one active owner');
}

/** ACCOUNT POLICY: two-step sign-in compulsory for every admin user. Switching
 *  it on lets current sessions finish their access token (<= ACCESS_TTL); at the
 *  next refresh, a session that did not use a second step must sign in again,
 *  and anyone without a method is taken through setting one up. */
usersRouter.get('/security-policy', asyncHandler(async (req, res) => {
  const a = await one<any>(
    `SELECT a.require_admin_mfa,
            (SELECT count(*)::int FROM users u WHERE u.account_id=a.id AND u.status='active') AS users,
            (SELECT count(*)::int FROM users u WHERE u.account_id=a.id AND u.status='active'
               AND ((u.mfa_enabled AND u.mfa_secret_ref IS NOT NULL) OR (u.mfa_email_enabled AND u.email_verified_at IS NOT NULL)
                    OR (u.mfa_sms_enabled AND u.phone_verified_at IS NOT NULL))) AS with_mfa
       FROM accounts a WHERE a.id=$1`, [accountId(req)]);
  res.json({ requireAdminMfa: !!a?.require_admin_mfa, activeUsers: a?.users ?? 0, usersWithMfa: a?.with_mfa ?? 0 });
}));

usersRouter.put('/security-policy', asyncHandler(async (req, res) => {
  const b = z.object({ requireAdminMfa: z.boolean() }).parse(req.body ?? {});
  if (rankOf(req.access!.role) < rankOf('admin')) throw forbidden('Only an administrator can change the account security policy');
  const acct = accountId(req);
  await query(`UPDATE accounts SET require_admin_mfa=$2 WHERE id=$1`, [acct, b.requireAdminMfa]);
  await writeAudit(null, { accountId: acct, userId: req.auth!.sub, label: 'security', action: 'update', entityType: 'account', entityId: acct, snapshot: { requireAdminMfa: b.requireAdminMfa } }).catch(() => {});
  res.json({ requireAdminMfa: b.requireAdminMfa });
}));

// Two-step sign-in is on when any second step is both enabled and usable.
const MFA_ON = `((u.mfa_enabled AND u.mfa_secret_ref IS NOT NULL) OR (u.mfa_email_enabled AND u.email_verified_at IS NOT NULL)
              OR (u.mfa_sms_enabled AND u.phone_verified_at IS NOT NULL))`;
// The list standard (util/listQuery.ts). Names are the response's; key is the
// column the cursor reads before shape() renames it.
const userList = defineList({
  path: '/api/users',
  fields: {
    id: { sql: 'u.id', type: 'uuid' },
    email: { sql: 'u.email', type: 'string' },
    displayName: { sql: 'u.display_name', type: 'string', key: 'display_name' },
    role: { sql: 'u.role', type: 'enum', values: ['owner', 'admin', 'operator', 'viewer'], doc: 'The access tier' },
    status: { sql: 'u.status', type: 'enum', values: ['active', 'invited', 'disabled'] },
    isPlatform: { sql: 'u.platform_role IS NOT NULL', type: 'boolean', key: 'is_platform' },
    mfa: { sql: MFA_ON, type: 'boolean', key: 'mfa_on', doc: 'Two-step sign-in is on' },
    emailVerified: { sql: 'u.email_verified_at IS NOT NULL', type: 'boolean', key: 'email_verified' },
    created_at: { sql: 'u.created_at', type: 'timestamp', notNull: true },
  },
  search: ['email', 'displayName'],
  defaultSort: 'created_at',
  unpagedLimit: 1000,
  aliases: { createdAt: 'created_at', tier: 'role' },
});

usersRouter.get('/', asyncHandler(async (req, res) => {
  const base: unknown[] = [accountId(req)];
  const params = [...base];
  const pl = parseList(userList, req.query, params);
  const fetched = await query<any>(
    `SELECT u.id, u.email, u.display_name, u.role, u.status, u.platform_role IS NOT NULL AS is_platform, u.created_at,
            u.email_verified_at IS NOT NULL AS email_verified,
            ${MFA_ON} AS mfa_on,
            COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name, 'role_key', g.role_key) ORDER BY g.name)
                     FILTER (WHERE g.id IS NOT NULL), '[]') AS roles
       FROM users u
       LEFT JOIN user_group_members m ON m.user_id = u.id
       LEFT JOIN user_groups g ON g.id = m.group_id
      WHERE u.account_id=$1${whereSql(pl)}
      GROUP BY u.id ${pageSql(pl)}`,
    params);
  const cParams = [...base];
  const cWhere = pl.count ? whereSql(parseList(userList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
  const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM users u WHERE u.account_id=$1${cWhere}`, cParams))?.n : undefined;
  res.json(finishPage(req, res, pl, fetched, total).map((u) => shape(u, u.roles)));
}));

usersRouter.get('/:id', asyncHandler(async (req, res) => {
  const t = await targetAccess(accountId(req), req.params.id);
  const extra = await one<any>(`SELECT display_name, created_at, platform_role IS NOT NULL AS is_platform FROM users WHERE id=$1`, [t.id]);
  res.json({ ...shape({ ...t, ...extra }, t.roles), access: t.perms,
    security: await securitySummary('user', t.id),
    // can the caller change this user? (the console greys the controls out)
    manageable: (() => { try { assertCanManageUser(req.access!, String(req.auth!.sub), t); return true; } catch { return false; } })() });
}));

const tierSchema = z.enum(['viewer', 'operator', 'admin', 'owner']);
const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Use at least 10 characters'),
  displayName: z.string().max(120).optional(),
  roleIds: z.array(z.string().uuid()).max(20).optional(),
  // legacy single-group + explicit tier
  userGroupId: z.string().uuid().nullable().optional(),
  role: tierSchema.optional(),
});

usersRouter.post('/', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const acct = accountId(req);
  const me = req.access!;
  const ids = [...new Set([...(b.roleIds ?? []), ...(b.userGroupId ? [b.userGroupId] : [])])];
  const roles = await rolesById(acct, ids);
  const tier = tierFor(roles, b.role ?? null);
  if (tier === 'owner' && me.role !== 'owner') throw forbidden('Only an owner can create another owner');
  if (rankOf(tier) > rankOf(me.role)) throw forbidden('You cannot create a user with a higher tier than yours');
  assertCovers(me.perms, accessOf(tier, roles), 'create a user');
  const dupe = await one('SELECT id FROM users WHERE email=$1', [b.email]);
  if (dupe) throw badRequest('That email is already registered');
  const pw = await hashPassword(b.password);
  const row = await tx(async (c) => {
    const u = (await c.query(
      `INSERT INTO users(account_id, email, password_hash, role, status, user_group_id, display_name)
       VALUES ($1,$2,$3,$4::user_role,'active',$5,$6) RETURNING id, email, display_name, role, status, created_at`,
      [acct, b.email, pw, tier, roles[0]?.id ?? null, b.displayName ?? null])).rows[0];
    for (const r of roles) {
      await c.query(`INSERT INTO user_group_members(user_id, group_id, granted_by) VALUES ($1,$2,$3)`, [u.id, r.id, req.auth!.sub.startsWith('apikey:') ? null : req.auth!.sub]);
    }
    return u;
  });
  await writeAudit(null, { accountId: acct, userId: req.auth!.sub, label: 'user', action: 'create', entityType: 'user', entityId: row.id, snapshot: { email: b.email, tier, roles: roles.map((r) => r.name) } }).catch(() => {});
  res.status(201).json(shape(row, roles));
}));

const patchSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(20).optional(),
  userGroupId: z.string().uuid().nullable().optional(),
  role: tierSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  displayName: z.string().max(120).nullable().optional(),
});

usersRouter.patch('/:id', asyncHandler(async (req, res) => {
  const b = patchSchema.parse(req.body);
  const acct = accountId(req);
  const me = req.access!;
  const target = await targetAccess(acct, req.params.id);
  assertCanManageUser(me, String(req.auth!.sub), target);

  const body = req.body ?? {};
  const rolesChanging = 'roleIds' in body || 'userGroupId' in body;
  const ids: string[] = 'roleIds' in body ? (b.roleIds ?? []) : 'userGroupId' in body ? (b.userGroupId ? [b.userGroupId] : []) : target.roles.map((r: RoleRow) => r.id);
  const roles = rolesChanging ? await rolesById(acct, [...new Set(ids)]) : target.roles;
  // The tier only moves when the roles or the tier itself are being changed;
  // disabling a user or renaming them leaves it exactly as it was.
  const tier: Tier = !rolesChanging && !b.role ? target.role
    : tierFor(roles, b.role ?? null, target.role === 'owner' ? 'owner' : null);

  if ((tier === 'owner') !== (target.role === 'owner') && me.role !== 'owner') throw forbidden('Only an owner can grant or remove the owner tier');
  if (rankOf(tier) > rankOf(me.role)) throw forbidden('You cannot give a tier above your own');
  assertCovers(me.perms, accessOf(tier, roles), 'give this user');
  if (target.role === 'owner' && (tier !== 'owner' || b.status === 'disabled')) await lastOwnerGuard(acct, target.id);

  await tx(async (c) => {
    await c.query(
      `UPDATE users SET role=$3::user_role, status=COALESCE($4::user_status, status), user_group_id=$5,
              display_name=CASE WHEN $6 THEN $7 ELSE display_name END
        WHERE id=$1 AND account_id=$2`,
      [target.id, acct, tier, b.status ?? null, roles[0]?.id ?? null, 'displayName' in body, b.displayName ?? null]);
    if (rolesChanging) {
      await c.query(`DELETE FROM user_group_members WHERE user_id=$1`, [target.id]);
      for (const r of roles) {
        await c.query(`INSERT INTO user_group_members(user_id, group_id, granted_by) VALUES ($1,$2,$3)`,
          [target.id, r.id, req.auth!.sub.startsWith('apikey:') ? null : req.auth!.sub]);
      }
    }
    // Sessions are re-issued with the new access: refresh tokens die now,
    // and the access cache is dropped by the users / membership triggers.
    if (rolesChanging || b.role || b.status) {
      await c.query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [target.id]);
    }
  });
  await writeAudit(null, { accountId: acct, userId: req.auth!.sub, label: 'user', action: 'update', entityType: 'user', entityId: target.id, snapshot: { tier, status: b.status, roles: roles.map((r: RoleRow) => r.name) } }).catch(() => {});
  const row = await one<any>(`SELECT id, email, display_name, role, status, created_at FROM users WHERE id=$1`, [target.id]);
  res.json(shape(row, roles));
}));

usersRouter.post('/:id/password', asyncHandler(async (req, res) => {
  const b = z.object({ password: z.string().min(10, 'Use at least 10 characters') }).parse(req.body ?? {});
  const acct = accountId(req);
  const target = await targetAccess(acct, req.params.id);
  assertCanManageUser(req.access!, String(req.auth!.sub), target);
  await query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [target.id, await hashPassword(b.password)]);
  await query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [target.id]);
  await writeAudit(null, { accountId: acct, userId: req.auth!.sub, label: 'user', action: 'update', entityType: 'user', entityId: target.id, snapshot: { password: 'reset' } }).catch(() => {});
  res.status(204).end();
}));

/** A user who lost their phone: their second steps and backup codes are
 *  removed and their sessions ended; they set one up again at next sign-in. */
usersRouter.post('/:id/mfa/reset', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const target = await targetAccess(acct, req.params.id);
  assertCanManageUser(req.access!, String(req.auth!.sub), target);
  await clearMfa('user', target.id);
  await query(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [target.id]);
  await writeAudit(null, { accountId: acct, userId: req.auth!.sub, label: 'security', action: 'update', entityType: 'user', entityId: target.id, snapshot: { mfa: 'reset' } }).catch(() => {});
  res.status(204).end();
}));

usersRouter.delete('/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const target = await targetAccess(acct, req.params.id);
  assertCanManageUser(req.access!, String(req.auth!.sub), target);
  if (target.role === 'owner') await lastOwnerGuard(acct, target.id);
  try {
    await query(`DELETE FROM users WHERE id=$1 AND account_id=$2`, [target.id, acct]);
  } catch (e: any) {
    if (e?.code === '23503') throw badRequest('This user is referenced by records that must be kept; disable the user instead');
    throw e;
  }
  await writeAudit(null, { accountId: acct, userId: req.auth!.sub, label: 'user', action: 'delete', entityType: 'user', entityId: target.id, snapshot: { email: target.email } }).catch(() => {});
  res.status(204).end();
}));

export { cleanPerms };
