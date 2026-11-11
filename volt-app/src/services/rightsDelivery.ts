// ============================================================================
//  RIGHTS DELIVERY: WHO SAW EACH PROGRAMME, WHO SAW THE REPLACEMENT, WHO WAS
//  REFUSED, AND FROM WHERE (FAST channels; services/fast/rights.ts).
//
//  For every scheduled programme of a FAST channel, per country: the viewers
//  who were given the programme ("viewed"), the viewers outside its rights
//  who were given the channel's geo replacement ("replaced"), and the viewers
//  refused ("blocked": outside the channel's own geo, or outside a title's
//  rights with no replacement chosen). With the playlist requests behind
//  each, so the size of the audience and its share of each outcome can be
//  read side by side.
//
//  WHERE IT IS COUNTED. From what already passes through, never an extra
//  request:
//    * WITHOUT A CDN (the Mac, a single-box deployment): at the origin. Every
//      viewer of a FAST channel with rights is kept on the variant service
//      (modules/publicLive.ts serveVariant), so each playlist reload is
//      answered there with the decision already made (viewed or replaced),
//      and the public /live route's refusals (451) are counted where made;
//    * BEHIND THE CDN: from its real-time log lines (services/qoe/cdnLogs.ts):
//      the channel's own playlists (viewed), the variant paths the edge sends a
//      replaced viewer to (replaced) and the edge's 451s (blocked). The origin
//      then counts nothing (originCounts), since the edge answers most
//      requests from its cache and a viewer must not be counted twice.
//
//  WHY IT DOES NOT SLOW ANYTHING DOWN OR LOCK ANYTHING.
//    * The request path only adds to a counter in memory: no database, no
//      await, never throws. A counter keeps its first viewers as they are,
//      then folds them into a HyperLogLog of 4 KB, so a million viewers cost
//      the same memory as a few hundred.
//    * Counters are per channel, 15 second bucket, country and outcome. Once
//      a minute they are resolved to the guide's programmes (one indexed
//      read per channel) and INSERTED into the ANALYTICS database as minute
//      rows (one statement per 2000): no conflicts, so tasks never wait on
//      one another. Every few minutes one task folds the minute rows into one
//      row per programme, country and outcome (see "storage" below), merging
//      the viewers in memory, so the database does no per-viewer work and a
//      busy channel is a few hundred rows a day, not a row a request.
//    * Bounded: MAX_KEYS counters in a minute; beyond that requests are
//      dropped and counted (rightsDeliveryStats.dropped).
//
//  ACCURACY. Viewers are estimated (HyperLogLog, 4096 registers: about 1.6 %
//  standard error, within a viewer or two below a few hundred). Behind the CDN, log lines may
//  be sampled: requests are weighted back up, viewers are those seen in the
//  sample. A viewer is the player's CMCD session id when it sends one, else
//  its address and user agent, hashed with a server secret: no address is
//  ever kept.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { query } from '../db';
import { analyticsPool } from './qoe/analyticsDb';

export type DeliveryOutcome = 'viewed' | 'replaced' | 'blocked';
export const OUTCOMES: DeliveryOutcome[] = ['viewed', 'replaced', 'blocked'];

export const FLUSH_MS = Math.max(1000, Number(process.env.RIGHTS_DELIVERY_FLUSH_MS ?? 60_000));
export const BUCKET_MS = 15_000;
export const MAX_KEYS = 50_000;
const P = 12;
/** Viewers kept as they are, per counter, before it changes to registers (most counters never do). */
const SMALL_MAX = 128;
export const REGISTERS = 1 << P;

export const rightsDeliveryStats = { recorded: 0, ignored: 0, dropped: 0, flushes: 0, statements: 0, rowsWritten: 0, flushFailures: 0, lastError: null as string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enabled = () => (process.env.VOLT_RIGHTS_DELIVERY ?? 'on') !== 'off';
const salt = () => process.env.QOE_ANON_SALT || process.env.JWT_ACCESS_SECRET || 'volt-anon';

// ---------------------------------------------------------------- HyperLogLog

/** Pure: fold one viewer (any string) into the registers. */
export function hllAdd(regs: Uint8Array, viewer: string): void {
  const h = createHash('sha256').update(`${salt()}|${viewer}`).digest();
  const x = h.readBigUInt64BE(0);
  const idx = Number(x >> BigInt(64 - P));
  const rest = x & ((BigInt(1) << BigInt(64 - P)) - BigInt(1));
  let rho = 1;
  for (let b = 64 - P - 1; b >= 0 && !((rest >> BigInt(b)) & BigInt(1)); b--) rho++;
  if (rho > regs[idx]) regs[idx] = rho;
}

/** Pure: register by register maximum, into `a`. */
export function hllMerge(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < a.length && i < b.length; i++) if (b[i] > a[i]) a[i] = b[i];
  return a;
}

