// ============================================================================
//  A COLLECTION AS A FAST POOL (build queue C3, PUBLISHING_POLICIES.md
//  "Collections, packages and apps").
//
//  A run order slot can take a collection instead of named titles: each time
//  the slot plays it airs the next title of the collection. Which titles of a
//  collection a channel may draw on is worked out here, so the lineup engine
//  (lineup.ts) stays a pure function of the lineup and the library:
//
//    * the collection and everything under it, in the collection's order (the
//      same order as its media list, sub-collections after their parent);
//    * only what the FAST library holds (store.ts libraryFor): rights that
//      allow FAST, a publishing rule that leaves FAST eligible on, not
//      withdrawn, with its window narrowed to the rights window;
//    * only the channel's media (no audio title on a video channel);
//    * only titles that can be seen SOMEWHERE the channel reaches: a channel
//      shown only in Australia and New Zealand does not air a film cleared for
//      the UK alone, which would be the geo replacement for every viewer it
//      has. A title cleared for part of the channel's region stays in: the
//      FAST rights (rights.ts) give the rest of the region the replacement
//      for the length of that programme, as for a title named by hand.
//
//  What is left out is counted with the reason, so the builder can say why a
//  collection of twelve airs nine here.
// ============================================================================
import { query } from '../../db';
import { ORDERS } from '../collectionRules';
import { rightsForAsset } from '../rightsProfiles';
import { channelGeo, type GeoAccess } from '../geoAccess';
import { fastRestriction } from './rights';
import type { Slot } from './lineup';
import type { LibraryAsset, FastMedia } from './store';

export interface PoolReport {
  /** The titles the slot takes turns over, in order. */
  ids: string[];
  /** Members of the collection (and its sub-collections). */
  total: number;
  /** Left out, by reason. */
  left: { media: number; notInLibrary: number; region: number };
  name: string;
}

/**
 * Pure: can a title restricted to `title` be seen anywhere a channel
 * restricted to `channel` is shown? null = everywhere.
 */
export function reachesChannel(title: GeoAccess | null, channel: GeoAccess | null): boolean {
  if (!title) return true;
  if (channel?.mode === 'allow') {
    return title.mode === 'allow'
      ? channel.countries.some((c) => title.countries.includes(c))
      : channel.countries.some((c) => !title.countries.includes(c));
  }
  // a channel shown everywhere (or everywhere but a few countries)
  if (title.mode === 'block') return true;
  const blocked = new Set(channel?.countries ?? []);
  return title.countries.some((c) => !blocked.has(c));
}

/** The collection ids a run order's slots take as pools. */
export function collectionIdsOf(slots: Slot[] | null | undefined): string[] {
  return [...new Set((slots ?? []).flatMap((s) => (s.kind === 'collection' ? [s.collectionId] : [])))];
}

/** Members of a collection and its sub-collections, in the collection's order, each once. */
async function orderedMembers(collectionId: string, orderBy: string | null): Promise<string[]> {
  const order = (ORDERS[orderBy ?? 'manual'] ?? ORDERS.manual).sql.replace('i.position', 'r.position');
  const rows = await query<{ id: string }>(
    `WITH RECURSIVE t AS (SELECT id, ARRAY[sort_order] AS path FROM collections WHERE id = $1
        UNION ALL SELECT c.id, t.path || c.sort_order FROM collections c JOIN t ON c.parent_id = t.id),
      ranked AS (
        SELECT i.vod_asset_id, i.position, i.added_at, t.path,
               row_number() OVER (PARTITION BY i.vod_asset_id ORDER BY t.path, i.position) AS rn
          FROM t JOIN collection_items i ON i.collection_id = t.id)
     SELECT v.id FROM ranked r JOIN vod_assets v ON v.id = r.vod_asset_id
      WHERE r.rn = 1
      ORDER BY r.path, ${order}, r.position, r.added_at`, [collectionId]);
  return rows.map((r) => String(r.id));
}

/**
 * The pool of every collection a run order uses, for one channel. `lib` is
 * the account's FAST library (libraryFor, or airable(libraryFor) when
 * planning onto air). A collection that is not the account's is left out of
 * the answer, which the planner reports as no longer existing.
 */
export async function collectionPoolsFor(
  accountId: string, channelId: string, slots: Slot[] | null | undefined, lib: Map<string, LibraryAsset>,
): Promise<Record<string, PoolReport>> {
  const ids = collectionIdsOf(slots);
  const out: Record<string, PoolReport> = {};
  if (!ids.length) return out;
  const cols = await query<any>(`SELECT id, name, order_by FROM collections WHERE id = ANY($1::uuid[]) AND account_id = $2`,
    [ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)), accountId]);
  if (!cols.length) return out;
  const ch = (await query<any>(`SELECT fast_media, geo_mode, geo_countries FROM channels WHERE id = $1`, [channelId]))[0] ?? {};
  const media: FastMedia = ch.fast_media === 'audio' ? 'audio' : 'video';
  const region = channelGeo(ch);
  for (const c of cols) {
    const members = await orderedMembers(String(c.id), c.order_by ?? null);
    const left = { media: 0, notInLibrary: 0, region: 0 };
    const inLib: string[] = [];
    for (const id of members) {
      const a = lib.get(id);
      if (!a) { left.notInLibrary++; continue; }
      if (a.media !== media) { left.media++; continue; }
      inLib.push(id);
    }
    // the region test reads each title's rights (cached profiles) and its publishing geo
    let kept = inLib;
    if (inLib.length) {
      const rows = await query<any>(
        `SELECT id, rights_profile_id, rights_narrow, created_at, first_aired_at, availability_state, availability
           FROM vod_assets WHERE id = ANY($1::uuid[])`, [inLib]);
      const reach = new Map<string, boolean>();
      for (const r of rows) {
        const fr = fastRestriction(await rightsForAsset(r), r);
        reach.set(String(r.id), !fr.nowhere && reachesChannel(fr.geo, region));
      }
      kept = inLib.filter((id) => reach.get(id) !== false);
      left.region = inLib.length - kept.length;
    }
    out[String(c.id)] = { ids: kept, total: members.length, left, name: String(c.name) };
  }
  return out;
}

/** Just the ids, in the shape the planner takes (Lineup.collections). */
export function poolIds(reports: Record<string, PoolReport>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(reports).map(([k, v]) => [k, v.ids]));
}
