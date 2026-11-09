// ============================================================================
//  REFUSALS COUNTED FOR THE RIGHTS DEMAND REPORT (build queue P2-3,
//  PUBLISHING_POLICIES.md "Rights demand").
//
//  Every time the play gate answers, and every time the CDN refuses a token
//  (edge 403 in the real-time logs), one call to recordDemand() adds to a
//  counter held in memory: per day, account, title, country, reason and
//  source. Nothing is written on the request path. Once a minute the counters
//  go to the analytics database as additions to a daily rollup
//  (availability_events) plus the set of hashed viewers seen that day
//  (availability_viewers), so a minute with ten thousand refusals of one title
//  in one country is one row update, not ten thousand rows.
//
//  WHY IN MEMORY AND NOT REDIS. The flush only ever adds (ON CONFLICT ... +),
//  so every API task can keep its own minute and write it on its own; the
//  database sees one statement per task per minute either way, and a Redis
//  round trip on the gate's path would cost more than the in-process map.
//
//  WHY POSTGRES EVEN WHEN QOE_STORE=clickhouse. These are already rollups
//  (a few rows per title, country and day), not per-view rows, so they stay
//  small at any audience; the report reads them with one pool.
//
//  PRIVACY. Only the day, account, title, country, reason and a hashed viewer
//  are kept. The viewer key is the signed-in viewer, else the player's
//  session id, else the address and user agent, hashed with a server secret
//  (never stored as given, never an IP address).
//
//  Bounded: at most MAX_KEYS counters and MAX_VIEWERS_PER_KEY hashes per
//  counter in a minute; beyond that requests still count, viewers are dropped
//  and counted in demandStats.dropped.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { analyticsPool } from './qoe/analyticsDb';

export const FLUSH_MS = Math.max(1000, Number(process.env.DEMAND_FLUSH_MS ?? 60_000));
export const MAX_KEYS = 100_000;
export const MAX_VIEWERS_PER_KEY = 50_000;

/** Reasons that count as demand from a place the title is not licensed for. */
export const DEMAND_REASONS = ['geo', 'rights'] as const;
/** Allowed answers: counted as plays, the like-for-like side of the report. */
export const PLAY_REASONS = ['allowed', 'replacement'] as const;
/** Asked for after the title's window closed (the gate answers 404, so nothing leaks). */
export const AFTER_WINDOW_REASONS = ['expired', 'restricted'] as const;
/** Other refusals about the title (kept with their own reason, not demand). */
export const OTHER_REASONS = ['availability', 'payment', 'sign_in', 'group', 'rules', ...AFTER_WINDOW_REASONS] as const;
const KEPT = new Set<string>([...DEMAND_REASONS, ...PLAY_REASONS, ...OTHER_REASONS]);

export type DemandSource = 'gate' | 'edge';
export interface DemandHit {
  accountId: string; assetId: string; assetKind?: string | null; country?: string | null;
  reason: string; source: DemandSource; at?: number;
  /** Who: a viewer id, a session id or address and user agent. Hashed here, never kept as given. */
  viewer?: string | null;
  /** Sampled CDN lines stand for this many requests (100 / sampling rate). */
  weight?: number;
}

