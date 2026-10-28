// ============================================================================
//  ONE COLLECTOR TASK PER SESSION: ROUTING REPORTS BY SID (build queue 2.11b,
//  QOE_REPORTING.md section 9a).
//
//  The live path (collector.ts) keeps each session's state in memory. With
//  two or more collector tasks behind the load balancer, a player's batches
//  land on whichever task the balancer picks, so each task held a part of
//  the session and wrote its own partial view row with the same id: the live
//  rows were wrong until the day was replayed, and every task held every
//  session it had ever seen a batch of.
//
//  Now every session has one owner. The tasks that take reports list
//  themselves in the analytics database (qoe_collectors: id, address, last
//  heartbeat), and the owner of a session is picked from that list by
//  rendezvous hashing of the account and sid: every task computes the same
//  owner without asking anyone, and a task joining or leaving moves only the
//  sessions it gains or loses, not a reshuffle of the whole audience.
//
//  A task that receives a batch keeps it raw first, as before (the raw store
//  is the record, whichever task wrote it), then derives the rows it owns
//  and forwards the rest to their owners. Forwards are gathered per owner
//  and sent every FORWARD_MS (one request per peer, not one per player
//  POST), signed with a key every task derives from the shared signing
//  secret, and never forwarded again by the receiver. A forward that fails
//  (the owner just died) is derived where it is: that session is split and
//  its rows are provisional until the nightly replay (nightly.ts), exactly
//  as every session was before this. Players are never kept waiting: they
//  have their 204 once the batch is raw.
//
//  Memory per task falls with the task count: each holds only the sessions
//  it owns (about 1/n of the audience).
//
//    QOE_ROUTE            auto (default): route when this task knows its own
//                         address; off: every task derives what it receives
//    QOE_PEER_URL         this task's address for its peers, e.g.
//                         http://10.0.3.7:8080. On ECS it is read from the
//                         task metadata endpoint; on the Mac (one process)
//                         it is unset and nothing here runs.
//    QOE_PEER_SECRET      the forward signing key (default: derived from
//                         JWT_ACCESS_SECRET, which every task already has)
//    QOE_PEER_HEARTBEAT_MS  how often a task renews its entry (5000); an
//                         entry older than three heartbeats is not a member
// ============================================================================
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { config } from '../../config';
import { analyticsPool } from './analyticsDb';
import type { RawRow } from './rawStore';

export const FORWARD_MS = 200;
/** A forward is refused when its signature is older than this (a replayed request). */
export const PEER_SKEW_MS = 60_000;

export interface Member { id: string; url: string }

const selfId = `${hostname().replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40)}-${process.pid}-${randomBytes(3).toString('hex')}`;
let selfUrl: string | null | undefined;
let members: Member[] = [];
let started: Promise<void> | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let sender: ReturnType<typeof setInterval> | null = null;
const outbox = new Map<string, { url: string; batches: Map<string, RawRow[]> }>();
export const routeStats = { local: 0, forwarded: 0, received: 0, forwardFailed: 0, refused: 0, heartbeatFailures: 0, lastError: null as string | null };

const heartbeatMs = () => Math.max(200, Number(process.env.QOE_PEER_HEARTBEAT_MS ?? 5000));
const mode = () => (process.env.QOE_ROUTE ?? 'auto').toLowerCase();

function peerKey(): Buffer {
  const s = process.env.QOE_PEER_SECRET;
  return s ? Buffer.from(s) : createHmac('sha256', config.jwt.accessSecret).update('volt-qoe-peer-v1').digest();
}

/** The signature header of a forward: `<ms>.<hex hmac of ms and body>`. */
export function signPeer(body: string, at = Date.now()): string {
  return `${at}.${createHmac('sha256', peerKey()).update(`${at}.${body}`).digest('hex')}`;
}

export function verifyPeer(header: string | undefined, body: string, now = Date.now()): boolean {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  if (Math.abs(now - Number(m[1])) > PEER_SKEW_MS) return false;
  const want = createHmac('sha256', peerKey()).update(`${m[1]}.${body}`).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** This task's address for its peers: QOE_PEER_URL, or the ECS task's own IP. */
async function ownUrl(): Promise<string | null> {
  if (process.env.QOE_PEER_URL) return process.env.QOE_PEER_URL.replace(/\/+$/, '');
  const meta = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!meta) return null;
  try {
    const r = await fetch(meta, { signal: AbortSignal.timeout(2000) });
    const j: any = await r.json();
    const ip = j?.Networks?.[0]?.IPv4Addresses?.[0];
    return ip ? `http://${ip}:${config.port}` : null;
  } catch { return null; }
}

/**
 * The owner of a session among `list`: the member with the highest hash of
 * its id with the session (rendezvous hashing). The same on every task.
 */
