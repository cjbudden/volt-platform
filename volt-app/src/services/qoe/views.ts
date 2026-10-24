// ============================================================================
//  FROM RAW CMCD REPORTS TO VIEWS (QOE_REPORTING.md section 4, written down).
//
//  One function of the raw reports, used two ways:
//    - live, by the collector (collector.ts), a session at a time as its
//      reports arrive, and
//    - in a replay (replay.ts), over a whole day partition read back from the
//      raw store.
//  Both feed the same ViewBuilder in the same order (report time, then sn),
//  so a replay of what the collector saw writes the same rows. That is what
//  makes the derived data disposable: change a definition, bump
//  DEFINITIONS_VERSION, replay.
//
//  THE DEFINITIONS (version 1)
//  - A view (play attempt) opens at the first play state `s` (starting: the
//    viewer pressed play, or autoplay began). An attempt that only ever
//    preloaded (`d`, waiting for the viewer) is not a view.
//  - It closes at quit (q), a fatal error (f), or 60 s without reports; it
//    may also end (e) and play again. Reports within 60 minutes resume it;
//    after that the same sid starts attempt 2.
//  - Every millisecond between two reports is in exactly one state: playing
//    (p), rebuffering (r, an involuntary stall), seeking (k, including a stall
//    caused by the seek), paused (a), backgrounded (b with bg, which wins over
//    the others), or uncounted (starting, preloading, ended). A gap of more
//    than 60 s without reports is counted in no state.
//  - Outcome: started (a first frame), failed (a fatal error before it), or
//    exited (left before it without an error: EBFF).
//  - Startup time is the player's msd (play pressed to the first presented
//    frame, preroll excluded); its spans are the SDK's com.volt-t* keys and
//    always add up to it.
//  - A stall is an entry into r after the first frame. Time to first stall is
//    measured from the first frame.
//  - Time-weighted bitrate: sum(kbps x playing ms) / playing ms with a known
//    bitrate. A switch is a bitrate change after the first frame; an
//    oscillation is a switch that reverses the previous one within 10 s.
//  - Exit after stall / error: the viewer left (q or silence, not a natural
//    end) within 30 s of the end of a stall (or during one) / of a non-fatal
//    error.
//  - Percentiles everywhere are nearest rank: the value at rank ceil(q x n).
// ============================================================================
import { parseCmcdLine, type CmcdValue } from './cmcdParse';
import { parseUa } from './ua';
import * as sk from './sketch';

export const DEFINITIONS_VERSION = 1;
export const SILENCE_MS = 60_000;
export const RESUME_MS = 60 * 60_000;
const OSC_MS = 10_000;
const EXIT_AFTER_MS = 30_000;
const LATE_MS = 60_000;

/** Where the report POST came from, kept on the raw row (no IP). */
export interface RawCtx { ua?: string; chp?: string; chv?: string; cc?: string; rg?: string; asn?: string }

export interface Ev { ts: number; rt: number; sn: number | null; e: string; r: Record<string, CmcdValue>; app: string | null; ctx?: RawCtx | null }

/** The keys the reports may carry; anything else is counted for report 12. */
const KNOWN = new Set(['v', 'ts', 'e', 'sid', 'sn', 'cid', 'sf', 'st', 'sta', 'msd', 'br', 'bl', 'mtp', 'pb', 'tpb', 'tb', 'dfa', 'ltc',
  'pr', 'bg', 'ec', 'su', 'bs', 'url', 'rc', 'ot', 'ttfb', 'ttlb', 'cmsds', 'cmsdd', 'd', 'nor', 'rtp', 'dl', 'df', 'ab', 'lb', 'tab', 'tbl', 'bsa', 'bsd', 'bsda', 'nr', 'sid', 'pt', 'cs', 'ts']);
const VOLT = 'com.volt-';

