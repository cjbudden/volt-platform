// ============================================================================
//  REPORT 11: ONE VIEWER'S SESSION, IN ORDER (QOE_REPORTING.md section 5).
//
//  "What happened to this viewer?" Built from the RAW reports (rawStore.ts),
//  not the view rows: every play state change, error, quality change,
//  heartbeat, sampled response, ad break, backgrounding and rate change the
//  player sent for one sid, in the player's own order, with
//    - the states laid out as spans (playing, stalled, seeking, paused,
//      backgrounded, ad), worked out the same way the view rows are,
//    - the view rows the reports made of it (views.ts, so the timeline and
//      the numbers can be checked against each other),
//    - the play gate's decisions for that sid (gateLog.ts), and
//    - the server-side ad beacons the stitcher sent for that viewer, when the
//      module passes them in (its stitcher session is named after the sid).
//  Gaps in the sequence numbers are listed, so a missing report shows as
//  missing rather than as nothing happening.
//
//  Which days to read: the days the sid's views started (from the view
//  rows) and the day after; with no view rows, the last two days. A timeline
//  can be shown for as long as the raw files are kept (the local folder on
//  the Mac; in the cloud, the S3 lifecycle in deploy/terraform/qoe_raw.tf).
// ============================================================================
import { aquery } from './analyticsDb';
import { readDay, type RawRow } from './rawStore';
import { toEvent, byReportOrder, SessionState, type Ev } from './views';
import type { CmcdValue } from './cmcdParse';

