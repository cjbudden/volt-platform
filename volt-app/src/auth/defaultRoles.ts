/**
 * THE DEFAULT ADMIN ROLES every account gets. See ACCESS_CONTROL.md.
 *
 * System roles (is_system) are read-only: "Administrator" means the same in
 * every account, and an account that wants a variation copies one and edits
 * the copy. They are created for new accounts at registration and topped up
 * for existing accounts at boot (ensureDefaultRoles), idempotently.
 *
 * "Public" is deliberately NOT here: a public user is a viewer account
 * (auth/viewerTokens.ts), a different kind of principal that can never hold an
 * admin session, not a role an admin user can be given.
 */
import { query } from '../db';
import { allPerms, type Level, type Perms, type Role } from './roles';

export interface DefaultRole {
  key: string;
  name: string;
  description: string;
  tier: Role;
  permissions: Perms;
}

function perms(p: Record<string, Level>): Perms {
  return { ...allPerms('none'), ...p };
}

const CONTENT_VIEW: Record<string, Level> = {
  monitoring: 'view', channels: 'view', radio: 'view', events: 'view', epg: 'view',
  recordings: 'view', vod: 'view', media: 'view', sharing: 'view',
};

export const DEFAULT_ROLES: DefaultRole[] = [
  {
    key: 'administrator', name: 'Administrator', tier: 'admin',
    description: 'Full access to everything in the account, including users, roles, apps, payments and settings.',
    permissions: allPerms('manage'),
  },
  {
    key: 'analytics_manager', name: 'Report and Analytics Manager', tier: 'operator',
    description: 'Manages analytics and reports. Sees channels, stations, events and usage; cannot change or run them.',
    permissions: perms({ ...CONTENT_VIEW, analytics: 'manage', fleet: 'view', viewers: 'view' }),
  },
  {
    key: 'event_manager', name: 'Event Manager', tier: 'operator',
    description: 'Creates, schedules and runs events, their EPG and recordings, and publishes the results.',
    permissions: perms({
      monitoring: 'view', events: 'manage', epg: 'manage', recordings: 'manage', vod: 'operate',
      media: 'manage', sharing: 'manage', analytics: 'view', channels: 'view',
    }),
  },
  {
    key: 'radio_manager', name: 'Radio Manager', tier: 'operator',
    description: 'Creates, configures and runs radio stations, their schedules and clips.',
    permissions: perms({
      monitoring: 'view', radio: 'manage', epg: 'manage', recordings: 'manage', media: 'manage',
      sharing: 'manage', analytics: 'view',
    }),
  },
  {
    key: 'system_viewer', name: 'System Viewer', tier: 'viewer',
    description: 'Read-only access to the whole admin: every list and detail page, no changes and no start/stop.',
    permissions: perms({
      ...CONTENT_VIEW, analytics: 'view', fleet: 'view', users: 'view', access: 'view', viewers: 'view',
      apps: 'view', payments: 'view', settings: 'view',
    }),
  },
];

/** Create (or refresh) the system roles for one account, or for every account. */
export async function ensureDefaultRoles(accountId?: string): Promise<number> {
  let n = 0;
  for (const r of DEFAULT_ROLES) {
    const rows = await query(
      `INSERT INTO user_groups(account_id, name, description, permissions, is_system, role_key, tier)
       SELECT a.id,
              -- an account that already named a custom role the same keeps it
              CASE WHEN EXISTS (SELECT 1 FROM user_groups x WHERE x.account_id = a.id AND x.name = $2
                                  AND x.role_key IS DISTINCT FROM $1)
                   THEN $2 || ' (default)' ELSE $2 END,
              $3, $4::jsonb, true, $1, $5::user_role
         FROM accounts a
        WHERE ($6::uuid IS NULL OR a.id = $6)
       ON CONFLICT (account_id, role_key) WHERE role_key IS NOT NULL DO UPDATE
         SET description = EXCLUDED.description,
             permissions = EXCLUDED.permissions,
             tier = EXCLUDED.tier,
             is_system = true,
             updated_at = now()
         WHERE user_groups.permissions IS DISTINCT FROM EXCLUDED.permissions
            OR user_groups.tier IS DISTINCT FROM EXCLUDED.tier
            OR user_groups.description IS DISTINCT FROM EXCLUDED.description
       RETURNING id`,
      [r.key, r.name, r.description, JSON.stringify(r.permissions), r.tier, accountId ?? null]
    );
    n += rows.length;
  }
  return n;
}
