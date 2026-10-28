// ============================================================================
//  CDN EDGE LOGS: CLOUDFRONT REAL-TIME LOG LINES INTO REPORTING
//  (build queue 2.9, QOE_REPORTING.md sections 3, 5 (report 6), 8 and 9).
//
//  The players we control report what they saw (modules/cmcd.ts). The CDN
//  sees every request, including from players that send no reports at all
//  (a raw stream address opened in a third-party player), so the edge log is
//  the only place those viewers are counted, and the only per-request view of
//  delivery: time to first byte at the edge, origin time on a miss, cache
//  hits, errors, segment throughput.
//
//  WHERE THE LINES COME FROM. CloudFront real-time logs (deploy/terraform/
//  cdn_logs.tf) put one tab-separated line per sampled request on a Kinesis
//  stream; services/qoe/cdnStream.ts reads the stream and hands batches of
//  lines here. Players put CMCD on every playlist and segment request as a
//  query argument (1.14d), so a line carries the session id (`sid`), the
//  object type (`ot`), buffer length and starvation of the player that asked.
//
//  SAMPLED, AND COUNTED AS THE WHOLE. CloudFront logs a percentage of
//  requests (1 to 100). Each line here carries a weight, 100 / the sampling
//  rate it was logged at, so every count and every percentile sketch is an
//  estimate of all requests, not of the sample (sketches take weights, see
//  sketch.ts). The rate is lowered and raised by cdnStream.ts to keep about
//  CDN_LOG_TARGET_LPS lines a second, which is plenty for statistics and caps
//  the cost (design section 9: 100 % at large audiences would cost more than
//  everything else in reporting together).
//
//  RAW FIRST, as for the players' reports: every attributed line is kept in
//  the raw store (stream `cdn`, rawStore.ts) before anything is derived, so a
//  day can be replayed (replayCdnDay) and the join with the players' own
//  response reports (`rr` with the edge request id, done by the replay) can
//  be made after the fact. NO IP ADDRESS IS KEPT: the viewer's address is
//  only used, with the user agent, the content and a secret, to make an
//  anonymous session key for players that send no CMCD session id, and the
//  stored line has the address field blanked.
//
//  WHOSE LINE IS IT. Delivery paths name the stream or asset
//  (`/channel/<id>/...`, `/event/<id>/...`, `/vod/<id>/...`, variant paths
//  `/v/<key>/...` keep it further in): the first uuid in the path is looked
//  up (channels and events through their group, assets directly) and cached.
//  A line nobody owns is counted and dropped.
// ============================================================================
import { createHmac } from 'node:crypto';
import { aquery, analyticsPool } from './analyticsDb';
import { chExec, chInsert, lit } from './clickhouse';
import { forEachTarget, qoeChDatabase, type StoreKind } from './storeSwitch';
import { parseCmcdLine, type CmcdValue } from './cmcdParse';
import { appendRaw, readDay, type RawRow } from './rawStore';
import { deviceClass } from './ua';
import * as sk from './sketch';

/**
 * The fields asked of CloudFront, in the order AWS documents them for
 * real-time logs (the record's fields follow the configuration's order, and
 * keeping that order as AWS lists it means both agree either way).
 * deploy/terraform/cdn_logs.tf sends exactly this list; the suite checks the
 * two match, so they cannot drift apart.
 */
export const CDN_LOG_FIELDS = [
  'timestamp', 'c-ip', 'time-to-first-byte', 'sc-status', 'sc-bytes', 'cs-uri-stem', 'x-edge-location', 'x-edge-request-id',
  'time-taken', 'cs-protocol-version', 'cs-user-agent', 'cs-uri-query', 'x-edge-result-type', 'x-edge-detailed-result-type',
  'c-country', 'origin-fbl', 'origin-lbl', 'asn',
] as const;
const IDX: Record<string, number> = Object.fromEntries(CDN_LOG_FIELDS.map((f, i) => [f, i]));

