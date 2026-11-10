// ============================================================================
//  COLLECTION ACCESS BY APP AND REGION (build queue C2, PUBLISHING_POLICIES.md
//  "Collections, packages and apps").
//
//  A collection can say, for the apps and territories it applies to, what a
//  viewer needs region by region: nothing (free), to be signed in (members),
//  or a package (premium, with the products that unlock it, priced per app
//  when each app sells it through its own store). New collections say
//  nothing: All apps, Global, All access.
//
//  A CHILD inherits its parent's access and can only tighten it: where it
//  applies is the parent's scope narrowed by its own, and what it asks for is
//  the higher of the two. Saving a child that asks for less is refused, so
//  what a person sees on the child is what it does.
//
//  MOST RESTRICTIVE WINS, per app and region (Christian, 6 Nov): a title in a
//  collection that is premium for an app in a region is premium for that app
//  in that region everywhere. Buying any of the packages that ask for it
//  unlocks it. Rights still cap everything: they are checked before this
//  layer at the play gate, and a collection cannot be given a title the
//  rights rule out for every app, territory or access type it asks for.
//
//  SCALE. Nothing here is worked out per request from the collections table.
//  Each title carries the collections that ask more than free of it, each
//  with its chain of ancestors (vod_assets.collection_access), compiled in
//  batches when membership or access changes. The play gate reads it from
//  the cached availability row and evaluates it in memory: a few chains of a
//  few levels, whatever the number of collections in the account.
//
//  Where a collection applies is read as its scope: outside its apps or
//  territories the collection says nothing about a title (its items are not
//  restricted there by it). An unknown country or app is treated as inside
//  every scope and as the strictest of a level's regions, so a viewer whose
//  country is not known never gets through a regional paywall.
// ============================================================================
import { query, one } from '../db';
import type { AccessTerm, ViewerCtx } from './accessRules';
import { accessAllowed, appAllowed, type EffectiveRights, type AccessType, type RightsAppType } from './rightsProfiles';

export type CollectionAccessType = 'free' | 'members' | 'premium';
export const RANK: Record<CollectionAccessType, number> = { free: 0, members: 1, premium: 2 };

export interface RegionRule {
  id: string;
  /** ISO 3166 alpha-2, or ['WORLD'] for everywhere. The first rule naming the viewer's country decides. */
  countries: string[];
  access: CollectionAccessType;
  /** Premium: what can be bought, in every app unless the app has its own. */
  terms?: AccessTerm[];
  /** Premium: an app's own products and store prices, by app id. */
  appTerms?: Record<string, AccessTerm[]>;
}
export interface CollectionAccess {
  apps: 'all' | string[];
  territories: { mode: 'world' | 'allow' | 'block'; countries: string[] };
  rules: RegionRule[];
}
/** One level of a chain as stored on the title: a collection and what it says. */
export interface Level extends CollectionAccess { c: string; n: string }
/** What governs a title: one chain per collection it is in (root first). */
export interface Compiled { v: 1; g: { c: string; n: string; levels: Level[] }[] }

export const ALL_ACCESS: CollectionAccess = { apps: 'all', territories: { mode: 'world', countries: [] }, rules: [] };

const up = (c: string | null | undefined) => (c ?? '').trim().toUpperCase();

// ---------------------------------------------------------------------------
//  Validation and normalising
// ---------------------------------------------------------------------------
export class AccessError extends Error { constructor(msg: string, public problems: string[] = [msg]) { super(msg); } }

