/**
 * Publishing rules (the ladder) and an asset's availability.
 *
 *   GET  /api/publishing-rules                      every rung the account has
 *   GET  /api/publishing-rules/points               the client's publishing points
 *   GET  /api/publishing-rules/:scopeKind/:scopeId  one rung ('account' has no id)
 *   PUT  /api/publishing-rules/:scopeKind/:scopeId  create or replace that rung's settings
 *   DELETE                                           remove an owner / type rung (account stays)
 *   GET  /api/publishing-rules/resolve?assetId=      what an asset would get, and from where
 *
 * All scoped to the caller's account: a rung can only name the account's own
 * types, owners, apps and social accounts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, conflict } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { resolveForAsset, validateTargets, publishingPoints, RULE_KEYS, type RuleSettings } from '../services/publishingRules';
import { assetAccount } from '../services/availability';

export const publishingRulesRouter = Router();
publishingRulesRouter.use(requireAuth);

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portal') }),
  z.object({ kind: z.literal('app'), appId: z.string().uuid() }),
  z.object({ kind: z.literal('social'), targetId: z.string().uuid(), platform: z.string().optional() }),
]);
export const settingsSchema = z.object({
  targets: z.array(target).optional(),
  autoPublish: z.boolean().optional(),
  availableFrom: z.union([z.object({ mode: z.literal('publish') }), z.object({ mode: z.literal('at'), at: z.string() })]).optional(),
  expire: z.union([
    z.object({ mode: z.literal('never') }),
    z.object({ mode: z.literal('days'), days: z.number().int().positive().max(3650) }),
    z.object({ mode: z.literal('at'), at: z.string() }),
  ]).optional(),
  geo: z.object({ mode: z.enum(['worldwide', 'allow', 'block']), countries: z.array(z.string().length(2)).default([]) }).optional(),
  access: z.enum(['free', 'entitled', 'paid']).optional(),
  paywall: z.object({ tier: z.string().optional(), priceCents: z.number().int().nonnegative().optional(), currency: z.string().length(3).optional() }).nullable().optional(),
  gate: z.object({ requireReview: z.boolean(), blockOnQcFail: z.boolean() }).optional(),
}).strict();

/** Clean a rung: validate targets against the account and drop unknown keys. */
export async function cleanSettings(account: string, raw: unknown): Promise<RuleSettings> {
  const s = settingsSchema.parse(raw ?? {});
  try { s.targets = await validateTargets(account, s.targets); }
  catch (e: any) { throw badRequest(e.message); }
  const out: RuleSettings = {};
  for (const k of RULE_KEYS) if (s[k] !== undefined) (out as any)[k] = s[k];
  return out;
}

const SCOPES = ['account', 'schema', 'owner'] as const;
function scopeOf(params: any): { kind: typeof SCOPES[number]; id: string | null } {
  const kind = params.scopeKind;
  if (!SCOPES.includes(kind)) throw badRequest('scopeKind must be account, schema or owner');
  const id = kind === 'account' ? null : String(params.scopeId ?? '');
  if (kind !== 'account' && !/^[0-9a-f-]{36}$/i.test(id ?? '')) throw badRequest('scopeId must be a uuid');
  return { kind, id };
}

/** An owner or type rung must point at something the account owns. */
async function assertScopeOwned(account: string, kind: string, id: string | null) {
  if (kind === 'account') return;
  if (kind === 'schema') {
    if (!(await one(`SELECT 1 FROM metadata_schemas WHERE id = $1 AND account_id = $2`, [id, account]))) throw notFound('Content type not found');
    return;
  }
  const owned = await one(
    `SELECT 1 FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2
     UNION ALL
     SELECT 1 FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1 AND g.account_id = $2`, [id, account]);
  if (!owned) throw notFound('Channel, station or event not found');
}

publishingRulesRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*,
            CASE r.scope_kind WHEN 'schema' THEN (SELECT name FROM metadata_schemas WHERE id = r.scope_id)
                              WHEN 'owner'  THEN COALESCE((SELECT name FROM channels WHERE id = r.scope_id), (SELECT name FROM events WHERE id = r.scope_id))
                              ELSE 'Account default' END AS scope_name
       FROM publishing_rules r WHERE r.account_id = $1
      ORDER BY CASE r.scope_kind WHEN 'account' THEN 0 WHEN 'schema' THEN 1 ELSE 2 END, scope_name`, [accountId(req)]);
  res.json(rows);
}));

publishingRulesRouter.get('/points', asyncHandler(async (req, res) => {
  res.json(await publishingPoints(accountId(req)));
}));

publishingRulesRouter.get('/resolve', asyncHandler(async (req, res) => {
  const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : null;
  if (assetId) {
    const found = await assetAccount(assetId);
    if (!found || found.accountId !== accountId(req)) throw notFound('Asset not found');
    return res.json(await resolveForAsset(accountId(req), found.asset));
  }
  // Or a hypothetical: what would an asset of this type on this owner get?
  const schemaId = typeof req.query.schemaId === 'string' ? req.query.schemaId : null;
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : null;
  const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : null;
  res.json(await resolveForAsset(accountId(req), { schema_id: schemaId, channel_id: channelId, event_id: eventId }));
}));

publishingRulesRouter.get('/:scopeKind/:scopeId?', asyncHandler(async (req, res) => {
  const { kind, id } = scopeOf(req.params);
  const row = await one<any>(
    `SELECT * FROM publishing_rules WHERE account_id = $1 AND scope_kind = $2 AND scope_id IS NOT DISTINCT FROM $3::uuid`,
    [accountId(req), kind, id]);
  res.json(row ?? { account_id: accountId(req), scope_kind: kind, scope_id: id, settings: {}, missing: true });
}));

publishingRulesRouter.put('/:scopeKind/:scopeId?', asyncHandler(async (req, res) => {
  const { kind, id } = scopeOf(req.params);
  await assertScopeOwned(accountId(req), kind, id);
  const settings = await cleanSettings(accountId(req), req.body?.settings ?? req.body);
  const who = actor(req);
  const before = await one<any>(
    `SELECT settings FROM publishing_rules WHERE account_id = $1 AND scope_kind = $2 AND scope_id IS NOT DISTINCT FROM $3::uuid`,
    [accountId(req), kind, id]);
  const row = await one<any>(
    `INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings, created_by, updated_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$5)
     ON CONFLICT (account_id, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, version = publishing_rules.version + 1, updated_at = now()
     RETURNING *`,
    [accountId(req), kind, id, JSON.stringify(settings), who.userId]);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: before ? 'update' : 'create', entityType: 'publishing_rule', entityId: row.id,
    changes: { settings: { from: before?.settings ?? null, to: settings } } }).catch(() => {});
  res.json(row);
}));

publishingRulesRouter.delete('/:scopeKind/:scopeId?', asyncHandler(async (req, res) => {
  const { kind, id } = scopeOf(req.params);
  if (kind === 'account') throw conflict('The account default cannot be removed; edit it instead.');
  const row = await one<any>(
    `DELETE FROM publishing_rules WHERE account_id = $1 AND scope_kind = $2 AND scope_id = $3 RETURNING id`,
    [accountId(req), kind, id]);
  if (!row) throw notFound('Rule not found');
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'delete', entityType: 'publishing_rule', entityId: row.id, snapshot: { scope_kind: kind, scope_id: id } }).catch(() => {});
  res.status(204).end();
}));
