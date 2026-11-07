/**
 * Rights profiles (build queue R1). The cap every asset carries.
 *
 *   GET    /api/rights/profiles               the account's profiles, with how many assets use each
 *   POST   /api/rights/profiles               create one
 *   GET    /api/rights/profiles/:id           one profile, with its asset count and where it is used
 *   PUT    /api/rights/profiles/:id           change it (built-ins cannot change)
 *   DELETE /api/rights/profiles/:id           only when no asset uses it and it is not the default
 *   GET    /api/rights/profiles/:id/assets    the assets that use it
 *   PUT    /api/rights/agreements/:id         upload the agreement file (private)
 *   GET    /api/rights/agreements/:id         download it (Rights: manage, audited)
 *   GET    /api/rights/settings               which profile new assets get, and the built-ins
 *   PUT    /api/rights/settings               change that
 *   GET    /api/rights/assets/:id             an asset's profile, narrowing and effective rights
 *   PUT    /api/rights/assets/:id             set them (never wider than the profile)
 *   POST   /api/rights/assign                 set one profile on many assets
 *   POST   /api/rights/check                  what the rights answer for a country, app, use and time
 *
 * Everything is scoped to the caller's account. Changing a profile drops the
 * cached answers that read it, so the play gate sees the change at once.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest, conflict, ApiError } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { actor, writeAudit } from '../services/audit';
import { actorLabel } from '../util/actor';
import { imageStore } from '../services/imageStore';
import { assetAccount } from '../services/availability';
import {
  USES, ACCESS_TYPES, APP_TYPES, ensureBuiltins, effectiveRights, evaluateRights, wideningProblems, cleanNarrow,
  invalidateRights, appTypeOf, type RightsProfile, type RightsNarrow,
} from '../services/rightsProfiles';

export const rightsRouter = Router();
rightsRouter.use(requireAuth);

const country = z.string().trim().length(2).transform((s) => s.toUpperCase());
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().max(200).nullable().optional(),
  takedownContact: z.string().trim().max(300).nullable().optional(),
  agreementRef: z.string().trim().max(120).nullable().optional(),
  territoryMode: z.enum(['worldwide', 'allow', 'block']).default('worldwide'),
  territories: z.array(country).max(300).default([]),
  appMode: z.enum(['all', 'allow', 'block']).default('all'),
  appTypes: z.array(z.enum(APP_TYPES)).max(APP_TYPES.length).default([]),
  appIds: z.array(z.string().uuid()).max(200).default([]),
  uses: z.array(z.enum(USES)).max(USES.length).default([...USES]),
  accessTypes: z.array(z.enum(ACCESS_TYPES)).max(ACCESS_TYPES.length).default([...ACCESS_TYPES]),
  window: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('open') }),
    z.object({ kind: z.literal('fixed'), from: z.string().datetime({ offset: true }).nullable().optional(), until: z.string().datetime({ offset: true }).nullable().optional() }),
    z.object({ kind: z.literal('relative'), count: z.number().int().positive().max(1200), unit: z.enum(['day', 'month', 'year']), from: z.enum(['first_air', 'ingest']).default('first_air') }),
  ]).default({ kind: 'open' }),
  warnDays: z.number().int().min(0).max(365).default(30),
});
type ProfileInput = z.infer<typeof profileSchema>;

const narrowSchema = z.object({
  territories: z.array(country).max(300).optional(),
  blockTerritories: z.array(country).max(300).optional(),
  appTypes: z.array(z.enum(APP_TYPES)).optional(),
  blockAppIds: z.array(z.string().uuid()).max(200).optional(),
  uses: z.array(z.enum(USES)).optional(),
  from: z.string().datetime({ offset: true }).nullable().optional(),
  until: z.string().datetime({ offset: true }).nullable().optional(),
}).nullable();

/** The API shape of a profile row. */
export function profileView(p: any, extra: Record<string, any> = {}) {
  return {
    id: p.id, name: p.name, builtin: p.builtin ?? null, provider: p.provider, takedownContact: p.takedown_contact, agreementRef: p.agreement_ref,
    territoryMode: p.territory_mode, territories: p.territories ?? [],
    appMode: p.app_mode, appTypes: p.app_types ?? [], appIds: p.app_ids ?? [],
    uses: p.uses ?? [], accessTypes: p.access_types ?? [],
    window: p.window_kind === 'fixed' ? { kind: 'fixed', from: p.window_from, until: p.window_until }
      : p.window_kind === 'relative' ? { kind: 'relative', count: p.relative_count, unit: p.relative_unit, from: p.relative_from }
      : { kind: 'open' },
    warnDays: p.warn_days,
    agreement: p.agreement ? { name: p.agreement.name, size: p.agreement.size, type: p.agreement.type, uploadedBy: p.agreement.uploadedBy, uploadedAt: p.agreement.uploadedAt } : null,
    createdAt: p.created_at, updatedAt: p.updated_at,
    ...extra,
  };
}

