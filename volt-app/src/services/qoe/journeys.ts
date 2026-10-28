// ============================================================================
//  JOURNEY TO PLAY (QOE_REPORTING.md section 13, build queue 1.14g).
//
//  Not a general app analytics tool. The app sends a fixed set of about ten
//  events (modules/journey.ts, POST /api/journey) so Volt can join HOW a
//  viewer got to the play button to WHAT happened after it, which only Volt
//  knows (entitlement, payment, startup, QoE, watch time):
//
//    app_open, app_close        launch source (icon, deeplink, push), cold start
//    screen                     name, type (home, browse, detail, search,
//                               player, account, other), content id
//    content_select             content id and entry point (row and position,
//                               search, deeplink, push, epg, continue, related)
//    search                     results count; the query only as a hash
//    paywall_show, purchase     product and outcome
//    play_intent                the play attempt's sid: the join to the views
//    background, foreground     for honest session lengths
//    track                      a few custom events, names and props capped
//
//  THE JOIN. The SDK keeps an app session id (asid; a new one after 30
//  minutes in the background) and a journey id (jid) that starts at
//  content_select or a deep link. play_intent carries the play attempt's sid,
//  and the attempt's own first CMCD report carries the jid, asid, entry point
//  and depth (views.ts, definitions version 3), so the two halves meet from
//  either side.
//
//  RAW FIRST, AS FOR CMCD. Accepted events are kept in the raw store's
//  journey stream before anything is derived; the rows below are a function
//  of them (the same builder live and in a replay), so qoe_app_sessions and
//  qoe_journeys can be dropped and rebuilt.
//
//  PRIVACY. Only the fields below are kept: anything else in an event is
//  dropped (counted), a search query is kept only as a 64 character hash,
//  track props are short strings, numbers or booleans. No IP address, no
//  advertising ids, no user ids.
// ============================================================================
import { analyticsPool, aquery } from './analyticsDb';
import { chExec, chInsert, lit } from './clickhouse';
import { forEachTarget, qoeChDatabase, type StoreKind } from './storeSwitch';
import { parseUa } from './ua';
import type { RawCtx } from './views';
import type { ReportQuery } from './reports';

export const JOURNEY_EVENTS = ['app_open', 'app_close', 'screen', 'content_select', 'search', 'paywall_show', 'purchase', 'play_intent', 'background', 'foreground', 'track'] as const;
export type JourneyEventName = (typeof JOURNEY_EVENTS)[number];
export const ENTRY_POINTS = ['row', 'search', 'deeplink', 'push', 'epg', 'continue', 'related', 'other'] as const;
export const SCREEN_TYPES = ['home', 'browse', 'detail', 'search', 'player', 'account', 'other'] as const;
export const LAUNCH_SOURCES = ['icon', 'deeplink', 'push', 'other'] as const;
/** Custom events: at most this many props, names this long. The SDK also caps distinct names per app session. */
export const TRACK_MAX_PROPS = 10;
/** A quiet app session is closed (written as ended by silence) after this; the SDK starts a new one after 30 min in the background. */
export const SESSION_QUIET_MS = 30 * 60_000;
/** Kept in memory this long after its last event, so a late batch still lands on the right row. */
export const SESSION_FORGET_MS = 2 * 3_600_000;
export const FLUSH_MS = 10_000;

const ID = /^[A-Za-z0-9._:-]{8,64}$/;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const HASH = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

export interface JourneyEvent {
  v: 1; e: JourneyEventName; ts: number; asid: string; sn?: number; jid?: string;
  app?: string; appv?: string; sdkv?: string;
  // app_open
  cold?: boolean; launch?: string;
  // screen
  name?: string; type?: string;
  // content_select, screen, play_intent
  cid?: string; entry?: string; ed?: string; pos?: number;
  // search
  n?: number; qh?: string;
  // paywall_show, purchase
  product?: string; outcome?: string;
  // play_intent
  sid?: string;
  // track
  props?: Record<string, string | number | boolean>;
}

const s64 = (v: unknown, max = 64): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, min = 0, max = 1e9): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined);
const oneOf = <T extends readonly string[]>(v: unknown, set: T, dflt?: T[number]): T[number] | undefined =>
  (typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T[number]) : v != null ? dflt : undefined);

/**
 * Check one event and keep only what may be kept. `dropped` lists the fields
 * that were left out (counted by the route, never stored).
 */