/** One request at the edge, as read from a line. Times in ms. */
export interface CdnLine {
  at: number;
  ip: string | null;
  ttfbMs: number | null;
  status: number;
  bytes: number;
  path: string;
  pop: string | null;
  requestId: string | null;
  timeMs: number | null;
  ua: string;
  result: string;          // hit | miss | error | other
  shieldHit: boolean;      // answered by Origin Shield, not the origin
  country: string | null;
  originFblMs: number | null;
  asn: string | null;
  cmcd: Record<string, CmcdValue> | null;
  contentId: string | null;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const dash = (v: string | undefined) => (v == null || v === '' || v === '-' ? null : v);
const secs = (v: string | undefined) => { const s = dash(v); if (s == null) return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null; };
function decode(v: string): string { try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; } }

/** The CMCD payload of a request's query string, or null. CloudFront logs the query URL-encoded; the player encoded the value once more. */
export function cmcdOfQuery(q: string | null): Record<string, CmcdValue> | null {
  if (!q) return null;
  let raw: string | null = null;
  for (const part of q.split('&')) {
    const eq = part.indexOf('=');
    const k = decode(eq < 0 ? part : part.slice(0, eq));
    if (k === 'CMCD') { raw = eq < 0 ? '' : part.slice(eq + 1); break; }
  }
  if (raw == null) {
    // A query logged fully encoded (CMCD%3D...): decode once and look again.
    const once = decode(q);
    if (once !== q && /(^|&)CMCD=/.test(once)) return cmcdOfQuery(once);
    return null;
  }
  let v = decode(raw);
  if (/%[0-9A-Fa-f]{2}/.test(v)) v = decode(v);
  if (!v) return null;
  try { return parseCmcdLine(v); } catch { return null; }
}

function resultOf(t: string | null): string {
  if (t === 'Hit' || t === 'RefreshHit') return 'hit';
  if (t === 'Miss') return 'miss';
  if (t === 'Error' || t === 'LimitExceeded' || t === 'CapacityExceeded') return 'error';
  return 'other';
}

/** Read one real-time log line (tab separated, CDN_LOG_FIELDS order). Null when it is not one. */
export function parseCdnLine(line: string): CdnLine | null {
  const f = line.replace(/\r?\n$/, '').split('\t');
  if (f.length < CDN_LOG_FIELDS.length) return null;
  const ts = Number(f[IDX.timestamp]);
  const status = Number(f[IDX['sc-status']]);
  const path = dash(f[IDX['cs-uri-stem']]);
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(status) || !path) return null;
  const q = dash(f[IDX['cs-uri-query']]);
  const cmcd = cmcdOfQuery(q);
  const uuid = UUID.exec(path)?.[0]?.toLowerCase() ?? null;
  const cid = cmcd && typeof cmcd.cid === 'string' && UUID.test(cmcd.cid) ? UUID.exec(cmcd.cid)![0].toLowerCase() : null;
  const cc = dash(f[IDX['c-country']]);
  const detailed = dash(f[IDX['x-edge-detailed-result-type']]);
  return {
    at: Math.round(ts * 1000),
    ip: dash(f[IDX['c-ip']]),
    ttfbMs: secs(f[IDX['time-to-first-byte']]),
    status,
    bytes: Math.max(0, Number(dash(f[IDX['sc-bytes']]) ?? 0) || 0),
    path,
    pop: dash(f[IDX['x-edge-location']]),
    requestId: dash(f[IDX['x-edge-request-id']]),
    timeMs: secs(f[IDX['time-taken']]),
    ua: decode(dash(f[IDX['cs-user-agent']]) ?? '').slice(0, 300),
    result: resultOf(dash(f[IDX['x-edge-result-type']])),
    shieldHit: detailed === 'OriginShieldHit',
    country: cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null,
    originFblMs: secs(f[IDX['origin-fbl']]),
    asn: (() => { const a = dash(f[IDX.asn]); return a && /^\d{1,10}$/.test(a) ? a : null; })(),
    cmcd,
    contentId: uuid ?? cid,
  };
}

/**
 * The session a line belongs to: the CMCD session id when the player sent
 * one, otherwise an anonymous key from the address, user agent and content,
 * keyed with a secret and the day, so it cannot be turned back into an
 * address and does not follow a viewer from one day to the next.
 */