const CC = /^[A-Z]{2}$/;
const KEY = /^[A-Za-z0-9._-]{1,120}$/;
function cleanTerms(list: unknown, where: string, problems: string[]): AccessTerm[] {
  if (list == null) return [];
  if (!Array.isArray(list)) { problems.push(`${where}: products must be a list.`); return []; }
  const out: AccessTerm[] = [];
  for (const [i, t] of list.entries()) {
    const at = `${where}, product ${i + 1}`;
    if (!t || typeof t !== 'object') { problems.push(`${at}: not a product.`); continue; }
    const x = t as any;
    if (typeof x.productKey !== 'string' || !KEY.test(x.productKey)) { problems.push(`${at}: productKey is letters, digits, dots, dashes or underscores.`); continue; }
    if (x.kind !== 'period' && x.kind !== 'published_dates') { problems.push(`${at}: kind is period or published_dates.`); continue; }
    if (x.kind === 'period' && (!Number.isInteger(x.count) || x.count < 1 || !['day', 'week', 'month', 'year'].includes(x.unit))) {
      problems.push(`${at}: a period needs a count of 1 or more and a unit (day, week, month or year).`); continue;
    }
    if (!Number.isInteger(x.priceCents) || x.priceCents < 0) { problems.push(`${at}: priceCents is a whole number of cents.`); continue; }
    if (typeof x.currency !== 'string' || !/^[A-Za-z]{3}$/.test(x.currency)) { problems.push(`${at}: currency is a three-letter code.`); continue; }
    out.push({ productKey: x.productKey, kind: x.kind, ...(x.kind === 'period' ? { count: x.count, unit: x.unit } : {}),
      priceCents: x.priceCents, currency: x.currency.toUpperCase(), ...(x.taxPct != null ? { taxPct: Number(x.taxPct) } : {}),
      ...(typeof x.name === 'string' && x.name.trim() ? { name: x.name.trim().slice(0, 120) } : {}) });
  }
  return out;
}

/** Check and normalise what a person sent. `appIds`: the account's apps. Throws AccessError listing every problem. */
export function validateAccess(raw: unknown, appIds: string[]): CollectionAccess {
  const problems: string[] = [];
  const b = (raw ?? {}) as any;
  let apps: CollectionAccess['apps'] = 'all';
  if (b.apps !== undefined && b.apps !== 'all') {
    if (!Array.isArray(b.apps) || !b.apps.length) problems.push('apps is "all" or a list of at least one app.');
    else {
      const known = new Set(appIds);
      const bad = b.apps.filter((a: unknown) => typeof a !== 'string' || !known.has(a));
      if (bad.length) problems.push(`Not an app of this account: ${bad.map(String).join(', ')}.`);
      apps = [...new Set<string>(b.apps.filter((a: unknown) => typeof a === 'string'))];
    }
  }
  const t = b.territories ?? { mode: 'world', countries: [] };
  const mode = t.mode ?? 'world';
  if (!['world', 'allow', 'block'].includes(mode)) problems.push('territories.mode is world, allow or block.');
  const countries = [...new Set<string>((Array.isArray(t.countries) ? t.countries : []).map((c: unknown) => up(String(c))))];
  const badCc = countries.filter((c) => !CC.test(c));
  if (badCc.length) problems.push(`Not a country code: ${badCc.join(', ')}.`);
  if (mode !== 'world' && !countries.length) problems.push(mode === 'allow' ? 'Name at least one territory the collection applies in.' : 'Name at least one territory to leave out.');
  const rules: RegionRule[] = [];
  const list = b.rules == null ? [] : b.rules;
  if (!Array.isArray(list)) problems.push('rules must be a list.');
  else if (list.length > 50) problems.push('At most 50 region rules.');
  else for (const [i, r] of list.entries()) {
    const at = `Region rule ${i + 1}`;
    const cs = [...new Set<string>((Array.isArray(r?.countries) ? r.countries : []).map((c: unknown) => up(String(c))))];
    if (!cs.length) { problems.push(`${at}: name its countries, or WORLD for everywhere.`); continue; }
    const bad = cs.filter((c) => c !== 'WORLD' && !CC.test(c));
    if (bad.length) { problems.push(`${at}: not a country code: ${bad.join(', ')}.`); continue; }
    if (!['free', 'members', 'premium'].includes(r?.access)) { problems.push(`${at}: access is free, members or premium.`); continue; }
    const terms = r.access === 'premium' ? cleanTerms(r.terms, at, problems) : [];
    const appTerms: Record<string, AccessTerm[]> = {};
    if (r.access === 'premium' && r.appTerms && typeof r.appTerms === 'object') {
      for (const [appId, ts] of Object.entries(r.appTerms)) {
        if (!appIds.includes(appId)) { problems.push(`${at}: prices for an app that is not this account's (${appId}).`); continue; }
        if (apps !== 'all' && !apps.includes(appId)) { problems.push(`${at}: prices for an app the collection does not apply to.`); continue; }
        const c = cleanTerms(ts, `${at}, app ${appId}`, problems);
        if (c.length) appTerms[appId] = c;
      }
    }
    if (r.access === 'premium' && !terms.length && !Object.keys(appTerms).length) problems.push(`${at}: premium needs at least one product to unlock it.`);
    rules.push({ id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `r${i + 1}`, countries: cs, access: r.access,
      ...(terms.length ? { terms } : {}), ...(Object.keys(appTerms).length ? { appTerms } : {}) });
  }
  if (problems.length) throw new AccessError(problems[0], problems);
  return { apps, territories: { mode, countries: mode === 'world' ? [] : countries }, rules };
}

