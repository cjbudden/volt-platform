// ============================================================================
//  RIGHTS PROFILES — the cap nothing overrides (build queue R1, Publishing
//  Policies design, "Rights").
//
//  Every asset carries one profile (migration 0133 makes that so for every
//  insert path). The profile says where the asset may be shown, on which
//  apps, for which uses, with which access types and inside which window. A
//  title can narrow its own profile (fewer territories, apps or uses, a
//  shorter window), never widen it.
//
//  The evaluation is PURE (evaluateRights): given the effective rights and
//  the request (country, app, use, time) it answers allowed or not, and why.
//  Everything that serves or lists content asks it first: the play gate,
//  publishing, FAST lineups, social posting and downloads. Collection access
//  and the publishing policy then decide inside what it allows.
//
//  Reads on the play path are cached (the profile by id, tagged rights:<id>;
//  the asset row by asset:<id>), so a warm gate makes no database reads.
// ============================================================================
import { query, one } from '../db';
import { cached, invalidateTag } from '../scale/cache';
import { scaleConfig } from '../scale/config';

export const USES = ['on_demand', 'fast', 'clips', 'social', 'downloads', 'ads'] as const;
export type Use = typeof USES[number];
export const ACCESS_TYPES = ['free', 'members', 'subscription', 'ppv'] as const;
export type AccessType = typeof ACCESS_TYPES[number];
/** Rights app types. Registered apps map onto them by their type (appTypeOf). */
export const APP_TYPES = ['web', 'mobile', 'smart_tv', 'embed', 'partner', 'venue'] as const;
export type RightsAppType = typeof APP_TYPES[number];

/** A registered app's type (apps.type) as the rights see it. */
export function appTypeOf(appType: string | null | undefined, surface?: string | null): RightsAppType {
  if (surface === 'embed' || surface === 'venue') return surface;
  switch (appType) {
    case 'ios': case 'android': return 'mobile';
    case 'tv': case 'roku': return 'smart_tv';
    case 'server': return 'partner';
    case 'embed': return 'embed';
    case 'venue': return 'venue';
    default: return 'web';
  }
}

export interface RightsProfile {
  id: string;
  account_id: string;
  name: string;
  builtin: 'open' | 'closed' | null;
  provider: string | null;
  takedown_contact: string | null;
  agreement_ref: string | null;
  territory_mode: 'worldwide' | 'allow' | 'block';
  territories: string[];
  app_mode: 'all' | 'allow' | 'block';
  app_types: string[];
  app_ids: string[];
  uses: string[];
  access_types: string[];
  window_kind: 'open' | 'fixed' | 'relative';
  window_from: string | Date | null;
  window_until: string | Date | null;
  relative_count: number | null;
  relative_unit: 'day' | 'month' | 'year' | null;
  relative_from: 'first_air' | 'ingest' | null;
  warn_days: number;
  agreement: any;
}

/** Per-title narrowing, stored on vod_assets.rights_narrow. Every field only takes away. */
export interface RightsNarrow {
  /** Only these countries (each must be allowed by the profile). */
  territories?: string[];
  /** Also refuse these countries. */
  blockTerritories?: string[];
  /** Only these app types (each must be allowed by the profile). */
  appTypes?: string[];
  /** Also refuse these registered apps. */
  blockAppIds?: string[];
  /** Only these uses (each must be allowed by the profile). */
  uses?: string[];
  from?: string | null;
  until?: string | null;
}

/** The rights one asset actually has: its profile with its own narrowing applied. */
export interface EffectiveRights {
  profileId: string | null;
  profileName: string;
  territoryMode: 'worldwide' | 'allow' | 'block';
  territories: string[];
  blockTerritories: string[];
  appMode: 'all' | 'allow' | 'block';
  appTypes: string[];
  appIds: string[];
  blockAppIds: string[];
  uses: string[];
  accessTypes: string[];
  from: Date | null;
  until: Date | null;
  narrowed: boolean;
}

export type RightsRefusal = 'territory' | 'app' | 'use' | 'window' | 'access';
export interface RightsAnswer { allowed: boolean; code?: RightsRefusal; reason?: string }

const up = (c: string) => String(c || '').trim().toUpperCase();