export interface ViewRow {
  account_id: string; view_id: string; day: string; def_version: number; sid: string; attempt: number; app_id: string | null;
  started_at: number; ended_at: number; ended_by: string;
  content_id: string | null; stream_type: string | null;
  app_name: string | null; app_version: string | null; sdk_version: string | null; player_version: string | null;
  device_model: string | null; device_class: string | null; os: string | null; os_version: string | null; browser: string | null; browser_version: string | null;
  codec: string | null; cdn: string | null; country: string | null; region: string | null; asn: string | null; network: string | null;
  outcome: 'started' | 'failed' | 'exited'; waited_ms: number | null; startup_ms: number | null;
  t_entitlement: number | null; t_manifest: number | null; t_drm: number | null; t_segment: number | null; t_decode: number | null; t_other: number | null;
  error_code: string | null; error_step: string | null; fatal_after_start: boolean; nonfatal_errors: number;
  playing_ms: number; rebuffer_ms: number; stalls: number; first_stall_ms: number | null; seeks: number; seek_ms: number;
  paused_ms: number; background_ms: number; bitrate_ms: number; bitrate_kbps_ms: number; below_top_ms: number;
  switches: number; oscillations: number; buffer_avg_ms: number | null; throughput_avg_kbps: number | null;
  dropped_frames: number | null; latency_avg_ms: number | null;
  exit_after_stall: boolean; exit_after_error: boolean;
  events: number; sn_missing: number; no_sn: number; late_events: number; clock_skew_ms: number | null; unknown_keys: Record<string, number>;
}

/** The minute aggregate key's dimensions. */
export interface MinuteDims { content_id: string; stream_type: string; country: string; device_class: string; cdn: string }
export interface MinuteRow extends MinuteDims {
  account_id: string; minute: number; attempts: number; starts: number; failures: number; fatal_after: number;
  stalls: number; playing_ms: number; rebuffer_ms: number; switches: number; startup_sketch: sk.Sketch;
}
export const MINUTE_FIELDS = ['attempts', 'starts', 'failures', 'fatal_after', 'stalls', 'playing_ms', 'rebuffer_ms', 'switches'] as const;

export function minuteKey(acct: string, minute: number, d: MinuteDims): string {
  return [acct, minute, d.content_id, d.stream_type, d.country, d.device_class, d.cdn].join('\u0001');
}

/** Accumulates minute aggregates (live or in a replay). */
export class MinuteSink {
  rows = new Map<string, MinuteRow>();
  add(acct: string, at: number, d: MinuteDims, f: Partial<Record<(typeof MINUTE_FIELDS)[number], number>>, startup?: number): void {
    const minute = Math.floor(at / 60_000) * 60_000;
    const k = minuteKey(acct, minute, d);
    let r = this.rows.get(k);
    if (!r) { r = { account_id: acct, minute, ...d, attempts: 0, starts: 0, failures: 0, fatal_after: 0, stalls: 0, playing_ms: 0, rebuffer_ms: 0, switches: 0, startup_sketch: {} }; this.rows.set(k, r); }
    for (const [n, v] of Object.entries(f)) (r as any)[n] += v ?? 0;
    if (startup != null) sk.add(r.startup_sketch, startup);
  }
  /** Merge a whole row back in (a flush that failed). */
  merge(m: MinuteRow): void {
    const d: MinuteDims = { content_id: m.content_id, stream_type: m.stream_type, country: m.country, device_class: m.device_class, cdn: m.cdn };
    const f: Record<string, number> = {};
    for (const n of MINUTE_FIELDS) f[n] = m[n];
    this.add(m.account_id, m.minute, d, f);
    sk.merge(this.rows.get(minuteKey(m.account_id, m.minute, d))!.startup_sketch, m.startup_sketch);
  }
  take(): MinuteRow[] { const out = [...this.rows.values()]; this.rows.clear(); return out; }
}