function columns(b: ProfileInput) {
  const w = b.window;
  return {
    name: b.name, provider: b.provider ?? null, takedown_contact: b.takedownContact ?? null, agreement_ref: b.agreementRef ?? null,
    territory_mode: b.territoryMode, territories: [...new Set(b.territories)],
    app_mode: b.appMode, app_types: [...new Set(b.appTypes)], app_ids: [...new Set(b.appIds)],
    uses: [...new Set(b.uses)], access_types: [...new Set(b.accessTypes)],
    window_kind: w.kind,
    window_from: w.kind === 'fixed' ? w.from ?? null : null,
    window_until: w.kind === 'fixed' ? w.until ?? null : null,
    relative_count: w.kind === 'relative' ? w.count : null,
    relative_unit: w.kind === 'relative' ? w.unit : null,
    relative_from: w.kind === 'relative' ? w.from : null,
    warn_days: b.warnDays,
  };
}

/** A profile must make sense on its own before anything is saved. */
async function checkProfile(acct: string, b: ProfileInput): Promise<void> {
  if (b.territoryMode !== 'worldwide' && !b.territories.length) throw badRequest('List at least one territory, or choose Worldwide.');
  if (b.appMode !== 'all' && !b.appTypes.length && !b.appIds.length) throw badRequest('List at least one app type or app, or choose All apps.');
  if (b.window.kind === 'fixed' && b.window.from && b.window.until && new Date(b.window.from) >= new Date(b.window.until))
    throw badRequest('The window must start before it ends.');
  if (b.appIds.length) {
    const found = await query<any>(`SELECT id FROM apps WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acct, b.appIds]);
    if (found.length !== new Set(b.appIds).size) throw badRequest('One of the apps is not an app of this account.');
  }
}

const COLS = ['name', 'provider', 'takedown_contact', 'agreement_ref', 'territory_mode', 'territories', 'app_mode', 'app_types', 'app_ids',
  'uses', 'access_types', 'window_kind', 'window_from', 'window_until', 'relative_count', 'relative_unit', 'relative_from', 'warn_days'] as const;

async function ownedProfile(acct: string, id: string): Promise<any> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Rights profile not found');
  const p = await one<any>(`SELECT * FROM rights_profiles WHERE id = $1 AND account_id = $2`, [id, acct]);
  if (!p) throw notFound('Rights profile not found');
  return p;
}

async function ownedAsset(acct: string, id: string): Promise<any> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Asset not found');
  const found = await assetAccount(id);
  if (!found || found.accountId !== acct) throw notFound('Asset not found');
  return found.asset;
}

// ---------------------------------------------------------------------------
//  Profiles
// ---------------------------------------------------------------------------
const profileList = defineList({
  path: '/api/rights/profiles',
  fields: {
    id: { sql: 'p.id', type: 'uuid' },
    name: { sql: 'p.name', type: 'string' },
    provider: { sql: 'p.provider', type: 'string' },
    builtin: { sql: 'p.builtin', type: 'enum', values: ['open', 'closed'] },
    territory_mode: { sql: 'p.territory_mode', type: 'enum', values: ['worldwide', 'allow', 'block'] },
    app_mode: { sql: 'p.app_mode', type: 'enum', values: ['all', 'allow', 'block'] },
    window_kind: { sql: 'p.window_kind', type: 'enum', values: ['open', 'fixed', 'relative'] },
    window_until: { sql: 'p.window_until', type: 'timestamp' },
    created_at: { sql: 'p.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'p.updated_at', type: 'timestamp', notNull: true },
  },
  search: ['name', 'provider'],
  defaultSort: 'name',
  unpagedLimit: 1000,
});

rightsRouter.get('/profiles', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  await ensureBuiltins(acct);
  const params: unknown[] = [acct];
  const pl = parseList(profileList, req.query, params);
  const rows = await query<any>(
    `SELECT p.*, (SELECT count(*)::int FROM vod_assets v WHERE v.rights_profile_id = p.id) AS asset_count,
            (a.default_rights_profile_id = p.id OR (a.default_rights_profile_id IS NULL AND p.builtin = 'open')) AS is_default
       FROM rights_profiles p JOIN accounts a ON a.id = p.account_id
      WHERE p.account_id = $1${whereSql(pl)} ${pageSql(pl)}`, params);
  const page = finishPage(req, res, pl, rows);
  res.json(page.map((r: any) => profileView(r, { assetCount: r.asset_count, isDefault: !!r.is_default })));
}));

rightsRouter.post('/profiles', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = profileSchema.parse(req.body);
  await checkProfile(acct, b);
  const c = columns(b);
  const dupe = await one(`SELECT 1 FROM rights_profiles WHERE account_id = $1 AND lower(name) = lower($2)`, [acct, c.name]);
  if (dupe) throw conflict('A rights profile with that name already exists.');
  const row = await one<any>(
    `INSERT INTO rights_profiles(account_id, ${COLS.join(', ')}) VALUES ($1, ${COLS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
    [acct, ...COLS.map((k) => (c as any)[k])]);
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'create', entityType: 'rights_profile', entityId: row.id, snapshot: profileView(row) });
  res.status(201).json(profileView(row, { assetCount: 0, isDefault: false }));
}));

