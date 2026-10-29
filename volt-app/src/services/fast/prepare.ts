// ============================================================================
//  IS EVERYTHING ON A FAST CHANNEL READY TO AIR? AND MAKE IT SO.
//
//  A title can go on a FAST channel as it is when it is packaged and its audio
//  and video segments line up (encode_result.zeroStart, set by every encode
//  since 20 Oct 2026). House spots also want broadcast loudness, and the slate
//  wants 1 s segments so it can land a break to the second. Readiness says, per
//  asset the channel uses, which of those holds; prepare() queues the encodes
//  that fix what can be fixed:
//
//    content      not zero-start          re-encode from its source
//    house spot   not loudness-normalised re-encode with loudnorm
//    slate        not 1 s segments        re-encode at 1 s
//    any          no packaged media       encode (if the source is here)
//
//  ON A VIDEO CHANNEL WITH A LADDER (services/fast/ladder.ts, 28 Oct 2026)
//  the test is instead "packaged to the channel's ladder": the asset's own
//  encode when it already is (recorded in vod_asset_ladders as 'main'), else a
//  variant encoded beside it (job vod.ladder) with the same per-role rules
//  (1 s slate and loop, broadcast loudness for spots, idents and the loop).
//
//  A re-encode needs the source file. Where it is no longer on this box (an
//  older upload on a replaced task) the asset is reported, not guessed at.
//  Runs on activation and on demand (POST /api/fast/channels/:id/prepare).
// ============================================================================
import { existsSync } from 'node:fs';
import { query } from '../../db';
import type { Slot } from './lineup';
import { episodesOf, type AssetInfo } from './lineup';
import { assetFromRow } from './store';
import { channelLadder, variantsOf, needFor, sameNeed, mainMatches, recordMain, recordQueued, variantRel, fitToTop, sourceQuality, isStale, type ChannelLadder, type Role } from './ladder';

/** ident / loop: the channel's brand (store.ts ChannelBrand). An ident is prepared like a house spot; the brand loop like the slate (it stretches to fill a gap), with normalised loudness. */
export type { Role };
export interface Readiness {
  assetId: string;
  title: string;
  role: Role;
  state: 'ready' | 'preparing' | 'needs-prepare' | 'no-source';
  why: string | null;
  /** Ready from the asset's own encode ('main') or from one made for the channel's ladder ('variant'). */
  packaging?: 'main' | 'variant' | null;
  /** Percent, while it is being packaged. */
  progress?: number | null;
  /** Worth knowing but not blocking (a source below the ladder's top rung). */
  note?: string | null;
  /** The last packaging failed (prepare({auto}) does not retry it on its own). */
  failed?: boolean;
}

/** Every asset a channel's lineups (active and draft), house spots and slate use, by role. */
export async function assetsInUse(channelId: string): Promise<Map<string, Role>> {
  const out = new Map<string, Role>();
  const ls = await query<any>(`SELECT slots, settings, l.channel_id, g.account_id FROM fast_lineups l JOIN channels c ON c.id = l.channel_id JOIN groups g ON g.id = c.group_id
    WHERE l.channel_id = $1 AND l.status IN ('active', 'draft')`, [channelId]);
  const series = new Set<string>();
  for (const l of ls) {
    for (const s of (l.slots ?? []) as Slot[]) {
      if (s.kind === 'title') for (const p of s.pool) { if ('assetId' in p) out.set(p.assetId, 'content'); }
      else if (!s.encoreOf) series.add(s.series);
    }
    for (const b of l.settings?.backfill ?? []) out.set(b, 'content');
  }
  if (series.size && ls.length) {
    const rows = await query<any>(`SELECT id, title, duration_ms, metadata, master_key, available_from, available_until, availability_state, break_cues_ms
      FROM vod_assets WHERE account_id = $1 AND metadata->>'series' IS NOT NULL`, [ls[0].account_id]);
    const lib = new Map<string, AssetInfo>(rows.map((r) => [String(r.id), assetFromRow(r)]));
    for (const name of series) for (const e of episodesOf(name, lib)) out.set(e.id, 'content');
  }
  const ads = await query<any>(`SELECT house_ads, policy FROM channel_ads WHERE channel_id = $1`, [channelId]);
  for (const h of ads[0]?.house_ads ?? []) out.set(h.assetId, 'house');
  if (ads[0]?.policy?.slateAssetId) out.set(ads[0].policy.slateAssetId, 'slate');
  const brand = ads[0]?.policy?.brand;
  if (brand && brand.mode && brand.mode !== 'off') {
    for (const id of Array.isArray(brand.identIds) ? brand.identIds : []) if (!out.has(id)) out.set(id, 'ident');
  }
  // the loop plays in gaps with or without idents (store.ts timelineFor)
  if (brand?.loopAssetId && !out.has(brand.loopAssetId)) out.set(brand.loopAssetId, 'loop');
  return out;
}


