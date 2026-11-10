/**
 * Publishing rules (the ladder) and an asset's availability.
 *
 *   GET  /api/publishing-rules                      every rung the account has
 *   GET  /api/publishing-rules/points               the client's publishing points
 *   GET  /api/publishing-rules/:scopeKind/:scopeId  one rung ('account' has no id)
 *   PUT  /api/publishing-rules/:scopeKind/:scopeId  create or replace that rung's settings
 *   DELETE                                           remove an owner / type rung (account stays)
 *   GET  /api/publishing-rules/resolve?assetId=      what an asset would get, and from where,
 *                                                    with its locks and conflicts
 *   GET  /api/publishing-rules/presets              the five starting policies (P3)
 *   GET  /api/publishing-rules/fields               the five sections, the lockable fields and their labels
 *   PUT  ...?dryRun=1                               the impact and conflicts of a save, nothing saved
 *
 * A save (build queue P3, PUBLISHING_POLICIES.md) is refused with 422
 * `policy_conflict` when the policy has a blocking conflict, changes a field a
 * rung above has locked, or would leave a title it governs in a blocking
 * state; it answers 409 `confirm_repackage` when it changes DRM on published
 * titles until it is sent again with `confirm: true`. Warnings are saved and
 * returned with the rule.
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
import { resolveForAsset, validateTargets, publishingPoints, resolveLadder, RULE_KEYS, LOCKABLE_FIELDS, POLICY_SECTIONS, type RuleSettings } from '../services/publishingRules';
import { PRESETS, policyConflicts, lockConflicts, policyImpact, fieldLabel, presetOf, type Conflict } from '../services/publishingPolicies';
import { rightsForAssetId } from '../services/rightsProfiles';
import { ApiError } from '../util/http';
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
  accessRules: z.array(z.object({
    id: z.string().min(1),
    for: z.object({ scopes: z.array(z.enum(['this', 'live', 'ondemand'])).default([]), schemaIds: z.array(z.string().uuid()).optional() }),
    if: z.object({ geo: z.enum(['in', 'not_in']), countries: z.array(z.string().min(2).max(5)).default(['WORLD']) }),
    then: z.object({
      access: z.enum(['free', 'members', 'premium']),
      userGroups: z.array(z.string().min(1)).optional(),
      terms: z.array(z.object({
        productKey: z.string().min(1),
        kind: z.enum(['period', 'published_dates']),
        count: z.number().int().positive().optional(),
        unit: z.enum(['day', 'week', 'month', 'year']).optional(),
        priceCents: z.number().int().nonnegative(),
        currency: z.string().length(3),
        taxPct: z.number().min(0).max(100).optional(),
        name: z.string().optional(),
      })).optional(),
    }),
  })).optional(),
  // Copy rules (Mirror and Archive, H3-3). Checked against the account's
  // licence and its own storage targets in cleanSettings.
  archive: z.object({
    copies: z.array(z.object({
      targetId: z.string().uuid(),
      on: z.array(z.enum(['ingest', 'publish', 'recording', 'schedule'])).min(1),
      // What an asset copy takes (H3-8, clips H3-9, packages H3-11); the original alone when unsaid.
      what: z.array(z.enum(['source', 'sidecars', 'clips', 'packages'])).min(1).optional(),
    }).strict()).max(20),
    offPeak: z.object({
      from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'from is HH:MM'),
      to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'to is HH:MM'),
      timeZone: z.string().max(64).optional(),
    }).strict().nullable().optional(),
  }).strict().optional(),
  // The policy sections (build queue P3). Each field may be left out, which
  // means "inherit it", so every field is optional and resolves on its own.
  protection: z.object({
    drm: z.boolean().optional(),
    tokenLifetimeSec: z.number().int().min(30).max(86_400).nullable().optional(),
    waf: z.enum(['off', 'standard', 'rights_managed']).optional(),
    referrers: z.array(z.string().min(1).max(253).regex(/^[a-z0-9.*-]+$/i, 'a domain such as example.com or *.example.com')).max(50).optional(),
    concurrentStreams: z.number().int().min(1).max(100).nullable().optional(),
  }).strict().optional(),
  distribution: z.object({
    mp4Download: z.boolean().optional(),
    shareLinks: z.boolean().optional(),
    fastEligible: z.boolean().optional(),
    sitemap: z.boolean().optional(),
  }).strict().optional(),
  retention: z.object({
    keep: z.enum(['forever', 'days']).optional(),
    days: z.number().int().positive().max(36_500).nullable().optional(),
    anchor: z.enum(['ingest', 'available_from', 'available_until']).optional(),
    legalHoldAllowed: z.boolean().optional(),
    archiveTier: z.enum(['infrequent', 'glacier']).nullable().optional(),
  }).strict().optional(),
}).strict();

/** Clean a rung: validate targets against the account and drop unknown keys. */
export async function cleanSettings(account: string, raw: unknown): Promise<RuleSettings> {
  const s = settingsSchema.parse(raw ?? {});
  try { s.targets = await validateTargets(account, s.targets); }
  catch (e: any) { throw badRequest(e.message); }
  if (s.archive) s.archive = await cleanArchive(account, s.archive);
  if (s.retention?.keep === 'days' && !s.retention.days) throw badRequest('retention: keeping for a number of days needs the number of days');
  const out: RuleSettings = {};
  for (const k of RULE_KEYS) {
    if (s[k] === undefined) continue;
    // An empty section says nothing: store it as absent, so it inherits.
    if (['protection', 'distribution', 'retention'].includes(k)) {
      const sec = Object.fromEntries(Object.entries(s[k] as object).filter(([, v]) => v !== undefined));
      if (!Object.keys(sec).length) continue;
      (out as any)[k] = sec; continue;
    }
    (out as any)[k] = s[k];
  }
  return out;
}