export function sessionKey(l: CdnLine, salt = anonSalt()): { key: string; sid: string | null } {
  const sid = l.cmcd && typeof l.cmcd.sid === 'string' && l.cmcd.sid ? String(l.cmcd.sid).slice(0, 64) : null;
  if (sid) return { key: sid, sid };
  const day = new Date(l.at).toISOString().slice(0, 10);
  const h = createHmac('sha256', salt).update(`${day}|${l.ip ?? ''}|${l.ua}|${l.contentId ?? ''}`).digest('hex').slice(0, 32);
  return { key: 'a:' + h, sid: null };
}
function anonSalt(): string { return process.env.QOE_ANON_SALT || process.env.JWT_ACCESS_SECRET || 'volt-anon'; }

/** The stored copy of a line: the viewer's address blanked, nothing else changed. */
export function storedLine(line: string): string {
  const f = line.replace(/\r?\n$/, '').split('\t');
  if (f.length > IDX['c-ip']) f[IDX['c-ip']] = '-';
  return f.join('\t');
}

// ------------------------------------------------------------- aggregation

/** One minute of edge requests on one content, object type, country and cache result. Counts are estimates of all requests (weighted). */
export interface CdnMinute {
  account_id: string; minute: number; content_id: string; ot: string; country: string; result: string;
  lines: number; requests: number; errors_4xx: number; errors_5xx: number; bytes: number; shield_hits: number;
  starved: number; with_cmcd: number; with_sid: number;
  ttfb_sketch: sk.Sketch; time_sketch: sk.Sketch; origin_sketch: sk.Sketch; kbps_sketch: sk.Sketch;
  joined: number; last_mile_sketch: sk.Sketch;
}
/** One viewing session as the edge saw it, per UTC day. */
export interface CdnSession {
  account_id: string; day: string; skey: string; sid: string | null; content_id: string; first_at: number; last_at: number;
  lines: number; requests: number; country: string | null; device_class: string | null;
}

const MEDIA = new Set(['v', 'a', 'av']);
/** The object type: CMCD's ot when the player said, otherwise from the path. */
export function objectType(l: CdnLine): string {
  const ot = l.cmcd?.ot;
  if (typeof ot === 'string' && /^[a-z]{1,3}$/.test(ot)) return ot;
  if (/\.(m3u8|mpd)$/i.test(l.path)) return 'm';
  if (/init/i.test(l.path)) return 'i';
  if (/\.(vtt|ttml)$/i.test(l.path)) return 'c';
  if (/\.(ts|m4s|mp4|aac|m4a|cmfv|cmfa)$/i.test(l.path)) return 'av';
  return 'o';
}

export class CdnSink {
  minutes = new Map<string, CdnMinute>();
  sessions = new Map<string, CdnSession>();

  add(acct: string, l: CdnLine, w: number, skey: string, sid: string | null): void {
    const minute = Math.floor(l.at / 60_000) * 60_000;
    const ot = objectType(l);
    const content = l.contentId ?? '';
    const country = l.country ?? '';
    const k = [acct, minute, content, ot, country, l.result].join('|');
    let m = this.minutes.get(k);
    if (!m) {
      m = { account_id: acct, minute, content_id: content, ot, country, result: l.result, lines: 0, requests: 0, errors_4xx: 0, errors_5xx: 0, bytes: 0,
        shield_hits: 0, starved: 0, with_cmcd: 0, with_sid: 0, ttfb_sketch: {}, time_sketch: {}, origin_sketch: {}, kbps_sketch: {}, joined: 0, last_mile_sketch: {} };
      this.minutes.set(k, m);
    }
    m.lines += 1;
    m.requests += w;
    if (l.status >= 400 && l.status < 500) m.errors_4xx += w;
    if (l.status >= 500) m.errors_5xx += w;
    m.bytes += l.bytes * w;
    if (l.shieldHit) m.shield_hits += w;
    if (l.cmcd) { m.with_cmcd += w; if (l.cmcd.bs === true) m.starved += w; }
    if (sid) m.with_sid += w;
    if (l.ttfbMs != null) sk.add(m.ttfb_sketch, l.ttfbMs, w);
    if (l.timeMs != null) sk.add(m.time_sketch, l.timeMs, w);
    if (l.result === 'miss' && l.originFblMs != null) sk.add(m.origin_sketch, l.originFblMs, w);
    // Segment throughput as the edge delivered it: only for media objects
    // big enough that the time is transfer, not a round trip.
    if (MEDIA.has(ot) && l.status < 400 && l.timeMs && l.timeMs > 0 && l.bytes >= 50_000) sk.add(m.kbps_sketch, (l.bytes * 8) / l.timeMs, w);

    const day = new Date(l.at).toISOString().slice(0, 10);
    const sk2 = acct + '|' + day + '|' + skey;
    let s = this.sessions.get(sk2);
    if (!s) {
      s = { account_id: acct, day, skey, sid, content_id: content, first_at: l.at, last_at: l.at, lines: 0, requests: 0, country: l.country,
        device_class: l.ua ? deviceClass(l.ua) : null };
      this.sessions.set(sk2, s);
    }
    s.first_at = Math.min(s.first_at, l.at); s.last_at = Math.max(s.last_at, l.at);
    s.lines += 1; s.requests += w;
    if (!s.content_id && content) s.content_id = content;
  }

