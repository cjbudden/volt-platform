// ============================================================================
//  SENDING THE AD BEACONS the stitcher owes (beacons.ts says when).
//
//  Each URL is claimed in ad_beacons before it is requested (unique per
//  session, break, ad and event), so a viewer whose refreshes land on two API
//  tasks still reports each pixel once. Then a plain GET, as the IAB asks of
//  server-side reporting: the viewer's address and player in X-Device-IP and
//  X-Device-User-Agent (VAST 4.1, section 2.4.3), our own User-Agent, 5 s at
//  most, redirects followed by hand (3 at most) so every hop is checked.
//
//  PRIVATE ADDRESSES ARE REFUSED. Tracking URLs come from whatever the ad
//  server and its wrappers returned, so a URL pointing into our own network is
//  never fetched (same ranges as the graphics data sources). Set
//  AD_BEACONS_ALLOW_PRIVATE=1 only for a local ad server stub.
//
//  ORDER: one chain per session in this process, events in the order
//  beacons.ts gave them, an event's URLs together. Never on the manifest path:
//  the playlist is answered first and the chain runs after.
//  A tracker that fails is recorded as failed, never retried (a late
//  impression is worse than a missing one for most ad servers).
// ============================================================================
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { query, one } from '../../db';
import { fillBeaconUrl, type DueBeacon } from './beacons';

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^::$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i, /^::ffff:(10|127|192\.168|169\.254|0)\./i];
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

export interface BeaconViewer { channelId: string; sessionId: string; ip?: string | null; userAgent?: string | null }

/** Why a URL may not be fetched, or null when it may. */
export async function refuseUrl(raw: string, allowPrivate = process.env.AD_BEACONS_ALLOW_PRIVATE === '1'): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${u.protocol} is not http or https`;
  if (allowPrivate) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) return `${host} does not resolve`;
  if (addrs.some((a) => PRIVATE.some((re) => re.test(a)))) return 'points at a private network address';
  return null;
}

async function get(url: string, v: BeaconViewer): Promise<{ status: number | null; error: string | null }> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const why = await refuseUrl(at);
    if (why) return { status: null, error: `refused: ${why}` };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'user-agent': 'Volt-SSAI/1.0' };
      if (v.ip) headers['x-device-ip'] = v.ip;
      if (v.userAgent) headers['x-device-user-agent'] = v.userAgent;
      const r = await fetch(at, { method: 'GET', redirect: 'manual', signal: ac.signal, headers });
      await r.arrayBuffer().catch(() => null);
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { at = new URL(loc, at).toString(); continue; }
      return { status: r.status, error: r.status >= 400 ? `answered ${r.status}` : null };
    } catch (e: any) {
      return { status: null, error: e?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000} s` : (e?.cause?.code ?? e?.message ?? String(e)) };
    } finally { clearTimeout(t); }
  }
  return { status: null, error: `more than ${MAX_REDIRECTS} redirects` };
}

/** Send one event's URLs (claimed first). Resolves when every one has an answer. */
async function sendEvent(v: BeaconViewer, b: DueBeacon, nowMs: number): Promise<void> {
  const breakId = b.breakId.replace(/^brk:/, '');
  await Promise.all(b.urls.map(async (raw, urlIndex) => {
    const url = fillBeaconUrl(raw, { nowMs, adPlayheadSec: b.offsetSec });
    const claimed = await one<{ id: string }>(
      `INSERT INTO ad_beacons (channel_id, break_id, session_id, pod_index, ad_id, creative_key, event, url_index, url, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (session_id, break_id, pod_index, event, url_index) DO NOTHING RETURNING id`,
      [v.channelId, breakId, v.sessionId, b.podIndex, b.adId, b.creativeKey, b.event, urlIndex, url, new Date(b.atMs).toISOString()]).catch(() => null);
    if (!claimed) return; // sent (or being sent) by another refresh or task
    const t0 = Date.now();
    const r = await get(url, v);
    await query(`UPDATE ad_beacons SET status = $2, ok = $3, error = $4, elapsed_ms = $5, sent_at = now() WHERE id = $1`,
      [claimed.id, r.status, r.error == null, r.error, Date.now() - t0]).catch(() => null);
  }));
}

