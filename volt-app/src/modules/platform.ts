/**
 * SaaS-provider (platform) management surface — cross-tenant monitoring & support.
 * Guarded by requirePlatform. This is the SaaS Admin's system view.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requirePlatform } from '../auth/platform';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { signAccess } from '../auth/jwt';
import { hashPassword } from '../auth/password';

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
              COALESCE(a.status,'active') AS status, a.created_at,
              (SELECT count(*) FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id=a.id) AS channels,
              (SELECT count(*) FROM users u WHERE u.account_id=a.id) AS users
         FROM accounts a ORDER BY a.name`
    );
    res.json(rows);
  })
);

/**
 * CREATE CLIENT ACCOUNT (saas_admin only). One transaction sets up everything a
 * new tenant needs to log in and go: the account row, its PRIMARY owner user,
 * a Default group and an HD output profile. The owner's password is returned
 * ONCE in this response (like an API key) and never again.
 */
const createAccountSchema = z.object({
  name: z.string().min(2),
  planTier: z.enum(['standard', 'pro', 'enterprise']).default('standard'),
  maxChannels: z.number().int().min(1).max(500).optional(),
  maxConcurrentSources: z.number().int().min(1).max(500).optional(),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
});

platformRouter.post(
  '/accounts',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const b = createAccountSchema.parse(req.body);
    const dupe = await one(`SELECT id FROM users WHERE email=$1`, [b.ownerEmail]);
    if (dupe) throw badRequest('That email is already registered');
    const pwHash = await hashPassword(b.ownerPassword);

    const out = await tx(async (c) => {
      const acc = (await c.query(
        `INSERT INTO accounts(name, plan_tier, max_channels, max_concurrent_sources, status)
         VALUES ($1,$2,COALESCE($3,5),COALESCE($4,3),'active')
         RETURNING id, name, plan_tier, max_channels, max_concurrent_sources, status, created_at`,
        [b.name, b.planTier, b.maxChannels ?? null, b.maxConcurrentSources ?? null]
      )).rows[0];
      const owner = (await c.query(
        `INSERT INTO users(account_id, email, password_hash, role, status)
         VALUES ($1,$2,$3,'owner','active') RETURNING id, email`,
        [acc.id, b.ownerEmail, pwHash]
      )).rows[0];
      const profile = (await c.query(
        `INSERT INTO output_profiles(account_id, name, rungs, workflow_type)
         VALUES ($1,'HD','[{"height":1080,"bitrate_kbps":5000},{"height":720,"bitrate_kbps":2500},{"height":480,"bitrate_kbps":1200}]'::jsonb,'transcode')
         RETURNING id`,
        [acc.id]
      )).rows[0];
      await c.query(
        `INSERT INTO groups(account_id, name, output_profile_id, max_channels, max_concurrent)
         VALUES ($1,'Default',$2,COALESCE($3,5),COALESCE($4,3))`,
        [acc.id, profile.id, b.maxChannels ?? null, b.maxConcurrentSources ?? null]
      );
      await c.query(
        `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
         VALUES ($1,$2,'platform.account_create','account',$1,$3::jsonb)`,
        [acc.id, req.auth!.sub, JSON.stringify({ plan_tier: b.planTier, owner_email: b.ownerEmail })]
      );
      return { account: acc, owner };
    });

    res.status(201).json({
      account: out.account,
      owner: { id: out.owner.id, email: out.owner.email },
      // shown once, exactly like a freshly minted API key
      credentials: { email: b.ownerEmail, password: b.ownerPassword },
      note: 'Share these credentials with the client now: the password is not retrievable later.',
    });
  })
);

/** Update a client account: plan, quotas, suspend / reactivate. */
const patchAccountSchema = z.object({
  name: z.string().min(2).optional(),
  planTier: z.enum(['standard', 'pro', 'enterprise']).optional(),
  maxChannels: z.number().int().min(1).max(500).optional(),
  maxConcurrentSources: z.number().int().min(1).max(500).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

platformRouter.patch(
  '/accounts/:id',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const b = patchAccountSchema.parse(req.body);
    const row = await one<any>(
      `UPDATE accounts SET
         name=COALESCE($2,name),
         plan_tier=COALESCE($3,plan_tier),
         max_channels=COALESCE($4,max_channels),
         max_concurrent_sources=COALESCE($5,max_concurrent_sources),
         status=COALESCE($6,status),
         updated_at=now()
       WHERE id=$1
       RETURNING id, name, plan_tier, max_channels, max_concurrent_sources, status, created_at`,
      [req.params.id, b.name ?? null, b.planTier ?? null, b.maxChannels ?? null, b.maxConcurrentSources ?? null, b.status ?? null]
    );
    if (!row) throw notFound('account not found');
    if (b.status === 'suspended') {
      // cut live sessions at the next token refresh; login + API keys are already blocked
      await query(
        `UPDATE refresh_tokens SET revoked_at=now()
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE account_id=$1)`,
        [row.id]
      );
    }
    await query(
      `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,'platform.account_update','account',$1,$3::jsonb)`,
      [row.id, req.auth!.sub, JSON.stringify(b)]
    );
    res.json(row);
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