// ---------------------------------------------------------------------------
//  Pure evaluation of one level and of a chain
// ---------------------------------------------------------------------------
/** Is (app, country) inside where this level applies? Unknown counts as inside. */
export function inScope(l: CollectionAccess, appId: string | null, country: string | null): boolean {
  if (l.apps !== 'all' && appId && !l.apps.includes(appId)) return false;
  const c = up(country);
  if (!c) return true;
  if (l.territories.mode === 'allow') return l.territories.countries.includes(c);
  if (l.territories.mode === 'block') return !l.territories.countries.includes(c);
  return true;
}

/** What one level asks for in a country: the first rule naming it (or WORLD); none: free. Unknown: the strictest rule. */
export function levelRule(l: CollectionAccess, country: string | null): RegionRule | null {
  const c = up(country);
  if (!c) {
    let worst: RegionRule | null = null;
    for (const r of l.rules) if (!worst || RANK[r.access] > RANK[worst.access]) worst = r;
    return worst;
  }
  return l.rules.find((r) => r.countries.includes(c) || r.countries.includes('WORLD')) ?? null;
}

export interface Cell {
  access: CollectionAccessType;
  /** The collections whose premium asks for it here: buying any of them unlocks it. */
  packages: { id: string; name: string }[];
  /** What this app can buy to unlock it (each product once). */
  terms: AccessTerm[];
  /** Every collection that has a say here, and what it asks. */
  decidedBy: { id: string; name: string; access: CollectionAccessType }[];
}

/** The cell for an app and a country: most restrictive of every chain. Pure. */
export function cellFor(compiled: Compiled | null | undefined, appId: string | null, country: string | null): Cell {
  const cell: Cell = { access: 'free', packages: [], terms: [], decidedBy: [] };
  if (!compiled?.g?.length) return cell;
  const premium: { id: string; name: string; terms: AccessTerm[] }[] = [];
  for (const chain of compiled.g) {
    if (!chain.levels.every((l) => inScope(l, appId, country))) continue;
    let access: CollectionAccessType = 'free';
    for (const l of chain.levels) {
      const r = levelRule(l, country);
      if (!r) continue;
      if (RANK[r.access] > RANK[access]) access = r.access;
      if (r.access === 'premium') premium.push({ id: l.c, name: l.n, terms: (appId && r.appTerms?.[appId]) || r.terms || [] });
    }
    if (access !== 'free') cell.decidedBy.push({ id: chain.c, name: chain.n, access });
    if (RANK[access] > RANK[cell.access]) cell.access = access;
  }
  if (cell.access === 'premium') {
    const seenP = new Set<string>(), seenT = new Set<string>();
    for (const p of premium) {
      if (!seenP.has(p.id)) { seenP.add(p.id); cell.packages.push({ id: p.id, name: p.name }); }
      for (const t of p.terms) if (!seenT.has(t.productKey)) { seenT.add(t.productKey); cell.terms.push(t); }
    }
  }
  return cell;
}

/** Does the viewer hold one of the packages (an entitlement granting the collection, or one of its products)? */
export function holdsPackage(viewer: ViewerCtx | null | undefined, cell: Cell, now = new Date()): boolean {
  const ids = new Set(cell.packages.map((p) => p.id));
  const keys = new Set(cell.terms.map((t) => t.productKey));
  for (const e of viewer?.entitlements ?? []) {
    if (e.validUntil && new Date(e.validUntil) < now) continue;
    if ((e.grants as any)?.collectionIds?.some((c: string) => ids.has(c))) return true;
    if (e.productKey && keys.has(e.productKey)) return true;
  }
  return false;
}

export type GateAnswer =
  | null
  | { allowed: true; via: 'members' | 'entitlement'; cell: Cell }
  | { allowed: false; reason: 'members_only' | 'payment_required'; message: string; cell: Cell; products: AccessTerm[] };