/**
 * Copy rules name the account's own storage targets, and only an account
 * with Mirror and Archive may save them: a rule that could never run would
 * read like a policy. Saying nothing about copies (an empty list) is always
 * allowed, so a rung can switch copies off below a rung that has them.
 */
async function cleanArchive(account: string, a: NonNullable<RuleSettings['archive']>): Promise<NonNullable<RuleSettings['archive']>> {
  const copies: NonNullable<RuleSettings['archive']>['copies'] = [];
  for (const c of a.copies) {
    if (copies.some((x) => x.targetId === c.targetId)) throw badRequest('archive.copies names the same storage target twice');
    // "Original only" is what an unsaid `what` means, so it is stored unsaid:
    // rules saved before sidecars existed and rules saved now read the same.
    const what = c.what ? [...new Set(c.what)] : undefined;
    copies.push({ targetId: c.targetId, on: [...new Set(c.on)], ...(what && !(what.length === 1 && what[0] === 'source') ? { what } : {}) });
  }
  if (copies.length || a.offPeak) {
    const { requireLicence } = await import('../services/sites/licences');
    await requireLicence(account, 'mirror_archive');
  }
  if (copies.length) {
    const owned = await query<any>(`SELECT id FROM archive_targets WHERE account_id = $1 AND id = ANY($2::uuid[])`, [account, copies.map((c) => c.targetId)]);
    const missing = copies.find((c) => !owned.some((o) => o.id === c.targetId));
    if (missing) throw badRequest(`archive.copies: storage target ${missing.targetId} not found`);
  }
  let offPeak = a.offPeak ?? null;
  if (offPeak) {
    const { validTimeZone } = await import('../services/archive/archive');
    if (offPeak.timeZone && !validTimeZone(offPeak.timeZone)) throw badRequest(`archive.offPeak.timeZone "${offPeak.timeZone}" is not a time zone (for example Europe/London)`);
    if (offPeak.from === offPeak.to) offPeak = null;   // the whole day: no window
  }
  return { copies, offPeak };
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

// The five starting policies. A person copies one onto a rung and edits it;
// the rung remembers which (preset_key), which the rights-managed checks read.
publishingRulesRouter.get('/presets', asyncHandler(async (_req, res) => {
  res.json(PRESETS);
}));

// How a policy is laid out: its five sections, the fields that can be locked,
// and what each is called, so the console and the API say the same words.
publishingRulesRouter.get('/fields', asyncHandler(async (_req, res) => {
  res.json({ sections: POLICY_SECTIONS, lockable: LOCKABLE_FIELDS, labels: Object.fromEntries(LOCKABLE_FIELDS.map((f) => [f, fieldLabel(f)])) });
}));

publishingRulesRouter.get('/resolve', asyncHandler(async (req, res) => {
  const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : null;
  if (assetId) {
    const found = await assetAccount(assetId);
    if (!found || found.accountId !== accountId(req)) throw notFound('Asset not found');
    const r = await resolveForAsset(accountId(req), found.asset);
    // The policy as this title gets it, checked with its own rights and dates.
    const rights = await rightsForAssetId(assetId);
    const conflicts = policyConflicts(r.settings, { presetKey: presetOf(r), title: { rights,
      availableFrom: found.asset.available_from ? new Date(found.asset.available_from) : null,
      availableUntil: found.asset.available_until ? new Date(found.asset.available_until) : null,
      createdAt: found.asset.created_at ? new Date(found.asset.created_at) : null } });
    return res.json({ ...r, conflicts });
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

// What a rung says about itself besides its settings: the fields it locks, its
// name and the preset it started from. Left out of a request, each keeps its
// stored value, so clients that only send settings change nothing else.
const metaSchema = z.object({
  lockedFields: z.array(z.string()).max(64).optional(),
  name: z.string().trim().max(120).nullable().optional(),
  presetKey: z.enum(['open', 'members', 'geo_locked', 'premium', 'rights_managed']).nullable().optional(),
  confirm: z.boolean().optional(),
});

/** A refusal that carries the conflicts and the impact, for the console to show. */
function policyRefusal(status: number, code: string, message: string, details: object): ApiError {
  const e: any = new ApiError(status, message); e.code = code; e.details = details; return e;
}

publishingRulesRouter.put('/:scopeKind/:scopeId?', asyncHandler(async (req, res) => {
  const { kind, id } = scopeOf(req.params);
  const acct = accountId(req);
  await assertScopeOwned(acct, kind, id);
  const settings = await cleanSettings(acct, req.body?.settings ?? req.body);
  const meta = metaSchema.parse(req.body?.settings ? req.body : {});
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const who = actor(req);
  const before = await one<any>(
    `SELECT settings, locked_fields, name, preset_key FROM publishing_rules WHERE account_id = $1 AND scope_kind = $2 AND scope_id IS NOT DISTINCT FROM $3::uuid`,
    [acct, kind, id]);
  const lockedFields: string[] = meta.lockedFields !== undefined ? [...new Set(meta.lockedFields)] : (before?.locked_fields ?? []);
  const bad = lockedFields.find((f: string) => !LOCKABLE_FIELDS.includes(f));
  if (bad) throw badRequest(`lockedFields: "${bad}" is not a field that can be locked`);
  const name = meta.name !== undefined ? (meta.name || null) : (before?.name ?? null);
  const presetKey = meta.presetKey !== undefined ? meta.presetKey : (before?.preset_key ?? null);

  // The policy as this rung would make it, over the account default (a type or
  // an owner rung), with the account's locks in force.
  const account = kind === 'account' ? null : await one<any>(
    `SELECT settings, locked_fields, preset_key FROM publishing_rules WHERE account_id = $1 AND scope_kind = 'account'`, [acct]);
  const rung = kind === 'account' ? 'account' : kind === 'schema' ? 'schema' : 'owner';
  const ladder = resolveLadder([
    ...(account ? [{ rung: 'account' as const, settings: account.settings, lockedFields: account.locked_fields ?? [], presetKey: account.preset_key }] : []),
    { rung, settings, lockedFields, presetKey },
  ]);
  const conflicts: Conflict[] = [
    ...lockConflicts(settings, rung, account ? resolveLadder([{ rung: 'account', settings: {}, lockedFields: account.locked_fields ?? [] }]).locks : {}),
    ...policyConflicts(ladder.settings, { presetKey: presetOf(ladder) }),
  ];
  const impact = await policyImpact(acct, { kind, id }, { settings, lockedFields, presetKey });
  const blocks = conflicts.filter((c) => c.level === 'block');
  const warnings = conflicts.filter((c) => c.level !== 'block');
  if (dryRun) return res.json({ dryRun: true, saved: false, canSave: !blocks.length && !impact.blocks.length, conflicts, impact });
  if (blocks.length || impact.blocks.length) {
    const first = blocks[0]?.message ?? `${impact.blocks[0].count} title${impact.blocks[0].count === 1 ? '' : 's'}: ${impact.blocks[0].message}`;
    throw policyRefusal(422, 'policy_conflict', first, { conflicts, impact });
  }
  if (impact.repackage && !meta.confirm)
    throw policyRefusal(409, 'confirm_repackage', `This changes DRM on ${impact.repackage} published title${impact.repackage === 1 ? '' : 's'}: their files must be packaged again. Send again with confirm to go ahead; they keep their current protection until then.`, { conflicts, impact });

  const row = await one<any>(
    `INSERT INTO publishing_rules(account_id, scope_kind, scope_id, settings, locked_fields, name, preset_key, created_by, updated_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$8)
     ON CONFLICT (account_id, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET settings = EXCLUDED.settings, locked_fields = EXCLUDED.locked_fields, name = EXCLUDED.name, preset_key = EXCLUDED.preset_key,
                   updated_by = EXCLUDED.updated_by, version = publishing_rules.version + 1, updated_at = now()
     RETURNING *`,
    [acct, kind, id, JSON.stringify(settings), lockedFields, name, presetKey, who.userId]);
  const changes: any = { settings: { from: before?.settings ?? null, to: settings } };
  if (JSON.stringify(before?.locked_fields ?? []) !== JSON.stringify(lockedFields)) changes.locked_fields = { from: before?.locked_fields ?? [], to: lockedFields };
  if ((before?.preset_key ?? null) !== presetKey) changes.preset_key = { from: before?.preset_key ?? null, to: presetKey };
  if ((before?.name ?? null) !== name) changes.name = { from: before?.name ?? null, to: name };
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label,
    action: before ? 'update' : 'create', entityType: 'publishing_rule', entityId: row.id, changes }).catch(() => {});
  // Every premium TERM is a product the providers sell: keep them in step.
  const { syncProductsFromRules } = await import('../services/entitlements');
  await syncProductsFromRules(acct, settings.accessRules ?? [], row.id, id).catch((e) => console.warn('[publishing-rules] product sync failed', e));
  res.json({ ...row, warnings, impact });
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
