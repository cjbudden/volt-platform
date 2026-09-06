// ============================================================================
//  PUBLISHING RULES — the ladder, resolved per field.
//
//    account default  <  content type  <  channel / event / station  <  asset
//
//  Each rung is a partial: only the keys it states. resolve() lays them on top
//  of the platform baseline in that order and remembers, per key, which rung
//  supplied the value, so the library can say "went to YouTube because of the
//  Sky Sport rule" rather than "because". The result is what is stamped on
//  the asset at publish time, and what the play gate reads afterwards.
//
//  PUBLISHING POINTS ARE THE CLIENT'S OWN. A target is one of: the platform
//  catalogue ('portal'), one of the client's registered apps ('app', by id),
//  or one of the client's configured social accounts ('social', by
//  publish_targets id). validateTargets() refuses anything else, so a rule
//  can never name an app or an account the client does not have.
// ============================================================================
import { query, one } from '../db';
import type { AccessRule } from './accessRules';

export type Target =
  | { kind: 'portal' }
  | { kind: 'app'; appId: string }
  | { kind: 'social'; targetId: string; platform?: string };

export interface RuleSettings {
  /** Where a publish sends the asset. */
  targets?: Target[];
  /** Publish derived assets as soon as they are built and pass the gate. */
  autoPublish?: boolean;
  /** When it becomes available: at publish, or at a set time. */
  availableFrom?: { mode: 'publish' } | { mode: 'at'; at: string };
  /** When it stops being available. */
  expire?: { mode: 'never' } | { mode: 'days'; days: number } | { mode: 'at'; at: string };
  geo?: { mode: 'worldwide' | 'allow' | 'block'; countries: string[] };
  /** free: anyone the geo allows; entitled: needs an entitlement; paid: needs the paywall. */
  access?: 'free' | 'entitled' | 'paid';
  paywall?: { tier?: string; priceCents?: number; currency?: string } | null;
  /** Gate before an automatic or manual publish goes through. */
  gate?: { requireReview: boolean; blockOnQcFail: boolean };
  /** The FOR / IF / THEN / TERMS rule set (services/accessRules.ts). When
   *  present and non-empty it decides access for the content it governs, and
   *  the simple geo / access / paywall fields are the fallback for content no
   *  rule matches. */
  accessRules?: AccessRule[];
}
export type RuleKey = keyof RuleSettings;
export const RULE_KEYS: RuleKey[] = ['targets', 'autoPublish', 'availableFrom', 'expire', 'geo', 'access', 'paywall', 'gate', 'accessRules'];

/** The platform baseline under the account rung: catalogue only, manual, worldwide, free. */
export const BASELINE: Required<Omit<RuleSettings, 'paywall'>> & { paywall: RuleSettings['paywall'] } = {
  targets: [{ kind: 'portal' }],
  autoPublish: false,
  availableFrom: { mode: 'publish' },
  expire: { mode: 'never' },
  geo: { mode: 'worldwide', countries: [] },
  access: 'free',
  paywall: null,
  gate: { requireReview: false, blockOnQcFail: false },
  accessRules: [],
};

export type Rung = 'baseline' | 'account' | 'schema' | 'owner' | 'asset';

export interface Resolved {
  settings: typeof BASELINE;
  /** Which rung each key came from. */
  sources: Record<RuleKey, Rung>;
  /** The rule rows that took part, for the UI to show and link. */
  rungs: { rung: Rung; id: string | null; scopeId: string | null; settings: RuleSettings }[];
}

/** Pure: lay the rungs (lowest first) over the baseline, per key. */
export function resolveLadder(rungs: { rung: Rung; id?: string | null; scopeId?: string | null; settings: RuleSettings | null | undefined }[]): Resolved {
  const settings: any = { ...BASELINE };
  const sources = Object.fromEntries(RULE_KEYS.map((k) => [k, 'baseline'])) as Record<RuleKey, Rung>;
  const used: Resolved['rungs'] = [];
  for (const r of rungs) {
    const s = r.settings ?? {};
    used.push({ rung: r.rung, id: r.id ?? null, scopeId: r.scopeId ?? null, settings: s });
    for (const k of RULE_KEYS) {
      if (s[k] !== undefined && s[k] !== null || (k === 'paywall' && s.paywall === null && 'paywall' in s)) {
        settings[k] = s[k];
        sources[k] = r.rung;
      }
    }
  }
  return { settings, sources, rungs: used };
}

