// ============================================================================
//  CONCURRENT STREAMS (build queue P3-4d, PUBLISHING_POLICIES.md Protection).
//
//  A publishing rule's **Concurrent streams** limits how many plays one
//  viewer's account may have open at once. Decided by Christian, 11 Nov 2026:
//    - only signed-in viewers are counted, and only on content that needs a
//      sign-in (members-only and premium titles and channels); free content
//      is never limited, whatever the rule says;
//    - over the limit the OLDEST play is stopped so the new one starts, and
//      the stopped player is told why (the account is playing on too many
//      devices).
//
//  The record of open plays is per viewer: each play attempt (its sid) with
//  what it plays, when it started and when it was last heard from (the play
//  gate, then the player's 30 s heartbeat beacons). A play not heard from for
//  PLAY_TTL_SEC is closed. A stopped play is remembered by its sid for an
//  hour so its heartbeats are answered "stopped" and the gate refuses it if
//  it asks again with the same sid (a token refresh), instead of starting it
//  and stopping the other device in turn. A new play (a new sid) always
//  starts.
//
//  Shared through Valkey when there is one (every API task sees the same
//  plays); per process otherwise, which is right for the single Mac server.
//  Nothing here reads the database, so the warm play gate still makes no
//  database read. A Valkey that fails is not the viewer's problem: the play
//  starts, uncounted.
//
//  AT THE EDGE (build queue P3-4d-2). A player that ignores the stop could
//  carry on with the addresses it already has, so a stopped play is also kept
//  in an edge stop list (sid -> stopped at, epoch seconds) for as long as a
//  play token can live. The control plane's edge sync writes each one to the
//  edge store as "x:<sid>" (services/edgeTokens.ts syncEdgeStops) and removes
//  it when it runs out; the edges refuse a token carrying that sid (its `s`
//  claim) issued at or before the stop. A token issued later (the gate let
//  the same sid in again once its hour as stopped had passed) plays.
// ============================================================================
import { redis, redisHealthy } from '../scale/redis';
import { maxTokenLifetimeSec } from './edgeTokens';

/** A play not heard from for this long is closed (three missed heartbeats). */
export const PLAY_TTL_SEC = 90;
/** How long a stopped play's sid is remembered. */
export const STOPPED_TTL_SEC = 3600;
/** The words a stopped player shows, and the gate's refusal of a stopped sid. */
export const STOPPED_MESSAGE = 'Playback stopped because this account is playing on too many devices.';
export const STOPPED_CODE = 'concurrent_streams';

export interface OpenPlay { sid: string; assetId: string; startedAt: number; lastSeen: number }

const viewerKey = (accountId: string, viewerId: string) => `cs:p:${accountId}:${viewerId}`;
const stoppedKey = (sid: string) => `cs:s:${sid}`;
/** The edge stop list in Valkey: a sorted set, member "<sid> <stopped at>", score = keep until (epoch seconds). */
const EDGE_STOPS_KEY = 'cs:edge';
const edgeStopKey = (sid: string) => `cs:x:${sid}`;
/** A sid the edge store can hold as a key (it is a path segment's claim, so already plain). */
export const EDGE_SID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

// ---- per-process store (no Valkey) -------------------------------------------
const memPlays = new Map<string, Map<string, OpenPlay>>();
const memStopped = new Map<string, number>();   // sid -> expires at (ms)
const memEdgeStops = new Map<string, { at: number; until: number }>();   // sid -> stopped at, keep until (epoch seconds)

/** Valkey when it is configured and connected; null means this process holds the record. */
function client(): any | null {
  return redisHealthy() ? redis() : null;
}

async function readPlays(key: string): Promise<Map<string, OpenPlay>> {
  const r = client();
  if (!r) return new Map(memPlays.get(key) ?? []);
  const raw: Record<string, string> = await r.hgetall(key);
  const out = new Map<string, OpenPlay>();
  for (const [sid, v] of Object.entries(raw ?? {})) { try { out.set(sid, JSON.parse(v)); } catch { /* a bad entry is no play */ } }
  return out;
}