  /** A player's response report matched to the edge's line by request id: the last mile is what the player waited beyond the edge's own first byte. */
  join(acct: string, l: CdnLine, playerTtfbMs: number): void {
    const minute = Math.floor(l.at / 60_000) * 60_000;
    const k = [acct, minute, l.contentId ?? '', objectType(l), l.country ?? '', l.result].join('|');
    const m = this.minutes.get(k);
    if (!m) return;
    m.joined += 1;
    if (l.ttfbMs != null) sk.add(m.last_mile_sketch, Math.max(0, playerTtfbMs - l.ttfbMs));
  }

  take(): { minutes: CdnMinute[]; sessions: CdnSession[] } {
    const out = { minutes: [...this.minutes.values()], sessions: [...this.sessions.values()] };
    this.minutes = new Map(); this.sessions = new Map();
    return out;
  }
}

// ------------------------------------------------------------------ writes

const iso = (ms: number) => new Date(ms).toISOString();
const CHUNK = 2000;
type Q = { query: (t: string, p: any[]) => Promise<any> };
const M_KEY = ['account_id', 'minute', 'content_id', 'ot', 'country', 'result'];
const M_ADD = ['lines', 'requests', 'errors_4xx', 'errors_5xx', 'bytes', 'shield_hits', 'starved', 'with_cmcd', 'with_sid', 'joined'];
const M_SK = ['ttfb_sketch', 'time_sketch', 'origin_sketch', 'kbps_sketch', 'last_mile_sketch'];

/** Add minute rows into what is there (several flushes and consumers merge). */
export async function addCdnMinutes(rows: CdnMinute[], client?: Q, target?: StoreKind): Promise<void> {
  if (!rows.length) return;
  if (client) return pgAddCdnMinutes(rows, client);
  await forEachTarget({ clickhouse: () => chAddCdnMinutes(rows), postgres: () => pgAddCdnMinutes(rows) }, target);
}

/** ClickHouse: the rows add into the minute (AggregatingMergeTree, clickhouse.ts). */
function chAddCdnMinutes(rows: CdnMinute[]): Promise<void> {
  return chInsert('qoe_cdn_minutes', rows.map((m) => { const o: any = { ...m, minute: iso(m.minute) }; for (const k of M_SK) o[k] = o[k] ?? {}; return o; }), qoeChDatabase(), { additive: true });
}

async function pgAddCdnMinutes(rows: CdnMinute[], client?: Q): Promise<void> {
  const c = client ?? await analyticsPool();
  const cols = [...M_KEY, ...M_ADD, ...M_SK];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map((m) => ({ ...m, minute: iso(m.minute) }));
    await c.query(
      `INSERT INTO qoe_cdn_minutes (${cols.join(',')})
       SELECT ${cols.join(',')} FROM jsonb_populate_recordset(NULL::qoe_cdn_minutes, $1::jsonb)
       ON CONFLICT (${M_KEY.join(',')}) DO UPDATE SET
         ${M_ADD.map((k) => `${k} = qoe_cdn_minutes.${k} + EXCLUDED.${k}`).join(', ')},
         ${M_SK.map((k) => `${k} = qoe_jsonb_add(qoe_cdn_minutes.${k}, EXCLUDED.${k})`).join(', ')}`,
      [JSON.stringify(part)]);
  }
}