rightsRouter.get('/profiles/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = await ownedProfile(acct, String(req.params.id));
  const n = await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE rights_profile_id = $1`, [p.id]);
  const a = await one<any>(`SELECT default_rights_profile_id FROM accounts WHERE id = $1`, [acct]);
  const isDefault = a?.default_rights_profile_id ? a.default_rights_profile_id === p.id : p.builtin === 'open';
  const by = await query<any>(`SELECT COALESCE(rights_set_by, 'unknown') AS how, count(*)::int AS n FROM vod_assets WHERE rights_profile_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [p.id]);
  res.json(profileView(p, { assetCount: n?.n ?? 0, isDefault, setBy: by.map((r) => ({ how: r.how, count: r.n })) }));
}));

rightsRouter.put('/profiles/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = await ownedProfile(acct, String(req.params.id));
  if (p.builtin) throw conflict(`"${p.name}" is built in and cannot be changed.`);
  const b = profileSchema.parse(req.body);
  await checkProfile(acct, b);
  const c = columns(b);
  const dupe = await one(`SELECT 1 FROM rights_profiles WHERE account_id = $1 AND lower(name) = lower($2) AND id <> $3`, [acct, c.name, p.id]);
  if (dupe) throw conflict('A rights profile with that name already exists.');
  const row = await one<any>(
    `UPDATE rights_profiles SET ${COLS.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND account_id = $2 RETURNING *`,
    [p.id, acct, ...COLS.map((k) => (c as any)[k])]);
  invalidateRights(p.id);
  // Rule collections that read the provider or the profile are matched again soon (build queue C1).
  if ((p.provider ?? null) !== (row.provider ?? null)) {
    await import('../services/collectionRules').then((m) => m.markStale(acct, ['provider'])).catch(() => {});
  }
  const before = profileView(p), after = profileView(row);
  const changes: Record<string, { from: any; to: any }> = {};
  for (const k of Object.keys(after) as (keyof typeof after)[]) {
    if (k === 'updatedAt') continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k], to: after[k] };
  }
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'rights_profile', entityId: p.id, changes });
  const n = await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE rights_profile_id = $1`, [p.id]);
  res.json(profileView(row, { assetCount: n?.n ?? 0 }));
}));

rightsRouter.delete('/profiles/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = await ownedProfile(acct, String(req.params.id));
  if (p.builtin) throw conflict(`"${p.name}" is built in and cannot be deleted.`);
  const a = await one<any>(`SELECT default_rights_profile_id FROM accounts WHERE id = $1`, [acct]);
  if (a?.default_rights_profile_id === p.id) throw conflict('This is the default for new assets. Choose another default first.');
  const n = await one<any>(`SELECT count(*)::int AS n FROM vod_assets WHERE rights_profile_id = $1`, [p.id]);
  if (n?.n) throw conflict(`${n.n} asset${n.n === 1 ? ' uses' : 's use'} this profile. Move them to another profile first.`);
  await query(`DELETE FROM rights_profiles WHERE id = $1 AND account_id = $2`, [p.id, acct]);
  if (p.agreement?.key) await imageStore().delete(p.agreement.key).catch(() => {});
  invalidateRights(p.id);
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'delete', entityType: 'rights_profile', entityId: p.id, snapshot: profileView(p) });
  res.status(204).end();
}));

rightsRouter.get('/profiles/:id/assets', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = await ownedProfile(acct, String(req.params.id));
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const rows = await query<any>(
    `SELECT id, title, availability_state, rights_narrow IS NOT NULL AS narrowed, rights_set_by, rights_set_at
       FROM vod_assets WHERE rights_profile_id = $1 ORDER BY rights_set_at DESC NULLS LAST, id LIMIT $2 OFFSET $3`, [p.id, limit + 1, offset]);
  res.json({ items: rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, state: r.availability_state, narrowed: r.narrowed, setBy: r.rights_set_by, setAt: r.rights_set_at })), hasMore: rows.length > limit });
}));

// ---------------------------------------------------------------------------
//  The agreement: private, for rights admins, every read audited.
// ---------------------------------------------------------------------------
const AGREEMENT_MAX = 25 * 1024 * 1024;
const safeFile = (s: string) => s.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'agreement';

rightsRouter.put('/agreements/:id', express.raw({ type: () => true, limit: AGREEMENT_MAX + 1024 }), asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = await ownedProfile(acct, String(req.params.id));
  if (p.builtin) throw conflict('Built-in profiles have no agreement.');
  const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw badRequest('The file is empty.');
  if (buf.length > AGREEMENT_MAX) throw new ApiError(413, 'Agreements are limited to 25 MB.');
  const name = safeFile(String(req.query.name ?? req.get('x-file-name') ?? 'agreement.pdf'));
  const key = `rights-agreements/${acct}/${p.id}/${Date.now()}-${name}`;
  await imageStore().put(key, buf, req.get('content-type') || 'application/octet-stream');
  const who = actor(req);
  const agreement = { name, size: buf.length, type: req.get('content-type') || 'application/octet-stream', key, uploadedBy: await actorLabel(req), uploadedAt: new Date().toISOString() };
  await query(`UPDATE rights_profiles SET agreement = $2::jsonb, updated_at = now() WHERE id = $1`, [p.id, JSON.stringify(agreement)]);
  if (p.agreement?.key) await imageStore().delete(p.agreement.key).catch(() => {});
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'rights_profile', entityId: p.id,
    changes: { agreement: { from: p.agreement?.name ?? null, to: name } } });
  res.json({ name, size: buf.length, type: agreement.type, uploadedBy: agreement.uploadedBy, uploadedAt: agreement.uploadedAt });
}));

rightsRouter.get('/agreements/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const p = await ownedProfile(acct, String(req.params.id));
  if (!p.agreement?.key) throw notFound('No agreement is attached to this profile.');
  const buf = await imageStore().get(p.agreement.key);
  if (!buf) throw notFound('The agreement file is missing from storage.');
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'download', entityType: 'rights_agreement', entityId: p.id, snapshot: { name: p.agreement.name } });
  res.setHeader('Content-Type', p.agreement.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFile(p.agreement.name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buf);
}));

// ---------------------------------------------------------------------------
//  Account settings: which profile new assets get.
// ---------------------------------------------------------------------------
rightsRouter.get('/settings', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = await ensureBuiltins(acct);
  const a = await one<any>(`SELECT default_rights_profile_id FROM accounts WHERE id = $1`, [acct]);
  res.json({ defaultProfileId: a?.default_rights_profile_id ?? b.open, builtins: b });
}));

rightsRouter.put('/settings', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({ defaultProfileId: z.string().uuid() }).parse(req.body);
  const p = await ownedProfile(acct, b.defaultProfileId);
  const before = await one<any>(`SELECT default_rights_profile_id FROM accounts WHERE id = $1`, [acct]);
  await query(`UPDATE accounts SET default_rights_profile_id = $2 WHERE id = $1`, [acct, p.id]);
  const who = actor(req);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'account', entityId: acct,
    changes: { defaultRightsProfileId: { from: before?.default_rights_profile_id ?? null, to: p.id } } });
  res.json({ defaultProfileId: p.id, builtins: await ensureBuiltins(acct) });
}));

// ---------------------------------------------------------------------------
//  One asset's rights.
// ---------------------------------------------------------------------------
async function assetRightsView(acct: string, asset: any) {
  const row = await one<any>(`SELECT rights_profile_id, rights_narrow, rights_set_by, rights_set_at, created_at, first_aired_at FROM vod_assets WHERE id = $1`, [asset.id]);
  const p = row?.rights_profile_id ? await one<any>(`SELECT * FROM rights_profiles WHERE id = $1 AND account_id = $2`, [row.rights_profile_id, acct]) : null;
  const eff = effectiveRights(p, row ?? {});
  return {
    assetId: asset.id, profile: p ? profileView(p) : null, narrow: row?.rights_narrow ?? null,
    setBy: row?.rights_set_by ?? null, setAt: row?.rights_set_at ?? null,
    effective: { ...eff, from: eff.from?.toISOString() ?? null, until: eff.until?.toISOString() ?? null },
  };
}

rightsRouter.get('/assets/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const asset = await ownedAsset(acct, String(req.params.id));
  res.json(await assetRightsView(acct, asset));
}));

rightsRouter.put('/assets/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const asset = await ownedAsset(acct, String(req.params.id));
  const b = z.object({ profileId: z.string().uuid(), narrow: narrowSchema.optional() }).parse(req.body);
  const p = await ownedProfile(acct, b.profileId);
  const narrow = b.narrow ? cleanNarrow(b.narrow as RightsNarrow) : null;
  if (narrow) {
    const problems = wideningProblems(p as RightsProfile, narrow, asset);
    if (problems.length) return res.status(422).json({ error: 'A title can narrow its rights, never widen them.', problems });
  }
  const who = actor(req);
  const before = { profileId: asset.rights_profile_id ?? null, narrow: asset.rights_narrow ?? null };
  await query(`UPDATE vod_assets SET rights_profile_id = $2, rights_narrow = $3::jsonb, rights_set_by = $4, rights_set_at = now(), updated_at = now() WHERE id = $1`,
    [asset.id, p.id, narrow ? JSON.stringify(narrow) : null, `set by ${await actorLabel(req)}`.slice(0, 200)]);
  invalidateRights(null, [asset.id]);
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: asset.id,
    changes: { rights: { from: before, to: { profileId: p.id, narrow } } } });
  res.json(await assetRightsView(acct, { id: asset.id }));
}));

rightsRouter.post('/assign', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({ profileId: z.string().uuid(), assetIds: z.array(z.string().uuid()).min(1).max(1000), keepNarrowing: z.boolean().default(false) }).parse(req.body);
  const p = await ownedProfile(acct, b.profileId);
  const who = actor(req);
  // Only the account's own assets: owned directly, or through a channel or event.
  const rows = await query<any>(
    `UPDATE vod_assets v SET rights_profile_id = $2, rights_narrow = CASE WHEN $4 THEN v.rights_narrow ELSE NULL END,
            rights_set_by = $5, rights_set_at = now(), updated_at = now()
       FROM (SELECT v2.id FROM vod_assets v2
               LEFT JOIN channels c ON c.id = v2.channel_id
               LEFT JOIN events e ON e.id = v2.event_id
               LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
              WHERE v2.id = ANY($3::uuid[]) AND COALESCE(g.account_id, v2.account_id) = $1) x
      WHERE v.id = x.id RETURNING v.id`,
    [acct, p.id, b.assetIds, b.keepNarrowing, `bulk by ${await actorLabel(req)}`.slice(0, 200)]);
  invalidateRights(null, rows.map((r) => r.id));
  await writeAudit(null, { accountId: acct, userId: who.userId, label: who.label, action: 'update', entityType: 'rights_profile', entityId: p.id,
    snapshot: { assigned: rows.length, requested: b.assetIds.length } });
  res.json({ assigned: rows.length, skipped: b.assetIds.length - rows.length });
}));

/**
 * What the rights alone answer. The full answer (collection access and the
 * policy on top) is the play gate's; this is the first step of it, for the
 * console's View as panel and for support.
 */
rightsRouter.post('/check', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({
    assetId: z.string().uuid(),
    country: z.string().length(2).optional(),
    appId: z.string().uuid().optional(),
    appType: z.enum(APP_TYPES).optional(),
    use: z.enum(USES).default('on_demand'),
    at: z.string().datetime({ offset: true }).optional(),
  }).parse(req.body);
  const asset = await ownedAsset(acct, b.assetId);
  let appType = b.appType ?? null;
  if (b.appId) {
    const app = await one<any>(`SELECT type, surface FROM apps WHERE id = $1 AND account_id = $2`, [b.appId, acct]);
    if (!app) throw badRequest('That app is not an app of this account.');
    appType = appTypeOf(app.type, app.surface);
  }
  const view = await assetRightsView(acct, asset);
  const p = view.profile ? await one<any>(`SELECT * FROM rights_profiles WHERE id = $1`, [view.profile.id]) : null;
  const row = await one<any>(`SELECT rights_narrow, created_at, first_aired_at FROM vod_assets WHERE id = $1`, [asset.id]);
  const eff = effectiveRights(p, row ?? {});
  const answer = evaluateRights(eff, { country: b.country ?? null, appType, appId: b.appId ?? null, use: b.use, at: b.at ? new Date(b.at) : undefined });
  res.json({ ...answer, profile: view.profile ? { id: view.profile.id, name: view.profile.name } : null, narrowed: eff.narrowed });
}));