/** Load the rungs that apply to an asset and resolve them. */
export async function resolveForAsset(accountId: string, asset: {
  id?: string; schema_id?: string | null; channel_id?: string | null; event_id?: string | null;
  availability_override?: RuleSettings | null;
}): Promise<Resolved> {
  const ownerId = asset.channel_id ?? asset.event_id ?? null;
  const rows = await query<any>(
    `SELECT id, scope_kind, scope_id, settings FROM publishing_rules
      WHERE account_id = $1 AND (
        scope_kind = 'account'
        OR (scope_kind = 'schema' AND scope_id = $2::uuid)
        OR (scope_kind = 'owner'  AND scope_id = $3::uuid))`,
    [accountId, asset.schema_id ?? null, ownerId]);
  const pick = (kind: string) => rows.find((r) => r.scope_kind === kind);
  const acc = pick('account'), sch = pick('schema'), own = pick('owner');
  return resolveLadder([
    { rung: 'account', id: acc?.id, scopeId: null, settings: acc?.settings },
    { rung: 'schema', id: sch?.id, scopeId: asset.schema_id ?? null, settings: sch?.settings },
    { rung: 'owner', id: own?.id, scopeId: ownerId, settings: own?.settings },
    { rung: 'asset', id: asset.id ?? null, scopeId: asset.id ?? null, settings: asset.availability_override ?? {} },
  ]);
}

/**
 * Every target in a rule must be one of the client's own publishing points.
 * Returns the cleaned list, or throws with the first offender.
 */
export async function validateTargets(accountId: string, targets: Target[] | undefined): Promise<Target[] | undefined> {
  if (!targets) return undefined;
  const out: Target[] = [];
  for (const t of targets) {
    if (t.kind === 'portal') { out.push({ kind: 'portal' }); continue; }
    if (t.kind === 'app') {
      const app = await one<any>(`SELECT id FROM apps WHERE id = $1 AND account_id = $2`, [t.appId, accountId]);
      if (!app) throw new Error(`app ${t.appId} is not registered to this account`);
      out.push({ kind: 'app', appId: t.appId }); continue;
    }
    if (t.kind === 'social') {
      const tg = await one<any>(`SELECT id, platform FROM publish_targets WHERE id = $1 AND account_id = $2`, [t.targetId, accountId]);
      if (!tg) throw new Error(`social account ${t.targetId} is not configured for this account`);
      out.push({ kind: 'social', targetId: t.targetId, platform: tg.platform }); continue;
    }
    throw new Error(`unknown target kind ${(t as any).kind}`);
  }
  return out;
}

/** The window a resolved plan gives an asset published now. */
export function windowFor(s: typeof BASELINE, now = new Date()): { from: Date; until: Date | null } {
  const from = s.availableFrom.mode === 'at' ? new Date(s.availableFrom.at) : now;
  let until: Date | null = null;
  if (s.expire.mode === 'days') until = new Date(from.getTime() + s.expire.days * 86_400_000);
  else if (s.expire.mode === 'at') until = new Date(s.expire.at);
  return { from, until };
}

/** The publishing points a client can choose from: its apps and its social accounts. */
export async function publishingPoints(accountId: string) {
  const apps = await query<any>(`SELECT id, name, type, enabled FROM apps WHERE account_id = $1 ORDER BY name`, [accountId]);
  const social = await query<any>(`SELECT id, platform, name, external_account, enabled FROM publish_targets WHERE account_id = $1 ORDER BY platform, name`, [accountId]);
  return {
    portal: { kind: 'portal', name: 'Catalogue (portal)' },
    apps: apps.map((a) => ({ kind: 'app', appId: a.id, name: a.name, type: a.type, enabled: a.enabled })),
    social: social.map((s) => ({ kind: 'social', targetId: s.id, platform: s.platform, name: s.name, account: s.external_account, enabled: s.enabled })),
  };
}