/** The open profile, as the rights of an asset with no profile at all. */
export const OPEN: EffectiveRights = {
  profileId: null, profileName: 'No restrictions', territoryMode: 'worldwide', territories: [], blockTerritories: [],
  appMode: 'all', appTypes: [], appIds: [], blockAppIds: [], uses: [...USES], accessTypes: [...ACCESS_TYPES],
  from: null, until: null, narrowed: false,
};

function addUnit(d: Date, count: number, unit: 'day' | 'month' | 'year'): Date {
  const x = new Date(d.getTime());
  if (unit === 'day') x.setUTCDate(x.getUTCDate() + count);
  else if (unit === 'month') x.setUTCMonth(x.getUTCMonth() + count);
  else x.setUTCFullYear(x.getUTCFullYear() + count);
  return x;
}

/** The profile's own window for one asset (relative windows start at first air or ingest). */
export function profileWindow(p: Pick<RightsProfile, 'window_kind' | 'window_from' | 'window_until' | 'relative_count' | 'relative_unit' | 'relative_from'>,
  asset: { created_at?: string | Date | null; first_aired_at?: string | Date | null }): { from: Date | null; until: Date | null } {
  if (p.window_kind === 'fixed') {
    return { from: p.window_from ? new Date(p.window_from) : null, until: p.window_until ? new Date(p.window_until) : null };
  }
  if (p.window_kind === 'relative' && p.relative_count && p.relative_unit) {
    const anchorRaw = p.relative_from === 'ingest' ? asset.created_at : (asset.first_aired_at ?? asset.created_at);
    if (!anchorRaw) return { from: null, until: null };
    const anchor = new Date(anchorRaw);
    return { from: anchor, until: addUnit(anchor, p.relative_count, p.relative_unit) };
  }
  return { from: null, until: null };
}

/** Pure: the profile and the title's narrowing, combined. */
export function effectiveRights(p: RightsProfile | null, asset: { created_at?: any; first_aired_at?: any; rights_narrow?: RightsNarrow | null }): EffectiveRights {
  if (!p) return OPEN;
  const n = asset.rights_narrow ?? {};
  const w = profileWindow(p, asset);
  let from = w.from, until = w.until;
  if (n.from) { const f = new Date(n.from); if (!from || f > from) from = f; }
  if (n.until) { const u = new Date(n.until); if (!until || u < until) until = u; }
  let territoryMode = p.territory_mode;
  let territories = (p.territories ?? []).map(up);
  if (n.territories?.length) {
    // An allow-list on the title: what the profile allows, intersected with it.
    const want = n.territories.map(up);
    territories = territoryMode === 'allow' ? territories.filter((c) => want.includes(c))
      : territoryMode === 'block' ? want.filter((c) => !territories.includes(c))
      : want;
    territoryMode = 'allow';
  }
  let appMode = p.app_mode, appTypes = [...(p.app_types ?? [])], appIds = [...(p.app_ids ?? [])];
  if (n.appTypes?.length) {
    const want = n.appTypes;
    if (appMode === 'allow') appTypes = appTypes.filter((t) => want.includes(t));
    else if (appMode === 'block') appTypes = want.filter((t) => !appTypes.includes(t));
    else appTypes = [...want];
    // Specific apps the profile allowed by name stay only if their type stays.
    if (appMode !== 'allow') appIds = [];
    appMode = 'allow';
  }
  const uses = n.uses?.length ? (p.uses ?? []).filter((u) => n.uses!.includes(u)) : [...(p.uses ?? [])];
  return {
    profileId: p.id, profileName: p.name, territoryMode, territories,
    blockTerritories: (n.blockTerritories ?? []).map(up),
    appMode, appTypes, appIds, blockAppIds: n.blockAppIds ?? [],
    uses, accessTypes: [...(p.access_types ?? [])], from, until,
    narrowed: !!(n.territories?.length || n.blockTerritories?.length || n.appTypes?.length || n.blockAppIds?.length || n.uses?.length || n.from || n.until),
  };
}

const USE_LABEL: Record<string, string> = {
  on_demand: 'on demand', fast: 'FAST and linear', clips: 'clips', social: 'social', downloads: 'downloads', ads: 'ads',
};

/**
 * Pure: may this be shown, here, on this app, for this use, now? Unknown
 * country under an allow-list is refused, as the other geo checks do.
 */