/** Pure: the estimated number of distinct viewers. */
export function hllCount(regs: Uint8Array): number {
  const m = regs.length;
  let sum = 0, zeros = 0;
  for (let i = 0; i < m; i++) { sum += Math.pow(2, -regs[i]); if (regs[i] === 0) zeros++; }
  const alpha = 0.7213 / (1 + 1.079 / m);
  const e = (alpha * m * m) / sum;
  if (e <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros));
  return Math.round(e);
}

// ---------------------------------------------------------------- recording

interface Counter { channelId: string; bucket: number; country: string; outcome: DeliveryOutcome; requests: number; small: Set<string> | null; regs: Uint8Array | null }

/** Add a viewer to a counter: kept as is while few, then registers. */
function addViewer(c: Counter, viewer: string): void {
  if (c.regs) { hllAdd(c.regs, viewer); return; }
  (c.small ??= new Set()).add(viewer);
  if (c.small.size > SMALL_MAX) { c.regs = new Uint8Array(REGISTERS); for (const v of c.small) hllAdd(c.regs, v); c.small = null; }
}
/** A counter's viewers as registers. */
export function regsOf(c: Counter): Uint8Array {
  if (c.regs) return c.regs;
  const r = new Uint8Array(REGISTERS);
  for (const v of c.small ?? []) hllAdd(r, v);
  return r;
}
function mergeCounter(into: Counter, from: Counter): void {
  into.requests += from.requests;
  if (from.regs) { if (!into.regs) { into.regs = regsOf(into); into.small = null; } hllMerge(into.regs, from.regs); }
  else for (const v of from.small ?? []) addViewer(into, v);
}
let counters = new Map<string, Counter>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;

export interface DeliveryHit {
  channelId: string;
  outcome: DeliveryOutcome;
  country?: string | null;
  /** The player's session id, or address and user agent: hashed, never kept. */
  viewer?: string | null;
  /** When (ms). The development `&at=` stand-in passes its own time so a test lands on the programme it asked about. */
  at?: number;
  /** Sampled CDN lines count for 100 / rate. */
  weight?: number;
}

/** Note one answer. Never throws, never waits, never touches a database. */
export function recordDelivery(h: DeliveryHit): void {
  try {
    if (!enabled() || !UUID.test(h.channelId) || !OUTCOMES.includes(h.outcome)) { rightsDeliveryStats.ignored++; return; }
    const at = h.at ?? Date.now();
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    const country = h.country && /^[A-Za-z]{2}$/.test(h.country) ? h.country.toUpperCase() : '';
    const k = `${h.channelId.toLowerCase()}|${bucket}|${country}|${h.outcome}`;
    let c = counters.get(k);
    if (!c) {
      if (counters.size >= MAX_KEYS) { rightsDeliveryStats.dropped++; return; }
      c = { channelId: h.channelId.toLowerCase(), bucket, country, outcome: h.outcome, requests: 0, small: null, regs: null };
      counters.set(k, c);
    }
    c.requests += Math.max(0, h.weight ?? 1);
    if (h.viewer) addViewer(c, h.viewer);
    rightsDeliveryStats.recorded++;
    if (!timer) { timer = setInterval(() => { void flushDelivery(); }, FLUSH_MS); timer.unref?.(); }
  } catch { /* delivery never fails because of its counts */ }
}

/** The viewer behind an origin request: the CMCD session id (query or header), else address and user agent. */
export function viewerOf(req: any): string {
  const q = req?.query?.CMCD ?? req?.query?.cmcd;
  const fromQ = typeof q === 'string' ? q.match(/(?:^|,)sid="?([^",]+)"?/)?.[1] : null;
  const fromH = String(req?.get?.('cmcd-session') ?? '').match(/(?:^|,)sid="?([^",]+)"?/)?.[1];
  const sid = fromQ || fromH;
  if (sid) return `sid:${sid}`;
  const ip = String(req?.get?.('x-forwarded-for') ?? '').split(',')[0].trim() || req?.ip || '';
  return `a:${ip}|${req?.get?.('user-agent') ?? ''}`;
}