/** The collection layer of the play gate. null: no collection asks anything here. Pure. */
export function collectionGate(compiled: Compiled | null | undefined, ctx: { appId: string | null; country: string | null; viewer?: ViewerCtx | null; entitled?: boolean }, now = new Date()): GateAnswer {
  const cell = cellFor(compiled, ctx.appId, ctx.country);
  if (cell.access === 'free') return null;
  if (cell.access === 'members') {
    // A package holder is signed in by definition; a trusted server's
    // assertion stands for both.
    if (ctx.viewer?.viewerId || ctx.entitled) return { allowed: true, via: 'members', cell };
    return { allowed: false, reason: 'members_only', message: 'Sign in to watch this.', cell, products: [] };
  }
  if (ctx.entitled || holdsPackage(ctx.viewer, cell, now)) return { allowed: true, via: 'entitlement', cell };
  const names = cell.packages.map((p) => p.name).join(', ');
  return { allowed: false, reason: 'payment_required', message: `Part of ${names}. Buy it to watch.`, cell, products: cell.terms };
}

/** The rights' access types a cell needs. */
export function kindsFor(cell: Cell): AccessType[] {
  if (cell.access === 'members') return ['members'];
  if (cell.access === 'premium') {
    const k = new Set<AccessType>();
    for (const t of cell.terms) k.add(t.kind === 'published_dates' ? 'ppv' : 'subscription');
    return k.size ? [...k] : ['subscription', 'ppv'];
  }
  return ['free'];
}

// ---------------------------------------------------------------------------
//  A child can only tighten
// ---------------------------------------------------------------------------
/** Where `own` would ask for less than the ancestors (root first) or reach further. Empty: it only tightens. */
export function looserThan(own: CollectionAccess, ancestors: CollectionAccess[]): string[] {
  const out: string[] = [];
  const set = ancestors.filter((a) => a);
  if (!set.length) return out;
  for (const a of set) {
    if (a.apps !== 'all') {
      if (own.apps === 'all') out.push('The parent applies to chosen apps only; choose among them.');
      else { const extra = own.apps.filter((x) => !(a.apps as string[]).includes(x)); if (extra.length) out.push(`Apps the parent does not apply to: ${extra.join(', ')}.`); }
    }
    if (a.territories.mode === 'allow') {
      if (own.territories.mode !== 'allow') out.push(`The parent applies in ${a.territories.countries.join(', ')} only; choose among them.`);
      else { const extra = own.territories.countries.filter((c) => !a.territories.countries.includes(c)); if (extra.length) out.push(`Territories the parent does not apply in: ${extra.join(', ')}.`); }
    } else if (a.territories.mode === 'block') {
      const back = own.territories.mode === 'block' ? a.territories.countries.filter((c) => !own.territories.countries.includes(c))
        : own.territories.mode === 'allow' ? own.territories.countries.filter((c) => a.territories.countries.includes(c)) : a.territories.countries;
      if (back.length) out.push(`The parent leaves out ${back.join(', ')}; the child cannot apply there.`);
    }
  }
  // Access, country by country: every country any level names, and one that none names.
  const cs = new Set<string>(['ZZ']);
  for (const l of [own, ...set]) for (const r of l.rules) for (const c of r.countries) if (c !== 'WORLD') cs.add(c);
  const lower: string[] = [];
  for (const c of cs) {
    const need = Math.max(...set.map((a) => RANK[levelRule(a, c)?.access ?? 'free']));
    const mine = RANK[levelRule(own, c)?.access ?? 'free'];
    if (mine < need) lower.push(c === 'ZZ' ? 'everywhere else' : c);
  }
  if (lower.length) out.push(`It asks for less than the parent in ${lower.join(', ')}. A child collection can only tighten its parent's access.`);
  return out;
}

// ---------------------------------------------------------------------------
//  The rights cap on a manual add
// ---------------------------------------------------------------------------
export interface AppInfo { id: string; name: string; rightsType: RightsAppType }
/**
 * Why the rights rule this title out of a collection, or null. Refused when the
 * collection applies only to apps the rights exclude, only in territories the
 * rights exclude, or asks for an access type the rights do not allow.
 */