const num = (v: unknown): number | null => {
  const x = Array.isArray(v) ? v[0] : v;
  const y = typeof x === 'object' && x && 'value' in (x as any) ? (x as any).value : x;
  const n = typeof y === 'string' ? Number(y) : y;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  const y = typeof x === 'object' && x && 'value' in (x as any) ? (x as any).value : x;
  if (y && typeof y === 'object' && 'token' in (y as any)) return String((y as any).token);
  return y == null || typeof y === 'object' ? null : String(y);
};
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function cdnOf(r: Record<string, CmcdValue>): string | null {
  if (r[VOLT + 'cfid'] != null) return 'CloudFront';
  const u = str(r.url);
  if (!u) return null;
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

/** One view (play attempt) of one session, built report by report. */
export class ViewBuilder {
  readonly acct: string; readonly sid: string; readonly attempt: number;
  private v: ViewRow;
  private opened = false;          // saw `s`
  private sta: string | null = null;
  private bg = false;
  private lastTs: number | null = null;
  private lastStartTs: number | null = null;
  private ffTs: number | null = null;
  private inStallSince: number | null = null;
  private lastStallEnd: number | null = null;
  private lastErrTs: number | null = null;
  private lastErr: { code: string | null; step: string | null } | null = null;
  private errors = 0;
  private br: number | null = null;
  private tpb: number | null = null;
  private lastSwitch: { ts: number; dir: number } | null = null;
  private sns = new Set<number>();
  private sums = { bl: 0, bln: 0, mtp: 0, mtpn: 0, ltc: 0, ltcn: 0 };
  private ctxSeen = false;
  lastRt = 0;
  closed = false;

  constructor(acct: string, sid: string, attempt: number) {
    this.acct = acct; this.sid = sid; this.attempt = attempt;
    this.v = {
      account_id: acct, view_id: `${sid}#${attempt}`, day: '', def_version: DEFINITIONS_VERSION, sid, attempt, app_id: null,
      started_at: 0, ended_at: 0, ended_by: 'silence', content_id: null, stream_type: null,
      app_name: null, app_version: null, sdk_version: null, player_version: null, device_model: null, device_class: null,
      os: null, os_version: null, browser: null, browser_version: null, codec: null, cdn: null, country: null, region: null, asn: null, network: null,
      outcome: 'exited', waited_ms: null, startup_ms: null,
      t_entitlement: null, t_manifest: null, t_drm: null, t_segment: null, t_decode: null, t_other: null,
      error_code: null, error_step: null, fatal_after_start: false, nonfatal_errors: 0,
      playing_ms: 0, rebuffer_ms: 0, stalls: 0, first_stall_ms: null, seeks: 0, seek_ms: 0, paused_ms: 0, background_ms: 0,
      bitrate_ms: 0, bitrate_kbps_ms: 0, below_top_ms: 0, switches: 0, oscillations: 0,
      buffer_avg_ms: null, throughput_avg_kbps: null, dropped_frames: null, latency_avg_ms: null,
      exit_after_stall: false, exit_after_error: false, events: 0, sn_missing: 0, no_sn: 0, late_events: 0, clock_skew_ms: null, unknown_keys: {},
    };
  }

  /** Is this a view at all (the viewer pressed play, or autoplay began)? */
  get isView(): boolean { return this.opened; }
  get last(): number | null { return this.lastTs; }
  get ended(): boolean { return this.sta === 'q' || this.sta === 'f'; }

  private dims(): MinuteDims {
    const v = this.v;
    return { content_id: v.content_id ?? '', stream_type: v.stream_type ?? '', country: v.country ?? '', device_class: v.device_class ?? '', cdn: v.cdn ?? '' };
  }

  /** Feed one report; minute contributions go to `sink`. */
  apply(ev: Ev, sink: MinuteSink | null): void {
    const v = this.v, r = ev.r;
    // A batch the player sent again (a retry after a lost answer) is the same report.
    if (ev.sn != null && this.sns.has(ev.sn)) return;
    this.lastRt = Math.max(this.lastRt, ev.rt);
    // ---- identity, dimensions and telemetry health, from every report
    v.events++;
    if (ev.sn == null) v.no_sn++; else this.sns.add(ev.sn);
    if (ev.rt - ev.ts > LATE_MS) v.late_events++;
    if (v.clock_skew_ms == null) v.clock_skew_ms = ev.ts - ev.rt;
    for (const k of Object.keys(r)) if (!KNOWN.has(k) && !k.startsWith(VOLT)) v.unknown_keys[k] = (v.unknown_keys[k] ?? 0) + 1;
    if (ev.app && !v.app_id) v.app_id = ev.app;
    if (!v.content_id && r.cid != null) v.content_id = str(r.cid);
    if (!v.stream_type && r.st != null) v.stream_type = str(r.st);
    if (!v.app_name && r[VOLT + 'app'] != null) v.app_name = str(r[VOLT + 'app']);
    if (!v.app_version && r[VOLT + 'appv'] != null) v.app_version = str(r[VOLT + 'appv']);
    if (!v.sdk_version && r[VOLT + 'sdkv'] != null) v.sdk_version = str(r[VOLT + 'sdkv']);
    if (!v.player_version && r[VOLT + 'plv'] != null) v.player_version = str(r[VOLT + 'plv']);
    if (!v.device_model && r[VOLT + 'dm'] != null) v.device_model = str(r[VOLT + 'dm']);
    if (!v.codec && r[VOLT + 'codec'] != null) v.codec = str(r[VOLT + 'codec']);
    if (!v.network && r[VOLT + 'net'] != null) v.network = str(r[VOLT + 'net']);
    if (!v.cdn && ev.e === 'rr') v.cdn = cdnOf(r);
    if (!this.ctxSeen && ev.ctx) {
      this.ctxSeen = true;
      const u = parseUa(ev.ctx.ua ?? '', { platform: ev.ctx.chp, platformVersion: ev.ctx.chv });
      v.os = u.os; v.os_version = u.osVersion; v.browser = u.browser; v.browser_version = u.browserVersion;
      v.device_class = ev.ctx.ua ? u.deviceClass : null;
      v.country = ev.ctx.cc ?? null; v.region = ev.ctx.rg ?? null; v.asn = ev.ctx.asn ?? null;
    }

    // ---- time since the last report, in the state it was in
    const ts = ev.ts;
    if (this.lastTs != null && this.opened) {
      const dt = ts - this.lastTs;
      if (dt > 0 && dt <= SILENCE_MS) this.count(dt, ts, sink);
    }
    this.lastTs = this.lastTs == null ? ts : Math.max(this.lastTs, ts);
    v.ended_at = this.lastTs;

    // ---- what this report says
    switch (ev.e) {
      case 'ps': this.playState(str(r.sta) ?? '', ev, sink); break;
      case 'e': {
        this.errors++;
        this.lastErrTs = ts;
        this.lastErr = { code: str(r.ec), step: str(r[VOLT + 'step']) };
        break;
      }
      case 'bc': {
        const b = num(r.br);
        if (b != null && this.ffTs != null && b !== this.br) {
          const dir = this.br == null ? 0 : Math.sign(b - this.br);
          if (this.br != null) {
            v.switches++;
            if (this.lastSwitch && this.lastSwitch.dir === -dir && ts - this.lastSwitch.ts <= OSC_MS) v.oscillations++;
            this.lastSwitch = { ts, dir };
            if (this.opened && sink) sink.add(this.acct, ts, this.dims(), { switches: 1 });
          }
        }
        if (b != null) this.br = b;
        break;
      }
      case 't': {
        const bl = num(r.bl); if (bl != null) { this.sums.bl += bl; this.sums.bln++; }
        const mtp = num(r.mtp); if (mtp != null) { this.sums.mtp += mtp; this.sums.mtpn++; }
        const ltc = num(r.ltc); if (ltc != null) { this.sums.ltc += ltc; this.sums.ltcn++; }
        const tpb = num(r.tpb); if (tpb != null) this.tpb = tpb;
        const pb = num(r.pb); if (pb != null && this.br == null) this.br = pb;
        const dfa = num(r.dfa); if (dfa != null) v.dropped_frames = Math.max(v.dropped_frames ?? 0, dfa);
        break;
      }
      case 'b': this.bg = r.bg === true; break;
      default: break;
    }
  }

  private count(dt: number, at: number, sink: MinuteSink | null): void {
    const v = this.v;
    if (this.bg) { v.background_ms += dt; return; }
    switch (this.sta) {
      case 'p':
        v.playing_ms += dt;
        if (this.br != null) {
          v.bitrate_ms += dt; v.bitrate_kbps_ms += Math.round(this.br * dt);
          if (this.tpb != null && this.br < this.tpb) v.below_top_ms += dt;
        }
        sink?.add(this.acct, at, this.dims(), { playing_ms: dt });
        break;
      case 'r': v.rebuffer_ms += dt; sink?.add(this.acct, at, this.dims(), { rebuffer_ms: dt }); break;
      case 'k': v.seek_ms += dt; break;
      case 'a': v.paused_ms += dt; break;
      default: break;
    }
  }

  private playState(s: string, ev: Ev, sink: MinuteSink | null): void {
    const v = this.v, ts = ev.ts, r = ev.r;
    if (this.sta === 'q' || this.sta === 'f') return; // the view is over
    const prev = this.sta;
    if (s === 's') {
      this.lastStartTs = ts;
      if (!this.opened) {
        this.opened = true;
        v.started_at = ts; v.day = dayOf(ts);
        sink?.add(this.acct, ts, this.dims(), { attempts: 1 });
      }
    }
    if (!this.opened) { this.sta = s; return; }
    if (s === 'p' && this.ffTs == null) {
      this.ffTs = ts;
      v.outcome = 'started';
      const msd = num(r.msd);
      v.startup_ms = msd != null ? Math.round(msd) : (this.lastStartTs != null ? ts - this.lastStartTs : null);
      v.t_entitlement = num(r[VOLT + 'tent']); v.t_manifest = num(r[VOLT + 'tman']); v.t_drm = num(r[VOLT + 'tdrm']);
      v.t_segment = num(r[VOLT + 'tseg']); v.t_decode = num(r[VOLT + 'tdec']); v.t_other = num(r[VOLT + 'toth']);
      const b = num(r.br); if (b != null) this.br = b;
      sink?.add(this.acct, ts, this.dims(), { starts: 1 }, v.startup_ms ?? undefined);
    }
    // stalls and seeks are entries into the state, after the first frame
    if (this.ffTs != null && s === 'r' && prev !== 'r') {
      v.stalls++;
      if (v.first_stall_ms == null) v.first_stall_ms = ts - this.ffTs;
      this.inStallSince = ts;
      sink?.add(this.acct, ts, this.dims(), { stalls: 1 });
    }
    if (prev === 'r' && s !== 'r') { this.inStallSince = null; this.lastStallEnd = ts; }
    if (this.ffTs != null && s === 'k' && prev !== 'k') v.seeks++;
    if (s === 'f') {
      if (this.ffTs == null) { v.outcome = 'failed'; sink?.add(this.acct, ts, this.dims(), { failures: 1 }); }
      else { v.fatal_after_start = true; sink?.add(this.acct, ts, this.dims(), { fatal_after: 1 }); }
      v.error_code = this.lastErr?.code ?? null; v.error_step = this.lastErr?.step ?? null;
    }
    this.sta = s;
  }

  /** The row as it stands (a view still open is written as ended by silence). */
  row(): ViewRow {
    const v = { ...this.v, unknown_keys: { ...this.v.unknown_keys } };
    v.ended_by = this.sta === 'q' || this.sta === 'f' || this.sta === 'e' ? this.sta : 'silence';
    v.nonfatal_errors = this.errors - (this.sta === 'f' ? 1 : 0);
    if (v.nonfatal_errors < 0) v.nonfatal_errors = 0;
    if (v.outcome !== 'started' && this.lastStartTs != null && this.lastTs != null) v.waited_ms = Math.max(0, this.lastTs - this.lastStartTs);
    if (v.outcome === 'failed' || v.fatal_after_start) { /* error kept from the fatal one */ }
    else if (this.lastErr) { v.error_code = this.lastErr.code; v.error_step = this.lastErr.step; }
    const left = v.ended_by === 'q' || v.ended_by === 'silence';
    const end = this.lastTs ?? 0;
    v.exit_after_stall = left && this.ffTs != null && (this.inStallSince != null || (this.lastStallEnd != null && end - this.lastStallEnd <= EXIT_AFTER_MS));
    v.exit_after_error = left && this.lastErrTs != null && end - this.lastErrTs <= EXIT_AFTER_MS && v.ended_by !== 'f';
    const s = this.sums;
    v.buffer_avg_ms = s.bln ? Math.round(s.bl / s.bln) : null;
    v.throughput_avg_kbps = s.mtpn ? Math.round(s.mtp / s.mtpn) : null;
    v.latency_avg_ms = s.ltcn ? Math.round(s.ltc / s.ltcn) : null;
    if (this.sns.size) {
      const sorted = [...this.sns];
      const max = Math.max(...sorted);
      v.sn_missing = max - this.sns.size; // sn starts at 1: everything up to max should be there
    }
    return v;
  }
}

/** Read a raw row into an event (null for a line that no longer parses). */
export function toEvent(row: { rt: number; app: string | null; line: string; ctx?: RawCtx | null }): Ev | null {
  try {
    const r = parseCmcdLine(row.line);
    const ts = num(r.ts), e = str(r.e);
    if (ts == null || !e) return null;
    const sn = num(r.sn);
    return { ts, rt: row.rt, sn: sn == null ? null : sn, e, r, app: row.app, ctx: row.ctx ?? null };
  } catch { return null; }
}

/** Report order inside a session: the player's time, then its sequence number. */
export function byReportOrder(a: Ev, b: Ev): number { return a.ts - b.ts || (a.sn ?? 0) - (b.sn ?? 0) || a.rt - b.rt; }

/**
 * A SESSION (one sid): its views, split into attempts by 60 minutes of
 * silence. The collector keeps one per live sid; a replay makes one per sid
 * in the period.
 */
export class SessionState {
  readonly acct: string; readonly sid: string;
  current: ViewBuilder;
  private attempt = 1;
  constructor(acct: string, sid: string, attempt = 1) {
    this.acct = acct; this.sid = sid; this.attempt = attempt;
    this.current = new ViewBuilder(acct, sid, attempt);
  }
  get attemptNo(): number { return this.attempt; }
  /** Apply a report; returns the view it closed by starting a new attempt, if any. */
  apply(ev: Ev, sink: MinuteSink | null): ViewBuilder | null {
    let done: ViewBuilder | null = null;
    const last = this.current.last;
    if (last != null && ev.ts - last > RESUME_MS) {
      done = this.current;
      this.attempt++;
      this.current = new ViewBuilder(this.acct, this.sid, this.attempt);
    }
    this.current.apply(ev, sink);
    return done;
  }
}

/**
 * Derive every view and minute aggregate from a set of raw rows (a replay).
 * Rows of several accounts may be mixed; each row says its account.
 */
export function deriveAll(rows: Array<{ acct: string; sid: string; rt: number; app: string | null; line: string; ctx?: RawCtx | null }>): { views: ViewRow[]; minutes: MinuteRow[] } {
  const bySession = new Map<string, { acct: string; sid: string; evs: Ev[] }>();
  // The first context a session carried (the collector writes it once per POST).
  for (const row of rows) {
    const ev = toEvent(row);
    if (!ev) continue;
    const k = row.acct + '\u0001' + row.sid;
    let s = bySession.get(k);
    if (!s) { s = { acct: row.acct, sid: row.sid, evs: [] }; bySession.set(k, s); }
    s.evs.push(ev);
  }
  const sink = new MinuteSink();
  const views: ViewRow[] = [];
  for (const s of bySession.values()) {
    s.evs.sort(byReportOrder);
    const st = new SessionState(s.acct, s.sid);
    for (const ev of s.evs) {
      const done = st.apply(ev, sink);
      if (done?.isView) views.push(done.row());
    }
    if (st.current.isView) views.push(st.current.row());
  }
  return { views, minutes: sink.take() };
}