/**
 * A CDN real-time log line, behind the CDN: a FAST channel's own playlist
 * (viewed) or the edge's refusal of it (blocked). Variant paths are counted
 * by the origin. Master playlists are left out: a reload is a media playlist
 * (HLS) or the MPD (DASH).
 */
export function recordEdgeLine(l: { status: number; path: string; country: string | null; at: number }, viewer: string, weight = 1): void {
  const m = /^\/channel\/([0-9a-f-]{36})\/(v\/v[0-9a-f]{8}\/)?(?:fast\/)?([A-Za-z0-9_.-]+\.(?:m3u8|mpd))$/i.exec(l.path.split('?')[0]);
  if (!m || /^master/.test(m[3])) return;
  const ok = l.status >= 200 && l.status < 400;
  // the edge sends a viewer to /v/<key>/ only when it replaces; a 451 is its refusal
  const outcome: DeliveryOutcome | null = l.status === 451 ? 'blocked' : ok ? (m[2] ? 'replaced' : 'viewed') : null;
  if (!outcome) return;
  recordDelivery({ channelId: m[1], outcome, country: l.country, viewer, at: l.at, weight });
}

/**
 * Whether this box counts at the origin. Behind a CDN the edge answers most
 * playlist requests from its cache and makes the refusals itself, so the CDN's
 * logs are the count (recordEdgeLine) and the origin counts nothing, which
 * also keeps a viewer from being counted twice.
 */
export async function originCounts(): Promise<boolean> {
  const { fastConfig } = await import('./fast/media');
  return !fastConfig.cdn;
}

// ---------------------------------------------------------------- storage
//
// TWO TABLES, SO THE DATABASE NEVER MERGES REGISTERS.
//   rights_delivery_minutes   what each task held for a minute: INSERT only,
//                             no conflicts, no locks between tasks;
//   rights_delivery           one row per programme, country and outcome,
//                             written only by the roll-up.
// Once every few minutes ONE task (a non-blocking advisory lock: the others
// skip) reads a batch of minute rows, merges them with the rows they add to,
// in memory, writes the results and deletes the batch, in one short
// transaction. The registers are merged in JavaScript (microseconds per row);
// merging them in SQL cost about a millisecond a row, measured. Readers are
// never blocked (the report reads both tables).
//
// Registers are stored SPARSE while few are set (3 bytes per viewer-ish
// register: index and value) and dense (4096 bytes) beyond that, so a
// programme seen by a handful of viewers in a country is a few dozen bytes.

const SCHEMA = `
-- RIGHTS DELIVERY (services/rightsDelivery.ts). Viewers per FAST programme,
-- country and outcome (viewed | replaced | blocked), as HyperLogLog registers
-- (encoded: 0x00 + 4096 bytes dense, or 0x01 + (index u16, value u8) pairs).
CREATE TABLE IF NOT EXISTS rights_delivery_minutes (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL,
  day           DATE NOT NULL,
  channel_id    UUID NOT NULL,
  programme_id  TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  outcome       TEXT NOT NULL,
  title         TEXT,
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  requests      DOUBLE PRECISION NOT NULL DEFAULT 0,
  hll           BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS rights_delivery_minutes_channel ON rights_delivery_minutes (account_id, channel_id, day);
CREATE TABLE IF NOT EXISTS rights_delivery (
  account_id    UUID NOT NULL,
  day           DATE NOT NULL,              -- the programme's start (UTC); the bucket's day when no programme
  channel_id    UUID NOT NULL,
  programme_id  TEXT NOT NULL DEFAULT '',   -- '' outside the guide
  country       TEXT NOT NULL DEFAULT '',   -- '' when unknown
  outcome       TEXT NOT NULL,
  title         TEXT,
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  requests      DOUBLE PRECISION NOT NULL DEFAULT 0,
  hll           BYTEA NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, channel_id, day, programme_id, country, outcome)
);
CREATE INDEX IF NOT EXISTS rights_delivery_day ON rights_delivery (account_id, day);
`;

