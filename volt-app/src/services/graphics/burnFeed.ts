// ============================================================================
//  GRAPHICS BURNED INTO THE VIDEO (build queue 1.10).
//
//  Graphics assigned "Burned into the video" (targets 'burn' or 'both') on a
//  TRANSCODE channel or event are drawn into the encode by the encoder's
//  renderer (volt-encoder/gfx/burn_renderer.js, volt-encoder/bin/gfx_burn.py).
//  This module is the control plane's side of it:
//
//  * burnPlan(): at start, whether the stream burns anything and the REGION
//    the encoder composites: the union of the graphics' boxes on the 1920x1080
//    canvas. The encoder overlays that box only, never the whole canvas: a
//    full transparent canvas cost +32 % encode CPU in the spike, a box +2 to
//    +4 % (SPIKE_live_graphics_burnin.md, section 3).
//  * burnFeed(): what the renderer follows (GET /api/streams/:id/burn-graphics,
//    the ingest token, like timed-events): the graphics and the state NOW. Not
//    snapshots over time, as the player gets: the picture being encoded is the
//    live edge, so "now" is exactly the moment it is drawn on.
//
//  SAME RULES AS THE PLAYER. Published template versions only (a draft can
//  still change or fail its checks), the same resolved values and on/off
//  decision (runtime.liveFor), off-air graphics carry no values, and an ad
//  break that hides graphics takes them off (stream_breaks, as the player's
//  state.adBreak does). Placement is the player's maths (placedBox), so a
//  graphic sits in the same place whether it is drawn in a player or burned.
// ============================================================================
import { one, query } from '../../db';
import { liveFor, loadTarget } from './runtime';

export type Box = [number, number, number, number];
export const CANVAS: [number, number] = [1920, 1080];
/** Room for soft shadows and glows a template draws just outside its declared box. */
const PAD = 8;

export interface Placement { anchor?: string; x?: number; y?: number; scale?: number; layer?: number }
export interface BurnDef { id: string; name: string; url: string; canvas: [number, number]; placement: Placement; bbox: Box | null }

const ORIGIN: Record<string, [number, number]> = {
  top_left: [0, 0], top: [0.5, 0], top_right: [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1],
};

/**
 * Where a graphic draws on the 1920x1080 output canvas. The player's layout
 * (volt-player/src/sdk/overlay.ts) for a 16:9 picture: the template canvas is
 * scaled to fit (s), and the iframe is translated by (x, y) and scaled by
 * `scale` about its anchor. A point p of the template lands at
 * s * (o + t + k * (p - o)), o the anchor point of the template canvas.
 * Without a declared bbox the whole template canvas is assumed.
 */
export function placedBox(d: { canvas: [number, number]; placement?: Placement; bbox?: Box | null }): Box {
  const [cw, ch] = d.canvas;
  const s = Math.min(CANVAS[0] / cw, CANVAS[1] / ch);
  const p = d.placement ?? {};
  const k = Number.isFinite(p.scale as number) && (p.scale as number) > 0 ? (p.scale as number) : 1;
  const [fx, fy] = ORIGIN[p.anchor ?? 'top_left'] ?? [0, 0];
  const ox = fx * cw, oy = fy * ch, tx = Number(p.x) || 0, ty = Number(p.y) || 0;
  const [bx, by, bw, bh] = d.bbox ?? [0, 0, cw, ch];
  const map = (px: number, py: number) => [s * (ox + tx + k * (px - ox)), s * (oy + ty + k * (py - oy))];
  const [x0, y0] = map(bx, by); const [x1, y1] = map(bx + bw, by + bh);
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * The box the encoder composites: every graphic's placed box, padded, joined,
 * kept inside the canvas, on even pixels (the picture is 4:2:0). Null when
 * nothing lands on the canvas.
 */
export function burnRegion(defs: { canvas: [number, number]; placement?: Placement; bbox?: Box | null }[]): Box | null {
  let u: [number, number, number, number] | null = null;
  for (const d of defs) {
    const [x, y, w, h] = placedBox(d);
    const b: [number, number, number, number] = [x - PAD, y - PAD, x + w + PAD, y + h + PAD];
    u = u ? [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])] : b;
  }
  if (!u) return null;
  const x0 = Math.max(0, Math.floor(u[0] / 2) * 2), y0 = Math.max(0, Math.floor(u[1] / 2) * 2);
  const x1 = Math.min(CANVAS[0], Math.ceil(u[2] / 2) * 2), y1 = Math.min(CANVAS[1], Math.ceil(u[3] / 2) * 2);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