export function checkJourneyEvent(raw: unknown, now = Date.now()): { ok: boolean; why?: string; ev?: JourneyEvent; dropped?: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'not an object' };
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return { ok: false, why: 'v must be 1' };
  const e = oneOf(r.e, JOURNEY_EVENTS);
  if (!e) return { ok: false, why: 'unknown event' };
  const ts = int(r.ts, 0, 1e15);
  if (ts == null) return { ok: false, why: 'ts missing' };
  if (ts < now - 7 * DAY_MS || ts > now + 3_600_000) return { ok: false, why: 'ts out of range' };
  const asid = typeof r.asid === 'string' && ID.test(r.asid) ? r.asid : null;
  if (!asid) return { ok: false, why: 'asid missing' };
  const ev: JourneyEvent = { v: 1, e, ts, asid };
  const used = new Set(['v', 'e', 'ts', 'asid']);
  const take = (k: string, val: unknown) => { used.add(k); if (val !== undefined) (ev as any)[k] = val; };
  take('sn', int(r.sn, 0, 1e9));
  if (r.jid != null) take('jid', typeof r.jid === 'string' && ID.test(r.jid) ? r.jid : undefined);
  take('app', s64(r.app)); take('appv', s64(r.appv, 32)); take('sdkv', s64(r.sdkv, 32));
  switch (e) {
    case 'app_open': take('cold', typeof r.cold === 'boolean' ? r.cold : undefined); take('launch', oneOf(r.launch, LAUNCH_SOURCES, 'other')); take('cid', s64(r.cid, 128)); break;
    case 'screen': take('name', s64(r.name)); take('type', oneOf(r.type, SCREEN_TYPES, 'other')); take('cid', s64(r.cid, 128)); break;
    case 'content_select':
      take('cid', s64(r.cid, 128)); take('entry', oneOf(r.entry, ENTRY_POINTS, 'other')); take('ed', s64(r.ed)); take('pos', int(r.pos, 0, 10_000));
      if (!ev.jid) return { ok: false, why: 'content_select needs jid' };
      break;
    case 'search': take('n', int(r.n, 0, 1e7)); take('qh', typeof r.qh === 'string' && HASH.test(r.qh) ? r.qh : undefined); break;
    case 'paywall_show': take('product', s64(r.product)); break;
    case 'purchase': take('product', s64(r.product)); take('outcome', oneOf(r.outcome, ['success', 'failed', 'cancelled'] as const, 'failed')); break;
    case 'play_intent':
      take('sid', typeof r.sid === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(r.sid) ? r.sid : undefined); take('cid', s64(r.cid, 128));
      if (!ev.sid) return { ok: false, why: 'play_intent needs sid' };
      break;
    case 'track': {
      const name = typeof r.name === 'string' && NAME.test(r.name) ? r.name : undefined;
      if (!name) return { ok: false, why: 'track needs a name like my_event' };
      take('name', name);
      if (r.props && typeof r.props === 'object' && !Array.isArray(r.props)) {
        const props: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(r.props as Record<string, unknown>).slice(0, TRACK_MAX_PROPS)) {
          if (!NAME.test(k)) continue;
          if (typeof v === 'string') props[k] = v.slice(0, 100);
          else if (typeof v === 'number' && Number.isFinite(v)) props[k] = v;
          else if (typeof v === 'boolean') props[k] = v;
        }
        take('props', Object.keys(props).length ? props : undefined);
      } else used.add('props');
      break;
    }
    default: break;
  }
  const dropped = Object.keys(r).filter((k) => !used.has(k));
  return { ok: true, ev, dropped };
}

// ------------------------------------------------------------------- rows

export interface AppSessionRow {
  account_id: string; asid: string; day: string; app_id: string | null;
  app_name: string | null; app_version: string | null; sdk_version: string | null; launch: string | null; cold: boolean | null;
  os: string | null; browser: string | null; device_class: string | null; country: string | null;
  started_at: number; ended_at: number; ended_by: 'close' | 'silence';
  screens: number; journeys: number; searches: number; background_ms: number;
  browse_ms: number | null; detail_ms: number | null; play_ms: number | null; paywall_ms: number | null; purchase_ms: number | null; purchase_ok: boolean;
  plays: Array<{ sid: string; at: number; jid: string | null }>; details: Record<string, number>; played: string[];
}
export interface JourneyRow {
  account_id: string; journey_id: string; asid: string; day: string; app_id: string | null; app_name: string | null; app_version: string | null;
  os: string | null; browser: string | null; device_class: string | null; country: string | null;
  started_at: number; entry: string; entry_detail: string | null; position: number | null; content_id: string | null;
  depth: number; since_open_ms: number | null; detail_ms: number | null; play_ms: number | null; paywall: boolean; purchase: string | null;
  plays: Array<{ sid: string; at: number }>;
}

export interface JEv { ev: JourneyEvent; rt: number; app: string | null; ctx?: RawCtx | null }
export const byJourneyOrder = (a: JEv, b: JEv) => a.ev.ts - b.ev.ts || (a.ev.sn ?? 0) - (b.ev.sn ?? 0) || a.rt - b.rt;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One app session, event by event. The same code live and in a replay. */
export class AppSessionBuilder {
  readonly acct: string; readonly asid: string;
  private s: AppSessionRow;
  private js = new Map<string, JourneyRow>();
  private current: JourneyRow | null = null;
  private sns = new Set<number>();
  private bgSince: number | null = null;
  private ctxSeen = false;
  lastRt = 0;

