// ============================================================================
//  GRAPHICS STATE CHANGES, PUSHED.
//
//  Live control used to ask for the whole graphics state of its channel or
//  event every second, whether anything had changed or not: one request a
//  second per open panel, and still up to a second late. Now every change is
//  announced on the admin status stream (GET /api/status/stream, statusHub.ts)
//  as a `gfx` frame, and the panel re-reads only when one arrives.
//
//  Two sources of change, both covered:
//   - WRITES: the operator, the API, a push or polled feed, a rundown take or
//     cue, the off timer, an assignment or setup edit. Each announces itself
//     the moment its transaction is done (runtime.ts, modules/graphics.ts).
//   - TIME: a rule or trigger graphic goes on or off at a programme boundary,
//     a feed goes stale, with no write at all. The tick (leader, every second)
//     resolves each LIVE stream's graphics and announces the ones whose
//     on/off or values moved since the last tick (watchLive below).
//
//  A frame carries which stream and why, never the values: the stream reaches
//  every admin of the account, and a page re-reads through its own credential,
//  the same rule as the `record` frames. Frames go through publish(), so with
//  several API processes they cross by Postgres NOTIFY like status frames.
// ============================================================================
import { query } from '../../db';
import { publish } from '../statusHub';
import { liveFor, loadTarget } from './runtime';
import { stableJson } from './playerFeed';

export type GfxReason = 'values' | 'air' | 'rundown' | 'feed' | 'assignment' | 'setup' | 'tick';

export interface GfxFrame { kind: 'channel' | 'event'; id: string; reason: GfxReason; assignmentId?: string }

/** Announce that one stream's graphics changed. Never throws: a lost frame is caught up by resync. */
export function publishGfx(acct: string, t: { channelId?: string | null; eventId?: string | null }, reason: GfxReason, assignmentId?: string | null): void {
  const kind = t.eventId ? 'event' : t.channelId ? 'channel' : null;
  if (!kind) return;
  const frame: GfxFrame = { kind, id: (t.eventId ?? t.channelId)!, reason, ...(assignmentId ? { assignmentId } : {}) };
  try { publish(acct, 'gfx', frame); } catch { /* a viewer re-reads on reconnect */ }
}

/** Every stream that shows a graphic from this setup (a setup edit changes them all). */
export async function publishForSetup(acct: string, setupId: string): Promise<void> {
  const rows = await query<any>(`SELECT DISTINCT channel_id, event_id FROM gfx_assignments WHERE account_id = $1 AND setup_id = $2`, [acct, setupId]).catch(() => []);
  for (const r of rows) publishGfx(acct, { channelId: r.channel_id, eventId: r.event_id }, 'setup');
}

/** Every stream that shows a field bound to this data source (a new payload can change its values). */
export async function publishForSource(acct: string, sourceId: string): Promise<void> {
  const rows = await query<any>(
    `SELECT DISTINCT a.channel_id, a.event_id FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id
      WHERE a.account_id = $1 AND s.fields::text LIKE '%' || $2 || '%'`, [acct, sourceId]).catch(() => []);
  for (const r of rows) publishGfx(acct, { channelId: r.channel_id, eventId: r.event_id }, 'feed');
}

/** What a console shows of one stream's graphics: on or off, why, values, staleness. */
export function consoleSignature(items: { id: string; onAir: boolean; enabled: boolean; takenByHand: boolean; values: Record<string, unknown>; staleFeeds: string[]; offAt: unknown }[]): string {
  return stableJson(items.map((i) => [i.id, i.onAir, i.enabled, i.takenByHand, i.values, i.staleFeeds, i.offAt ? new Date(i.offAt as any).getTime() : null]));
}

const lastSig = new Map<string, string>();

/**
 * The time-driven half: resolve each live stream's graphics now and announce
 * the streams whose signature moved. The first sight of a stream only records
 * it (a fresh process has nothing to compare against, and a viewer that just
 * connected has read the state already). Streams that stop being live are
 * forgotten, so the map stays the size of what is on air.
 */
export async function watchLive(now = new Date()): Promise<number> {
  const streams = await query<any>(
    `SELECT DISTINCT a.account_id, a.channel_id, a.event_id FROM gfx_assignments a
       LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN events e ON e.id = a.event_id
      WHERE COALESCE(c.status::text, e.status::text) = 'live'
      LIMIT 2000`);
  const seen = new Set<string>();
  let n = 0;
  for (const s of streams) {
    const key = s.channel_id ?? s.event_id;
    seen.add(key);
    try {
      const target = await loadTarget(s.account_id, { channelId: s.channel_id, eventId: s.event_id });
      const sig = consoleSignature(await liveFor(s.account_id, target, now));
      const prev = lastSig.get(key);
      lastSig.set(key, sig);
      if (prev !== undefined && prev !== sig) { publishGfx(s.account_id, { channelId: s.channel_id, eventId: s.event_id }, 'tick'); n++; }
    } catch (e) {
      console.error('[graphics] live watch failed for', key, (e as Error).message);
    }
  }
  for (const k of [...lastSig.keys()]) if (!seen.has(k)) lastSig.delete(k);
  return n;
}

/** Tests: start from nothing. */
export function resetLiveWatch(): void { lastSig.clear(); }