export function evaluateRights(r: EffectiveRights, req: { country?: string | null; appType?: RightsAppType | null; appId?: string | null; use: Use; at?: Date }): RightsAnswer {
  const at = req.at ?? new Date();
  if (!r.uses.includes(req.use)) {
    return { allowed: false, code: 'use', reason: r.uses.length ? `The rights do not allow ${USE_LABEL[req.use] ?? req.use}.` : 'This content is not cleared for use.' };
  }
  if (r.from && at < r.from) return { allowed: false, code: 'window', reason: `Not available until ${r.from.toISOString().slice(0, 10)}.` };
  if (r.until && at >= r.until) return { allowed: false, code: 'window', reason: 'This content is no longer available.' };
  const c = up(req.country ?? '');
  if (r.territoryMode === 'allow' && (!c || !r.territories.includes(c))) return { allowed: false, code: 'territory', reason: 'This programme is not available in your region.' };
  if (r.territoryMode === 'block' && c && r.territories.includes(c)) return { allowed: false, code: 'territory', reason: 'This programme is not available in your region.' };
  if (c && r.blockTerritories.includes(c)) return { allowed: false, code: 'territory', reason: 'This programme is not available in your region.' };
  if ((req.appType || req.appId) && !appAllowed(r, req.appType ?? null, req.appId ?? null)) {
    return { allowed: false, code: 'app', reason: 'This programme is not available in this app.' };
  }
  return { allowed: true };
}

/** Pure: may this app (by type, and by id when known) show the asset at all? */
export function appAllowed(r: EffectiveRights, appType: RightsAppType | null, appId: string | null): boolean {
  if (appId && r.blockAppIds.includes(appId)) return false;
  const t = appType ?? 'web';
  const named = !!appId && r.appIds.includes(appId);
  if (r.appMode === 'allow') return named || r.appTypes.includes(t);
  if (r.appMode === 'block') return !(named || r.appTypes.includes(t));
  return true;
}

/** May the rights' access types carry this kind of access? */
export function accessAllowed(r: EffectiveRights, kinds: AccessType[]): boolean {
  return kinds.some((k) => r.accessTypes.includes(k));
}

// ---------------------------------------------------------------------------
//  Narrowing: never wider. Returns the reasons a narrowing would widen.
// ---------------------------------------------------------------------------
export function wideningProblems(p: RightsProfile, n: RightsNarrow, asset: { created_at?: any; first_aired_at?: any } = {}): string[] {
  const out: string[] = [];
  const terr = (p.territories ?? []).map(up);
  for (const c of (n.territories ?? []).map(up)) {
    if (p.territory_mode === 'allow' && !terr.includes(c)) out.push(`${c} is outside the profile's territories.`);
    if (p.territory_mode === 'block' && terr.includes(c)) out.push(`${c} is blocked by the profile.`);
  }
  for (const t of n.appTypes ?? []) {
    if (!(APP_TYPES as readonly string[]).includes(t)) out.push(`${t} is not an app type.`);
    else if (p.app_mode === 'allow' && !p.app_types.includes(t)) out.push(`The profile does not allow ${t} apps.`);
    else if (p.app_mode === 'block' && p.app_types.includes(t)) out.push(`The profile blocks ${t} apps.`);
  }
  for (const u of n.uses ?? []) {
    if (!(p.uses ?? []).includes(u)) out.push(`The profile does not allow ${USE_LABEL[u] ?? u}.`);
  }
  const w = profileWindow(p, asset);
  if (n.from && w.from && new Date(n.from) < w.from) out.push('The start is before the profile allows.');
  if (n.until && w.until && new Date(n.until) > w.until) out.push('The end is after the profile allows.');
  if (n.from && n.until && new Date(n.from) >= new Date(n.until)) out.push('The start must be before the end.');
  return out;
}

// ---------------------------------------------------------------------------
//  Loading, cached for the play path.
// ---------------------------------------------------------------------------
const C = () => scaleConfig.cache;

export function cachedProfile(id: string | null | undefined): Promise<RightsProfile | null> {
  if (!id) return Promise.resolve(null);
  return cached<RightsProfile | null>(`rightsprof:${id}`, { ttlSec: C().rulesTtlSec, tags: [`rights:${id}`] },
    () => one<RightsProfile>(`SELECT * FROM rights_profiles WHERE id = $1`, [id]));
}