/** Merge sessions: first and last seen widen, counts add. */
export async function addCdnSessions(rows: CdnSession[], client?: Q, target?: StoreKind): Promise<void> {
  if (!rows.length) return;
  if (client) return pgAddCdnSessions(rows, client);
  await forEachTarget({ clickhouse: () => chAddCdnSessions(rows), postgres: () => pgAddCdnSessions(rows) }, target);
}

/** ClickHouse: first and last seen widen (min, max), counts add, the first known content, country and device stay (any). */
function chAddCdnSessions(rows: CdnSession[]): Promise<void> {
  return chInsert('qoe_cdn_sessions', rows.map((x) => ({ ...x, content_id: x.content_id || null, first_at: iso(x.first_at), last_at: iso(x.last_at) })), qoeChDatabase(), { additive: true });
}

async function pgAddCdnSessions(rows: CdnSession[], client?: Q): Promise<void> {
  const c = client ?? await analyticsPool();
  const cols = ['account_id', 'day', 'skey', 'sid', 'content_id', 'first_at', 'last_at', 'lines', 'requests', 'country', 'device_class'];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map((s) => ({ ...s, first_at: iso(s.first_at), last_at: iso(s.last_at) }));
    await c.query(
      `INSERT INTO qoe_cdn_sessions (${cols.join(',')})
       SELECT ${cols.join(',')} FROM jsonb_populate_recordset(NULL::qoe_cdn_sessions, $1::jsonb)
       ON CONFLICT (account_id, day, skey) DO UPDATE SET
         first_at = LEAST(qoe_cdn_sessions.first_at, EXCLUDED.first_at), last_at = GREATEST(qoe_cdn_sessions.last_at, EXCLUDED.last_at),
         lines = qoe_cdn_sessions.lines + EXCLUDED.lines, requests = qoe_cdn_sessions.requests + EXCLUDED.requests,
         content_id = COALESCE(NULLIF(qoe_cdn_sessions.content_id, ''), EXCLUDED.content_id),
         country = COALESCE(qoe_cdn_sessions.country, EXCLUDED.country), device_class = COALESCE(qoe_cdn_sessions.device_class, EXCLUDED.device_class)`,
      [JSON.stringify(part)]);
  }
}

// ---------------------------------------------------------------- the path

export interface CdnDeps {
  /** The account that owns a stream or asset id, or null. */
  accountOf(contentId: string): Promise<string | null>;
}

export const cdnStats = { lines: 0, kept: 0, unreadable: 0, unattributed: 0, flushFailures: 0, lastError: null as string | null };
let sink = new CdnSink();

/** The control plane's lookup, cached: a stream's account does not change while it streams. */
export function dbAccountOf(): CdnDeps['accountOf'] {
  const cache = new Map<string, { a: string | null; at: number }>();
  return async (id) => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.a;
    const { one } = await import('../../db');
    const r = await one<any>(
      `SELECT COALESCE(
         (SELECT g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1),
         (SELECT g.account_id FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1),
         (SELECT COALESCE(g.account_id, v.account_id) FROM vod_assets v
             LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
             LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id) WHERE v.id = $1)) AS account_id`, [id]);
    const a = r?.account_id ?? null;
    if (cache.size > 50_000) cache.clear();
    cache.set(id, { a, at: Date.now() });
    return a;
  };
}

/**
 * A batch of log lines logged at `rate` percent: kept raw per account first,
 * then added to the live minute and session aggregates (written by
 * flushCdn). Resolves once the raw copy is kept, so the caller may then
 * record how far it has read.
 */