  constructor(acct: string, asid: string) {
    this.acct = acct; this.asid = asid;
    this.s = {
      account_id: acct, asid, day: '', app_id: null, app_name: null, app_version: null, sdk_version: null, launch: null, cold: null,
      os: null, browser: null, device_class: null, country: null, started_at: 0, ended_at: 0, ended_by: 'silence',
      screens: 0, journeys: 0, searches: 0, background_ms: 0, browse_ms: null, detail_ms: null, play_ms: null, paywall_ms: null, purchase_ms: null, purchase_ok: false,
      plays: [], details: {}, played: [],
    };
  }

  get lastTs(): number { return this.s.ended_at; }
  get closed(): boolean { return this.s.ended_by === 'close'; }

  private since(ts: number) { return Math.max(0, ts - this.s.started_at); }

  private journey(jid: string, ts: number, entry = 'other'): JourneyRow {
    let j = this.js.get(jid);
    if (!j) {
      const s = this.s;
      j = {
        account_id: this.acct, journey_id: jid, asid: this.asid, day: dayOf(ts), app_id: s.app_id, app_name: s.app_name, app_version: s.app_version,
        os: s.os, browser: s.browser, device_class: s.device_class, country: s.country,
        started_at: ts, entry, entry_detail: null, position: null, content_id: null, depth: s.screens, since_open_ms: this.since(ts),
        detail_ms: null, play_ms: null, paywall: false, purchase: null, plays: [],
      };
      this.js.set(jid, j);
      s.journeys = this.js.size;
    }
    return j;
  }

  apply(x: JEv): void {
    const ev = x.ev, s = this.s;
    if (ev.sn != null) { if (this.sns.has(ev.sn)) return; this.sns.add(ev.sn); }
    this.lastRt = Math.max(this.lastRt, x.rt);
    if (!s.started_at) { s.started_at = ev.ts; s.day = dayOf(ev.ts); }
    s.ended_at = Math.max(s.ended_at, ev.ts);
    if (x.app && !s.app_id) s.app_id = x.app;
    if (!s.app_name && ev.app) s.app_name = ev.app;
    if (!s.app_version && ev.appv) s.app_version = ev.appv;
    if (!s.sdk_version && ev.sdkv) s.sdk_version = ev.sdkv;
    if (!this.ctxSeen && x.ctx) {
      this.ctxSeen = true;
      const u = parseUa(x.ctx.ua ?? '', { platform: x.ctx.chp, platformVersion: x.ctx.chv });
      s.os = u.os; s.browser = u.browser; s.device_class = x.ctx.ua ? u.deviceClass : null; s.country = x.ctx.cc ?? null;
    }
    const jid = ev.jid ?? null;
    switch (ev.e) {
      case 'app_open':
        s.launch = ev.launch ?? s.launch ?? 'icon';
        if (ev.cold != null) s.cold = ev.cold;
        // A deep link opens a journey of its own (the SDK gives it a jid).
        if (jid && ev.launch && ev.launch !== 'icon') { const j = this.journey(jid, ev.ts, ev.launch === 'push' ? 'push' : 'deeplink'); j.content_id = ev.cid ?? j.content_id; this.current = j; }
        break;
      case 'screen': {
        s.screens++;
        const t = ev.type ?? 'other';
        if ((t === 'home' || t === 'browse' || t === 'search') && s.browse_ms == null) s.browse_ms = this.since(ev.ts);
        if (t === 'detail') {
          if (s.detail_ms == null) s.detail_ms = this.since(ev.ts);
          if (ev.cid) s.details[ev.cid] = (s.details[ev.cid] ?? 0) + 1;
          const j = (jid && this.js.get(jid)) || this.current;
          if (j && j.detail_ms == null && (!ev.cid || !j.content_id || ev.cid === j.content_id)) j.detail_ms = Math.max(0, ev.ts - j.started_at);
        }
        break;
      }
      case 'content_select': {
        const j = this.journey(jid!, ev.ts, ev.entry ?? 'other');
        j.entry = ev.entry ?? j.entry; j.entry_detail = ev.ed ?? null; j.position = ev.pos ?? null; j.content_id = ev.cid ?? null;
        j.started_at = Math.min(j.started_at, ev.ts);
        this.current = j;
        // A select from a row or search is browsing; a detail page follows it.
        if (s.browse_ms == null && j.entry !== 'deeplink' && j.entry !== 'push') s.browse_ms = this.since(ev.ts);
        break;
      }
      case 'search': s.searches++; if (s.browse_ms == null) s.browse_ms = this.since(ev.ts); break;
      case 'paywall_show': {
        if (s.paywall_ms == null) s.paywall_ms = this.since(ev.ts);
        const j = (jid && this.js.get(jid)) || this.current; if (j) j.paywall = true;
        break;
      }
      case 'purchase': {
        if (ev.outcome === 'success') { s.purchase_ok = true; if (s.purchase_ms == null) s.purchase_ms = this.since(ev.ts); }
        const j = (jid && this.js.get(jid)) || this.current;
        if (j && j.purchase !== 'success') j.purchase = ev.outcome ?? 'failed';
        break;
      }
      case 'play_intent': {
        const sid = ev.sid!;
        if (s.plays.some((p) => p.sid === sid)) break;
        const j = jid ? (this.js.get(jid) ?? this.journey(jid, ev.ts, 'other')) : this.current;
        s.plays.push({ sid, at: this.since(ev.ts), jid: j?.journey_id ?? null });
        if (s.play_ms == null) s.play_ms = this.since(ev.ts);
        const cid = ev.cid ?? j?.content_id ?? null;
        if (cid && !s.played.includes(cid)) s.played.push(cid);
        if (j) { j.plays.push({ sid, at: Math.max(0, ev.ts - j.started_at) }); if (j.play_ms == null) j.play_ms = Math.max(0, ev.ts - j.started_at); if (!j.content_id && cid) j.content_id = cid; }
        break;
      }
      case 'background': if (this.bgSince == null) this.bgSince = ev.ts; break;
      case 'foreground': if (this.bgSince != null) { s.background_ms += Math.max(0, ev.ts - this.bgSince); this.bgSince = null; } break;
      case 'app_close':
        if (this.bgSince != null) { s.background_ms += Math.max(0, ev.ts - this.bgSince); this.bgSince = null; }
        s.ended_by = 'close';
        break;
      default: break; // track: kept raw only
    }
  }