const VOLT = 'com.volt-';

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
const kbps = (k: number | null) => (k == null ? '' : k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${Math.round(k)} kbps`);
const secs = (ms: number | null) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

const STATE_WORDS: Record<string, string> = {
  s: 'Play pressed', d: 'Waiting for the viewer to press play', p: 'Playing', r: 'Stalled (rebuffering)', k: 'Seeking', a: 'Paused',
  w: 'Waiting', e: 'Ended', f: 'Stopped by an error', q: 'Left',
};
const OT_WORDS: Record<string, string> = { m: 'manifest', v: 'video segment', a: 'audio segment', i: 'init segment', c: 'caption segment' };

export type Kind = 'state' | 'error' | 'quality' | 'heartbeat' | 'request' | 'ad' | 'background' | 'rate' | 'sound' | 'other';
export interface TimelineEvent {
  at: string; ts: number; offsetMs: number; receivedAt: string; sn: number | null; e: string; kind: Kind; label: string;
  problem: boolean; detail: Record<string, string | number | boolean>;
}
export interface Span { state: 'starting' | 'playing' | 'stalled' | 'seeking' | 'paused' | 'backgrounded' | 'ad' | 'ended'; from: number; to: number; ms: number }

/** One report in plain words. */
function describe(ev: Ev, firstFrameSeen: boolean): { kind: Kind; label: string; problem: boolean; detail: Record<string, string | number | boolean> } {
  const r = ev.r as Record<string, CmcdValue>;
  const d: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(r)) {
    if (['v', 'ts', 'e', 'sid', 'sn'].includes(k)) continue;
    const x = num(v) ?? str(v) ?? (v === true ? true : null);
    if (x != null) d[k] = x as any;
  }
  switch (ev.e) {
    case 'ps': {
      const sta = str(r.sta) ?? '';
      if (sta === 'p' && !firstFrameSeen) {
        const msd = num(r.msd);
        return { kind: 'state', label: `First frame${msd != null ? ` after ${secs(msd)}` : ''}${num(r.br) != null ? ` at ${kbps(num(r.br))}` : ''}`, problem: false, detail: d };
      }
      return { kind: 'state', label: STATE_WORDS[sta] ?? `Play state ${sta}`, problem: sta === 'r' || sta === 'f', detail: d };
    }
    case 'e': {
      const http = num(r[VOLT + 'http']);
      return { kind: 'error', label: `Error ${str(r.ec) ?? 'unknown'} at the ${str(r[VOLT + 'step']) ?? 'unknown'} step${http ? ` (HTTP ${http})` : ''}`, problem: true, detail: d };
    }
    case 'bc': return { kind: 'quality', label: `Quality changed to ${kbps(num(r.br))}`, problem: false, detail: d };
    case 't': {
      const parts: string[] = [];
      if (num(r.bl) != null) parts.push(`buffer ${secs(num(r.bl))}`);
      if (num(r.mtp) != null) parts.push(`throughput ${kbps(num(r.mtp))}`);
      if (num(r.pb) != null) parts.push(`playing ${kbps(num(r.pb))}`);
      if (num(r.ltc) != null) parts.push(`${secs(num(r.ltc))} behind live`);
      if (num(r.dfa) != null) parts.push(`${num(r.dfa)} dropped frames so far`);
      return { kind: 'heartbeat', label: `Heartbeat${parts.length ? ': ' + parts.join(', ') : ''}`, problem: false, detail: d };
    }
    case 'rr': {
      const rc = num(r.rc) ?? 0;
      const what = str(r[VOLT + 'req']) ?? OT_WORDS[str(r.ot) ?? ''] ?? 'request';
      const t = num(r.ttlb);
      return { kind: 'request', label: `${what[0].toUpperCase()}${what.slice(1)} answered ${rc || 'nothing (network)'}${t != null ? ` in ${secs(t)}` : ''}`, problem: rc === 0 || rc >= 400 || (t ?? 0) >= 2000, detail: d };
    }
    case 'abs': return { kind: 'ad', label: `Ad break started${str(r[VOLT + 'brk']) ? ` (${str(r[VOLT + 'brk'])})` : ''}`, problem: false, detail: d };
    case 'abe': return { kind: 'ad', label: 'Ad break ended', problem: false, detail: d };
    case 'as': return { kind: 'ad', label: 'Ad started', problem: false, detail: d };
    case 'ae': return { kind: 'ad', label: 'Ad ended', problem: false, detail: d };
    case 'b': return { kind: 'background', label: r.bg === true ? 'Went to the background' : 'Back in the foreground', problem: false, detail: d };
    case 'pr': return { kind: 'rate', label: `Playback rate ${num(r.pr) ?? '?'}x`, problem: false, detail: d };
    case 'm': return { kind: 'sound', label: 'Muted', problem: false, detail: d };
    case 'um': return { kind: 'sound', label: 'Unmuted', problem: false, detail: d };
    default: return { kind: 'other', label: `Report ${ev.e}`, problem: false, detail: d };
  }
}

/** The states as spans: the same rules as views.ts (backgrounded wins, then ad, then the play state). */
function spans(evs: Ev[]): Span[] {
  const out: Span[] = [];
  let sta: string | null = null, bg = false, ad = false, last: number | null = null;
  const stateNow = (): Span['state'] | null => {
    if (bg) return 'backgrounded';
    if (ad) return 'ad';
    switch (sta) { case 's': return 'starting'; case 'p': return 'playing'; case 'r': return 'stalled'; case 'k': return 'seeking'; case 'a': return 'paused'; case 'e': case 'f': case 'q': return 'ended'; default: return null; }
  };
  for (const ev of evs) {
    const cur = stateNow();
    if (last != null && cur && ev.ts > last && ev.ts - last <= 60_000) {
      const prev = out[out.length - 1];
      if (prev && prev.state === cur && prev.to === last) { prev.to = ev.ts; prev.ms = prev.to - prev.from; }
      else out.push({ state: cur, from: last, to: ev.ts, ms: ev.ts - last });
    }
    last = last == null ? ev.ts : Math.max(last, ev.ts);
    if (ev.e === 'ps') { const s = str(ev.r.sta); if (s && sta !== 'q' && sta !== 'f') sta = s; }
    else if (ev.e === 'b') bg = ev.r.bg === true;
    else if (ev.e === 'abs') ad = true;
    else if (ev.e === 'abe') ad = false;
  }
  return out.filter((s) => s.state !== 'ended' && s.ms > 0);
}

/** The sequence numbers that never arrived. */
function gaps(evs: Ev[]): number[] {
  const sns = new Set(evs.map((e) => e.sn).filter((x): x is number => x != null));
  if (!sns.size) return [];
  const max = Math.max(...sns), out: number[] = [];
  for (let i = 1; i <= max && out.length < 200; i++) if (!sns.has(i)) out.push(i);
  return out;
}

export interface BeaconRow { at: string; event: string; adId: string | null; podIndex: number; ok: boolean | null; status: number | null; breakId: string | null }

/** Report 11 for one sid of one account, or null when nothing is known about it. */
export async function sessionTimeline(acct: string, sid: string, opts: { now?: number; beacons?: (sid: string) => Promise<BeaconRow[]> } = {}) {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(sid)) return null;
  const now = opts.now ?? Date.now();
  const viewRows = await aquery<any>(`SELECT * FROM qoe_views WHERE account_id = $1 AND sid = $2 ORDER BY attempt`, [acct, sid]);
  // The days to read: each view's start day and the day after (a view over midnight), else the last two days.
  const days = new Set<string>();
  for (const v of viewRows) {
    const d0 = new Date(v.started_at).getTime();
    days.add(new Date(d0).toISOString().slice(0, 10));
    days.add(new Date(d0 + 86_400_000).toISOString().slice(0, 10));
    days.add(new Date(new Date(v.ended_at).getTime()).toISOString().slice(0, 10));
  }
  if (!days.size) for (let i = 1; i >= 0; i--) days.add(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  const raw: RawRow[] = [];
  for (const day of [...days].sort()) {
    if (Date.parse(day) > now + 86_400_000) continue;
    raw.push(...await readDay(acct, day, (r) => r.sid === sid));
  }
  const evs = raw.map((r) => toEvent(r)).filter((e): e is Ev => !!e).sort(byReportOrder);
  // Drop a report the player sent twice (a retried batch): same sn, same report.
  const seen = new Set<number>();
  const uniq = evs.filter((e) => (e.sn == null ? true : seen.has(e.sn) ? false : (seen.add(e.sn), true)));
  const gate = await aquery<any>(`SELECT at, method, status, mode, reason, layer, rule_id, asset_id, asset_kind, country, ms FROM qoe_gate WHERE account_id = $1 AND sid = $2 ORDER BY at`, [acct, sid]);
  const beacons = opts.beacons ? await opts.beacons(sid).catch(() => []) : [];
  if (!uniq.length && !viewRows.length && !gate.length) return null;

  // The views as the reports count them, from these same reports (so they can be compared to the stored rows).
  const st = new SessionState(acct, sid);
  const derived: any[] = [];
  for (const ev of uniq) { const done = st.apply(ev, null); if (done?.isView) derived.push(done.row()); }
  if (st.current.isView) derived.push(st.current.row());

  const t0 = uniq.length ? uniq[0].ts : (gate[0] ? new Date(gate[0].at).getTime() : now);
  let ff = false;
  const events: TimelineEvent[] = uniq.map((ev) => {
    const dsc = describe(ev, ff);
    if (ev.e === 'ps' && str(ev.r.sta) === 'p') ff = true;
    return { at: new Date(ev.ts).toISOString(), ts: ev.ts, offsetMs: ev.ts - t0, receivedAt: new Date(ev.rt).toISOString(), sn: ev.sn, e: ev.e, ...dsc };
  });
  const first = uniq.find((e) => e.ctx) ?? null;
  return {
    sid, from: new Date(t0).toISOString(), to: uniq.length ? new Date(uniq[uniq.length - 1].ts).toISOString() : null,
    reports: uniq.length, duplicates: evs.length - uniq.length, missingSequence: gaps(uniq),
    viewer: first?.ctx ? { userAgent: first.ctx.ua ?? null, country: first.ctx.cc ?? null, region: first.ctx.rg ?? null, asn: first.ctx.asn ?? null } : null,
    views: viewRows.map((v) => ({ ...v, started_at: new Date(v.started_at).toISOString(), ended_at: new Date(v.ended_at).toISOString() })),
    derived,
    spans: spans(uniq).map((s) => ({ ...s, fromOffsetMs: s.from - t0, toOffsetMs: s.to - t0 })),
    events,
    gate: gate.map((g) => ({ at: new Date(g.at).toISOString(), offsetMs: new Date(g.at).getTime() - t0, method: g.method, status: g.status, mode: g.mode, reason: g.reason,
      layer: g.layer, ruleId: g.rule_id, assetId: g.asset_id, assetKind: g.asset_kind, country: g.country, ms: g.ms })),
    beacons: beacons.map((b) => ({ ...b, offsetMs: new Date(b.at).getTime() - t0 })),
  };
}
