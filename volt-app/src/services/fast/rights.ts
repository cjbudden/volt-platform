// ============================================================================
//  WHO MAY SEE EACH PROGRAMME OF A FAST CHANNEL, WHERE THEY ARE.
//
//  A FAST channel is one output for every viewer, but the titles in it carry
//  their own rights: a film cleared for Australia and New Zealand only, a
//  series whose FAST rights end on the 30th, a title the rules block in one
//  country. While the channel airs, a viewer outside a title's rights must see
//  the channel's GEO REPLACEMENT (a loop or slate from Loops & Fillers, chosen
//  under Build > Brand & filler) for the length of that programme, and then
//  the channel again.
//
//  This turns the FAST guide into the same programme rights the live channels
//  already have (programmes.geo_mode / geo_countries / replacement), so the
//  whole delivery side is shared: the edge rules and their audience variants
//  (services/edgeRights.ts), the /live route's redirect, and the variant
//  manifest service, which swaps the programme's segments for the
//  replacement's inside each window (services/variantManifest.ts, made FAST
//  aware for this). Nothing is re-encoded and the channel's own output, its
//  recordings and its guide are untouched.
//
//  WHAT A TITLE'S RIGHTS ARE, ON A FAST CHANNEL:
//    * its rights profile (Rights): the FAST use must be allowed, the
//      territories (allow or block list, plus blocked territories), and the
//      rights window (from / until);
//    * the geo of its publishing plan (Publishing Rules), when it has one;
//    * an asset whose access was removed (withdrawn) airs nowhere.
//  Several lists combine to the strictest: every allow list must allow the
//  country, and no block list may name it.
//
//  THE CHANNEL'S OWN RULES come first and are not repeated here: the account's
//  geo and the channel's own "where it can be watched" (channels.geo_mode)
//  decide whether a viewer gets the channel at all (services/geoAccess.ts).
//
//  A window with no geo replacement chosen is enforced as a BLOCK (the viewer
//  is refused for that programme): never show what the rights say a viewer
//  may not see. The FAST page warns when that would happen.
// ============================================================================
import { query, one } from '../../db';
import { normGeo, type GeoAccess } from '../geoAccess';
import { rightsForAsset, type EffectiveRights } from '../rightsProfiles';
import type { ProgrammeRight } from '../edgeRights';

/** What one title allows on a FAST channel. */
export interface FastRestriction {
  /** Nowhere at all: the FAST use is not cleared, or access was removed. */
  nowhere: string | null;
  /** The countries that may (allow) or may not (block) see it; null = everywhere. */
  geo: GeoAccess | null;
  /** The rights window: outside it the title airs nowhere. */
  from: Date | null;
  until: Date | null;
  /** In words, for the console: "allowed in AU, NZ", "blocked in GB". */
  why: string;
}

const up = (c: string) => String(c || '').trim().toUpperCase();

/**
 * Pure: the strictest of several geo lists. Every allow list must allow a
 * country and no block list may name it, so the result is the intersection
 * of the allow lists minus the union of the block lists (an allow list), or
 * the union of the block lists when there is no allow list.
 */
export function combineGeo(lists: (GeoAccess | null | undefined)[]): GeoAccess | null {
  const allows = lists.filter((g): g is GeoAccess => !!g && g.mode === 'allow');
  const blocks = new Set(lists.filter((g): g is GeoAccess => !!g && g.mode === 'block').flatMap((g) => g.countries.map(up)));
  if (allows.length) {
    let set = new Set(allows[0].countries.map(up));
    for (const a of allows.slice(1)) { const next = new Set(a.countries.map(up)); set = new Set([...set].filter((c) => next.has(c))); }
    return { mode: 'allow', countries: [...set].filter((c) => !blocks.has(c)).sort() };
  }
  return blocks.size ? { mode: 'block', countries: [...blocks].sort() } : null;
}