/** Pure: registers to their stored form (sparse while that is smaller). */
export function encodeRegs(regs: Uint8Array): Buffer {
  let nz = 0;
  for (let i = 0; i < regs.length; i++) if (regs[i]) nz++;
  if (nz * 3 < regs.length) {
    const b = Buffer.alloc(1 + nz * 3);
    b[0] = 1;
    let o = 1;
    for (let i = 0; i < regs.length; i++) if (regs[i]) { b.writeUInt16BE(i, o); b[o + 2] = regs[i]; o += 3; }
    return b;
  }
  const b = Buffer.alloc(1 + regs.length);
  b[0] = 0;
  b.set(regs, 1);
  return b;
}

/** Pure: the stored form back to registers. Anything unreadable is no viewers. */
export function decodeRegs(b: Buffer | Uint8Array | null | undefined): Uint8Array {
  const r = new Uint8Array(REGISTERS);
  if (!b || !b.length) return r;
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (buf[0] === 0) { r.set(buf.subarray(1, 1 + REGISTERS)); return r; }
  if (buf[0] === 1) for (let o = 1; o + 2 < buf.length; o += 3) { const i = buf.readUInt16BE(o); if (i < REGISTERS && buf[o + 2] > r[i]) r[i] = buf[o + 2]; }
  return r;
}

let schemaFor: Pool | null = null;
async function deliveryPool(): Promise<Pool> {
  const p = await analyticsPool();
  if (schemaFor !== p) {
    const c = await p.connect();
    try {
      await c.query(`SELECT pg_advisory_lock(72010003)`);
      await c.query(SCHEMA);
    } finally { await c.query(`SELECT pg_advisory_unlock(72010003)`).catch(() => {}); c.release(); }
    schemaFor = p;
  }
  return p;
}

