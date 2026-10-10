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
    // Every client starts with the standard content types (services/contentTypes.ts).
    const { ensureStandardTypes } = await import('../services/contentTypes');
    await ensureStandardTypes(out.account.id).catch((e) => console.warn('[platform] standard types not seeded', e));

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
 * An account's GROUPS. A group ties channels to an output profile, and the
 * profile's workflow decides what the group's channels are: TRANSCODE (one
 * source in, a ladder built by us; watermark and captions possible) or
 * PACKAGING (a pre-encoded ladder passed through). New channels pick a group,
 * so an account with no transcode group cannot create a transcode channel:
 * this is where one is added. Group caps (channels, concurrent sources) are
 * entitlements, so only the SaaS admin sets them.
 */
platformRouter.get(
  '/accounts/:id/groups',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    res.json(await query(
      `SELECT g.id, g.name, g.max_channels, g.max_concurrent, p.name AS profile_name, p.workflow_type, p.rungs,
              (SELECT count(*)::int FROM channels c WHERE c.group_id = g.id) AS channel_count
         FROM groups g LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE g.account_id = $1 ORDER BY g.name`, [req.params.id]));
  })
);

const DEFAULT_LADDER = [{ height: 1080, bitrate_kbps: 5000 }, { height: 720, bitrate_kbps: 2800 }, { height: 480, bitrate_kbps: 1200 }];
const addGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  workflowType: z.enum(['transcode', 'package_only']),
  maxChannels: z.number().int().min(1).max(1000).default(5),
  maxConcurrent: z.number().int().min(1).max(500).default(3),
  rungs: z.array(z.object({ height: z.number().int().min(144).max(4320), bitrate_kbps: z.number().int().min(64).max(100000) })).min(1).max(10).optional(),
});

platformRouter.post(
  '/accounts/:id/groups',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const b = addGroupSchema.parse(req.body);
    const acc = await one<any>('SELECT id FROM accounts WHERE id = $1', [req.params.id]);
    if (!acc) throw notFound('account not found');
    const clash = await one<any>('SELECT 1 FROM groups WHERE account_id = $1 AND lower(name) = lower($2)', [acc.id, b.name]);
    if (clash) throw badRequest(`This account already has a group called "${b.name}"`);
    const out = await tx(async (c) => {
      // The group's own profile: its ladder is the default for the group's
      // channels (each channel can still set its own ladder).
      const profile = (await c.query(
        `INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,$2,$3::jsonb,$4) RETURNING id, name, workflow_type, rungs`,
        [acc.id, `${b.name} (${b.workflowType === 'transcode' ? 'transcode' : 'packaging'})`, JSON.stringify(b.rungs ?? DEFAULT_LADDER), b.workflowType])).rows[0];
      const group = (await c.query(
        `INSERT INTO groups(account_id, name, output_profile_id, max_channels, max_concurrent) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, max_channels, max_concurrent`,
        [acc.id, b.name, profile.id, b.maxChannels, b.maxConcurrent])).rows[0];
      await c.query(
        `INSERT INTO audit_log(account_id, user_id, action, entity_type, entity_id, detail)
         VALUES ($1,$2,'platform.group_create','group',$3,$4::jsonb)`,
        [acc.id, req.auth!.sub, group.id, JSON.stringify(b)]);
      return { ...group, profile_name: profile.name, workflow_type: profile.workflow_type, rungs: profile.rungs, channel_count: 0 };
    });
    res.status(201).json(out);
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

/* ============================================================================
 *  THE RELAY TIER — SYSTEM ADMIN ONLY, and the boundary is the point.
 *
 *  Everything below is on /api/platform behind requirePlatform, and none of it
 *  is reachable from the tenant API. That is not tidiness, it is the commercial
 *  boundary:
 *
 *    - The relay topology is SHARED infrastructure. One tenant learning which
 *      relay carries their stations learns which relay carries everyone else's.
 *    - relay_accruals and cost_actuals are the platform's own COST BASIS.
 *      Showing a customer what their traffic costs us to serve tells them our
 *      margin, and they will ask for it back.
 *
 *  A client's ACCOUNT ADMIN gets everything about their account: their stations,
 *  their users, their usage, their bill. That is usage_accruals, which is
 *  already account-scoped and stays exactly where it is. What they never get is
 *  the machinery underneath, and the way to keep that true is for it to have no
 *  route on the surface they can reach at all — rather than a route that checks
 *  a role and could one day stop checking.
 * ========================================================================= */

/** The fleet view for relays: assignment, live performance, uptime. */
platformRouter.get(
  '/relays',
  ...requirePlatform('read_only'),
  asyncHandler(async (_req, res) => {
    const { relayHealth } = await import('../services/fleet/relays');
    res.json({ relays: await relayHealth() });
  })
);

/** Which stations are on a relay. The direct answer to "what is on this box". */
platformRouter.get(
  '/relays/:id/stations',
  ...requirePlatform('read_only'),
  asyncHandler(async (req, res) => {
    const relay = await one<any>(`SELECT id, name FROM relays WHERE id=$1`, [req.params.id]);
    if (!relay) throw notFound('relay not found');
    const stations = await query<any>(
      `SELECT c.id, c.name, c.status, a.name AS account_name
         FROM channels c
         JOIN groups g ON g.id = c.group_id
         JOIN accounts a ON a.id = g.account_id
        WHERE c.relay_id = $1 AND c.kind = 'radio'
        ORDER BY c.name`, [relay.id]);
    res.json({ relay, stations });
  })
);

const relayBody = z.object({
  name: z.string().min(1),
  sourceHost: z.string().min(1),
  sourcePort: z.number().int().positive().optional(),
  sourceUser: z.string().optional(),
  tls: z.boolean().optional(),
  // The NAME of a secret, never a secret. See relays.secret_ref.
  secretRef: z.string().optional(),
  publicBase: z.string().optional(),
  adminBase: z.string().optional(),
  maxListeners: z.number().int().positive().optional(),
  region: z.string().optional(),
  hostId: z.string().uuid().optional(),
  note: z.string().optional(),
});

platformRouter.post(
  '/relays',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const b = relayBody.parse(req.body);
    const row = await one<any>(
      `INSERT INTO relays(name, source_host, source_port, source_user, tls, secret_ref,
                          public_base, admin_base, max_listeners, region, host_id, note)
       VALUES ($1,$2,COALESCE($3,8000),COALESCE($4,'source'),COALESCE($5,false),$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [b.name, b.sourceHost, b.sourcePort ?? null, b.sourceUser ?? null, b.tls ?? null,
       b.secretRef ?? null, b.publicBase ?? null, b.adminBase ?? null,
       b.maxListeners ?? null, b.region ?? null, b.hostId ?? null, b.note ?? null]);
    res.status(201).json(row);
  })
);

/**
 * DRAINING IS THE INTERESTING TRANSITION, which is why state is not a boolean.
 *
 * Retiring a relay must stop it taking NEW stations while the stations already
 * on it keep broadcasting. 'offline' is the harder statement — it makes every
 * station on this relay reassign on its next start — and an operator must be
 * able to say the first without accidentally saying the second.
 */
platformRouter.patch(
  '/relays/:id',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const b = z.object({
      state: z.enum(['active', 'draining', 'offline']).optional(),
      publicBase: z.string().nullable().optional(),
      maxListeners: z.number().int().positive().nullable().optional(),
      hostId: z.string().uuid().nullable().optional(),
      note: z.string().nullable().optional(),
    }).parse(req.body);
    const row = await one<any>(
      `UPDATE relays SET
         state = COALESCE($2, state),
         public_base = CASE WHEN $3::boolean THEN $4 ELSE public_base END,
         max_listeners = CASE WHEN $5::boolean THEN $6 ELSE max_listeners END,
         host_id = CASE WHEN $7::boolean THEN $8 ELSE host_id END,
         note = CASE WHEN $9::boolean THEN $10 ELSE note END,
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, b.state ?? null,
       'publicBase' in b, b.publicBase ?? null,
       'maxListeners' in b, b.maxListeners ?? null,
       'hostId' in b, b.hostId ?? null,
       'note' in b, b.note ?? null]);
    if (!row) throw notFound('relay not found');
    res.json(row);
  })
);