/** Pure: one title's restriction from its rights and its publishing plan. */
export function fastRestriction(rights: EffectiveRights, asset: { availability_state?: string | null; availability?: any }): FastRestriction {
  if (asset.availability_state === 'withdrawn') return { nowhere: 'access to it was removed', geo: null, from: null, until: null, why: 'access removed' };
  if (!rights.uses.includes('fast')) return { nowhere: `its rights (${rights.profileName}) do not allow FAST`, geo: null, from: null, until: null, why: 'not cleared for FAST' };
  const fromRights = rights.territoryMode === 'allow' ? normGeo({ mode: 'allow', countries: rights.territories })
    : rights.territoryMode === 'block' ? normGeo({ mode: 'block', countries: rights.territories }) : null;
  const extraBlock = normGeo({ mode: 'block', countries: rights.blockTerritories });
  const plan = asset.availability?.geo;
  const fromPlan = plan && (plan.mode === 'allow' || plan.mode === 'block') ? normGeo(plan) : null;
  const geo = combineGeo([fromRights, extraBlock, fromPlan]);
  const why = !geo ? 'everywhere' : geo.mode === 'allow'
    ? (geo.countries.length ? `only in ${geo.countries.join(', ')}` : 'nowhere (no country is in every list)')
    : `everywhere except ${geo.countries.join(', ')}`;
  return { nowhere: null, geo, from: rights.from, until: rights.until, why };
}

export interface FastProgramme { id: string; title: string | null; starts_at: Date | string; ends_at: Date | string; assetId: string | null }

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/**
 * Pure: the programme rights a FAST guide gives. A programme whose title is
 * open everywhere gives nothing. Outside the title's rights window, or where
 * the title may air nowhere, the window covers every country (an empty allow
 * list); otherwise the title's countries for the whole programme. With a geo
 * replacement the windows are replaced, else blocked.
 */
export function fastProgrammeRights(progs: FastProgramme[], restrictions: Map<string, FastRestriction>, geoAssetId: string | null): ProgrammeRight[] {
  const out: ProgrammeRight[] = [];
  const rep = geoAssetId ? { replacement_asset_id: geoAssetId, replacement_kind: 'fast_geo', replacement_ref: geoAssetId } : {};
  const push = (p: FastProgramme, from: number, to: number, mode: 'allow' | 'block', countries: string[], part: string) => {
    if (to - from < 1000) return;
    out.push({ id: `${p.id}${part}`, title: p.title, starts_at: new Date(from), ends_at: new Date(to), geo_mode: mode, geo_countries: countries, ...rep });
  };
  for (const p of progs) {
    const r = p.assetId ? restrictions.get(p.assetId) : null;
    if (!r) continue;
    const s = ms(p.starts_at), e = ms(p.ends_at);
    if (!(e > s)) continue;
    if (r.nowhere) { push(p, s, e, 'allow', [], ''); continue; }
    // outside the rights window: nowhere, for that part of the programme
    const open = Math.max(s, r.from ? r.from.getTime() : s), close = Math.min(e, r.until ? r.until.getTime() : e);
    if (close <= open) { push(p, s, e, 'allow', [], ''); continue; }
    if (open > s) push(p, s, open, 'allow', [], ':before');
    if (r.geo) push(p, open, close, r.geo.mode, r.geo.countries, '');
    if (close < e) push(p, close, e, 'allow', [], ':after');
  }
  return out;
}

/** The channel's geo replacement: the library copy made from the Loops & Fillers item (fillerBridge.ts). */
export async function geoReplacementOf(channelId: string): Promise<{ assetId: string; fillerId: string | null } | null> {
  const r = await one<any>(`SELECT policy FROM channel_ads WHERE channel_id = $1`, [channelId]);
  const id = r?.policy?.geoAssetId;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { assetId: id, fillerId: r?.policy?.fillerSources?.[id] ?? null };
}

const memo = new Map<string, { at: number; v: Promise<ProgrammeRight[]> }>();