  rows(): { session: AppSessionRow; journeys: JourneyRow[] } {
    const s = { ...this.s, plays: [...this.s.plays], details: { ...this.s.details }, played: [...this.s.played] };
    // The app-level facts known by now go on every journey (a select may come before the context did).
    const journeys = [...this.js.values()].map((j) => ({ ...j, plays: [...j.plays], app_id: j.app_id ?? s.app_id, app_name: j.app_name ?? s.app_name, app_version: j.app_version ?? s.app_version,
      os: j.os ?? s.os, browser: j.browser ?? s.browser, device_class: j.device_class ?? s.device_class, country: j.country ?? s.country }));
    return { session: s, journeys };
  }
}

/** A raw row of the journey stream as an event (null when it no longer parses). */
export function toJourneyEvent(row: { rt: number; app: string | null; line: string; ctx?: RawCtx | null }): JEv | null {
  try { const c = checkJourneyEvent(JSON.parse(row.line), row.rt); return c.ok ? { ev: c.ev!, rt: row.rt, app: row.app, ctx: row.ctx ?? null } : null; } catch { return null; }
}

/** Derive every app session and journey of a set of raw rows (a replay). */
export function deriveJourneys(rows: Array<{ acct: string; rt: number; app: string | null; line: string; ctx?: RawCtx | null }>): { sessions: AppSessionRow[]; journeys: JourneyRow[] } {
  const by = new Map<string, { acct: string; asid: string; evs: JEv[] }>();
  for (const row of rows) {
    const x = toJourneyEvent(row);
    if (!x) continue;
    const k = row.acct + '\u0001' + x.ev.asid;
    let b = by.get(k);
    if (!b) { b = { acct: row.acct, asid: x.ev.asid, evs: [] }; by.set(k, b); }
    b.evs.push(x);
  }
  const sessions: AppSessionRow[] = [], journeys: JourneyRow[] = [];
  for (const b of by.values()) {
    b.evs.sort(byJourneyOrder);
    const bl = new AppSessionBuilder(b.acct, b.asid);
    for (const x of b.evs) bl.apply(x);
    const r = bl.rows(); sessions.push(r.session); journeys.push(...r.journeys);
  }
  return { sessions, journeys };
}

// -------------------------------------------------------------- the store

const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_COLS = ['account_id', 'asid', 'day', 'app_id', 'app_name', 'app_version', 'sdk_version', 'launch', 'cold', 'os', 'browser', 'device_class', 'country',
  'started_at', 'ended_at', 'ended_by', 'screens', 'journeys', 'searches', 'background_ms', 'browse_ms', 'detail_ms', 'play_ms', 'paywall_ms', 'purchase_ms', 'purchase_ok',
  'plays', 'details', 'played'];
const JOURNEY_COLS = ['account_id', 'journey_id', 'asid', 'day', 'app_id', 'app_name', 'app_version', 'os', 'browser', 'device_class', 'country', 'started_at', 'entry',
  'entry_detail', 'position', 'content_id', 'depth', 'since_open_ms', 'detail_ms', 'play_ms', 'paywall', 'purchase', 'plays'];
const okApp = (a: string | null) => (a && /^[0-9a-f-]{36}$/i.test(a) ? a : null);
type Q = { query: (t: string, p: any[]) => Promise<any> };

