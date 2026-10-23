// ============================================================================
//  GRAPHICS FOR VIEWERS' PLAYERS (player overlay, REQ section 13).
//
//  Graphics assigned to show in the player (targets 'player' or 'both') reach
//  viewers through a public feed, not through manifest triggers: scores and
//  clocks change by the second, which manifests are the wrong place for
//  (DESIGN_stream_graphics_triggers.md, "Next graphics").
//
//  IN STEP WITH THE PICTURE. The feed carries the state over time: snapshots,
//  recorded by the scheduler leader whenever a live stream's player graphics
//  change. The player applies the snapshot in force at its playhead's wall
//  clock, so a viewer 40 s behind live sees the score change when the try is
//  scored on their screen, not 40 s before, and a viewer scrubbing back in the
//  DVR sees what was on screen then.
//
//  COST. One feed read per stream per second whatever the audience (the public
//  route caches per stream and window), and one snapshot row per change.
// ============================================================================
import { one, query } from '../../db';
import { liveFor, loadTarget } from './runtime';

export type SnapState = Record<string, { on: boolean; v: Record<string, unknown> }>;

/** Key order does not make a change. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as any).sort().map((k) => JSON.stringify(k) + ':' + stableJson((v as any)[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

/** The player-facing state of a stream's graphics, from liveFor() items. */
export function playerState(items: { id: string; targets: string; enabled: boolean; onAir: boolean; values: Record<string, unknown> }[]): SnapState {
  const out: SnapState = {};
  for (const i of items) {
    if (!i.enabled || (i.targets !== 'player' && i.targets !== 'both')) continue;
    // Off-air graphics carry no values: nothing to leak before it is shown.
    out[i.id] = { on: !!i.onAir, v: i.onAir ? i.values : {} };
  }
  return out;
}

/** The snapshot in force at wall-clock ms t (the last one at or before it). */
export function stateAt<T extends { at: number }>(snaps: T[], t: number): T | null {
  let best: T | null = null;
  for (const s of snaps) if (s.at <= t && (!best || s.at > best.at)) best = s;
  return best;
}

const last = new Map<string, string>();   // stream -> stableJson of the last recorded state (leader memory)