/**
 * The programme rights of a FAST channel's guide from `nowSec` over the
 * horizon, read from the database. Kept for 15 s: the variant manifest service
 * reads the rules on every playlist request, and a rights or guide change
 * reaches viewers within that.
 */
export function loadFastRights(channelId: string, nowSec: number, horizonSec: number): Promise<ProgrammeRight[]> {
  const k = `${channelId}|${Math.floor(nowSec / 15)}|${horizonSec}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < 15000) return hit.v;
  const v = (async () => {
    const progs = await query<any>(
      `SELECT id, title, starts_at, ends_at, metadata->>'vodAssetId' AS asset_id
         FROM programmes
        WHERE channel_id = $1 AND source_ref LIKE 'fast:%'
          AND ends_at > to_timestamp($2) AND starts_at < to_timestamp($3)
        ORDER BY starts_at LIMIT 400`, [channelId, nowSec, nowSec + horizonSec]);
    const ids = [...new Set(progs.map((p: any) => p.asset_id).filter((x: any) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))];
    if (!ids.length) return [];
    const assets = await query<any>(
      `SELECT id, rights_profile_id, rights_narrow, created_at, first_aired_at, availability_state, availability
         FROM vod_assets WHERE id = ANY($1::uuid[])`, [ids]);
    const restrictions = new Map<string, FastRestriction>();
    for (const a of assets) {
      const r = fastRestriction(await rightsForAsset(a), a);
      if (r.nowhere || r.geo || r.from || r.until) restrictions.set(String(a.id), r);
    }
    if (!restrictions.size) return [];
    const geo = await geoReplacementOf(channelId);
    return fastProgrammeRights(progs.map((p: any) => ({ id: p.id, title: p.title, starts_at: p.starts_at, ends_at: p.ends_at, assetId: p.asset_id })), restrictions, geo?.assetId ?? null);
  })();
  memo.set(k, { at: Date.now(), v });
  if (memo.size > 500) for (const [kk, e] of memo) if (Date.now() - e.at > 15000) memo.delete(kk);
  v.catch(() => memo.delete(k));
  return v;
}

/** For the console: each restricted title on the guide ahead, what it allows, and what viewers elsewhere get. */
export async function fastRightsReport(channelId: string, hours = 48) {
  const nowSec = Math.floor(Date.now() / 1000);
  const progs = await query<any>(
    `SELECT p.id, p.title, p.starts_at, p.ends_at, p.metadata->>'vodAssetId' AS asset_id
       FROM programmes p
      WHERE p.channel_id = $1 AND p.source_ref LIKE 'fast:%'
        AND p.ends_at > now() AND p.starts_at < now() + make_interval(hours => $2)
      ORDER BY p.starts_at LIMIT 400`, [channelId, hours]);
  const ids = [...new Set(progs.map((p: any) => p.asset_id).filter((x: any) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))];
  const assets = ids.length ? await query<any>(
    `SELECT id, title, metadata, rights_profile_id, rights_narrow, created_at, first_aired_at, availability_state, availability
       FROM vod_assets WHERE id = ANY($1::uuid[])`, [ids]) : [];
  const byId = new Map<string, { title: string; r: FastRestriction }>();
  for (const a of assets) {
    const r = fastRestriction(await rightsForAsset(a), a);
    if (r.nowhere || r.geo || r.from || r.until) byId.set(String(a.id), { title: String(a.metadata?.title || a.title || 'Untitled'), r });
  }
  const geo = await geoReplacementOf(channelId);
  const items = progs.filter((p: any) => byId.has(p.asset_id)).map((p: any) => {
    const x = byId.get(p.asset_id)!;
    return {
      programmeId: p.id, title: p.title ?? x.title, assetId: p.asset_id, startsAt: p.starts_at, endsAt: p.ends_at,
      allowed: x.r.nowhere ? `nowhere: ${x.r.nowhere}` : x.r.why,
      window: { from: x.r.from, until: x.r.until },
    };
  });
  void nowSec;
  return { geoReplacement: geo, enforcedAs: geo ? 'replace' : 'block', items };
}
