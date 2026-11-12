// ============================================================================
//  PUBLISHING POLICIES: presets, conflict checks and the impact of a change
//  (build queue P3, PUBLISHING_POLICIES.md "Conflict rules" and "Presets").
//
//  A policy is a rung of the publishing ladder (services/publishingRules.ts)
//  with its five sections. This file holds what is ABOUT policies rather than
//  how they resolve:
//
//    PRESETS            the five starting policies a person can copy and edit
//    policyConflicts()  pure: what is wrong with one resolved policy, as a
//                       block (cannot save) or a warning (saved, shown)
//    lockConflicts()    pure: a rung that tries to change a locked field
//    policyImpact()     what saving a rung would do to the account's titles:
//                       how many it governs, how many change, how many
//                       published titles would need repackaging, and the
//                       per-title blocks and warnings, before anything is saved
//
//  Conflicts are caught when a policy is saved, never discovered by a viewer.
// ============================================================================
import { query } from '../db';
import {
  resolveLadder, BASELINE, SECTION_KEYS, LOCKABLE_FIELDS,
  type RuleSettings, type Rung, type Resolved,
} from './publishingRules';
import { effectiveRights, cachedProfile, type EffectiveRights } from './rightsProfiles';
import { rungOf, loadRules, firstMatches, type MetadataRule } from './publishingMetadataRules';
import { tokenFreeBlockers } from './deliveryPolicy';

export type PresetKey = 'open' | 'members' | 'geo_locked' | 'premium' | 'rights_managed';
export interface Preset { key: PresetKey; name: string; summary: string; settings: RuleSettings }

/** The five starting policies (PUBLISHING_POLICIES.md, Presets). Countries are
 *  left for the person to choose: a preset never guesses a territory. */
export const PRESETS: Preset[] = [
  { key: 'open', name: 'Open', summary: 'Published when ready, free worldwide, no DRM, MP4 and share links allowed',
    settings: { autoPublish: true, access: 'free', paywall: null, geo: { mode: 'worldwide', countries: [] },
      protection: { drm: false, waf: 'off' }, distribution: { mp4Download: true, shareLinks: true } } },
  { key: 'members', name: 'Members', summary: 'Sign-in required, worldwide, no DRM',
    settings: { geo: { mode: 'worldwide', countries: [] }, access: 'free',
      accessRules: [{ id: 'members', for: { scopes: ['this', 'live', 'ondemand'] }, if: { geo: 'in', countries: ['WORLD'] }, then: { access: 'members' } }],
      protection: { drm: false } } },
  { key: 'geo_locked', name: 'Geo-locked', summary: 'Free, chosen countries only, VPN and proxy flagged',
    settings: { access: 'free', geo: { mode: 'allow', countries: [] }, protection: { waf: 'standard' } } },
  { key: 'premium', name: 'Premium', summary: 'Paywall products, DRM, no MP4 download',
    settings: { access: 'paid', protection: { drm: true }, distribution: { mp4Download: false } } },
  { key: 'rights_managed', name: 'Rights-managed', summary: 'Rights window required, chosen territories, DRM, rights-managed WAF profile, no social or MP4',
    settings: { geo: { mode: 'allow', countries: [] }, targets: [{ kind: 'portal' }],
      protection: { drm: true, waf: 'rights_managed' }, distribution: { mp4Download: false } } },
];
export const presetByKey = (k: string | null | undefined) => PRESETS.find((p) => p.key === k) ?? null;

export type ConflictLevel = 'block' | 'warn' | 'confirm';
export interface Conflict { code: string; level: ConflictLevel; fields: string[]; message: string }

type Settings = typeof BASELINE;
const restrictedGeo = (s: Settings) =>
  (s.geo?.mode === 'allow' || s.geo?.mode === 'block')
  || (s.accessRules ?? []).some((r) => !(r.if?.geo === 'in' && (r.if.countries ?? []).every((c) => c.toUpperCase() === 'WORLD')));
const hasSocial = (s: Settings) => (s.targets ?? []).some((t) => t.kind === 'social');

/** The publish window a resolved policy gives a title, by its own dates where it has them. */
function windowOf(s: Settings, t: { availableFrom?: Date | null; availableUntil?: Date | null }): { from: Date | null; until: Date | null } {
  const from = t.availableFrom ?? (s.availableFrom?.mode === 'at' ? new Date(s.availableFrom.at) : null);
  let until = t.availableUntil ?? null;
  if (!until && s.expire?.mode === 'at') until = new Date(s.expire.at);
  if (!until && s.expire?.mode === 'days' && from) until = new Date(from.getTime() + s.expire.days * 86_400_000);
  return { from, until };
}