export function rightsConflict(levels: CollectionAccess[], rights: EffectiveRights, apps: AppInfo[]): string | null {
  for (const l of levels) {
    if (l.apps !== 'all') {
      const mine = apps.filter((a) => (l.apps as string[]).includes(a.id));
      if (mine.length && !mine.some((a) => appAllowed(rights, a.rightsType, a.id))) {
        return `The rights do not allow this title in ${mine.map((a) => a.name).join(', ')}, the apps this collection applies to.`;
      }
    }
    if (l.territories.mode === 'allow') {
      const ok = l.territories.countries.some((c) =>
        (rights.territoryMode !== 'allow' || rights.territories.includes(c)) && !(rights.territoryMode === 'block' && rights.territories.includes(c)) && !rights.blockTerritories.includes(c));
      if (!ok) return `The rights do not allow this title in ${l.territories.countries.join(', ')}, the territories this collection applies to.`;
    }
    for (const r of l.rules) {
      if (r.access === 'members' && !accessAllowed(rights, ['members'])) return 'The rights do not allow members-only access, which this collection asks for.';
      if (r.access === 'premium') {
        const kinds = kindsFor({ access: 'premium', packages: [], decidedBy: [], terms: [...(r.terms ?? []), ...Object.values(r.appTerms ?? {}).flat()] });
        if (!accessAllowed(rights, kinds)) return 'The rights do not allow premium access, which this collection asks for.';
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Reading the tree, compiling titles, the queue
// ---------------------------------------------------------------------------
interface Row { id: string; parent_id: string | null; name: string; access: CollectionAccess | null }

/** Collections and every ancestor of them, by id. */
async function withAncestors(ids: string[]): Promise<Map<string, Row>> {
  const rows = ids.length ? await query<Row>(
    `WITH RECURSIVE up AS (SELECT id, parent_id, name, access FROM collections WHERE id = ANY($1::uuid[])
       UNION SELECT c.id, c.parent_id, c.name, c.access FROM collections c JOIN up ON c.id = up.parent_id)
     SELECT DISTINCT ON (id) id, parent_id, name, access FROM up`, [ids]) : [];
  return new Map(rows.map((r) => [String(r.id), r]));
}

/** Root first: the collection's ancestors and itself. */
function chainOf(id: string, byId: Map<string, Row>): Row[] {
  const out: Row[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
  return out;
}

const asksMore = (l: CollectionAccess | null) => !!l?.rules?.some((r) => r.access !== 'free');

/** The ancestors' access, root first (levels that say nothing left out). */
export async function ancestorsOf(collectionId: string, parentId: string | null): Promise<{ id: string; name: string; access: CollectionAccess }[]> {
  if (!parentId) return [];
  const byId = await withAncestors([parentId]);
  return chainOf(parentId, byId).filter((r) => r.access).map((r) => ({ id: r.id, name: r.name, access: r.access! }));
}

/** The levels that govern items of this collection (root first, only those that say something). */
export async function levelsOf(collectionId: string): Promise<Level[]> {
  const byId = await withAncestors([collectionId]);
  return chainOf(collectionId, byId).filter((r) => r.access).map((r) => ({ c: r.id, n: r.name, ...r.access! }));
}

/** Compile what governs these titles from the collections they are in now. */
export async function compileFor(assetIds: string[]): Promise<Map<string, Compiled | null>> {
  const out = new Map<string, Compiled | null>(assetIds.map((id) => [id, null]));
  if (!assetIds.length) return out;
  const mem = await query<{ vod_asset_id: string; collection_id: string }>(
    `SELECT vod_asset_id, collection_id FROM collection_items WHERE vod_asset_id = ANY($1::uuid[])`, [assetIds]);
  const byId = await withAncestors([...new Set(mem.map((m) => String(m.collection_id)))]);
  for (const m of mem) {
    const chain = chainOf(String(m.collection_id), byId);
    const levels: Level[] = chain.filter((r) => r.access).map((r) => ({ c: r.id, n: r.name, ...r.access! }));
    // A chain where no level asks more than free changes nothing: not stored.
    if (!levels.some((l) => asksMore(l))) continue;
    const aid = String(m.vod_asset_id);
    const leaf = chain[chain.length - 1];
    const cur = out.get(aid) ?? { v: 1 as const, g: [] };
    cur.g.push({ c: leaf.id, n: leaf.name, levels });
    out.set(aid, cur);
  }
  return out;
}

/** Compile and store. Only titles whose answer changed are written (each write drops the title's cached row). */
export async function recompileAssets(assetIds: string[]): Promise<{ checked: number; changed: number }> {
  if (!assetIds.length) return { checked: 0, changed: 0 };
  const m = await compileFor(assetIds);
  const rows = [...m.entries()].map(([id, c]) => ({ id, m: c }));
  const r = await query(
    `UPDATE vod_assets v SET collection_access = x.m
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, m jsonb)
      WHERE v.id = x.id AND v.collection_access IS DISTINCT FROM x.m
      RETURNING v.id`, [JSON.stringify(rows)]);
  // The row change is announced to every task (the vod_assets cache trigger);
  // this task drops its own copies now, so an answer given right after a save
  // is already the new one.
  if (r.length) {
    const { invalidateTag } = await import('../scale/cache');
    for (const x of r) invalidateTag(`asset:${(x as any).id}`);
  }
  return { checked: assetIds.length, changed: r.length };
}

/** Queue every title in these collections (an access change, a move). */
export async function enqueueCollections(collectionIds: string[]): Promise<number> {
  if (!collectionIds.length) return 0;
  const r = await query(
    `INSERT INTO collection_access_rechecks(vod_asset_id)
     SELECT DISTINCT vod_asset_id FROM collection_items WHERE collection_id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING RETURNING vod_asset_id`, [collectionIds]);
  return r.length;
}

/** THE QUEUE PASS: a batch of titles (each task its own: SKIP LOCKED), compiled again. */
export async function drainAccessRechecks(batch = 500): Promise<number> {
  const taken = await query<{ vod_asset_id: string }>(
    `DELETE FROM collection_access_rechecks WHERE vod_asset_id IN (
       SELECT vod_asset_id FROM collection_access_rechecks ORDER BY queued_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING vod_asset_id`, [batch]);
  if (!taken.length) return 0;
  await recompileAssets(taken.map((t) => String(t.vod_asset_id)));
  return taken.length;
}

/** Drain until empty or the budget is spent (after a save, so the answer the person sees is current). */
export async function drainFor(budgetMs: number): Promise<number> {
  const t0 = Date.now();
  let n = 0;
  for (;;) {
    const got = await drainAccessRechecks();
    n += got;
    if (!got || Date.now() - t0 > budgetMs) return n;
  }
}

/** The products behind a collection's premium prices: one per productKey, granting the collection. */
export async function syncPackageProducts(accountId: string, collectionId: string, a: CollectionAccess | null): Promise<number> {
  if (!a) return 0;
  let n = 0;
  for (const r of a.rules) {
    if (r.access !== 'premium') continue;
    for (const t of [...(r.terms ?? []), ...Object.values(r.appTerms ?? {}).flat()]) {
      const price = `${(t.priceCents / 100).toFixed(2)} ${t.currency}`;
      const name = t.name ?? (t.kind === 'published_dates' ? `Access while published · ${price}` : `${t.count} ${t.unit}${(t.count ?? 1) === 1 ? '' : 's'} · ${price}`);
      await query(
        `INSERT INTO products(account_id, key, name, term, grants, source_rule)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
         ON CONFLICT (account_id, key) DO UPDATE
           SET name = EXCLUDED.name, term = EXCLUDED.term, grants = EXCLUDED.grants, source_rule = EXCLUDED.source_rule, updated_at = now()`,
        [accountId, t.productKey, name, JSON.stringify(t), JSON.stringify({ collectionIds: [collectionId] }), `collection:${collectionId}`]);
      n++;
    }
  }
  return n;
}

/** Product keys another collection or a rule already sells (a key names one product). */
export async function productKeyClashes(accountId: string, collectionId: string, a: CollectionAccess): Promise<string[]> {
  const keys = [...new Set(a.rules.flatMap((r) => [...(r.terms ?? []), ...Object.values(r.appTerms ?? {}).flat()].map((t) => t.productKey)))];
  if (!keys.length) return [];
  const rows = await query<{ key: string }>(
    `SELECT key FROM products WHERE account_id = $1 AND key = ANY($2::text[]) AND source_rule IS DISTINCT FROM $3`,
    [accountId, keys, `collection:${collectionId}`]);
  return rows.map((r) => r.key);
}

export async function appsOf(accountId: string): Promise<{ id: string; name: string; type: string; surface: string | null }[]> {
  return query(`SELECT id, name, type::text AS type, surface FROM apps WHERE account_id = $1 ORDER BY created_at`, [accountId]);
}

export async function compiledOf(assetId: string): Promise<Compiled | null> {
  return (await one<{ collection_access: Compiled | null }>(`SELECT collection_access FROM vod_assets WHERE id = $1`, [assetId]))?.collection_access ?? null;
}
