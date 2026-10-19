// ============================================================================
//  PLAN AND ALLOCATION (docs/PLAN_AND_GROUPS.md).
//
//    ACCOUNT  the plan: a name, how many channels and stations in all
//             (accounts.max_channels) and how many may run at once
//             (accounts.max_concurrent_sources). Set by the platform, or in a
//             single-client deployment by the account owner (the super user).
//    GROUP    a share of the plan: groups.max_channels channels and stations,
//             groups.max_concurrent running at once. Account administrators
//             share the plan out; allocations add up to no more than the plan.
//
//  A new channel or station needs room in BOTH: the account under its plan,
//  and the group under its allocation.
// ============================================================================
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { one } from '../db';
import { config } from '../config';
import { rankOf, ROLE_RANK } from '../auth/roles';
import { conflict, forbidden } from '../util/http';

export interface PlanUsage {
  accountId: string; accountName: string
  planTier: string; maxChannels: number; maxConcurrent: number
  used: { total: number; tv: number; radio: number; events: number; running: number }
  allocated: number; unallocated: number
}

async function q1<T = any>(c: PoolClient | null, sql: string, p: unknown[]): Promise<T | null> {
  if (c) return ((await c.query(sql, p)).rows[0] ?? null) as T | null;
  return one<T>(sql, p);
}

export async function planUsage(accountId: string, c: PoolClient | null = null): Promise<PlanUsage> {
  const r = await q1<any>(c,
    `SELECT a.id, a.name, a.plan_tier, a.max_channels, a.max_concurrent_sources,
            (SELECT count(*)::int FROM channels ch JOIN groups g ON g.id = ch.group_id WHERE g.account_id = a.id) AS total,
            (SELECT count(*)::int FROM channels ch JOIN groups g ON g.id = ch.group_id WHERE g.account_id = a.id AND ch.kind = 'radio') AS radio,
            (SELECT count(*)::int FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = a.id) AS events,
            (SELECT count(*)::int FROM channels ch JOIN groups g ON g.id = ch.group_id WHERE g.account_id = a.id AND ch.status = 'live') AS running,
            (SELECT COALESCE(sum(g.max_channels), 0)::int FROM groups g WHERE g.account_id = a.id) AS allocated
       FROM accounts a WHERE a.id = $1`, [accountId]);
  if (!r) throw new Error('account not found');
  return {
    accountId: r.id, accountName: r.name, planTier: r.plan_tier,
    maxChannels: r.max_channels, maxConcurrent: r.max_concurrent_sources,
    used: { total: r.total, tv: r.total - r.radio, radio: r.radio, events: r.events, running: r.running },
    allocated: r.allocated, unallocated: Math.max(0, r.max_channels - r.allocated),
  };
}

async function platformRoleOf(req: Request): Promise<string | null> {
  const sub = String(req.auth?.sub ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(sub)) return null;
  const u = await one<{ platform_role: string | null }>('SELECT platform_role FROM users WHERE id = $1', [sub]);
  return u?.platform_role ?? null;
}

/** May this user change the PLAN? System admins always; owners in a single-client deployment. */
export async function planEditor(req: Request): Promise<{ ok: boolean; why: string }> {
  if ((await platformRoleOf(req)) === 'saas_admin') return { ok: true, why: 'system administrator' };
  if (config.deployment === 'single' && rankOf(req.auth?.role) >= ROLE_RANK.owner) return { ok: true, why: 'account owner (single-client deployment)' };
  return {
    ok: false,
    why: config.deployment === 'single'
      ? 'Only the account owner or a system administrator changes the plan.'
      : 'The plan is set by your platform provider. Ask them to change it.',
  };
}

/** May this user create, allocate, set the default of, or remove GROUPS? Account admins and system admins. */
export async function groupManager(req: Request): Promise<boolean> {
  if (rankOf(req.auth?.role) >= ROLE_RANK.admin) return true;
  return (await platformRoleOf(req)) === 'saas_admin';
}
export async function assertGroupManager(req: Request) {
  if (!(await groupManager(req))) throw forbidden('Creating, sharing out and removing groups needs an account administrator or a system administrator');
}

const things = (tv: number, radio: number) => {
  const p = [`${tv} TV channel${tv === 1 ? '' : 's'}`];
  if (radio) p.push(`${radio} radio station${radio === 1 ? '' : 's'}`);
  return p.join(' and ');
};

/** Refuse a new channel or station when the ACCOUNT's plan is used up. */
export async function assertPlanRoom(accountId: string, c: PoolClient | null = null) {
  const u = await planUsage(accountId, c);
  if (u.used.total >= u.maxChannels) {
    throw conflict(`Your plan allows ${u.maxChannels} channels and stations together and all are in use (${things(u.used.tv, u.used.radio)}). ` +
      'Remove one, or ask for a bigger plan.');
  }
}

/**
 * Check a group's new allocation against the plan and its own use. Returns
 * nothing; throws a 409 with the numbers when it does not fit.
 */
export async function assertAllocationFits(accountId: string, groupId: string | null, maxChannels: number, maxConcurrent: number | null) {
  const u = await planUsage(accountId);
  const g = groupId ? await one<any>(
    `SELECT g.name, g.max_channels,
            (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id) AS used
       FROM groups g WHERE g.id = $1`, [groupId]) : null;
  const others = u.allocated - (g?.max_channels ?? 0);
  if (g && maxChannels < g.used) {
    throw conflict(`${g.name} already has ${g.used} channels and stations, so it needs at least ${g.used}.`);
  }
  if (others + maxChannels > u.maxChannels) {
    const free = Math.max(0, u.maxChannels - others);
    throw conflict(`The plan allows ${u.maxChannels} channels and stations; other groups are given ${others}, so this group can have at most ${free}. ` +
      'Lower another group first, or ask for a bigger plan.');
  }
  if (maxConcurrent != null && maxConcurrent > u.maxConcurrent) {
    throw conflict(`The plan allows ${u.maxConcurrent} running at once, so a group cannot be given more.`);
  }
}

/** What a group holds, for the remove dialog and the remove guard. */
export async function groupUse(groupId: string) {
  const r = await one<any>(
    `SELECT g.id, g.name, g.is_default,
            (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id AND c.kind <> 'radio') AS channels,
            (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id AND c.kind = 'radio') AS stations,
            (SELECT count(*)::int FROM events e WHERE e.group_id = g.id) AS events,
            (SELECT count(*)::int FROM events e WHERE e.group_id = g.id AND e.status IN ('scheduled','provisioning','testing','live')) AS events_upcoming
       FROM groups g WHERE g.id = $1`, [groupId]);
  if (!r) return null;
  const inUse = r.channels + r.stations + r.events > 0;
  const parts: string[] = []
  if (r.channels) parts.push(`${r.channels} TV channel${r.channels === 1 ? '' : 's'}`);
  if (r.stations) parts.push(`${r.stations} radio station${r.stations === 1 ? '' : 's'}`);
  if (r.events) parts.push(`${r.events} event${r.events === 1 ? '' : 's'}${r.events_upcoming ? ` (${r.events_upcoming} not yet ended)` : ''}`);
  const blocker = r.is_default
    ? `${r.name} is the default group, where new channels, stations and events go. Make another group the default first.`
    : inUse ? `${r.name} is in use: ${parts.join(', ')}. Move or remove them first.` : null;
  return { id: r.id, name: r.name, isDefault: r.is_default, counts: { channels: r.channels, stations: r.stations, events: r.events, eventsUpcoming: r.events_upcoming }, inUse, blocker };
}