/** When retention would delete the title, or null when it keeps it or cannot say yet. */
function retainUntil(s: Settings, t: { createdAt?: Date | null }, w: { from: Date | null; until: Date | null }): Date | null {
  const r = s.retention;
  if (!r || r.keep !== 'days' || !r.days) return null;
  const anchor = r.anchor === 'ingest' ? (t.createdAt ?? null) : r.anchor === 'available_from' ? w.from : w.until;
  return anchor ? new Date(anchor.getTime() + r.days * 86_400_000) : null;
}

/**
 * PURE. What is wrong with one resolved policy. Without `title` it checks the
 * policy on its own (a rule being saved); with it, the policy as one title
 * would get it, with the title's rights and dates.
 */
export function policyConflicts(s: Settings, o: {
  presetKey?: string | null;
  title?: { rights?: EffectiveRights | null; availableFrom?: Date | null; availableUntil?: Date | null; createdAt?: Date | null; collectionAccess?: any };
} = {}): Conflict[] {
  const out: Conflict[] = [];
  const p = s.protection ?? BASELINE.protection, d = s.distribution ?? BASELINE.distribution;
  if (p.drm && d.mp4Download)
    out.push({ code: 'drm_mp4', level: 'block', fields: ['protection.drm', 'distribution.mp4Download'], message: 'DRM is on and MP4 download is allowed: MP4 export is not possible for DRM content. Turn one of them off.' });
  if (p.drm && hasSocial(s))
    out.push({ code: 'drm_social', level: 'block', fields: ['protection.drm', 'targets'], message: 'DRM is on and a social account is a publishing point: social platforms need a clear MP4. Remove the social account or turn DRM off.' });
  const rights = o.title?.rights ?? null;
  const rightsTerritory = !!rights && rights.territoryMode !== 'worldwide';
  if ((restrictedGeo(s) || rightsTerritory) && hasSocial(s))
    out.push({ code: 'geo_social', level: 'warn', fields: ['geo', 'targets'], message: 'Restricted to some countries and published to a social account: once posted, the platform cannot keep to your territories.' });
  if (restrictedGeo(s) && (p.waf ?? 'off') === 'off')
    out.push({ code: 'geo_no_waf', level: 'warn', fields: ['geo', 'protection.waf'], message: 'Restricted to some countries without a WAF profile: VPN users can get around a country restriction. Choose the standard or rights-managed WAF profile.' });
  if (s.geo?.mode === 'allow' && !(s.geo.countries ?? []).length)
    out.push({ code: 'geo_empty', level: 'warn', fields: ['geo'], message: 'Only in these countries, with no country chosen: nobody can watch.' });
  if (s.availableFrom?.mode === 'at' && s.expire?.mode === 'at' && new Date(s.expire.at) <= new Date(s.availableFrom.at))
    out.push({ code: 'empty_window', level: 'block', fields: ['availableFrom', 'expire'], message: 'Expires before it becomes available: the window is empty.' });
  // TOKEN-FREE PLAYBACK (build queue P2-2c): a plain address plays for anyone
  // who has it, so it is refused wherever a condition depends on the viewer.
  // With a title, its rights and collections count too.
  if ((p as any).tokenFree === true) {
    const why = tokenFreeBlockers(s, { rights: o.title?.rights ?? null, collectionAccess: o.title?.collectionAccess ?? null });
    if (why.length)
      out.push({ code: 'token_free_conditions', level: 'block', fields: ['protection.tokenFree', ...new Set(why.map((b) => TOKEN_FREE_FIELD[b.code]).filter(Boolean))],
        message: `Token-free playback is on, but ${why.map((b) => b.words).join(', ')}: a plain address would let anyone play it. Turn token-free off, or remove ${why.length === 1 ? 'that condition' : 'those conditions'}.` });
  }
  const rightsManaged = o.presetKey === 'rights_managed' || p.waf === 'rights_managed';
  const w = windowOf(s, o.title ?? {});
  if (o.title) {
    if (rightsManaged && rights && !rights.from && !rights.until)
      out.push({ code: 'rights_managed_no_window', level: 'block', fields: ['protection.waf'], message: 'A rights-managed policy needs a rights window, and this title has none. Give it a rights profile with a window.' });
    if (rights && (rights.from || rights.until)) {
      const before = rights.from && (!w.from || w.from < rights.from);
      const after = rights.until && (!w.until || w.until > rights.until);
      if (before || after)
        out.push({ code: 'window_outside_rights', level: 'warn', fields: ['availableFrom', 'expire'], message: 'The publish window reaches outside the rights window: the title shows as Restricted for the gap.' });
    }
  }
  const ret = s.retention ?? BASELINE.retention;
  if (ret.keep === 'days' && ret.days) {
    if (s.expire?.mode === 'never' && !o.title?.availableUntil)
      out.push({ code: 'retention_while_live', level: 'block', fields: ['retention.days', 'expire'], message: 'Retention deletes titles that never expire: they would be deleted while still available. Set an expiry or keep them.' });
    else if (ret.anchor !== 'available_until') {
      const del = retainUntil(s, o.title ?? {}, w);
      const days = s.expire?.mode === 'days' ? s.expire.days : null;
      const short = del && w.until ? del < w.until
        : (ret.anchor === 'available_from' && days != null ? ret.days < days : false);
      if (short)
        out.push({ code: 'retention_while_live', level: 'block', fields: ['retention.days', 'expire'], message: 'Retention is shorter than the time the title is available: it would be deleted while still live.' });
    }
  }
  return out;
}