/** Encodes in flight for these assets: vod.encode by asset, vod.ladder by asset and variant (with progress). */
async function inFlight(ids: string[]) {
  const rows = await query<any>(
    `SELECT type, payload, progress_pct FROM jobs WHERE type IN ('vod.encode', 'vod.ladder') AND state IN ('queued', 'running') AND payload->>'vodAssetId' = ANY($1::text[])`, [ids]);
  const encode = new Set<string>(), ladder = new Map<string, number | null>();
  for (const r of rows) {
    const p = r.payload ?? {};
    if (r.type === 'vod.encode') encode.add(String(p.vodAssetId));
    else ladder.set(`${p.vodAssetId}|${p.ladderGroupId}|${variantRel(String(p.ladderGroupId), Number(p.segmentSeconds), !!p.loudnorm)}`, r.progress_pct == null ? null : Number(r.progress_pct));
  }
  return { encode, ladder };
}

export async function readiness(channelId: string): Promise<Readiness[]> {
  return (await readinessWithLadder(channelId)).items;
}

/** Readiness, and the ladder it was measured against (null: an audio channel, or no ladder anywhere, so each asset's own encode is checked as before). */
export async function readinessWithLadder(channelId: string): Promise<{ items: Readiness[]; ladder: ChannelLadder | null }> {
  const use = await assetsInUse(channelId);
  const ladder = await channelLadder(channelId);
  if (!use.size) return { items: [], ladder };
  const ids = [...use.keys()];
  const rows = await query<any>(`SELECT id, title, metadata, master_key, source_key, encode_result, ingest, top_height FROM vod_assets WHERE id = ANY($1::uuid[])`, [ids]);
  const busy = await inFlight(ids);
  const variants = ladder ? await variantsOf(ids, ladder.groupId) : [];
  const top = ladder?.rungs[0] ?? null;
  const items: Readiness[] = [];
  for (const r of rows) {
    const id = String(r.id);
    const role = use.get(id)!;
    const title = String(r.metadata?.title || r.title || 'Untitled');
    const base = { assetId: id, title, role, packaging: null as Readiness['packaging'], progress: null as number | null, note: null as string | null };
    const hasSource = !!r.source_key && existsSync(r.source_key);
    if (ladder) {
      const need = needFor(role, ladder);
      const fit = fitToTop(sourceQuality(r), top);
      if (fit.fit === 'below' && role === 'content') base.note = `Below the channel's ladder: ${fit.why}. It is scaled up to fill the top rung.`;
      const key = `${id}|${ladder.groupId}|${variantRel(ladder.groupId, need.segmentSeconds, need.loudnorm)}`;
      if (busy.ladder.has(key)) { items.push({ ...base, state: 'preparing', why: `packaging to ${ladder.groupName}`, progress: busy.ladder.get(key) ?? null }); continue; }
      if (busy.encode.has(id)) { items.push({ ...base, state: 'preparing', why: 'encoding' }); continue; }
      const v = variants.find((x) => String(x.vod_asset_id) === id && sameNeed(x, need));
      const stale = !!v && v.state === 'ready' && isStale(v, ladder);
      if (v?.state === 'ready' && v.master_key && !stale) { items.push({ ...base, state: 'ready', why: null, packaging: v.origin }); continue; }
      if (mainMatches(r, ladder, need)) {
        await recordMain(id, ladder, need, r.master_key);
        items.push({ ...base, state: 'ready', why: null, packaging: 'main' });
        continue;
      }
      const why = stale ? `the ladder ${ladder.groupName} changed since it was packaged (now ${ladder.rungs.map((x) => `${x.height}p`).join(', ')})`
        : v?.state === 'failed'
        ? `packaging to ${ladder.groupName} failed: ${String(v.error ?? 'no reason given').slice(0, 200)}`
        : `not yet packaged to the channel's ladder (${ladder.groupName}: ${ladder.rungs.map((x) => `${x.height}p`).join(', ')}${need.segmentSeconds !== ladder.segmentSeconds ? `, ${need.segmentSeconds} s segments` : ''}${need.loudnorm ? ', broadcast loudness' : ''})`;
      items.push(hasSource
        ? { ...base, state: 'needs-prepare', why, failed: v?.state === 'failed' }
        : { ...base, state: 'no-source', why: `${why}; the source file is not on this server${r.master_key ? ', so it airs on its own encode' : ''}` });
      continue;
    }
    if (busy.encode.has(id)) { items.push({ ...base, state: 'preparing', why: 'encoding' }); continue; }
    const er = r.encode_result ?? {};
    let why: string | null = null;
    if (!r.master_key) why = 'not packaged yet';
    else if (er.zeroStart !== true) why = 'encoded before audio and video were aligned for splicing';
    else if ((role === 'house' || role === 'ident' || role === 'loop') && er.loudnorm !== true) why = 'loudness not normalised';
    else if ((role === 'slate' || role === 'loop') && Number(er.segmentSeconds) !== 1) why = 'not in 1 s segments';
    if (!why) { items.push({ ...base, state: 'ready', why: null, packaging: 'main' }); continue; }
    items.push({ ...base, state: hasSource ? 'needs-prepare' : 'no-source', why: hasSource ? why : `${why}; the source file is not on this server` });
  }
  items.sort((a, b) => a.state.localeCompare(b.state) || a.title.localeCompare(b.title));
  return { items, ladder };
}