const goodBox = (b: any): Box | null => Array.isArray(b) && b.length === 4 && b.every((n: any) => Number.isFinite(Number(n))) && Number(b[2]) > 0 && Number(b[3]) > 0
  ? b.map(Number) as Box : null;
const goodCanvas = (c: any): [number, number] => Array.isArray(c) && c.length === 2 && Number(c[0]) > 0 && Number(c[1]) > 0 ? [Number(c[0]), Number(c[1])] : [1920, 1080];

/** The stream's account, or null if there is no such stream. */
async function accountOf(kind: 'channel' | 'event', id: string): Promise<string | null> {
  const r = await one<any>(`SELECT g.account_id FROM ${kind === 'channel' ? 'channels' : 'events'} x JOIN groups g ON g.id = x.group_id WHERE x.id = $1`, [id]);
  return r?.account_id ?? null;
}

/** The graphics a stream burns: enabled, burn or both, at a PUBLISHED version. */
export async function burnDefs(accountId: string, kind: 'channel' | 'event', id: string): Promise<BurnDef[]> {
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const rows = await query<any>(
    `SELECT a.id, s.name, s.version_id, s.placement, v.manifest->'canvas' AS canvas, v.manifest->'bbox' AS bbox
       FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id
       JOIN gfx_template_versions v ON v.id = s.version_id
      WHERE a.account_id = $1 AND a.${col} = $2 AND a.enabled AND a.targets IN ('burn','both')
        AND v.status = 'published'
      ORDER BY COALESCE((s.placement->>'layer')::int, 2), a.created_at`, [accountId, id]);
  return rows.map((r) => ({ id: r.id, name: r.name, url: `/gfx/${r.version_id}/index.html`,
    canvas: goodCanvas(r.canvas), placement: r.placement ?? {}, bbox: goodBox(r.bbox) }));
}

/**
 * At start: does this stream burn graphics, and where. Null when it burns none
 * (or is not a transcode stream: a package-only stream has no picture of ours
 * to draw on; the assignment API refuses burn there, this is the backstop).
 */
export async function burnPlan(kind: 'channel' | 'event', id: string): Promise<{ region: Box; count: number } | null> {
  const acct = await accountOf(kind, id);
  if (!acct) return null;
  const target = await loadTarget(acct, kind === 'channel' ? { channelId: id } : { eventId: id });
  if (target.workflow !== 'transcode') return null;
  const defs = await burnDefs(acct, kind, id);
  const region = burnRegion(defs);
  return region ? { region, count: defs.length } : null;
}

/** An ad break on now that takes graphics off (an operator's Go to break, a FAST break, a source cue). */
async function hidingBreakNow(kind: 'channel' | 'event', id: string, at: Date): Promise<boolean> {
  const r = await one<any>(
    `SELECT 1 AS x FROM stream_breaks WHERE ${kind === 'channel' ? 'channel_id' : 'event_id'} = $1 AND status <> 'cancelled'
        AND hide_graphics IS NOT FALSE AND starts_at <= $2 AND starts_at + make_interval(secs => duration_ms / 1000.0) > $2 LIMIT 1`,
    [id, at]).catch(() => null);
  return !!r;
}

export interface BurnFeed {
  streamId: string; kind: 'channel' | 'event'; serverTime: number; canvas: [number, number]; region: Box | null; inBreak: boolean
  graphics: BurnDef[]; state: Record<string, { on: boolean; v: Record<string, unknown> }>
}

/** What the renderer draws now. Null when there is no such stream. */
export async function burnFeed(kind: 'channel' | 'event', id: string, at = new Date()): Promise<BurnFeed | null> {
  const acct = await accountOf(kind, id);
  if (!acct) return null;
  const target = await loadTarget(acct, kind === 'channel' ? { channelId: id } : { eventId: id });
  const defs = target.workflow === 'transcode' ? await burnDefs(acct, kind, id) : [];
  const ids = new Set(defs.map((d) => d.id));
  const inBreak = defs.length ? await hidingBreakNow(kind, id, at) : false;
  const state: BurnFeed['state'] = {};
  if (defs.length) {
    for (const i of await liveFor(acct, target, at)) {
      if (!ids.has(i.id)) continue;
      const on = !!i.onAir && !inBreak;
      // Off-air graphics carry no values: nothing to draw, nothing to leak.
      state[i.id] = { on, v: on ? i.values : {} };
    }
  }
  return { streamId: id, kind, serverTime: at.getTime(), canvas: CANVAS, region: burnRegion(defs), inBreak, graphics: defs, state };
}