/** The field behind each token-free blocker, for the editor to outline. */
const TOKEN_FREE_FIELD: Record<string, string> = {
  geo: 'geo', paywall: 'access', sign_in: 'accessRules', drm: 'protection.drm', referrers: 'protection.referrers', concurrent: 'protection.concurrentStreams', rights: '', account: '', collection: '',
};

/** PURE. A rung changing fields a rung above it has locked: one block per field. */
export function lockConflicts(settings: RuleSettings, rung: Rung, locks: Record<string, Rung>): Conflict[] {
  const out: Conflict[] = [];
  const said = statedFields(settings);
  for (const f of said) {
    const by = locks[f] ?? (f.includes('.') ? locks[f.split('.')[0]] : undefined);
    if (by && by !== rung) out.push({ code: 'locked_field', level: 'block', fields: [f], message: `${fieldLabel(f)} is locked by the ${rungLabel(by)}: it cannot be changed here.` });
  }
  return out;
}

/** The fields a rung states, section fields by their dotted name. */
export function statedFields(s: RuleSettings): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(s ?? {})) {
    if ((SECTION_KEYS as readonly string[]).includes(k)) { for (const [f, x] of Object.entries(v ?? {})) if (x !== undefined) out.push(`${k}.${f}`); }
    else if (v !== undefined) out.push(k);
  }
  return out.filter((f) => LOCKABLE_FIELDS.includes(f) || LOCKABLE_FIELDS.includes(f.split('.')[0]));
}

export const rungLabel = (r: Rung) => ({ baseline: 'platform default', account: 'account default', schema: 'content type rule', owner: 'channel, event or station rule', metadata: 'metadata rule', asset: 'title' } as Record<Rung, string>)[r];
const FIELD_LABELS: Record<string, string> = {
  targets: 'Publish to', autoPublish: 'Auto-publish', availableFrom: 'Available from', expire: 'Expires', geo: 'Geo access', access: 'Access',
  paywall: 'Paywall', gate: 'Publish gate', accessRules: 'Access rules', archive: 'Archive copies',
  'protection.drm': 'DRM', 'protection.tokenLifetimeSec': 'Playback token lifetime', 'protection.waf': 'WAF profile', 'protection.referrers': 'Allowed referrer domains',
  'protection.concurrentStreams': 'Concurrent streams', 'protection.tokenFree': 'Token-free playback', 'distribution.mp4Download': 'MP4 download', 'distribution.shareLinks': 'Share links',
  'distribution.fastEligible': 'FAST eligible', 'distribution.sitemap': 'Sitemap and schema.org', 'retention.keep': 'Retention', 'retention.days': 'Retention days',
  'retention.anchor': 'Retention counts from', 'retention.legalHoldAllowed': 'Legal hold allowed', 'retention.archiveTier': 'Archive storage tier',
};
export const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f;

// ---------------------------------------------------------------- impact

export interface Impact {
  /** Titles this rung governs. */
  assets: number;
  /** Of those, published (available or scheduled). */
  published: number;
  /** Titles whose effective policy changes with this save. */
  changed: number;
  /** Published titles whose DRM setting changes: their files must be repackaged (build queue P4). */
  repackage: number;
  /** Published titles that take up the change within about a minute of the save (build queue P3-4). */
  publishedChanged: number;
  /** Titles playable now that would stop being playable at once: their window
   *  now ends in the past, or opens in the future (P3-4). */
  unavailableNow: number;
  /** Per-title problems the save would cause, by code, with up to five titles each. */
  blocks: { code: string; message: string; count: number; titles: { id: string; title: string }[] }[];
  warnings: { code: string; message: string; count: number; titles: { id: string; title: string }[] }[];
}

