/**
 * ACCESS ROLES (stored as user_groups): named per-feature levels that members
 * inherit. Mounted at /api/user-groups (original path) and /api/access-roles.
 *
 *   GET    /            access:view    every role in the account + member counts
 *   GET    /catalogue   access:view    features, levels, what "operate" means
 *   POST   /            access:manage  create a custom role
 *   POST   /:id/copy    access:manage  copy any role (the way to vary a system role)
 *   PATCH  /:id         access:manage  edit a custom role
 *   DELETE /:id         access:manage  delete a custom role
 *
 * NO ESCALATION: a role can only be created or edited with levels the editor
 * holds, and a role the editor does not fully cover cannot be edited or
 * deleted by them. System roles are read-only. The model is in auth/roles.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { FEATURES, LEVELS, cleanPerms, effectivePerms, assertCovers, accessDescription, CATALOGUE, type Perms } from '../auth/roles';
import { asyncHandler, notFound, badRequest, forbidden } from '../util/http';
import { writeAudit } from '../services/audit';

export const userGroupsRouter = Router();
userGroupsRouter.use(requireAuth);

const levelSchema = z.enum(LEVELS);
const permsSchema = z.record(levelSchema).refine(
  (p) => Object.keys(p).every((k) => FEATURES.includes(k)),
  { message: `permissions keys must be one of: ${FEATURES.join(', ')}` }
);
const tierSchema = z.enum(['operator', 'viewer']);

function shape(g: any) {
  return {
    id: g.id, name: g.name, description: g.description, key: g.role_key ?? null,
    system: !!g.is_system, tier: g.tier, permissions: cleanPerms(g.permissions),
    memberCount: g.member_count ?? 0, createdAt: g.created_at, updatedAt: g.updated_at,
    // legacy field names the original console reads
    member_count: g.member_count ?? 0,
  };
}

/** What a member of this role would hold: the tier cap applied. */
const grantOf = (tier: string, perms: Perms) => effectivePerms(tier, [perms]);

userGroupsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT g.*, (SELECT count(*)::int FROM user_group_members m WHERE m.group_id = g.id) AS member_count
       FROM user_groups g WHERE g.account_id=$1 ORDER BY g.is_system DESC, g.name`,
    [accountId(req)]
  );
  res.json(rows.map(shape));
}));

userGroupsRouter.get('/catalogue', asyncHandler(async (_req, res) => {
  res.json({ ...accessDescription(), catalogue: CATALOGUE.map((f) => ({ key: f.key, label: f.label, area: f.area, operate: f.operateMeans ?? null })) });
}));

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  tier: tierSchema.default('operator'),
  permissions: permsSchema.default({}),
});

async function nameFree(acct: string, name: string, exceptId?: string) {
  const d = await one(`SELECT id FROM user_groups WHERE account_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3)`, [acct, name, exceptId ?? null]);
  if (d) throw badRequest('A role with that name already exists');
}

userGroupsRouter.post('/', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const perms = cleanPerms(b.permissions);
  assertCovers(req.access!.perms, grantOf(b.tier, perms), 'create a role');
  await nameFree(accountId(req), b.name);
  const row = await one(
    `INSERT INTO user_groups(account_id, name, description, permissions, tier)
     VALUES ($1,$2,$3,$4::jsonb,$5::user_role) RETURNING *, 0 AS member_count`,
    [accountId(req), b.name, b.description ?? null, JSON.stringify(perms), b.tier]
  );
  await writeAudit(null, { accountId: accountId(req), userId: req.auth!.sub, label: 'role', action: 'create', entityType: 'access_role', entityId: (row as any).id, snapshot: b }).catch(() => {});
  res.status(201).json(shape(row));
}));

userGroupsRouter.post('/:id/copy', asyncHandler(async (req, res) => {
  const src = await one<any>(`SELECT * FROM user_groups WHERE id=$1 AND account_id=$2`, [req.params.id, accountId(req)]);
  if (!src) throw notFound('Role not found');
  const name = z.object({ name: z.string().min(1).max(80).optional() }).parse(req.body ?? {}).name ?? `${src.name} (copy)`;
  const tier = src.tier === 'admin' || src.tier === 'owner' ? 'operator' : src.tier;
  const perms = cleanPerms(src.permissions);
  assertCovers(req.access!.perms, grantOf(tier, perms), 'copy a role');
  await nameFree(accountId(req), name);
  const row = await one(
    `INSERT INTO user_groups(account_id, name, description, permissions, tier)
     VALUES ($1,$2,$3,$4::jsonb,$5::user_role) RETURNING *, 0 AS member_count`,
    [accountId(req), name, src.description, JSON.stringify(perms), tier]
  );
  res.status(201).json(shape(row));
}));

async function editable(req: any, id: string) {
  const g = await one<any>(`SELECT * FROM user_groups WHERE id=$1 AND account_id=$2`, [id, accountId(req)]);
  if (!g) throw notFound('Role not found');
  if (g.is_system) throw forbidden('System roles cannot be changed. Copy it and edit the copy.');
  // Editing or deleting a role you do not fully hold would let you change
  // what its (more powerful) members can do.
  assertCovers(req.access!.perms, grantOf(g.tier, cleanPerms(g.permissions)), 'change a role');
  return g;
}

userGroupsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    tier: tierSchema.optional(),
    permissions: permsSchema.optional(),
  }).parse(req.body);
  const g = await editable(req, req.params.id);
  const perms = b.permissions ? cleanPerms(b.permissions) : cleanPerms(g.permissions);
  assertCovers(req.access!.perms, grantOf(b.tier ?? g.tier, perms), 'give a role');
  if (b.name) await nameFree(accountId(req), b.name, g.id);
  const row = await one(
    `UPDATE user_groups SET
       name=COALESCE($3,name),
       description=CASE WHEN $4 THEN $5 ELSE description END,
       permissions=$6::jsonb,
       tier=COALESCE($7::user_role, tier),
       updated_at=now()
     WHERE id=$1 AND account_id=$2
     RETURNING *, (SELECT count(*)::int FROM user_group_members m WHERE m.group_id = user_groups.id) AS member_count`,
    [g.id, accountId(req), b.name ?? null,
     Object.prototype.hasOwnProperty.call(req.body ?? {}, 'description'), b.description ?? null,
     JSON.stringify(perms), b.tier ?? null]
  );
  // Members' cached access is dropped by the user_groups trigger (0047).
  await writeAudit(null, { accountId: accountId(req), userId: req.auth!.sub, label: 'role', action: 'update', entityType: 'access_role', entityId: g.id, snapshot: b }).catch(() => {});
  res.json(shape(row));
}));

userGroupsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const g = await editable(req, req.params.id);
  await query(`UPDATE users SET user_group_id=NULL WHERE user_group_id=$1`, [g.id]);
  await query(`DELETE FROM user_groups WHERE id=$1 AND account_id=$2`, [g.id, accountId(req)]);
  await writeAudit(null, { accountId: accountId(req), userId: req.auth!.sub, label: 'role', action: 'delete', entityType: 'access_role', entityId: g.id, snapshot: { name: g.name } }).catch(() => {});
  res.status(204).end();
}));