interface Counter {
  account_id: string; day: string; asset_id: string; asset_kind: string; country: string; reason: string; source: DemandSource;
  requests: number; viewers: Set<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let counters = new Map<string, Counter>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
export const demandStats = { recorded: 0, ignored: 0, flushes: 0, statements: 0, rowsWritten: 0, dropped: 0, flushFailures: 0, lastError: null as string | null };

const enabled = () => (process.env.VOLT_DEMAND_LOG ?? 'on') !== 'off';
const salt = () => process.env.QOE_ANON_SALT || process.env.JWT_ACCESS_SECRET || 'volt-anon';

/** The stored form of a viewer key: 16 hex characters of a keyed hash, per account. */
export function viewerHash(accountId: string, viewer: string): string {
  return createHash('sha256').update(`${salt()}|${accountId}|${viewer}`).digest('hex').slice(0, 16);
}

/** Note one answer. Never throws, never waits, never touches a database. */
export function recordDemand(h: DemandHit): void {
  try {
    if (!enabled() || !UUID.test(h.accountId) || !UUID.test(h.assetId) || !KEPT.has(h.reason)) { demandStats.ignored++; return; }
    const day = new Date(h.at ?? Date.now()).toISOString().slice(0, 10);
    const country = h.country && /^[A-Za-z]{2}$/.test(h.country) ? h.country.toUpperCase() : '';
    const asset = h.assetId.toLowerCase();
    const k = [h.accountId, day, asset, country, h.reason, h.source].join('|');
    let c = counters.get(k);
    if (!c) {
      if (counters.size >= MAX_KEYS) { demandStats.dropped++; return; }
      c = { account_id: h.accountId, day, asset_id: asset, asset_kind: h.assetKind ?? '', country, reason: h.reason, source: h.source, requests: 0, viewers: new Set() };
      counters.set(k, c);
    }
    c.requests += Math.max(0, h.weight ?? 1);
    if (!c.asset_kind && h.assetKind) c.asset_kind = h.assetKind;
    if (h.viewer) {
      if (c.viewers.size < MAX_VIEWERS_PER_KEY) c.viewers.add(viewerHash(h.accountId, h.viewer));
      else demandStats.dropped++;
    }
    demandStats.recorded++;
    if (!timer) { timer = setInterval(() => { void flushDemand(); }, FLUSH_MS); timer.unref?.(); }
  } catch { /* the gate never fails because of its counts */ }
}

const SCHEMA = `
-- RIGHTS DEMAND (build queue P2-3, services/availabilityDemand.ts). Daily
-- rollups of the play gate's answers and the CDN's token refusals, added to
-- once a minute per API task; never a row per request.
CREATE TABLE IF NOT EXISTS availability_events (
  account_id  UUID NOT NULL,
  day         DATE NOT NULL,
  asset_id    TEXT NOT NULL,             -- on-demand title, channel or event
  asset_kind  TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',  -- '' when unknown
  reason      TEXT NOT NULL,             -- geo | rights | allowed | replacement | availability | payment | sign_in | group | rules | expired | restricted
  source      TEXT NOT NULL,             -- gate | edge
  requests    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- edge lines are sampled: weighted estimate
  PRIMARY KEY (account_id, day, asset_id, country, reason, source)
);
CREATE INDEX IF NOT EXISTS availability_events_day ON availability_events (account_id, day);
-- The hashed viewers behind each day's refusals, so unique viewers over any
-- period are a count of distinct hashes (plays are counted, not kept by viewer).
CREATE TABLE IF NOT EXISTS availability_viewers (
  account_id  UUID NOT NULL,
  day         DATE NOT NULL,
  asset_id    TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL,
  vh          TEXT NOT NULL,
  PRIMARY KEY (account_id, day, asset_id, country, reason, vh)
);
CREATE INDEX IF NOT EXISTS availability_viewers_day ON availability_viewers (account_id, day);
`;

let schemaFor: Pool | null = null;
/** The analytics pool with the two tables made (once per pool). */
export async function demandPool(): Promise<Pool> {
  const p = await analyticsPool();
  if (schemaFor !== p) {
    const c = await p.connect();
    try {
      await c.query(`SELECT pg_advisory_lock(72010002)`);
      await c.query(SCHEMA);
    } finally { await c.query(`SELECT pg_advisory_unlock(72010002)`).catch(() => {}); c.release(); }
    schemaFor = p;
  }
  return p;
}

/** Write what is held: one statement for the counts, one for the viewers (in parts of 5000). Never throws. */
export async function flushDemand(): Promise<void> {
  if (flushing) return flushing;
  if (!counters.size) return;
  flushing = (async () => {
    const held = counters; counters = new Map();
    const rows = [...held.values()];
    try {
      const p = await demandPool();
      for (let i = 0; i < rows.length; i += 5000) {
        const part = rows.slice(i, i + 5000).map(({ viewers, ...r }) => r);
        await p.query(
          `INSERT INTO availability_events (account_id, day, asset_id, asset_kind, country, reason, source, requests)
           SELECT account_id, day, asset_id, asset_kind, country, reason, source, requests
             FROM jsonb_to_recordset($1::jsonb) AS x(account_id uuid, day date, asset_id text, asset_kind text, country text, reason text, source text, requests float8)
           ON CONFLICT (account_id, day, asset_id, country, reason, source) DO UPDATE
             SET requests = availability_events.requests + EXCLUDED.requests,
                 asset_kind = CASE WHEN availability_events.asset_kind = '' THEN EXCLUDED.asset_kind ELSE availability_events.asset_kind END`,
          [JSON.stringify(part)]);
        demandStats.statements++;
      }
      const vs: any[] = [];
      for (const r of rows) for (const vh of r.viewers) vs.push({ account_id: r.account_id, day: r.day, asset_id: r.asset_id, country: r.country, reason: r.reason, vh });
      for (let i = 0; i < vs.length; i += 5000) {
        await p.query(
          `INSERT INTO availability_viewers (account_id, day, asset_id, country, reason, vh)
           SELECT account_id, day, asset_id, country, reason, vh
             FROM jsonb_to_recordset($1::jsonb) AS x(account_id uuid, day date, asset_id text, country text, reason text, vh text)
           ON CONFLICT DO NOTHING`, [JSON.stringify(vs.slice(i, i + 5000))]);
        demandStats.statements++;
      }
      demandStats.flushes++; demandStats.rowsWritten += rows.length; demandStats.lastError = null;
    } catch (e) {
      demandStats.flushFailures++; demandStats.lastError = (e as Error).message;
      // Kept for the next flush: merged back into whatever arrived meanwhile.
      for (const r of rows) {
        const k = [r.account_id, r.day, r.asset_id, r.country, r.reason, r.source].join('|');
        const have = counters.get(k);
        if (!have) { if (counters.size < MAX_KEYS) counters.set(k, r); else demandStats.dropped++; continue; }
        have.requests += r.requests;
        for (const v of r.viewers) if (have.viewers.size < MAX_VIEWERS_PER_KEY) have.viewers.add(v);
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

/** For tests. */
export function resetDemand(): void {
  counters = new Map();
  Object.assign(demandStats, { recorded: 0, ignored: 0, flushes: 0, statements: 0, rowsWritten: 0, dropped: 0, flushFailures: 0, lastError: null });
}
export function demandPending(): number { return counters.size; }

// ---------------------------------------------------------------- the edge

/**
 * An edge refusal from a CloudFront real-time log line: a 403 on a tokenised
 * manifest (`/t/<token>/...m3u8|mpd`). The token's own claims say which title
 * and whose session; the reason is worked out the way the edge decided it.
 * Only a country refusal is demand ("geo"): the token was made for one
 * country and asked for from another. Expired links, bad signatures, revoked
 * titles and segment requests are not counted (a player asks for many
 * segments, an expired link is not a viewer refused, and a withdrawn title is
 * already refused by the gate, which counts it).
 */
export function edgeDemandOf(l: { status: number; path: string; country: string | null; at: number }, verify: (token: string, uri: string, country: string | null, nowSec: number) => { verdict: string; claims?: { a: string; s?: string } }): { assetId: string; reason: 'geo'; sid: string | null } | null {
  if (l.status !== 403 || !/\.(m3u8|mpd)$/i.test(l.path)) return null;
  const m = /^\/t\/([^/]+)(\/.*)$/.exec(l.path);
  if (!m) return null;
  let v: { verdict: string; claims?: { a: string; s?: string } };
  try { v = verify(m[1], m[2], l.country, Math.floor(l.at / 1000)); } catch { return null; }
  if (!v.claims?.a || !UUID.test(v.claims.a)) return null;
  return v.verdict === 'country' ? { assetId: v.claims.a, reason: 'geo', sid: v.claims.s ?? null } : null;
}

// ---------------------------------------------------------------- the report

export interface DemandQuery { from: string; to: string; assetId?: string | null; country?: string | null; kind?: string | null; limit?: number }

const n = (v: unknown) => Math.round(Number(v ?? 0));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The period asked for, as two UTC days: default the last 30 days, at most 400. */
export function demandPeriod(q: { from?: string; to?: string }, now = new Date()): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  const to = q.to && DAY.test(q.to) ? q.to : today;
  const back = (d: string, days: number) => new Date(Date.parse(d + 'T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
  let from = q.from && DAY.test(q.from) ? q.from : back(to, 29);
  if (from > to) from = to;
  if (Date.parse(to) - Date.parse(from) > 399 * 86_400_000) from = back(to, 399);
  return { from, to };
}

/** Where the title may play, in words a table can show, and whether a country is inside it. */
function licensedIn(r: { territoryMode: string; territories: string[]; blockTerritories: string[] } | null, country: string): boolean | null {
  if (!r || !country) return null;
  if (r.territoryMode === 'allow') return r.territories.includes(country) && !r.blockTerritories.includes(country);
  return !r.blockTerritories.includes(country) && !(r.territoryMode === 'block' && r.territories.includes(country));
}

/**
 * THE RIGHTS DEMAND REPORT for one account and period: blocked unique viewers
 * and requests by country and by title, the daily trend, plays (the gate's
 * allowed answers) beside them, demand after a title's window closed, and
 * each title's window and territories. Reads only the daily rollups.
 */
export async function rightsDemandReport(acct: string, q: DemandQuery, deps: {
  titles: (acct: string, ids: string[]) => Promise<Map<string, { title: string; kind: string }>>;
  windowOf: (assetId: string) => Promise<{ status: string; from: Date | null; until: Date | null; rightsFrom: Date | null; rightsUntil: Date | null;
    territoryMode: string; territories: string[]; blockTerritories: string[] } | null>;
}, now = new Date()) {
  const p = await demandPool();
  const where: string[] = ['account_id = $1', 'day BETWEEN $2::date AND $3::date'];
  const args: any[] = [acct, q.from, q.to];
  if (q.assetId) { args.push(q.assetId.toLowerCase()); where.push(`asset_id = $${args.length}`); }
  if (q.country) { args.push(q.country.toUpperCase()); where.push(`country = $${args.length}`); }
  const ewhere = [...where];
  if (q.kind) { args.push(q.kind); ewhere.push(`asset_kind = $${args.length}`); }
  // The viewers table has no kind: narrow it to the titles of that kind seen in the period.
  const vwhere = q.kind ? [...where, `asset_id IN (SELECT DISTINCT asset_id FROM availability_events WHERE ${ewhere.join(' AND ')})`] : where;
  const D = `'${DEMAND_REASONS.join("','")}'`, P = `'${PLAY_REASONS.join("','")}'`, A = `'${AFTER_WINDOW_REASONS.join("','")}'`;
  const sums = `SUM(requests) FILTER (WHERE reason IN (${D})) AS blocked, SUM(requests) FILTER (WHERE reason IN (${P})) AS plays,
                SUM(requests) FILTER (WHERE reason IN (${A})) AS after_window`;
  const E = `FROM availability_events WHERE ${ewhere.join(' AND ')}`;
  const V = `FROM availability_viewers WHERE ${vwhere.join(' AND ')} AND reason IN (${D})`;
  const [tot, totV, byC, byCV, byT, byTV, trend, trendV, other] = await Promise.all([
    p.query(`SELECT ${sums} ${E}`, args),
    p.query(`SELECT COUNT(DISTINCT vh) AS v ${V}`, args),
    p.query(`SELECT country, ${sums} ${E} GROUP BY country`, args),
    p.query(`SELECT country, COUNT(DISTINCT vh) AS v ${V} GROUP BY country`, args),
    p.query(`SELECT asset_id, MAX(asset_kind) AS kind, ${sums} ${E} GROUP BY asset_id`, args),
    p.query(`SELECT asset_id, COUNT(DISTINCT vh) AS v ${V} GROUP BY asset_id`, args),
    p.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, ${sums} ${E} GROUP BY day ORDER BY day`, args),
    p.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, COUNT(DISTINCT vh) AS v ${V} GROUP BY day`, args),
    p.query(`SELECT reason, SUM(requests) AS r ${E} AND reason NOT IN (${D}) AND reason NOT IN (${P}) GROUP BY reason ORDER BY 2 DESC`, args),
  ]);
  const vmap = (rows: any[], k: string) => new Map(rows.map((r) => [r[k], n(r.v)]));
  const cv = vmap(byCV.rows, 'country'), tv = vmap(byTV.rows, 'asset_id'), dv = vmap(trendV.rows, 'day');

  const limit = Math.max(1, Math.min(200, q.limit ?? 50));
  const titlesRanked = byT.rows
    .map((r: any) => ({ assetId: r.asset_id, kind: r.kind || null, blockedViewers: tv.get(r.asset_id) ?? 0, blockedRequests: n(r.blocked), plays: n(r.plays), afterWindowRequests: n(r.after_window) }))
    .filter((t) => t.blockedRequests || t.plays || t.afterWindowRequests)
    .sort((a, b) => b.blockedViewers - a.blockedViewers || b.blockedRequests - a.blockedRequests || b.afterWindowRequests - a.afterWindowRequests || b.plays - a.plays)
    .slice(0, limit);
  const names = await deps.titles(acct, titlesRanked.map((t) => t.assetId));
  const iso = (x: Date | null) => (x ? x.toISOString() : null);
  const byTitle = await Promise.all(titlesRanked.map(async (t) => {
    const nm = names.get(t.assetId);
    const w = (nm?.kind ?? t.kind) === 'vod' ? await deps.windowOf(t.assetId).catch(() => null) : null;
    const state = !w ? null : w.from && now < w.from ? 'upcoming' : w.until && now >= w.until ? 'expired' : 'open';
    return { ...t, title: nm?.title ?? null, kind: nm?.kind ?? t.kind,
      window: w ? { state, status: w.status, from: iso(w.from), until: iso(w.until), rightsFrom: iso(w.rightsFrom), rightsUntil: iso(w.rightsUntil),
        territoryMode: w.territoryMode, territories: w.territories, blockTerritories: w.blockTerritories } : null };
  }));
  // One title asked for: each country says whether it is licensed there, so
  // blocked viewers sit beside plays in licensed places like for like.
  const one = q.assetId ? byTitle.find((t) => t.assetId === q.assetId!.toLowerCase())?.window ?? null : null;
  const byCountry = byC.rows
    .map((r: any) => ({ country: r.country || null, blockedViewers: cv.get(r.country) ?? 0, blockedRequests: n(r.blocked), plays: n(r.plays), afterWindowRequests: n(r.after_window),
      ...(one ? { licensed: licensedIn(one, r.country) } : {}) }))
    .filter((c) => c.blockedRequests || c.plays || c.afterWindowRequests)
    .sort((a, b) => b.blockedViewers - a.blockedViewers || b.blockedRequests - a.blockedRequests || b.plays - a.plays);
  const t0 = tot.rows[0] ?? {};
  return {
    from: q.from, to: q.to,
    filters: { assetId: q.assetId ?? null, country: q.country ? q.country.toUpperCase() : null, kind: q.kind ?? null },
    demandReasons: [...DEMAND_REASONS],
    totals: { blockedViewers: n(totV.rows[0]?.v), blockedRequests: n(t0.blocked), plays: n(t0.plays), afterWindowRequests: n(t0.after_window) },
    byCountry,
    byTitle,
    trend: trend.rows.map((r: any) => ({ day: r.day, blockedViewers: dv.get(r.day) ?? 0, blockedRequests: n(r.blocked), plays: n(r.plays), afterWindowRequests: n(r.after_window) })),
    otherRefusals: other.rows.map((r: any) => ({ reason: r.reason, requests: n(r.r) })),
  };
}

/** The same period by title and country, for a spreadsheet. */
export async function rightsDemandCsv(acct: string, q: DemandQuery, titles: (acct: string, ids: string[]) => Promise<Map<string, { title: string; kind: string }>>): Promise<string> {
  const p = await demandPool();
  const where: string[] = ['account_id = $1', 'day BETWEEN $2::date AND $3::date'];
  const args: any[] = [acct, q.from, q.to];
  if (q.assetId) { args.push(q.assetId.toLowerCase()); where.push(`asset_id = $${args.length}`); }
  if (q.country) { args.push(q.country.toUpperCase()); where.push(`country = $${args.length}`); }
  const ewhere = [...where];
  if (q.kind) { args.push(q.kind); ewhere.push(`asset_kind = $${args.length}`); }
  const D = `'${DEMAND_REASONS.join("','")}'`, P = `'${PLAY_REASONS.join("','")}'`, A = `'${AFTER_WINDOW_REASONS.join("','")}'`;
  const [rows, vs] = await Promise.all([
    p.query(`SELECT asset_id, MAX(asset_kind) AS kind, country,
                    SUM(requests) FILTER (WHERE reason IN (${D})) AS blocked, SUM(requests) FILTER (WHERE reason IN (${P})) AS plays,
                    SUM(requests) FILTER (WHERE reason IN (${A})) AS after_window
               FROM availability_events WHERE ${ewhere.join(' AND ')} GROUP BY asset_id, country ORDER BY asset_id, country`, args),
    p.query(`SELECT asset_id, country, COUNT(DISTINCT vh) AS v FROM availability_viewers WHERE ${where.join(' AND ')} AND reason IN (${D}) GROUP BY asset_id, country`, q.kind ? args.slice(0, -1) : args),
  ]);
  const v = new Map(vs.rows.map((r: any) => [`${r.asset_id}|${r.country}`, n(r.v)]));
  const names = await titles(acct, [...new Set(rows.rows.map((r: any) => r.asset_id as string))]);
  const cell = (x: unknown) => { const s = x == null ? '' : String(x); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  const out = [['from', 'to', 'asset_id', 'title', 'kind', 'country', 'blocked_viewers', 'blocked_requests', 'plays', 'after_window_requests'].join(',')];
  for (const r of rows.rows as any[]) {
    const blocked = n(r.blocked), plays = n(r.plays), after = n(r.after_window);
    if (!blocked && !plays && !after) continue;
    const nm = names.get(r.asset_id);
    out.push([q.from, q.to, r.asset_id, nm?.title ?? '', nm?.kind ?? r.kind ?? '', r.country, v.get(`${r.asset_id}|${r.country}`) ?? 0, blocked, plays, after].map(cell).join(','));
  }
  return out.join('\n') + '\n';
}