const chains = new Map<string, Promise<void>>();

/**
 * Queue a refresh's due beacons behind the session's earlier ones. Returns the
 * promise of this batch (tests wait on it; the stitcher does not).
 */
export function sendBeacons(v: BeaconViewer, due: DueBeacon[], nowMs = Date.now()): Promise<void> {
  if (!due.length) return chains.get(v.sessionId) ?? Promise.resolve();
  const prev = chains.get(v.sessionId) ?? Promise.resolve();
  const next = prev.then(async () => { for (const b of due) await sendEvent(v, b, nowMs).catch(() => null); });
  chains.set(v.sessionId, next);
  next.finally(() => { if (chains.get(v.sessionId) === next) chains.delete(v.sessionId); });
  return next;
}

/** What was reported for a channel's ads since a moment: per event, ads reached and URLs sent and failed. */
export async function beaconReport(channelId: string, since: Date) {
  const rows = await query<any>(
    `SELECT event,
            count(DISTINCT (session_id, break_id, pod_index))::int AS ads,
            count(*) FILTER (WHERE ok)::int AS sent,
            count(*) FILTER (WHERE ok = false)::int AS failed,
            count(*) FILTER (WHERE ok IS NULL)::int AS pending
       FROM ad_beacons WHERE channel_id = $1 AND created_at >= $2 GROUP BY event`, [channelId, since.toISOString()]);
  const by: Record<string, { ads: number; sent: number; failed: number; pending: number }> = {};
  for (const r of rows) by[r.event] = { ads: r.ads, sent: r.sent, failed: r.failed, pending: r.pending };
  const imp = by.impression?.ads ?? 0;
  return {
    events: by,
    impressions: imp,
    completes: by.complete?.ads ?? 0,
    completionRate: imp ? Math.round(((by.complete?.ads ?? 0) / imp) * 1000) / 1000 : null,
    failed: rows.reduce((n, r) => n + r.failed, 0),
  };
}

/** One break's beacons: per ad in the pod, per event, how many viewers reached it, and the latest rows. */
export async function breakBeacons(breakId: string) {
  const per = await query<any>(
    `SELECT pod_index, ad_id, creative_key, event,
            count(DISTINCT session_id)::int AS sessions,
            count(*) FILTER (WHERE ok)::int AS sent, count(*) FILTER (WHERE ok = false)::int AS failed,
            min(due_at) AS first_due
       FROM ad_beacons WHERE break_id = $1 GROUP BY pod_index, ad_id, creative_key, event ORDER BY pod_index, min(due_at), event`, [breakId]);
  const ads = new Map<number, any>();
  for (const r of per) {
    const a = ads.get(r.pod_index) ?? { podIndex: r.pod_index, adId: r.ad_id, creativeKey: r.creative_key, events: {} as Record<string, unknown> };
    a.events[r.event] = { sessions: r.sessions, sent: r.sent, failed: r.failed };
    ads.set(r.pod_index, a);
  }
  const recent = await query<any>(
    `SELECT session_id, pod_index, event, url, status, ok, error, elapsed_ms, due_at, sent_at
       FROM ad_beacons WHERE break_id = $1 ORDER BY id DESC LIMIT 100`, [breakId]);
  return {
    ads: [...ads.values()],
    recent: recent.map((r) => ({ sessionId: r.session_id, podIndex: r.pod_index, event: r.event, host: hostOf(r.url), status: r.status, ok: r.ok, error: r.error, elapsedMs: r.elapsed_ms, dueAt: r.due_at, sentAt: r.sent_at })),
  };
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return null; } };