export async function handleCdnLines(lines: string[], rate: number, deps: CdnDeps, now = Date.now()): Promise<{ kept: number; unreadable: number; unattributed: number }> {
  const w = 100 / Math.max(1, Math.min(100, rate || 100));
  const byAcct = new Map<string, Array<{ l: CdnLine; raw: RawRow; skey: string; sid: string | null }>>();
  let unreadable = 0, unattributed = 0;
  for (const text of lines) {
    if (!text.trim()) continue;
    cdnStats.lines++;
    const l = parseCdnLine(text);
    if (!l) { unreadable++; continue; }
    const acct = l.contentId ? await deps.accountOf(l.contentId) : null;
    if (!acct) { unattributed++; continue; }
    const { key, sid } = sessionKey(l);
    const raw: RawRow = { rt: now, app: null, sid: key, e: 'cdn', line: storedLine(text), w };
    (byAcct.get(acct) ?? byAcct.set(acct, []).get(acct)!).push({ l, raw, skey: key, sid });
  }
  let kept = 0;
  for (const [acct, items] of byAcct) {
    await appendRaw(acct, items.map((x) => x.raw), 'cdn');
    for (const x of items) sink.add(acct, x.l, w, x.skey, x.sid);
    kept += items.length;
  }
  cdnStats.kept += kept; cdnStats.unreadable += unreadable; cdnStats.unattributed += unattributed;
  return { kept, unreadable, unattributed };
}

/** Write what is held; a failed write is kept for the next flush. */
export async function flushCdn(): Promise<void> {
  const { minutes, sessions } = sink.take();
  try {
    await addCdnMinutes(minutes);
    await addCdnSessions(sessions);
    cdnStats.lastError = null;
  } catch (e) {
    cdnStats.flushFailures++; cdnStats.lastError = (e as Error).message;
    // Put them back: the next flush merges them with what came since.
    for (const m of minutes) { const k = [m.account_id, m.minute, m.content_id, m.ot, m.country, m.result].join('|'); const have = sink.minutes.get(k); if (!have) sink.minutes.set(k, m); else mergeMinute(have, m); }
    for (const s of sessions) { const k = s.account_id + '|' + s.day + '|' + s.skey; const have = sink.sessions.get(k); if (!have) sink.sessions.set(k, s); else { have.first_at = Math.min(have.first_at, s.first_at); have.last_at = Math.max(have.last_at, s.last_at); have.lines += s.lines; have.requests += s.requests; } }
  }
}
function mergeMinute(a: CdnMinute, b: CdnMinute) {
  for (const k of M_ADD) (a as any)[k] += (b as any)[k];
  for (const k of M_SK) sk.merge((a as any)[k], (b as any)[k]);
}

/** For tests. */
export function resetCdn(): void { sink = new CdnSink(); Object.assign(cdnStats, { lines: 0, kept: 0, unreadable: 0, unattributed: 0, flushFailures: 0, lastError: null }); }

// ------------------------------------------------------------------ replay

const shift = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Rebuild one account's CDN minutes and sessions for one UTC day from the
 * raw lines, and make the join the live path cannot: each player response
 * report (`rr`) carrying the edge request id (com.volt-cfid) is matched to
 * the edge's line for the same request, giving the last mile (what the
 * player waited beyond the edge's own first byte). Replaces the day in one
 * transaction; idempotent.
 */