type MetaRow = Pick<MetadataRule, 'id' | 'name' | 'conditions' | 'settings' | 'locked_fields' | 'preset_key'>;
type RuleRow = { id: string; scope_kind: 'account' | 'schema' | 'owner'; scope_id: string | null; settings: RuleSettings; locked_fields: string[]; preset_key: string | null; name?: string | null };

/**
 * JSON with object keys sorted, for comparing two policies. A stored rung
 * comes back from jsonb with its keys in jsonb's order (shortest first), while
 * the same rung as sent is in the order it was written, so a plain
 * JSON.stringify counted every title as changed by a save that changed
 * nothing (found by the console's impact preview, build queue P3-2).
 */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as any)[k]])) : x);
}

/**
 * Resolve a title against a set of rule rows (all the account's, in memory)
 * and the metadata rule it meets first, if any (build queue P3-3; the caller
 * matches a batch at once with publishingMetadataRules.firstMatches).
 */
export function resolveWith(rows: RuleRow[], a: { id?: string; schema_id?: string | null; channel_id?: string | null; event_id?: string | null; availability_override?: RuleSettings | null },
  matched?: MetaRow | null): Resolved {
  const owner = a.channel_id ?? a.event_id ?? null;
  const acc = rows.find((r) => r.scope_kind === 'account');
  const sch = a.schema_id ? rows.find((r) => r.scope_kind === 'schema' && r.scope_id === a.schema_id) : undefined;
  const own = owner ? rows.find((r) => r.scope_kind === 'owner' && r.scope_id === owner) : undefined;
  const m = (r?: RuleRow) => r ? { id: r.id, settings: r.settings, lockedFields: r.locked_fields ?? [], presetKey: r.preset_key } : { settings: {} };
  return resolveLadder([
    { rung: 'account', scopeId: null, ...m(acc) },
    { rung: 'schema', scopeId: a.schema_id ?? null, ...m(sch) },
    { rung: 'owner', scopeId: owner, ...m(own) },
    rungOf(matched),
    { rung: 'asset', id: a.id ?? null, scopeId: a.id ?? null, settings: a.availability_override ?? {} },
  ]);
}

/** The preset that governs a resolved title: the most specific rung that names one. */
export function presetOf(r: Resolved): string | null {
  for (const x of [...r.rungs].reverse()) if (x.presetKey) return x.presetKey;
  return null;
}

/**
 * What saving `next` at this scope would do to the account's titles, without
 * saving it. Reads every rule of the account once and every title the rung
 * governs once, then resolves in memory; titles that share a content type, an
 * owner and have no override of their own resolve once between them.
 */