async function upsert(c: Q, table: string, cols: string[], key: string[], rows: object[]) {
  for (let i = 0; i < rows.length; i += 2000) {
    await c.query(
      `INSERT INTO ${table} (${cols.join(',')}) SELECT ${cols.join(',')} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
       ON CONFLICT (${key.join(',')}) DO UPDATE SET ${cols.filter((k) => !key.includes(k)).map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`,
      [JSON.stringify(rows.slice(i, i + 2000))]);
  }
}

export async function writeJourneyRows(sessions: AppSessionRow[], journeys: JourneyRow[], client?: Q, target?: StoreKind): Promise<void> {
  if (client) return pgWriteJourneyRows(sessions, journeys, client);
  await forEachTarget({ clickhouse: () => chWriteJourneyRows(sessions, journeys), postgres: () => pgWriteJourneyRows(sessions, journeys) }, target);
}

/** ClickHouse: versioned rows (a later write of the same app session or journey wins, clickhouse.ts). */
async function chWriteJourneyRows(sessions: AppSessionRow[], journeys: JourneyRow[]): Promise<void> {
  const db = qoeChDatabase();
  const pick = (o: any, cols: string[]) => Object.fromEntries(cols.map((k) => [k, o[k] ?? null]));
  await chInsert('qoe_app_sessions', sessions.map((x) => pick({ ...x, app_id: okApp(x.app_id), started_at: iso(x.started_at), ended_at: iso(x.ended_at) }, SESSION_COLS)), db, { versioned: true });
  await chInsert('qoe_journeys', journeys.map((j) => pick({ ...j, app_id: okApp(j.app_id), started_at: iso(j.started_at) }, JOURNEY_COLS)), db, { versioned: true });
}

async function pgWriteJourneyRows(sessions: AppSessionRow[], journeys: JourneyRow[], client?: Q): Promise<void> {
  const c = client ?? await analyticsPool();
  if (sessions.length) await upsert(c, 'qoe_app_sessions', SESSION_COLS, ['account_id', 'asid'],
    sessions.map((s) => ({ ...s, app_id: okApp(s.app_id), started_at: iso(s.started_at), ended_at: iso(s.ended_at) })));
  if (journeys.length) await upsert(c, 'qoe_journeys', JOURNEY_COLS, ['account_id', 'journey_id'],
    journeys.map((j) => ({ ...j, app_id: okApp(j.app_id), started_at: iso(j.started_at) })));
}

/** Replace one account's day of app sessions and journeys (by the day they started), in one transaction. */
export async function replaceJourneyDay(acct: string, day: string, sessions: AppSessionRow[], journeys: JourneyRow[], target?: StoreKind): Promise<void> {
  await forEachTarget({
    clickhouse: async () => {
      const db = qoeChDatabase();
      await chExec(`DELETE FROM qoe_app_sessions WHERE account_id = ${lit(acct)} AND day = toDate(${lit(day)})`, db);
      await chExec(`DELETE FROM qoe_journeys WHERE account_id = ${lit(acct)} AND day = toDate(${lit(day)})`, db);
      await chWriteJourneyRows(sessions, journeys);
    },
    postgres: () => pgReplaceJourneyDay(acct, day, sessions, journeys),
  }, target);
}