/** Record a snapshot for every live stream with player graphics whose state changed. */
export async function recordSnapshots(now = new Date()): Promise<number> {
  const streams = await query<any>(
    `SELECT DISTINCT a.account_id, a.channel_id, a.event_id FROM gfx_assignments a
       LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN events e ON e.id = a.event_id
      WHERE a.enabled AND a.targets IN ('player','both') AND COALESCE(c.status::text, e.status::text) = 'live'`);
  let n = 0;
  for (const s of streams) {
    const key = s.channel_id ?? s.event_id;
    try {
      const target = await loadTarget(s.account_id, { channelId: s.channel_id, eventId: s.event_id });
      const state = playerState(await liveFor(s.account_id, target, now));
      const json = stableJson(state);
      if (!last.has(key)) {
        const prev = await one<any>(`SELECT state FROM gfx_snapshots WHERE ${s.channel_id ? 'channel_id' : 'event_id'} = $1 ORDER BY at DESC LIMIT 1`, [key]);
        last.set(key, prev ? stableJson(prev.state) : '');
      }
      if (last.get(key) === json) continue;
      await query(`INSERT INTO gfx_snapshots(account_id, channel_id, event_id, at, state) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [s.account_id, s.channel_id, s.event_id, now, JSON.stringify(state)]);
      last.set(key, json);
      n++;
    } catch (e) {
      console.error('[graphics] snapshot failed for', key, (e as Error).message);
    }
  }
  return n;
}

/** Record one stream now (after an operator's change), so the feed does not wait for the tick. */
export async function recordStream(accountId: string, t: { channelId?: string | null; eventId?: string | null }): Promise<void> {
  const key = (t.channelId ?? t.eventId)!;
  try {
    const target = await loadTarget(accountId, t);
    if (!target.live) return;
    const state = playerState(await liveFor(accountId, target));
    const json = stableJson(state);
    const prev = await one<any>(`SELECT state FROM gfx_snapshots WHERE ${t.channelId ? 'channel_id' : 'event_id'} = $1 ORDER BY at DESC LIMIT 1`, [key]);
    if (prev && stableJson(prev.state) === json) return;
    await query(`INSERT INTO gfx_snapshots(account_id, channel_id, event_id, state) VALUES ($1,$2,$3,$4::jsonb)`,
      [accountId, t.channelId ?? null, t.eventId ?? null, JSON.stringify(state)]);
    last.set(key, json);
  } catch { /* the tick catches up within a second */ }
}

export async function pruneSnapshots(keepHours = 48): Promise<number> {
  const r = await query<any>(`WITH d AS (DELETE FROM gfx_snapshots WHERE at < now() - make_interval(hours => $1) RETURNING 1) SELECT count(*)::int AS n FROM d`, [keepHours]);
  return r[0]?.n ?? 0;
}

export interface PlayerGraphicDef {
  id: string; name: string; kind: string; url: string; canvas: [number, number]
  placement: { anchor?: string; x?: number; y?: number; scale?: number; layer?: number }
}
export interface PlayerFeed { streamId: string; serverTime: number; graphics: PlayerGraphicDef[]; snapshots: { at: number; state: SnapState }[] }

/**
 * What a player needs: the graphics it may draw (published template versions
 * only), and the snapshots from the one in force at `since` (its playhead's
 * wall clock, a little earlier) on.
 */
export async function feedFor(accountId: string, kind: 'channel' | 'event', streamId: string, since: number): Promise<PlayerFeed> {
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const defs = await query<any>(
    `SELECT a.id, s.name, t.kind, s.version_id, s.placement, v.manifest->'canvas' AS canvas
       FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id JOIN gfx_templates t ON t.id = s.template_id
       JOIN gfx_template_versions v ON v.id = s.version_id
      WHERE a.account_id = $1 AND a.${col} = $2 AND a.enabled AND a.targets IN ('player','both')
        -- Viewers only ever get a PUBLISHED version. A setup may be trying out a
        -- draft in the console (preview, live control), but a draft can still
        -- change or carry check errors, and the template standard promises that
        -- nothing reaches viewers until it is published. Such a setup is simply
        -- not drawn in players until it is moved to a published version.
        AND v.status = 'published'
      ORDER BY COALESCE((s.placement->>'layer')::int, 2), a.created_at`, [accountId, streamId]);
  const sinceAt = new Date(Math.max(0, since));
  const base = await one<any>(`SELECT at, state FROM gfx_snapshots WHERE ${col} = $1 AND at <= $2 ORDER BY at DESC LIMIT 1`, [streamId, sinceAt]);
  const after = await query<any>(`SELECT at, state FROM gfx_snapshots WHERE ${col} = $1 AND at > $2 ORDER BY at LIMIT 600`, [streamId, sinceAt]);
  const ids = new Set(defs.map((d) => d.id));
  const clean = (s: SnapState): SnapState => Object.fromEntries(Object.entries(s ?? {}).filter(([k]) => ids.has(k)));
  return {
    streamId, serverTime: Date.now(),
    graphics: defs.map((d) => ({
      id: d.id, name: d.name, kind: d.kind, url: `/gfx/${d.version_id}/index.html`,
      canvas: Array.isArray(d.canvas) && d.canvas.length === 2 ? [Number(d.canvas[0]), Number(d.canvas[1])] : [1920, 1080],
      placement: d.placement ?? {},
    })),
    snapshots: [...(base ? [base] : []), ...after].map((r) => ({ at: new Date(r.at).getTime(), state: clean(r.state) })),
  };
}

export async function impressionCounts(accountId: string, assignmentIds: string[], hours = 24): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (!assignmentIds.length) return m;
  for (const r of await query<any>(`SELECT assignment_id, count(*)::int AS n FROM gfx_impressions
      WHERE account_id = $1 AND assignment_id = ANY($2::uuid[]) AND shown_at > now() - make_interval(hours => $3) GROUP BY 1`, [accountId, assignmentIds, hours])) {
    m.set(r.assignment_id, r.n);
  }
  return m;
}