/**
 * Queue the encodes that make a channel's assets ready. Returns what was queued.
 * `auto` (a title added, a lineup saved, the slate changed): does not retry a
 * packaging that failed, so a broken source is not re-encoded on every save;
 * the Prepare button does.
 */
export async function prepare(channelId: string, opts: { auto?: boolean } = {}): Promise<{ queued: string[]; skipped: Readiness[]; ladder: { id: string; name: string } | null }> {
  const { items: list, ladder } = await readinessWithLadder(channelId);
  const { enqueue } = await import('../jobs/queue');
  const queued: string[] = [];
  const skipped: Readiness[] = [];
  const rows = new Map((await query<any>(`SELECT id, account_id, source_key FROM vod_assets WHERE id = ANY($1::uuid[])`, [list.map((r) => r.assetId)]))
    .map((r) => [String(r.id), r]));
  for (const r of list) {
    if (r.state === 'no-source') { skipped.push(r); continue; }
    if (r.state !== 'needs-prepare') continue;
    if (opts.auto && r.failed) continue;
    const a = rows.get(r.assetId);
    if (!a) continue;
    if (ladder) {
      const need = needFor(r.role, ladder);
      const job = await enqueue({
        type: 'vod.ladder',
        payload: { vodAssetId: r.assetId, accountId: a.account_id, sourcePath: a.source_key, ladderGroupId: ladder.groupId, segmentSeconds: need.segmentSeconds, loudnorm: need.loudnorm, channelId },
        dedupeKey: `vod.ladder:${r.assetId}:${variantRel(ladder.groupId, need.segmentSeconds, need.loudnorm)}`, channelId, maxAttempts: 2,
        // what goes to air first: content and the slate before spots
        priority: r.role === 'content' || r.role === 'slate' ? 60 : 80,
      });
      await recordQueued(r.assetId, ladder.groupId, need, job?.id ?? null);
    } else {
      await enqueue({
        type: 'vod.encode',
        payload: {
          vodAssetId: r.assetId, accountId: a.account_id, sourcePath: a.source_key, ladderGroupId: null,
          ...(r.role === 'slate' || r.role === 'loop' ? { segmentSeconds: 1 } : {}), ...(r.role === 'house' || r.role === 'ident' || r.role === 'loop' ? { loudnorm: true } : {}),
        },
        dedupeKey: `vod.encode:${r.assetId}`, channelId, maxAttempts: 2,
      });
    }
    queued.push(r.assetId);
  }
  return { queued, skipped, ladder: ladder ? { id: ladder.groupId, name: ladder.groupName } : null };
}
