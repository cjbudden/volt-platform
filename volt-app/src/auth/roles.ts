/**
 * ACCESS MODEL — roles + user groups.
 *
 * Two layers, matching how the product is operated:
 *
 * 1. ROLE (rank): owner > admin > operator > viewer. Owners/admins always have
 *    full tenant access (someone must be able to fix a bad group). The role
 *    also draws hard lines the groups can never cross: user management, apps &
 *    API keys and account config are admin+ regardless of any group.
 *
 * 2. USER GROUP (feature access): every non-admin user can be assigned to a
 *    user group; the group sets a LEVEL PER FEATURE — none / view / manage —
 *    and that decides which sections and functions the member can use. A user
 *    without a group falls back to their role's default (viewer = view
 *    content, operator = manage content).
 *
 * Enforcement is CENTRAL: requireAuth resolves the caller's effective feature
 * map (cached ~20s) and checks it against the requested path + method, so new
 * endpoints are covered by default and the rules live in one place. The same
 * map is served via /api/auth/me so the UI gates nav items and buttons
 * consistently with the API.
 */
import { Request, Response, NextFunction } from 'express';
import { one } from '../db';
import { forbidden } from '../util/http';

export type Role = 'viewer' | 'operator' | 'admin' | 'owner';
export const ROLE_RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

export type Level = 'none' | 'view' | 'manage';
const LEVEL_RANK: Record<Level, number> = { none: 0, view: 1, manage: 2 };

/** The manageable FEATURES and the API surfaces they cover. */
export const FEATURES = ['channels', 'events', 'epg', 'recordings', 'vod', 'media', 'sharing', 'analytics'] as const;
export type Feature = (typeof FEATURES)[number];

const FEATURE_PREFIXES: Record<Feature, string[]> = {
  channels: ['/api/channels', '/api/sources', '/api/streams'],
  events: ['/api/events'],
  epg: ['/api/epg'],
  recordings: ['/api/recordings', '/api/scheduled-clips'],
  vod: ['/api/vod', '/api/publications'],
  media: ['/api/files', '/api/filler-assets'],
  sharing: ['/api/share-links'],
  analytics: ['/api/analytics'],
};

/** Admin-only surfaces: NEVER delegated to a user group. */
const ADMIN_PREFIXES = [
  '/api/users', '/api/user-groups', '/api/apps',
  '/api/groups', '/api/output-profiles', '/api/metadata-schemas',
  '/api/notification-templates', '/api/publish-targets',
];
/** Admin surfaces where operators/viewers still need READ (forms use them). */
const ADMIN_READ_OPEN = ['/api/groups', '/api/output-profiles', '/api/metadata-schemas'];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function featureOf(path: string): Feature | null {
  for (const f of FEATURES) if (FEATURE_PREFIXES[f].some((p) => path.startsWith(p))) return f;
  return null;
}

/** Role default feature map (used when the user has no group). */
export function roleDefaultPerms(role: string): Record<Feature, Level> {
  const lvl: Level = ROLE_RANK[role] >= ROLE_RANK.operator ? 'manage' : 'view';
  return Object.fromEntries(FEATURES.map((f) => [f, lvl])) as Record<Feature, Level>;
}

/** Effective per-feature map for a user: admins full; group wins when set. */
export function effectivePerms(role: string, groupPerms: Record<string, string> | null): Record<Feature, Level> {
  if (ROLE_RANK[role] >= ROLE_RANK.admin) {
    return Object.fromEntries(FEATURES.map((f) => [f, 'manage'])) as Record<Feature, Level>;
  }
  if (!groupPerms) return roleDefaultPerms(role);
  const out = {} as Record<Feature, Level>;
  for (const f of FEATURES) {
    const v = groupPerms[f];
    out[f] = v === 'manage' || v === 'view' ? (v as Level) : 'none';
    // a viewer's group can grant at most view (role rank still caps writes)
    if (out[f] === 'manage' && ROLE_RANK[role] < ROLE_RANK.operator) out[f] = 'view';
  }
  return out;
}

// ---- per-request resolution (cached) ---------------------------------------
const cache = new Map<string, { role: string; perms: Record<Feature, Level>; at: number }>();
const TTL = 20_000;

export async function resolveAccess(userId: string, tokenRole: string): Promise<{ role: string; perms: Record<Feature, Level> }> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL) return hit;
  let role = tokenRole;
  let groupPerms: Record<string, string> | null = null;
  if (!userId.startsWith('apikey:')) {
    const row = await one<any>(
      `SELECT u.role, g.permissions FROM users u
         LEFT JOIN user_groups g ON g.id = u.user_group_id
        WHERE u.id=$1 AND u.status='active'`, [userId]);
    if (row) { role = row.role; groupPerms = row.permissions ?? null; }
  }
  const entry = { role, perms: effectivePerms(role, groupPerms), at: Date.now() };
  cache.set(userId, entry);
  return entry;
}
export function invalidateAccess(userId?: string) {
  if (userId) cache.delete(userId); else cache.clear();
}

/** Central gate: throws 403 when the caller's effective access is short. */
export async function enforceAccess(req: Request): Promise<void> {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  const isWrite = WRITE_METHODS.has(req.method.toUpperCase());
  const { role, perms } = await resolveAccess(String(req.auth!.sub), String(req.auth!.role));
  (req.auth as any).role = role;   // keep downstream checks honest after role changes

  // hard admin lines first
  if (ADMIN_PREFIXES.some((p) => path.startsWith(p))) {
    const readOpen = !isWrite && ADMIN_READ_OPEN.some((p) => path.startsWith(p));
    if (!readOpen && ROLE_RANK[role] < ROLE_RANK.admin) {
      throw forbidden('This area requires the admin role');
    }
    return;
  }
  const feature = featureOf(path);
  if (!feature) {
    // unmapped surfaces: writes need operator+, reads any authenticated user
    if (isWrite && ROLE_RANK[role] < ROLE_RANK.operator) throw forbidden('This action requires the operator role');
    return;
  }
  const need: Level = isWrite ? 'manage' : 'view';
  if (LEVEL_RANK[perms[feature]] < LEVEL_RANK[need]) {
    throw forbidden(`Your user group does not allow ${need === 'manage' ? 'changes to' : 'access to'} ${feature}`);
  }
}

/** Router-level guard for surfaces with an explicit role floor. */
export function requireMinRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = String(req.auth?.role ?? 'viewer');
    if ((ROLE_RANK[role] ?? 0) < ROLE_RANK[min]) return next(forbidden(`This action requires the ${min} role`));
    next();
  };
}

/** The model as data for /api/auth/me → consistent UI gating. */
export function accessDescription() {
  return {
    roles: ['viewer', 'operator', 'admin', 'owner'],
    features: FEATURES,
    levels: ['none', 'view', 'manage'],
    notes: [
      'Owners and admins always have full access; groups apply to operators and viewers.',
      'User management, apps & API keys and account config are admin-only, never delegated to a group.',
      "A viewer's group can grant at most view access.",
    ],
  };
}