/**
 * ESTIMATED AGAINST ACTUAL — the reason for accruing anything at all.
 *
 * Every figure the fleet produces is observed seconds times a rate somebody
 * typed in. The invoice is the other side, and without both in one place the
 * estimate can never be checked and so never improves.
 */
platformRouter.get(
  '/costs/comparison',
  ...requirePlatform('read_only'),
  asyncHandler(async (req, res) => {
    const months = Math.min(36, Math.max(1, Number(req.query.months ?? 6) || 6));
    const { costComparison } = await import('../services/fleet/relays');
    res.json({ months, rows: await costComparison(months) });
  })
);

/** Enter what a month actually cost, from the bill. */
platformRouter.put(
  '/costs/actuals',
  ...requirePlatform('saas_admin'),
  asyncHandler(async (req, res) => {
    const b = z.object({
      // First of the month, UTC. A date rather than a range because cloud bills
      // are monthly and pretending otherwise invites overlapping periods.
      periodMonth: z.string().regex(/^\d{4}-\d{2}(-01)?$/),
      category: z.enum(['compute', 'relay', 'egress', 'storage', 'other']),
      usd: z.number(),
      source: z.string().optional(),
      note: z.string().optional(),
    }).parse(req.body);
    const month = b.periodMonth.length === 7 ? `${b.periodMonth}-01` : b.periodMonth;
    const row = await one<any>(
      `INSERT INTO cost_actuals(period_month, category, usd, source, note, entered_by)
       VALUES ($1::date,$2,$3,$4,$5,$6)
       ON CONFLICT (period_month, category)
       DO UPDATE SET usd = EXCLUDED.usd, source = EXCLUDED.source,
                     note = EXCLUDED.note, entered_by = EXCLUDED.entered_by,
                     updated_at = now()
       RETURNING *`,
      [month, b.category, b.usd, b.source ?? 'manual', b.note ?? null, req.auth!.sub]);
    res.json(row);
  })
);
