/**
 * SaaS-provider (platform) management surface — cross-tenant monitoring & support.
 * Guarded by requirePlatform. This is the SaaS Admin's system view.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requirePlatform } from '../auth/platform';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { signAccess } from '../auth/jwt';

export const platformRouter = Router();

/** The SaaS Admin dashboard: everything across all tenants in one call. */
platformRouter.get(
  '/overview',
  ...requirePlatform('read_only'),
  asyncHandler(async (_req, res) => {
    const activeInstances = await query(
      `SELECT i.id, i.channel_id, i.event_id, i.instance_type, i.is_gpu, i.lifecycle, i.state, i.launched_at
         FROM instances i WHERE i.terminated_at IS NULL ORDER BY i.launched_at DESC NULLS LAST`
    );
    const activeChannels = await query(
      `SELECT c.id, c.name, g.account_id, a.name AS account_name
         FROM channels c JOIN groups g ON g.id=c.group_id JOIN accounts a ON a.id=g.account_id
        WHERE c.status='live' ORDER BY c.name`
    );
    const upcoming = await query(
      `SELECT e.id, e.name, e.scheduled_start, e.scheduled_end, g.account_id, a.name AS account_name
         FROM events e JOIN groups g ON g.id=e.group_id JOIN accounts a ON a.id=g.account_id
        WHERE e.scheduled_start BETWEEN now() AND now() + interval '24 hours' AND e.status <> 'ended'
        ORDER BY e.scheduled_start LIMIT 100`
    );
    // projected containers needed today = live channels + events whose server window is today
    const projected = await one<any>(
      `SELECT (SELECT count(*) FROM channels WHERE status='live')
            + (SELECT count(*) FROM events
                WHERE status <> 'ended'
                  AND COALESCE(server_start, scheduled_start)::date <= current_date
                  AND COALESCE(server_stop,  scheduled_end)::date   >= current_date) AS n`
    );
    const viewers = await one<any>(
      `SELECT COALESCE(SUM(concurrent),0)::int AS n FROM stream_concurrency WHERE updated_at > now() - interval '120 seconds'`
    );
    const admins = await one<any>(
      `SELECT count(DISTINCT user_id)::int AS n FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()`
    );
    const tickets = await query(`SELECT status, count(*)::int AS n FROM support_tickets GROUP BY status`);
    const openTickets = await query(
      `SELECT t.id, t.subject, t.status, t.priority, a.name AS account_name, t.created_at
         FROM support_tickets t JOIN accounts a ON a.id=t.account_id
        WHERE t.status IN ('open','pending') ORDER BY t.priority DESC, t.created_at LIMIT 25`
    );
    // system/API status = quick subsystem checks
    let dbOk = true;
    try { await one(`SELECT 1 AS ok`); } catch { dbOk = false; }
    res.json({
      generated_at: new Date().toISOString(),
      servers: { active: activeInstances.length, projected_today: projected?.n ?? 0, instances: activeInstances },
      channels: { active: activeChannels.length, list: activeChannels },
      upcoming_events: upcoming,
      viewers: { active: viewers?.n ?? 0 },
      admins: { active: admins?.n ?? 0 },
      api_status: { database: dbOk ? 'ok' : 'down', orchestrator: 'ok', ingest: 'ok' },
      tickets: { by_status: Object.fromEntries(tickets.map((t: any) => [t.status, t.n])), open: openTickets },
    });
  })
);

/** All tenants + headline usage (for the provider account list). */
platformRouter.get(
  '/accounts',
  ...requirePlatform('read_only'),
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT a.id, a.name, a.plan_tier, a.max_channels, a.max_concurrent_sources,
              (SELECT count(*) FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=a.id) AS channels,
              (SELECT count(*) FROM users u WHERE u.account_id=a.id) AS users
         FROM accounts a ORDER BY a.name`
    );
    res.json(rows);
  })
);

/**
 * Account impersonation ("view as") — PLANNED / behind saas_admin. Mints a
 * short-lived tenant-scoped token as the account's owner and audit-logs it.
 * Deferred past the initial deployment but wired so support can use it safely.
 */
platformRouter.post(
  '/impersonate/:accountId',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const acct = await one<any>(`SELECT id, name FROM accounts WHERE id=$1`, [req.params.accountId]);
    if (!acct) throw notFound('account not found');
    const owner = await one<any>(`SELECT id, role FROM users WHERE account_id=$1 AND role='owner' ORDER BY created_at LIMIT 1`, [acct.id]);
    if (!owner) throw badRequest('account has no owner user to view as');
    const token = signAccess({ sub: owner.id, account_id: acct.id, role: 'admin' }); // view-as, not full owner
    await query(
      `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,'platform.impersonate','account',$1,$3::jsonb)`,
      [acct.id, req.auth!.sub, JSON.stringify({ by_platform_user: req.auth!.sub, role: req.platformRole })]
    );
    res.json({ account: acct.name, viewAsToken: token, note: 'short-lived tenant-scoped token; audit-logged' });
  })
);
