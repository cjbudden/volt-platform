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
//  A re-encode needs the source file. Where it is no longer on this box (an
//  older upload on a replaced task) the asset is reported, not guessed at.
//  Runs on activation and on demand (POST /api/fast/channels/:id/prepare).
// ============================================================================
import { existsSync } from 'node:fs';
import { query } from '../../db';
import type { Slot } from './lineup';
import { episodesOf, type AssetInfo } from './lineup';
import { assetFromRow } from './store';

export type Role = 'content' | 'house' | 'slate';
export interface Readiness {
  assetId: string;
  title: string;
  role: Role;
  state: 'ready' | 'preparing' | 'needs-prepare' | 'no-source';
  why: string | null;
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
  return out;
}

export async function readiness(channelId: string): Promise<Readiness[]> {
  const use = await assetsInUse(channelId);
  if (!use.size) return [];
  const ids = [...use.keys()];
  const rows = await query<any>(`SELECT id, title, metadata, master_key, source_key, encode_result FROM vod_assets WHERE id = ANY($1::uuid[])`, [ids]);
  const busy = new Set((await query<any>(
    `SELECT payload->>'vodAssetId' AS id FROM jobs WHERE type = 'vod.encode' AND state IN ('queued', 'running') AND payload->>'vodAssetId' = ANY($1::text[])`, [ids]))
    .map((r) => String(r.id)));
  return rows.map((r) => {
    const role = use.get(String(r.id))!;
    const er = r.encode_result ?? {};
    const title = String(r.metadata?.title || r.title || 'Untitled');
    const base = { assetId: String(r.id), title, role };
    if (busy.has(String(r.id))) return { ...base, state: 'preparing' as const, why: 'encoding' };
    let why: string | null = null;
    if (!r.master_key) why = 'not packaged yet';
    else if (er.zeroStart !== true) why = 'encoded before audio and video were aligned for splicing';
    else if (role === 'house' && er.loudnorm !== true) why = 'loudness not normalised';
    else if (role === 'slate' && Number(er.segmentSeconds) !== 1) why = 'not in 1 s segments';
    if (!why) return { ...base, state: 'ready' as const, why: null };
    const hasSource = !!r.source_key && existsSync(r.source_key);
    return { ...base, state: hasSource ? 'needs-prepare' as const : 'no-source' as const, why: hasSource ? why : `${why}; the source file is not on this server` };
  }).sort((a, b) => a.state.localeCompare(b.state) || a.title.localeCompare(b.title));
}

/** Queue the encodes that make a channel's assets ready. Returns what was queued. */
export async function prepare(channelId: string): Promise<{ queued: string[]; skipped: Readiness[] }> {
  const list = await readiness(channelId);
  const { enqueue } = await import('../jobs/queue');
  const queued: string[] = [];
  const skipped: Readiness[] = [];
  const rows = new Map((await query<any>(`SELECT id, account_id, source_key FROM vod_assets WHERE id = ANY($1::uuid[])`, [list.map((r) => r.assetId)]))
    .map((r) => [String(r.id), r]));
  for (const r of list) {
    if (r.state === 'no-source') { skipped.push(r); continue; }
    if (r.state !== 'needs-prepare') continue;
    const a = rows.get(r.assetId);
    if (!a) continue;
    await enqueue({
      type: 'vod.encode',
      payload: {
        vodAssetId: r.assetId, accountId: a.account_id, sourcePath: a.source_key, ladderGroupId: null,
        ...(r.role === 'slate' ? { segmentSeconds: 1 } : {}), ...(r.role === 'house' ? { loudnorm: true } : {}),
      },
      dedupeKey: `vod.encode:${r.assetId}`, channelId, maxAttempts: 2,
    });
    queued.push(r.assetId);
  }
  return { queued, skipped };
}