export async function policyImpact(accountId: string, scope: { kind: 'account' | 'schema' | 'owner' | 'metadata' | 'asset'; id: string | null },
  next: { settings: RuleSettings; lockedFields: string[]; presetKey: string | null },
  /** A metadata-rule change (P3-3): the account's enabled metadata rules, in order, as they would be after it. */
  opts: { metaAfter?: MetaRow[] } = {}): Promise<Impact> {
  const rows = await query<RuleRow>(`SELECT id, scope_kind, scope_id, settings, locked_fields, preset_key FROM publishing_rules WHERE account_id = $1`, [accountId]);
  const after = rows.filter((r) => !(r.scope_kind === scope.kind && (r.scope_id ?? null) === (scope.id ?? null)));
  // The asset rung (build queue P3-2b) is the title's own override, not a rule row: it is swapped on the title below.
  if (scope.kind !== 'metadata' && scope.kind !== 'asset')
    after.push({ id: 'next', scope_kind: scope.kind, scope_id: scope.id, settings: next.settings, locked_fields: next.lockedFields, preset_key: next.presetKey });
  // Which metadata rule each title meets now and after the save: a change to
  // a rule's conditions or order moves titles between rules, so a metadata
  // change is measured over the whole library.
  const metaBefore: MetaRow[] = await loadRules(accountId, { enabledOnly: true });
  const metaAfter = scope.kind === 'metadata' ? (opts.metaAfter ?? metaBefore) : metaBefore;
  const matchedBefore = await firstMatches(accountId, null, metaBefore);
  const matchedAfter = metaAfter === metaBefore ? matchedBefore : await firstMatches(accountId, null, metaAfter);
  const where = scope.kind === 'account' || scope.kind === 'metadata' ? '' : scope.kind === 'schema' ? 'AND v.schema_id = $2'
    : scope.kind === 'asset' ? 'AND v.id = $2' : 'AND (v.channel_id = $2 OR v.event_id = $2)';
  // A title recorded from a channel or event belongs to the account through
  // its group (as in services/availability.ts assetAccount); an upload directly.
  const titles = await query<any>(
    `SELECT v.id, v.title, v.schema_id, v.channel_id, v.event_id, v.availability_override, v.availability_state, v.available_from, v.available_until,
            v.availability->>'publishedAt' AS published_at,
            v.created_at, v.rights_profile_id, v.rights_narrow, v.first_aired_at, v.collection_access
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.archived_at IS NULL ${where}`, where ? [accountId, scope.id] : [accountId]);
  const memo = new Map<string, [Resolved, Resolved]>();
  const profiles = new Map<string, any>();
  const impact: Impact = { assets: titles.length, published: 0, changed: 0, repackage: 0, publishedChanged: 0, unavailableNow: 0, blocks: [], warnings: [] };
  const { restampPublished, publishedAnchor } = await import('./availability');
  const at = new Date();
  const tally = (list: Impact['blocks'], c: Conflict, t: any) => {
    let e = list.find((x) => x.code === c.code);
    if (!e) list.push(e = { code: c.code, message: c.message, count: 0, titles: [] });
    e.count++; if (e.titles.length < 5) e.titles.push({ id: t.id, title: t.title });
  };
  for (const t of titles) {
    const hasOverride = t.availability_override && Object.keys(t.availability_override).length > 0;
    const mb = matchedBefore.get(t.id) ?? null, ma = matchedAfter.get(t.id) ?? null;
    // A metadata rule governs the titles that meet it, before or after the save.
    if (scope.kind === 'metadata' && scope.id && mb?.id !== scope.id && ma?.id !== scope.id) { impact.assets--; continue; }
    const key = hasOverride || scope.kind === 'asset' ? `a:${t.id}` : `${t.schema_id ?? ''}|${t.channel_id ?? t.event_id ?? ''}|${mb?.id ?? ''}|${ma === mb ? '=' : ma?.id ?? ''}`;
    let pair = memo.get(key);
    if (!pair) { pair = [resolveWith(rows, t, mb), resolveWith(after, scope.kind === 'asset' ? { ...t, availability_override: next.settings } : t, ma)]; memo.set(key, pair); }
    const [was, now] = pair;
    const live = ['available', 'scheduled'].includes(t.availability_state);
    if (live) impact.published++;
    if (stableJson(was.settings) !== stableJson(now.settings)) impact.changed++;
    if (live && !!was.settings.protection.drm !== !!now.settings.protection.drm) impact.repackage++;
    // The title's rights, from the cached profile, as the play gate sees them.
    const pid = t.rights_profile_id ?? '';
    if (!profiles.has(pid)) profiles.set(pid, await cachedProfile(t.rights_profile_id ?? null));
    const rights = effectiveRights(profiles.get(pid), t);
    // Published titles take up the change (services/availability.ts
    // restampPublished): the same window arithmetic says which stop at once.
    if (live && stableJson(was.settings) !== stableJson(now.settings)) {
      impact.publishedChanged++;
      if (t.availability_state === 'available') {
        const next = restampPublished(null, now.settings, { anchor: publishedAnchor({ availability: { publishedAt: t.published_at }, available_from: t.available_from }, at), rights, now: at });
        if (next.state !== 'available') impact.unavailableNow++;
      }
    }
    const preset = presetOf(now);
    // Only what this save introduces is charged to it: a problem the title
    // already had under the rules as they stand is not a reason to refuse.
    // The policy's own problems (DRM with MP4, say) are reported once for the
    // rule, not once per title, so only what the title's dates and rights add
    // is counted here.
    const own = new Set(policyConflicts(now.settings, { presetKey: preset }).map((c) => c.code));
    const before = new Set(policyConflicts(was.settings, { presetKey: presetOf(was), title: { rights, availableFrom: t.available_from, availableUntil: t.available_until, createdAt: t.created_at, collectionAccess: t.collection_access } }).map((c) => c.code));
    for (const c of policyConflicts(now.settings, { presetKey: preset, title: { rights, availableFrom: t.available_from, availableUntil: t.available_until, createdAt: t.created_at, collectionAccess: t.collection_access } })) {
      if (before.has(c.code) || own.has(c.code)) continue;
      tally(c.level === 'block' ? impact.blocks : impact.warnings, c, t);
    }
  }
  return impact;
}