export function ownerOf(acct: string, sid: string, list: Member[] = members): Member | null {
  let best: Member | null = null; let bestScore = '';
  for (const m of list) {
    const s = createHash('sha1').update(m.id).update('\u0001').update(acct).update('\u0001').update(sid).digest('hex');
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

async function heartbeat(): Promise<void> {
  try {
    const p = await analyticsPool();
    await p.query(`INSERT INTO qoe_collectors(id, url, seen_at) VALUES ($1, $2, now())
                   ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, seen_at = now()`, [selfId, selfUrl]);
    const r = await p.query(`SELECT id, url FROM qoe_collectors WHERE seen_at > now() - ($1 || ' milliseconds')::interval ORDER BY id`, [String(heartbeatMs() * 3)]);
    members = r.rows.map((x: any) => ({ id: x.id, url: x.url }));
    // entries gone for a day are tidied by whichever task notices
    if (Math.random() < 0.01) await p.query(`DELETE FROM qoe_collectors WHERE seen_at < now() - interval '1 day'`);
  } catch (e) {
    routeStats.heartbeatFailures++;
    routeStats.lastError = (e as Error).message;
    // Cannot see the list: derive everything here rather than guess an owner.
    members = [];
  }
}

/** Join the list (first report this task takes). Resolves once the list is read; never throws. */
export function startRouting(): Promise<void> {
  if (started) return started;
  started = (async () => {
    if (mode() === 'off') return;
    selfUrl = await ownUrl();
    if (!selfUrl) return;
    await heartbeat();
    beat = setInterval(() => { void heartbeat(); }, heartbeatMs());
    beat.unref?.();
    sender = setInterval(() => { void drainForwards(); }, FORWARD_MS);
    sender.unref?.();
  })().catch((e) => { routeStats.lastError = (e as Error).message; });
  return started;
}

/**
 * Split a batch already kept raw: the rows this task owns come back, the
 * rest are queued for their owners. Without routing, everything is local.
 */
export function route(acct: string, rows: RawRow[], deriveHere: (acct: string, rows: RawRow[]) => void): void {
  if (!selfUrl || members.length < 2) { routeStats.local += rows.length; deriveHere(acct, rows); return; }
  const mine: RawRow[] = [];
  const owners = new Map<string, Member>();
  for (const r of rows) {
    const o = ownerOf(acct, r.sid);
    if (!o || o.id === selfId) { mine.push(r); continue; }
    owners.set(o.id, o);
    let box = outbox.get(o.id);
    if (!box) { box = { url: o.url, batches: new Map() }; outbox.set(o.id, box); }
    const list = box.batches.get(acct) ?? [];
    list.push(r);
    box.batches.set(acct, list);
  }
  if (mine.length) { routeStats.local += mine.length; deriveHere(acct, mine); }
}

let fallback: ((acct: string, rows: RawRow[]) => void) | null = null;
/** Where a forward that could not be delivered is derived (collector.ts ingestReports). */
export function setFallback(f: (acct: string, rows: RawRow[]) => void): void { fallback = f; }

const sending = new Set<Promise<void>>();
/**
 * Send every queued forward, one request per peer. Called every FORWARD_MS;
 * tests call it directly. Resolves once these AND any sends already under
 * way have finished, so "drained" means nothing is still in flight.
 */
export async function drainForwards(): Promise<void> {
  const boxes = [...outbox.entries()];
  outbox.clear();
  const p = sendBoxes(boxes);
  sending.add(p);
  void p.finally(() => sending.delete(p));
  await Promise.all([...sending]);
}

async function sendBoxes(boxes: Array<[string, { url: string; batches: Map<string, RawRow[]> }]>): Promise<void> {
  await Promise.all(boxes.map(async ([, box]) => {
    const batches = [...box.batches.entries()].map(([acct, rows]) => ({ acct, rows }));
    const n = batches.reduce((s, b) => s + b.rows.length, 0);
    const body = JSON.stringify({ from: selfId, batches });
    try {
      const r = await fetch(`${box.url}/api/cmcd/_peer`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-volt-peer': signPeer(body) }, body,
        signal: AbortSignal.timeout(2000),
      });
      if (r.status !== 204) throw new Error(`peer answered ${r.status}`);
      routeStats.forwarded += n;
    } catch (e) {
      // The owner is gone or refusing: derive here (provisional until the replay).
      routeStats.forwardFailed += n;
      routeStats.lastError = (e as Error).message;
      for (const b of batches) fallback?.(b.acct, b.rows);
    }
  }));
}

/** A forward from a peer, already verified: derived here, never forwarded on. */
export function receiveForward(batches: Array<{ acct: string; rows: RawRow[] }>, deriveHere: (acct: string, rows: RawRow[]) => void): number {
  let n = 0;
  for (const b of batches) { deriveHere(b.acct, b.rows); n += b.rows.length; }
  routeStats.received += n;
  return n;
}

/** What routing sees now (collectorState, tests). */
export function routeState() {
  return { self: selfId, url: selfUrl ?? null, members: members.map((m) => m.id), queued: [...outbox.values()].reduce((s, b) => s + [...b.batches.values()].reduce((x, r) => x + r.length, 0), 0), ...routeStats };
}

/** For tests: leave the list and forget everything. */
export async function stopRouting(): Promise<void> {
  if (beat) clearInterval(beat); if (sender) clearInterval(sender);
  beat = sender = null;
  if (selfUrl) { try { const p = await analyticsPool(); await p.query(`DELETE FROM qoe_collectors WHERE id = $1`, [selfId]); } catch { /* gone anyway after three heartbeats */ } }
  started = null; selfUrl = undefined; members = []; outbox.clear();
  Object.assign(routeStats, { local: 0, forwarded: 0, received: 0, forwardFailed: 0, refused: 0, heartbeatFailures: 0, lastError: null });
}