async function pgReplaceJourneyDay(acct: string, day: string, sessions: AppSessionRow[], journeys: JourneyRow[]): Promise<void> {
  const p = await analyticsPool();
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM qoe_app_sessions WHERE account_id = $1 AND day = $2::date`, [acct, day]);
    await c.query(`DELETE FROM qoe_journeys WHERE account_id = $1 AND day = $2::date`, [acct, day]);
    await pgWriteJourneyRows(sessions, journeys, c);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

// --------------------------------------------------------- the live path

interface LiveS { b: AppSessionBuilder; dirty: boolean; seenAt: number }
const live = new Map<string, LiveS>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
export const journeyStats = { ingested: 0, sessionsWritten: 0, journeysWritten: 0, flushFailures: 0, lastError: null as string | null };
const enabled = () => (process.env.QOE_DERIVE ?? 'on') !== 'off';

/** Hand the live path a batch already kept raw. */
export function ingestJourneyEvents(acct: string, evs: JEv[], now = Date.now()): void {
  if (!enabled() || !evs.length) return;
  const sorted = [...evs].sort((a, b) => (a.ev.asid < b.ev.asid ? -1 : a.ev.asid > b.ev.asid ? 1 : byJourneyOrder(a, b)));
  for (const x of sorted) {
    const k = acct + '\u0001' + x.ev.asid;
    let l = live.get(k);
    if (!l) { l = { b: new AppSessionBuilder(acct, x.ev.asid), dirty: false, seenAt: now }; live.set(k, l); }
    l.b.apply(x); l.dirty = true; l.seenAt = now;
    journeyStats.ingested++;
  }
  if (!timer) { timer = setInterval(() => { void flushJourneys(); }, FLUSH_MS); timer.unref?.(); }
}

/** Write the sessions that changed since the last flush. Never throws; a failed write is tried again. */
export async function flushJourneys(now = Date.now()): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const due = [...live.entries()].filter(([, l]) => l.dirty);
    for (const [, l] of due) l.dirty = false;
    const sessions: AppSessionRow[] = [], journeys: JourneyRow[] = [];
    for (const [, l] of due) { const r = l.b.rows(); sessions.push(r.session); journeys.push(...r.journeys); }
    try {
      if (sessions.length) await writeJourneyRows(sessions, journeys);
      journeyStats.sessionsWritten += sessions.length; journeyStats.journeysWritten += journeys.length; journeyStats.lastError = null;
    } catch (e) {
      journeyStats.flushFailures++; journeyStats.lastError = (e as Error).message;
      for (const [, l] of due) l.dirty = true;
    }
    for (const [k, l] of live) if (!l.dirty && now - l.seenAt > SESSION_FORGET_MS) live.delete(k);
  })().finally(() => { flushing = null; });
  return flushing;
}

export function journeyState() { return { sessions: live.size, ...journeyStats }; }
export function resetJourneys(): void { live.clear(); Object.assign(journeyStats, { ingested: 0, sessionsWritten: 0, journeysWritten: 0, flushFailures: 0, lastError: null }); }

// ------------------------------------------------------------- reports

/** The filters the journey reports take: the app session's own dimensions, and the entry point. */
const J_FILTERS = ['app_name', 'app_version', 'os', 'browser', 'device_class', 'country'] as const;

function jWhere(q: ReportQuery, p: unknown[], alias: string): string[] {
  const w: string[] = [];
  for (const f of J_FILTERS) {
    const vals = (q.filters as any)[f] as string[] | undefined;
    if (!vals?.length) continue;
    const known = vals.filter((v) => v !== '__none');
    const parts: string[] = [];
    if (known.length) { p.push(known); parts.push(`${alias}.${f} = ANY($${p.length}::text[])`); }
    if (vals.includes('__none')) parts.push(`${alias}.${f} IS NULL`);
    w.push(`(${parts.join(' OR ')})`);
  }
  return w;
}

const pctl = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const isPayment = (code: string | null) => !!code && /402|payment|paywall/i.test(code);

interface ViewLite { sid: string; outcome: string; error_step: string | null; error_code: string | null; startup_ms: number | null; t_entitlement: number | null;
  playing_ms: number; rebuffer_ms: number; ended_by: string; fatal_after_start: boolean }

async function viewsFor(acct: string, sids: string[]): Promise<Map<string, ViewLite[]>> {
  const out = new Map<string, ViewLite[]>();
  for (let i = 0; i < sids.length; i += 5000) {
    const rows = await aquery<any>(
      `SELECT sid, outcome, error_step, error_code, startup_ms, t_entitlement, playing_ms, rebuffer_ms, ended_by, fatal_after_start
       FROM qoe_views WHERE account_id = $1 AND sid = ANY($2::text[])`, [acct, sids.slice(i, i + 5000)]);
    for (const r of rows) {
      const v: ViewLite = { ...r, playing_ms: Number(r.playing_ms), rebuffer_ms: Number(r.rebuffer_ms), startup_ms: r.startup_ms == null ? null : Number(r.startup_ms), t_entitlement: r.t_entitlement == null ? null : Number(r.t_entitlement) };
      (out.get(r.sid) ?? out.set(r.sid, []).get(r.sid)!).push(v);
    }
  }
  return out;
}

/** Most app sessions one report reads (the Mac's analytics database; ClickHouse, 2.11, does this in SQL). */
export const MAX_SESSIONS = 200_000;

export const FUNNEL_STEPS = ['open', 'browse', 'detail', 'play', 'entitled', 'paid', 'first_frame'] as const;

/**
 * 28. JOURNEY TO PLAY: app open to first frame as a funnel over app sessions
 * that opened in the window. A session has reached a step when it got to it
 * or to any later one (a deep link straight to a detail page has passed
 * browse). The steps:
 *   open         the app session
 *   browse       a home, browse or search screen, a search, or a select from a row
 *   detail       a detail screen
 *   play         play pressed (play_intent)
 *   entitled     a play the gate did not refuse, or refused only for payment
 *   paid         no paywall was needed, or a purchase succeeded
 *   first_frame  a play reached its first frame (the view started)
 * Drop-off at a step is the sessions that reached the one before and not it;
 * the time is ms after the app opened (nearest rank). entitled, paid and
 * first_frame read the play's view row, which the collector writes when the
 * view closes (quit, the end, a fatal error, or SILENCE_MS without reports),
 * so a play still going reaches them then, as it reaches reports 1 to 10.
 */
export async function journeyToPlay(acct: string, q: ReportQuery) {
  const p: unknown[] = [acct, q.from.toISOString(), q.to.toISOString()];
  const w = [`s.account_id = $1`, `s.started_at >= $2`, `s.started_at < $3`, ...jWhere(q, p, 's')];
  const entries = q.filters.entry_point?.filter((e) => e !== '__none') ?? [];
  const chW = [...w];
  if (entries.length) {
    p.push(entries);
    w.push(`EXISTS (SELECT 1 FROM qoe_journeys j WHERE j.account_id = s.account_id AND j.asid = s.asid AND j.entry = ANY($${p.length}::text[]))`);
    // ClickHouse: the correlated EXISTS as IN over the account's journeys
    chW.push(`s.asid IN (SELECT asid FROM qoe_journeys WHERE account_id = $1 AND entry = ANY($${p.length}::text[]))`);
  }
  const sel = (ws: string[]) => `SELECT asid, browse_ms, detail_ms, play_ms, paywall_ms, purchase_ms, purchase_ok, plays, journeys FROM qoe_app_sessions s WHERE ${ws.join(' AND ')}
    ORDER BY started_at LIMIT ${MAX_SESSIONS}`;
  const sess = await aquery<any>(sel(w), p, sel(chW));
  // With an entry point filter, only the plays of journeys from those entries count.
  let allowJ: Set<string> | null = null;
  if (entries.length && sess.length) {
    const js = await aquery<any>(`SELECT journey_id FROM qoe_journeys WHERE account_id = $1 AND asid = ANY($2::text[]) AND entry = ANY($3::text[])`, [acct, sess.map((s) => s.asid), entries]);
    allowJ = new Set(js.map((j) => j.journey_id));
  }
  const sids = sess.flatMap((s) => (s.plays as any[]).filter((x) => !allowJ || (x.jid && allowJ.has(x.jid))).map((x) => String(x.sid)));
  const views = await viewsFor(acct, sids);
  const reached = FUNNEL_STEPS.map(() => 0);
  const times: number[][] = FUNNEL_STEPS.map(() => []);
  const toFirstFrame: number[] = [];
  let paywallShown = 0, purchased = 0, refused = 0;
  for (const s of sess) {
    const plays = (s.plays as Array<{ sid: string; at: number; jid: string | null }>).filter((x) => !allowJ || (x.jid && allowJ.has(x.jid)));
    const t: Array<number | null> = FUNNEL_STEPS.map(() => null);
    t[0] = 0;
    t[1] = s.browse_ms; t[2] = s.detail_ms;
    if (plays.length) t[3] = Math.min(...plays.map((x) => x.at));
    let ent: number | null = null, ff: number | null = null, refusedHere = false;
    for (const pl of plays) {
      for (const v of views.get(pl.sid) ?? []) {
        const passed = !(v.error_step === 'entitlement' && !isPayment(v.error_code)) && (v.outcome === 'started' || v.t_entitlement != null || v.error_step != null);
        if (v.error_step === 'entitlement' && !isPayment(v.error_code)) refusedHere = true;
        if (passed) { const at = pl.at + (v.t_entitlement ?? 0); ent = ent == null ? at : Math.min(ent, at); }
        if (v.outcome === 'started' && v.startup_ms != null) { const at = pl.at + v.startup_ms; ff = ff == null ? at : Math.min(ff, at); }
      }
    }
    if (ff != null && ent == null) ent = ff; // a started view passed the gate whatever it reported
    t[4] = ent;
    if (s.paywall_ms != null) paywallShown++;
    if (s.purchase_ok) purchased++;
    if (refusedHere && ent == null) refused++;
    const needsPay = s.paywall_ms != null;
    t[5] = ent == null ? null : !needsPay ? ent : s.purchase_ok ? Math.max(ent, s.purchase_ms ?? ent) : (ff != null ? ff : null);
    t[6] = ff;
    // reached a step: it, or any later one
    let later = false;
    for (let i = FUNNEL_STEPS.length - 1; i >= 0; i--) {
      if (t[i] != null) later = true;
      if (later) reached[i]++;
      if (t[i] != null) times[i].push(t[i]!);
    }
    if (ff != null) toFirstFrame.push(ff);
  }
  const open = reached[0];
  return {
    sessions: open, truncated: sess.length >= MAX_SESSIONS,
    steps: FUNNEL_STEPS.map((step, i) => ({
      step, sessions: reached[i], rate: ratio(reached[i], open), fromPrevious: i ? ratio(reached[i], reached[i - 1]) : 1,
      dropOff: i ? reached[i - 1] - reached[i] : 0, msSinceOpen: { p50: pctl(times[i], 0.5), p95: pctl(times[i], 0.95), n: times[i].length },
    })),
    openToFirstFrame: { p50: pctl(toFirstFrame, 0.5), p95: pctl(toFirstFrame, 0.95), n: toFirstFrame.length },
    paywall: { shown: paywallShown, purchased, abandoned: Math.max(0, paywallShown - purchased) },
    refusedByGate: refused,
  };
}

/**
 * 29. DISCOVERY ATTRIBUTION: per entry point (and per row, search, campaign
 * within it), the journeys that started in the window, how many led to a
 * play and a first frame, watch time, completion (views that played to the
 * end / started views) and QoE of those plays; and the detail pages viewed
 * and never played.
 */
export async function discovery(acct: string, q: ReportQuery, opts: { by?: 'entry' | 'detail'; limit?: number } = {}) {
  const p: unknown[] = [acct, q.from.toISOString(), q.to.toISOString()];
  const w = [`j.account_id = $1`, `j.started_at >= $2`, `j.started_at < $3`, ...jWhere(q, p, 'j')];
  const entries = q.filters.entry_point?.filter((e) => e !== '__none') ?? [];
  if (entries.length) { p.push(entries); w.push(`j.entry = ANY($${p.length}::text[])`); }
  const js = await aquery<any>(`SELECT journey_id, entry, entry_detail, position, content_id, depth, plays, paywall, purchase FROM qoe_journeys j WHERE ${w.join(' AND ')}
    LIMIT ${MAX_SESSIONS}`, p);
  const views = await viewsFor(acct, js.flatMap((j) => (j.plays as any[]).map((x) => String(x.sid))));
  type G = { entry: string; detail: string | null; journeys: number; played: number; started: number; views: number; startedViews: number; completed: number;
    watchMs: number; rebufferMs: number; startup: number[]; failed: number; depth: number[]; positions: number[] };
  const groups = new Map<string, G>();
  for (const j of js) {
    const key = opts.by === 'detail' ? `${j.entry}\u0001${j.entry_detail ?? ''}` : j.entry;
    let g = groups.get(key);
    if (!g) { g = { entry: j.entry, detail: opts.by === 'detail' ? j.entry_detail ?? null : null, journeys: 0, played: 0, started: 0, views: 0, startedViews: 0, completed: 0, watchMs: 0, rebufferMs: 0, startup: [], failed: 0, depth: [], positions: [] }; groups.set(key, g); }
    g.journeys++; g.depth.push(Number(j.depth));
    if (j.position != null) g.positions.push(Number(j.position));
    const plays = j.plays as Array<{ sid: string }>;
    if (plays.length) g.played++;
    let started = false;
    for (const pl of plays) for (const v of views.get(pl.sid) ?? []) {
      g.views++;
      if (v.outcome === 'failed') g.failed++;
      if (v.outcome === 'started') { started = true; g.startedViews++; if (v.startup_ms != null) g.startup.push(v.startup_ms); if (v.ended_by === 'e') g.completed++; }
      g.watchMs += v.playing_ms; g.rebufferMs += v.rebuffer_ms;
    }
    if (started) g.started++;
  }
  const rows = [...groups.values()].map((g) => ({
    entry: g.entry, detail: g.detail, journeys: g.journeys, plays: g.played, started: g.started,
    playRate: ratio(g.played, g.journeys), startRate: ratio(g.started, g.journeys),
    views: g.views, watchMs: g.watchMs, watchMsPerJourney: g.journeys ? Math.round(g.watchMs / g.journeys) : null,
    completion: ratio(g.completed, g.startedViews), startupFailureRate: ratio(g.failed, g.views),
    startupP50: pctl(g.startup, 0.5), rebufferRatio: ratio(g.rebufferMs, g.watchMs + g.rebufferMs),
    depthP50: pctl(g.depth, 0.5), positionP50: pctl(g.positions, 0.5),
  })).sort((a, b) => b.journeys - a.journeys || a.entry.localeCompare(b.entry));

  // Viewed, never played: detail screens per content id in the app sessions of the window.
  const p2: unknown[] = [acct, q.from.toISOString(), q.to.toISOString()];
  const w2 = [`s.account_id = $1`, `s.started_at >= $2`, `s.started_at < $3`, ...jWhere(q, p2, 's')];
  const sess = await aquery<any>(`SELECT details, played FROM qoe_app_sessions s WHERE ${w2.join(' AND ')} AND s.details <> '{}'::jsonb LIMIT ${MAX_SESSIONS}`, p2);
  const det = new Map<string, { contentId: string; detailViews: number; sessions: number; playedIn: number }>();
  for (const s of sess) {
    const played = new Set<string>(s.played ?? []);
    for (const [cid, n] of Object.entries(s.details ?? {})) {
      const d = det.get(cid) ?? { contentId: cid, detailViews: 0, sessions: 0, playedIn: 0 };
      d.detailViews += Number(n); d.sessions++; if (played.has(cid)) d.playedIn++;
      det.set(cid, d);
    }
  }
  const neverPlayed = [...det.values()].map((d) => ({ ...d, neverPlayed: d.sessions - d.playedIn, playRate: ratio(d.playedIn, d.sessions) }))
    .sort((a, b) => b.neverPlayed - a.neverPlayed || b.detailViews - a.detailViews).slice(0, opts.limit ?? 20);
  return { by: opts.by ?? 'entry', journeys: js.length, rows, neverPlayed };
}