/** An asset's effective rights, from cached rows. */
export async function rightsForAsset(asset: { rights_profile_id?: string | null; rights_narrow?: any; created_at?: any; first_aired_at?: any }): Promise<EffectiveRights> {
  const p = await cachedProfile(asset.rights_profile_id ?? null);
  return effectiveRights(p, asset);
}

/** The same by asset id (not on the play path: a direct read). */
export async function rightsForAssetId(assetId: string): Promise<EffectiveRights | null> {
  const a = await one<any>(`SELECT rights_profile_id, rights_narrow, created_at, first_aired_at FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) return null;
  return rightsForAsset(a);
}

/** Make sure both built-ins exist; returns their ids. */
export async function ensureBuiltins(accountId: string): Promise<{ open: string; closed: string }> {
  const r = await one<any>(`SELECT volt_rights_builtin($1, 'open') AS open, volt_rights_builtin($1, 'closed') AS closed`, [accountId]);
  return { open: r.open, closed: r.closed };
}

/** The profile new assets get: the account's choice, else No restrictions. */
export async function defaultProfileId(accountId: string): Promise<string> {
  const r = await one<any>(
    `SELECT p.id FROM accounts a JOIN rights_profiles p ON p.id = a.default_rights_profile_id AND p.account_id = a.id WHERE a.id = $1`, [accountId]);
  if (r?.id) return r.id;
  return (await ensureBuiltins(accountId)).open;
}

/** Drop every cached answer that read this profile or these assets. */
export function invalidateRights(profileId?: string | null, assetIds: string[] = []): void {
  if (profileId) invalidateTag(`rights:${profileId}`);
  for (const id of assetIds) invalidateTag(`asset:${id}`);
}

/**
 * Set an asset's profile (and narrowing). The caller has checked the account.
 * A narrowing that would widen the profile is refused with its reasons.
 */
export async function assignRights(assetId: string, accountId: string, profileId: string, narrow: RightsNarrow | null, by: string): Promise<{ ok: true } | { ok: false; problems: string[] }> {
  const p = await one<RightsProfile>(`SELECT * FROM rights_profiles WHERE id = $1 AND account_id = $2`, [profileId, accountId]);
  if (!p) return { ok: false, problems: ['Rights profile not found.'] };
  if (narrow) {
    const a = await one<any>(`SELECT created_at, first_aired_at FROM vod_assets WHERE id = $1`, [assetId]);
    const problems = wideningProblems(p, narrow, a ?? {});
    if (problems.length) return { ok: false, problems };
  }
  await query(
    `UPDATE vod_assets SET rights_profile_id = $2, rights_narrow = $3::jsonb, rights_set_by = $4, rights_set_at = now(), updated_at = now() WHERE id = $1`,
    [assetId, profileId, narrow ? JSON.stringify(cleanNarrow(narrow)) : null, by.slice(0, 200)]);
  invalidateRights(null, [assetId]);
  return { ok: true };
}

/** Drop empty fields so "narrowed" means something. */
export function cleanNarrow(n: RightsNarrow): RightsNarrow | null {
  const out: RightsNarrow = {};
  if (n.territories?.length) out.territories = [...new Set(n.territories.map(up))];
  if (n.blockTerritories?.length) out.blockTerritories = [...new Set(n.blockTerritories.map(up))];
  if (n.appTypes?.length) out.appTypes = [...new Set(n.appTypes)];
  if (n.blockAppIds?.length) out.blockAppIds = [...new Set(n.blockAppIds)];
  if (n.uses?.length) out.uses = [...new Set(n.uses)];
  if (n.from) out.from = n.from;
  if (n.until) out.until = n.until;
  return Object.keys(out).length ? out : null;
}

/** The access types a resolved policy outcome stands for, for the rights check. */
export function accessKindsFor(via: string | undefined, simpleAccess: string | undefined, terms?: { kind?: string }[] | null): AccessType[] {
  if (via === 'free') return ['free'];
  if (via === 'members') return ['members'];
  if (via === 'entitlement' || via === 'premium') {
    const kinds = new Set<AccessType>();
    for (const t of terms ?? []) kinds.add(t.kind === 'published_dates' ? 'ppv' : 'subscription');
    return kinds.size ? [...kinds] : ['subscription', 'ppv'];
  }
  // The simple fields: free, entitled (a subscription or grant), paid (a purchase).
  if (simpleAccess === 'entitled') return ['subscription'];
  if (simpleAccess === 'paid') return ['ppv', 'subscription'];
  return ['free'];
}