const channelInfo = new Map<string, { at: number; v: { accountId: string; fast: boolean } | null }>();
async function infoOf(channelId: string) {
  const hit = channelInfo.get(channelId);
  if (hit && Date.now() - hit.at < 300_000) return hit.v;
  const r = (await query<any>(`SELECT c.origin, g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [channelId]))[0];
  const v = r ? { accountId: String(r.account_id), fast: r.origin === 'playlist' } : null;
  channelInfo.set(channelId, { at: Date.now(), v });
  if (channelInfo.size > 20_000) channelInfo.clear();
  return v;
}

interface Row {
  account_id: string; day: string; channel_id: string; programme_id: string; country: string; outcome: DeliveryOutcome;
  title: string | null; starts_at: string | null; ends_at: string | null; requests: number; regs: Uint8Array;
}
const rowKey = (r: { account_id: string; channel_id: string; day: any; programme_id: string; country: string; outcome: string }) =>
  [r.account_id, r.channel_id, typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10), r.programme_id, r.country, r.outcome].join('|');

/**
 * Pure: the held counters as rows per programme, given each channel's
 * account and programmes. A bucket belongs to the programme on air at its
 * middle (buckets are 15 s, so a change of programme is placed to within 8 s).
 */
export function rowsFor(held: Counter[], info: Map<string, { accountId: string } | null>,
  progs: Map<string, { id: string; title: string | null; starts_at: Date | string; ends_at: Date | string }[]>): Row[] {
  const out = new Map<string, Row>();
  const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : Date.parse(d));
  for (const c of held) {
    const inf = info.get(c.channelId);
    if (!inf) continue;
    const mid = c.bucket + BUCKET_MS / 2;
    const p = (progs.get(c.channelId) ?? []).find((x) => ms(x.starts_at) <= mid && mid < ms(x.ends_at)) ?? null;
    const day = new Date(p ? ms(p.starts_at) : c.bucket).toISOString().slice(0, 10);
    const pid = p ? String(p.id) : '';
    const k = [inf.accountId, c.channelId, day, pid, c.country, c.outcome].join('|');
    let r = out.get(k);
    if (!r) {
      r = { account_id: inf.accountId, day, channel_id: c.channelId, programme_id: pid, country: c.country, outcome: c.outcome,
        title: p?.title ?? null, starts_at: p ? new Date(ms(p.starts_at)).toISOString() : null, ends_at: p ? new Date(ms(p.ends_at)).toISOString() : null,
        requests: 0, regs: new Uint8Array(REGISTERS) };
      out.set(k, r);
    }
    r.requests += c.requests;
    hllMerge(r.regs, regsOf(c));
  }
  return [...out.values()];
}

/** Write what is held, as minute rows (insert only). A failed write is kept for the next flush. Never throws. */
export async function flushDelivery(): Promise<void> {
  if (flushing) return flushing;
  if (!counters.size) return;
  flushing = (async () => {
    const held = counters; counters = new Map();
    const list = [...held.values()];
    try {
      const info = new Map<string, { accountId: string } | null>();
      const progs = new Map<string, any[]>();
      const byChannel = new Map<string, Counter[]>();
      for (const c of list) (byChannel.get(c.channelId) ?? byChannel.set(c.channelId, []).get(c.channelId)!).push(c);
      for (const [ch, cs] of byChannel) {
        const inf = await infoOf(ch);
        info.set(ch, inf && inf.fast ? inf : null);
        if (!inf?.fast) continue;
        const from = Math.min(...cs.map((c) => c.bucket)), to = Math.max(...cs.map((c) => c.bucket)) + BUCKET_MS;
        progs.set(ch, await query<any>(
          `SELECT id, title, starts_at, ends_at FROM programmes
            WHERE channel_id = $1 AND starts_at < to_timestamp($3) AND ends_at > to_timestamp($2)
            ORDER BY starts_at LIMIT 500`, [ch, from / 1000, to / 1000]));
      }
      const rows = rowsFor(list, info, progs);
      if (rows.length) {
        const p = await deliveryPool();
        for (let i = 0; i < rows.length; i += 2000) {
          const part = rows.slice(i, i + 2000).map(({ regs, ...r }) => ({ ...r, hll: encodeRegs(regs).toString('base64') }));
          await p.query(
            `INSERT INTO rights_delivery_minutes (account_id, day, channel_id, programme_id, country, outcome, title, starts_at, ends_at, requests, hll)
             SELECT account_id, day, channel_id, programme_id, country, outcome, title, starts_at, ends_at, requests, decode(hll, 'base64')
               FROM jsonb_to_recordset($1::jsonb) AS x(account_id uuid, day date, channel_id uuid, programme_id text, country text, outcome text,
                                                      title text, starts_at timestamptz, ends_at timestamptz, requests float8, hll text)`, [JSON.stringify(part)]);
          rightsDeliveryStats.statements++;
        }
      }
      rightsDeliveryStats.flushes++; rightsDeliveryStats.rowsWritten += rows.length; rightsDeliveryStats.lastError = null;
      if (!rollTimer) { rollTimer = setInterval(() => { void rollUpDelivery(); }, ROLLUP_MS); rollTimer.unref?.(); }
    } catch (e) {
      rightsDeliveryStats.flushFailures++; rightsDeliveryStats.lastError = (e as Error).message;
      for (const c of list) {
        const k = `${c.channelId}|${c.bucket}|${c.country}|${c.outcome}`;
        const have = counters.get(k);
        if (!have) { if (counters.size < MAX_KEYS) counters.set(k, c); else rightsDeliveryStats.dropped++; continue; }
        mergeCounter(have, c);
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

export const ROLLUP_MS = Math.max(5000, Number(process.env.RIGHTS_DELIVERY_ROLLUP_MS ?? 300_000));
const ROLLUP_BATCH = 20_000;
let rollTimer: ReturnType<typeof setInterval> | null = null;

type StoredRow = { account_id: string; channel_id: string; day: any; programme_id: string; country: string; outcome: string;
  title: string | null; starts_at: any; ends_at: any; requests: number; hll: Buffer };

/** Pure: the rolled rows after adding the minute rows to what is already rolled up for the same keys. */
export function rollUp(existing: StoredRow[], minutes: StoredRow[]): (Omit<StoredRow, 'hll'> & { hll: Buffer })[] {
  const out = new Map<string, { row: StoredRow; regs: Uint8Array; requests: number }>();
  for (const r of [...existing, ...minutes]) {
    const k = rowKey(r);
    const have = out.get(k);
    const regs = decodeRegs(r.hll);
    if (!have) { out.set(k, { row: { ...r }, regs, requests: Number(r.requests) || 0 }); continue; }
    hllMerge(have.regs, regs);
    have.requests += Number(r.requests) || 0;
    if (r.title) have.row.title = r.title;
    if (r.starts_at) have.row.starts_at = r.starts_at;
    if (r.ends_at) have.row.ends_at = r.ends_at;
  }
  return [...out.values()].map(({ row, regs, requests }) => ({
    ...row, day: typeof row.day === 'string' ? row.day.slice(0, 10) : new Date(row.day).toISOString().slice(0, 10), requests, hll: encodeRegs(regs),
  }));
}

/**
 * Fold the minute rows into the per-programme rows. One task at a time (the
 * others skip, never wait); a batch at a time, each in one short transaction.
 * Never throws.
 */
export async function rollUpDelivery(maxBatches = 5): Promise<{ rolled: number }> {
  let rolled = 0;
  let c: any = null;
  try {
    const p = await deliveryPool();
    c = await p.connect();
    const got = (await c.query(`SELECT pg_try_advisory_lock(72010004) AS ok`)).rows[0]?.ok;
    if (!got) return { rolled };
    try {
      for (let b = 0; b < maxBatches; b++) {
        const mins: (StoredRow & { id: string })[] = (await c.query(
          `SELECT id, account_id, channel_id, day, programme_id, country, outcome, title, starts_at, ends_at, requests, hll
             FROM rights_delivery_minutes ORDER BY id LIMIT ${ROLLUP_BATCH}`)).rows;
        if (!mins.length) break;
        const keys = [...new Map(mins.map((m) => [rowKey(m), { account_id: m.account_id, channel_id: m.channel_id, day: rowKey(m).split('|')[2], programme_id: m.programme_id, country: m.country, outcome: m.outcome }])).values()];
        const existing: StoredRow[] = (await c.query(
          `SELECT d.account_id, d.channel_id, d.day, d.programme_id, d.country, d.outcome, d.title, d.starts_at, d.ends_at, d.requests, d.hll
             FROM rights_delivery d
             JOIN jsonb_to_recordset($1::jsonb) AS k(account_id uuid, channel_id uuid, day date, programme_id text, country text, outcome text)
               ON d.account_id = k.account_id AND d.channel_id = k.channel_id AND d.day = k.day
              AND d.programme_id = k.programme_id AND d.country = k.country AND d.outcome = k.outcome`, [JSON.stringify(keys)])).rows;
        const rows = rollUp(existing, mins);
        await c.query('BEGIN');
        try {
          for (let i = 0; i < rows.length; i += 2000) {
            const part = rows.slice(i, i + 2000).map((r) => ({ ...r, hll: r.hll.toString('base64') }));
            await c.query(
              `INSERT INTO rights_delivery (account_id, day, channel_id, programme_id, country, outcome, title, starts_at, ends_at, requests, hll)
               SELECT account_id, day, channel_id, programme_id, country, outcome, title, starts_at, ends_at, requests, decode(hll, 'base64')
                 FROM jsonb_to_recordset($1::jsonb) AS x(account_id uuid, day date, channel_id uuid, programme_id text, country text, outcome text,
                                                        title text, starts_at timestamptz, ends_at timestamptz, requests float8, hll text)
               ON CONFLICT (account_id, channel_id, day, programme_id, country, outcome) DO UPDATE
                 SET requests = EXCLUDED.requests, hll = EXCLUDED.hll, title = EXCLUDED.title,
                     starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, updated_at = now()`, [JSON.stringify(part)]);
            rightsDeliveryStats.statements++;
          }
          await c.query(`DELETE FROM rights_delivery_minutes WHERE id = ANY($1::bigint[])`, [mins.map((m) => m.id)]);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        rolled += mins.length;
        if (mins.length < ROLLUP_BATCH) break;
      }
    } finally { await c.query(`SELECT pg_advisory_unlock(72010004)`).catch(() => {}); }
  } catch (e) {
    rightsDeliveryStats.lastError = (e as Error).message;
  } finally { c?.release(); }
  return { rolled };
}

/** For tests. */
export function resetDelivery(): void {
  counters = new Map();
  Object.assign(rightsDeliveryStats, { recorded: 0, ignored: 0, dropped: 0, flushes: 0, statements: 0, rowsWritten: 0, flushFailures: 0, lastError: null });
}
export function deliveryPending(): Counter[] { return [...counters.values()]; }

// ---------------------------------------------------------------- the report

export interface OutcomeCount { viewers: number; requests: number }
export interface ProgrammeReport {
  programmeId: string; title: string | null; startsAt: string | null; endsAt: string | null;
  totals: Record<DeliveryOutcome, OutcomeCount> & { viewers: number };
  countries: { country: string; viewed: OutcomeCount; replaced: OutcomeCount; blocked: OutcomeCount }[];
}

const zero = (): OutcomeCount => ({ viewers: 0, requests: 0 });

/** Pure: the stored rows, pivoted per programme (in schedule order) and per country within it. */
export function pivot(rows: { programme_id: string; title: string | null; starts_at: any; ends_at: any; country: string; outcome: string; requests: number; hll: Buffer | Uint8Array }[]): {
  programmes: ProgrammeReport[]; totals: Record<DeliveryOutcome, OutcomeCount> & { viewers: number };
} {
  type Acc = { meta: { title: string | null; startsAt: string | null; endsAt: string | null }; all: Uint8Array;
    by: Map<DeliveryOutcome, { regs: Uint8Array; requests: number }>; cc: Map<string, Map<DeliveryOutcome, { regs: Uint8Array; requests: number }>> };
  const progs = new Map<string, Acc>();
  const grand = { all: new Uint8Array(REGISTERS), by: new Map<DeliveryOutcome, { regs: Uint8Array; requests: number }>() };
  const slot = (m: Map<DeliveryOutcome, { regs: Uint8Array; requests: number }>, o: DeliveryOutcome) =>
    m.get(o) ?? m.set(o, { regs: new Uint8Array(REGISTERS), requests: 0 }).get(o)!;
  const iso = (v: any) => (v ? new Date(v).toISOString() : null);
  for (const r of rows) {
    const o = r.outcome as DeliveryOutcome;
    if (!OUTCOMES.includes(o)) continue;
    const regs = decodeRegs(r.hll);
    let a = progs.get(r.programme_id);
    if (!a) {
      a = { meta: { title: r.title, startsAt: iso(r.starts_at), endsAt: iso(r.ends_at) }, all: new Uint8Array(REGISTERS), by: new Map(), cc: new Map() };
      progs.set(r.programme_id, a);
    }
    if (!a.meta.title && r.title) a.meta.title = r.title;
    hllMerge(a.all, regs);
    const s = slot(a.by, o); hllMerge(s.regs, regs); s.requests += Number(r.requests) || 0;
    const c = slot(a.cc.get(r.country) ?? a.cc.set(r.country, new Map()).get(r.country)!, o); hllMerge(c.regs, regs); c.requests += Number(r.requests) || 0;
    hllMerge(grand.all, regs);
    const g = slot(grand.by, o); hllMerge(g.regs, regs); g.requests += Number(r.requests) || 0;
  }
  const count = (s?: { regs: Uint8Array; requests: number }): OutcomeCount => (s ? { viewers: hllCount(s.regs), requests: Math.round(s.requests) } : zero());
  const programmes: ProgrammeReport[] = [...progs.entries()].map(([id, a]) => ({
    programmeId: id, title: a.meta.title, startsAt: a.meta.startsAt, endsAt: a.meta.endsAt,
    totals: { viewed: count(a.by.get('viewed')), replaced: count(a.by.get('replaced')), blocked: count(a.by.get('blocked')), viewers: hllCount(a.all) },
    countries: [...a.cc.entries()].map(([country, m]) => ({ country, viewed: count(m.get('viewed')), replaced: count(m.get('replaced')), blocked: count(m.get('blocked')) }))
      .sort((x, y) => (y.viewed.viewers + y.replaced.viewers + y.blocked.viewers) - (x.viewed.viewers + x.replaced.viewers + x.blocked.viewers) || x.country.localeCompare(y.country)),
  })).sort((x, y) => (x.startsAt ?? '9999').localeCompare(y.startsAt ?? '9999'));
  return {
    programmes,
    totals: { viewed: count(grand.by.get('viewed')), replaced: count(grand.by.get('replaced')), blocked: count(grand.by.get('blocked')), viewers: hllCount(grand.all) },
  };
}

/** The report for one channel over [fromDay, toDay] (UTC dates). This task's held minute is written first. */
export async function deliveryReport(accountId: string, channelId: string, fromDay: string, toDay: string) {
  await flushDelivery().catch(() => {});
  const p = await deliveryPool();
  // the rolled-up rows and the minutes not rolled up yet: the pivot merges them
  const r = await p.query(
    `SELECT programme_id, title, starts_at, ends_at, country, outcome, requests, hll
       FROM rights_delivery
      WHERE account_id = $1 AND channel_id = $2 AND day BETWEEN $3::date AND $4::date
     UNION ALL
     SELECT programme_id, title, starts_at, ends_at, country, outcome, requests, hll
       FROM rights_delivery_minutes
      WHERE account_id = $1 AND channel_id = $2 AND day BETWEEN $3::date AND $4::date
      LIMIT 100000`, [accountId, channelId, fromDay, toDay]);
  return { channelId, from: fromDay, to: toDay, ...pivot(r.rows) };
}