async function writePlay(key: string, p: OpenPlay): Promise<void> {
  const r = client();
  if (!r) { const m = memPlays.get(key) ?? new Map(); m.set(p.sid, p); memPlays.set(key, m); return; }
  await r.hset(key, p.sid, JSON.stringify(p));
  await r.expire(key, STOPPED_TTL_SEC);
}

async function dropPlays(key: string, sids: string[]): Promise<void> {
  if (!sids.length) return;
  const r = client();
  if (!r) { const m = memPlays.get(key); if (m) { for (const s of sids) m.delete(s); if (!m.size) memPlays.delete(key); } return; }
  await r.hdel(key, ...sids);
}

async function markStopped(sid: string, now: number): Promise<void> {
  const at = Math.floor(now / 1000);
  // Kept at the edge as long as a token handed out before the stop can live.
  const until = at + maxTokenLifetimeSec();
  const r = client();
  if (!r) {
    memStopped.set(sid, now + STOPPED_TTL_SEC * 1000);
    if (EDGE_SID_RE.test(sid)) memEdgeStops.set(sid, { at, until });
    return;
  }
  await r.set(stoppedKey(sid), '1', 'EX', STOPPED_TTL_SEC);
  if (EDGE_SID_RE.test(sid)) {
    await r.zadd(EDGE_STOPS_KEY, until, `${sid} ${at}`);
    // One key per sid too, so the API's own token check (every segment on a single server) is one read.
    await r.set(edgeStopKey(sid), String(at), 'EX', until - at);
  }
}

/**
 * The edge stop list: `live` the stopped plays whose tokens the edge must
 * refuse (sid, stopped at), `gone` the sids whose time has run out (every
 * token issued before their stop has expired). No database read.
 */
export async function edgeStops(nowSec = Math.floor(Date.now() / 1000)): Promise<{ live: Array<{ sid: string; at: number }>; gone: string[] }> {
  const r = client();
  if (!r) {
    const live: Array<{ sid: string; at: number }> = [], gone: string[] = [];
    for (const [sid, v] of memEdgeStops) (v.until > nowSec ? live.push({ sid, at: v.at }) : gone.push(sid));
    return { live, gone };
  }
  const parse = (m: string) => { const i = m.lastIndexOf(' '); return { sid: m.slice(0, i), at: Number(m.slice(i + 1)) }; };
  const live = ((await r.zrangebyscore(EDGE_STOPS_KEY, `(${nowSec}`, '+inf')) as string[]).map(parse);
  const gone = ((await r.zrangebyscore(EDGE_STOPS_KEY, '-inf', nowSec)) as string[]).map((m) => parse(m).sid);
  return { live, gone };
}

/** The edge store no longer holds these: drop them from the list. */
export async function forgetEdgeStops(nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  const r = client();
  if (!r) { for (const [sid, v] of memEdgeStops) if (v.until <= nowSec) memEdgeStops.delete(sid); return; }
  await r.zremrangebyscore(EDGE_STOPS_KEY, '-inf', nowSec);
}

/** When this play was stopped (epoch seconds), while the edge must still refuse its old tokens; null otherwise. */
export async function edgeStoppedAt(sid: string | null | undefined, nowSec = Math.floor(Date.now() / 1000)): Promise<number | null> {
  if (!sid || !EDGE_SID_RE.test(sid)) return null;
  try {
    const r = client();
    if (!r) { const v = memEdgeStops.get(sid); return v && v.until > nowSec ? v.at : null; }
    const v = await r.get(edgeStopKey(sid));
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  } catch { return null; }
}