export async function replayCdnDay(acct: string, day: string, target?: StoreKind): Promise<{ lines: number; minuteRows: number; sessions: number; joined: number }> {
  // Raw partitions are by the day a line ARRIVED; a request just before
  // midnight can arrive after it, so the next day's partition is read too
  // and only the day's own requests are kept below.
  const raw: RawRow[] = [];
  for (const d of [day, shift(day, 1)]) raw.push(...await readDay(acct, d, undefined, 'cdn'));
  const s = new CdnSink();
  const parsed: Array<{ l: CdnLine }> = [];
  const dayStart = Date.parse(day + 'T00:00:00Z');
  for (const r of raw) {
    const l = parseCdnLine(r.line);
    if (!l || l.at < dayStart || l.at >= dayStart + 86_400_000) continue;
    const sid = r.sid.startsWith('a:') ? null : r.sid;
    s.add(acct, l, Number(r.w) || 1, r.sid, sid);
    parsed.push({ l });
  }
  // The players' response reports of that day and the next (a report sent late).
  const byReq = new Map<string, number>();
  if (parsed.length) {
    for (const d of [day, shift(day, 1)]) {
      for (const r of await readDay(acct, d, (x) => x.e === 'rr')) {
        try {
          const c = parseCmcdLine(r.line);
          const id = c['com.volt-cfid'];
          const t = c.ttfb;
          if (typeof id === 'string' && typeof t === 'number') byReq.set(id, t);
        } catch { /* refused at intake already */ }
      }
    }
  }
  let joined = 0;
  for (const { l } of parsed) {
    const t = l.requestId ? byReq.get(l.requestId) : undefined;
    if (t != null) { s.join(acct, l, t); joined++; }
  }
  const { minutes, sessions } = s.take();
  const dayMinutes = minutes.filter((m) => m.minute >= dayStart && m.minute < dayStart + 86_400_000), daySessions = sessions.filter((x) => x.day === day);
  await forEachTarget({
    clickhouse: async () => {
      // No transactions in ClickHouse: this account's day out, the rebuilt one in (store.ts replaceDay says why that is enough).
      const db = qoeChDatabase();
      await chExec(`DELETE FROM qoe_cdn_minutes WHERE account_id = ${lit(acct)} AND minute >= ${lit(new Date(dayStart))} AND minute < ${lit(new Date(dayStart + 86_400_000))}`, db);
      await chExec(`DELETE FROM qoe_cdn_sessions WHERE account_id = ${lit(acct)} AND day = toDate(${lit(day)})`, db);
      await chAddCdnMinutes(dayMinutes);
      await chAddCdnSessions(daySessions);
    },
    postgres: async () => {
      const p = await analyticsPool();
      const c = await p.connect();
      try {
        await c.query('BEGIN');
        await c.query(`DELETE FROM qoe_cdn_minutes WHERE account_id = $1 AND minute >= ($2::date)::timestamp AT TIME ZONE 'UTC' AND minute < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`, [acct, day]);
        await c.query(`DELETE FROM qoe_cdn_sessions WHERE account_id = $1 AND day = $2::date`, [acct, day]);
        await pgAddCdnMinutes(dayMinutes, c);
        await pgAddCdnSessions(daySessions, c);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
  }, target);
  return { lines: parsed.length, minuteRows: minutes.length, sessions: sessions.length, joined };
}

/** The sessions the edge saw in a window, and how many of them reported themselves (report 12 coverage, report 6 audience). */
export async function cdnAudience(acct: string, from: Date, to: Date) {
  const [r] = await aquery<any>(
    `WITH s AS (
       SELECT skey, sid FROM qoe_cdn_sessions
        WHERE account_id = $1 AND last_at >= $2 AND first_at < $3)
     SELECT count(*) AS sessions,
            count(*) FILTER (WHERE sid IS NOT NULL) AS with_sid,
            count(*) FILTER (WHERE sid IS NOT NULL AND EXISTS (SELECT 1 FROM qoe_views v WHERE v.account_id = $1 AND v.sid = s.sid)) AS reported
       FROM s`, [acct, from.toISOString(), to.toISOString()],
    // ClickHouse: the correlated EXISTS as IN, looking up only the sids the edge saw (the sid index skips the rest)
    `WITH s AS (
       SELECT skey, sid FROM qoe_cdn_sessions
        WHERE account_id = $1 AND last_at >= $2 AND first_at < $3)
     SELECT count(*) AS sessions,
            count(*) FILTER (WHERE sid IS NOT NULL) AS with_sid,
            count(*) FILTER (WHERE sid IS NOT NULL AND sid IN (SELECT sid FROM qoe_views WHERE account_id = $1 AND sid IN (SELECT sid FROM s WHERE sid IS NOT NULL))) AS reported
       FROM s`);
  const sessions = Number(r?.sessions ?? 0), reported = Number(r?.reported ?? 0), withSid = Number(r?.with_sid ?? 0);
  return { sessions, withSessionId: withSid, withTelemetry: reported, withoutTelemetry: sessions - reported, withoutSessionId: sessions - withSid };
}