/** Was this play stopped for being over the limit? */
export async function isStopped(sid: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!sid) return false;
  try {
    const r = client();
    if (!r) {
      const until = memStopped.get(sid);
      if (until == null) return false;
      if (until <= now) { memStopped.delete(sid); return false; }
      return true;
    }
    return (await r.exists(stoppedKey(sid))) === 1;
  } catch { return false; }
}

/** The limit a stamp (or resolved settings) sets: a whole number from 1, or null for none. */
export function concurrentLimitOf(settings: any): number | null {
  const n = Number(settings?.protection?.concurrentStreams);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * Does the limit apply to this play? Only to a signed-in viewer let in by a
 * sign-in: a members rule or an entitlement (premium, paid, a package).
 * `via` is the rights decision's rule.via.
 */
export function countedPlay(o: { signedIn: boolean; via: string | null | undefined; limit: number | null }): boolean {
  return !!o.limit && o.signedIn && (o.via === 'members' || o.via === 'entitlement');
}

/**
 * A new play starts. The viewer's open plays are counted (closed ones, not
 * heard from for PLAY_TTL_SEC, are dropped first); while there are more than
 * `limit`, the oldest is stopped. The play asked for always starts. Returns
 * what is open and which sids were stopped.
 */
export async function admitPlay(o: { accountId: string; viewerId: string; sid: string; assetId: string; limit: number; now?: number }):
  Promise<{ open: number; stopped: string[] }> {
  const now = o.now ?? Date.now();
  const key = viewerKey(o.accountId, o.viewerId);
  try {
    const plays = await readPlays(key);
    const closed = [...plays.values()].filter((p) => now - p.lastSeen > PLAY_TTL_SEC * 1000).map((p) => p.sid);
    for (const s of closed) plays.delete(s);
    const mine = plays.get(o.sid);
    const play: OpenPlay = mine ? { ...mine, assetId: o.assetId, lastSeen: now } : { sid: o.sid, assetId: o.assetId, startedAt: now, lastSeen: now };
    plays.set(o.sid, play);
    const stopped: string[] = [];
    const others = [...plays.values()].filter((p) => p.sid !== o.sid).sort((a, b) => a.startedAt - b.startedAt || a.sid.localeCompare(b.sid));
    while (plays.size > o.limit && others.length) {
      const old = others.shift()!;
      plays.delete(old.sid);
      stopped.push(old.sid);
    }
    await dropPlays(key, [...closed, ...stopped]);
    await writePlay(key, play);
    for (const s of stopped) await markStopped(s, now);
    return { open: plays.size, stopped };
  } catch (e: any) {
    console.warn('[concurrent-streams] not counted:', e?.message ?? e);
    return { open: 0, stopped: [] };
  }
}

/** A heartbeat from an open play keeps it open. A play not in the record (stopped, or closed) is not added back. */
export async function touchPlay(accountId: string, viewerId: string, sid: string, now = Date.now()): Promise<void> {
  const key = viewerKey(accountId, viewerId);
  try {
    const plays = await readPlays(key);
    const p = plays.get(sid);
    if (p) await writePlay(key, { ...p, lastSeen: now });
  } catch { /* a missed touch only shortens the play's life */ }
}

/** A play that ended (the player's `end` beacon) no longer counts. */
export async function endPlay(accountId: string, viewerId: string, sid: string): Promise<void> {
  try { await dropPlays(viewerKey(accountId, viewerId), [sid]); } catch { /* it closes on its own */ }
}

/** The viewer's open plays, for tests and support. */
export async function openPlays(accountId: string, viewerId: string, now = Date.now()): Promise<OpenPlay[]> {
  const plays = await readPlays(viewerKey(accountId, viewerId));
  return [...plays.values()].filter((p) => now - p.lastSeen <= PLAY_TTL_SEC * 1000).sort((a, b) => a.startedAt - b.startedAt);
}

/** Tests: forget everything held in this process. */
export function _resetForTests(): void { memPlays.clear(); memStopped.clear(); memEdgeStops.clear(); }
