// ============================================================================
//  THE COLLECTOR'S LIVE PATH: VIEW ROWS AND MINUTE AGGREGATES AS REPORTS
//  ARRIVE (QOE_REPORTING.md sections 3 and 9a).
//
//  modules/cmcd.ts writes each accepted batch to the raw store FIRST and only
//  then hands it here. This keeps each live session's state in memory
//  (views.ts SessionState, the same code a replay runs), and every 10 s
//  writes, in one batch each:
//    - the views that closed (quit, fatal error, or 60 s without reports; a
//      view that resumes within 60 minutes is written again, same id),
//    - the minute aggregates gathered since the last flush (they add), and
//    - the collector's own counts of accepted and refused lines.
//
//  BACKPRESSURE, NOT LOSS. If the analytics database is slow or down, the
//  writes are kept (views by id, minutes merged) up to MAX_PENDING_VIEWS and
//  tried again at the next flush; the player has had its 204 long before and
//  never sees it. Beyond the bound the oldest pending views are dropped and
//  counted, and the replay of that day restores them from the raw reports.
//  Nothing here touches the control plane's pool.
//
//  ONE PROCESS PER SESSION. On the Mac the API is one process. With several
//  collector tasks behind the load balancer a session's batches can land on
//  different tasks; each then holds part of it, so live view rows of such
//  sessions are provisional until the day is replayed (build queue 2.11 routes
//  by sid). QOE_DERIVE=off turns the live path off (raw is still kept).
// ============================================================================
import { MinuteSink, SessionState, SILENCE_MS, RESUME_MS, toEvent, byReportOrder, type MinuteRow, type ViewRow, type Ev } from './views';
import type { RawRow } from './rawStore';
import { addCollectorCounts, addMinutes, writeViews } from './store';
import { flushGate, gatePending, gateStats } from './gateLog';

export const FLUSH_MS = 10_000;
export const MAX_PENDING_VIEWS = 200_000;

interface Live { st: SessionState; lastRt: number; writtenAt: number }
const sessions = new Map<string, Live>();
/** A session dropped after RESUME_MS of silence: the next report from it starts attempt n + 1. */
const finished = new Map<string, { attempt: number; at: number }>();
let sink = new MinuteSink();
const pendingViews = new Map<string, ViewRow>();
let counts = new Map<string, { account_id: string; minute: number; accepted: number; rejected: number; reasons: Record<string, number> }>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
export const stats = { ingested: 0, viewsWritten: 0, minuteRowsWritten: 0, flushFailures: 0, droppedViews: 0, lastError: null as string | null };

const enabled = () => (process.env.QOE_DERIVE ?? 'on') !== 'off';
const skey = (acct: string, sid: string) => acct + '\u0001' + sid;
const vkey = (v: ViewRow) => v.account_id + '|' + v.view_id;

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => { void flushQoe(); }, FLUSH_MS);
  timer.unref?.();
}

/** The lines the collector accepted and refused, for report 12. */
export function countReports(acct: string, at: number, accepted: number, reasons: string[]): void {
  if (!enabled()) return;
  const minute = Math.floor(at / 60_000) * 60_000;
  const k = acct + '|' + minute;
  let c = counts.get(k);
  if (!c) { c = { account_id: acct, minute, accepted: 0, rejected: 0, reasons: {} }; counts.set(k, c); }
  c.accepted += accepted;
  c.rejected += reasons.length;
  for (const r of reasons) { const why = r.replace(/ at \d+$/, '').slice(0, 40); c.reasons[why] = (c.reasons[why] ?? 0) + 1; }
  ensureTimer();
}

/** Hand the collector a batch it has already kept raw. */
export function ingestReports(acct: string, rows: RawRow[]): void {
  if (!enabled() || !rows.length) return;
  const evs: Array<{ sid: string; ev: Ev }> = [];
  for (const row of rows) { const ev = toEvent(row); if (ev) evs.push({ sid: row.sid, ev }); }
  // In report order within the batch, as a replay will read them.
  evs.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : byReportOrder(a.ev, b.ev)));
  for (const { sid, ev } of evs) {
    const k = skey(acct, sid);
    let l = sessions.get(k);
    if (!l) {
      const f = finished.get(k);
      l = { st: new SessionState(acct, sid, f ? f.attempt + 1 : 1), lastRt: ev.rt, writtenAt: 0 };
      if (f) finished.delete(k);
      sessions.set(k, l);
    }
    const done = l.st.apply(ev, sink);
    if (done?.isView) { const r = done.row(); pendingViews.set(vkey(r), r); }
    l.lastRt = Math.max(l.lastRt, ev.rt);
    // quit and fatal end the view now; it stays in memory in case it resumes
    if (l.st.current.ended && l.st.current.isView) { const r = l.st.current.row(); pendingViews.set(vkey(r), r); l.writtenAt = l.lastRt; }
    stats.ingested++;
  }
  ensureTimer();
}

/** Close the views that went quiet and forget sessions silent past resuming. */
function sweep(now: number) {
  for (const [k, l] of sessions) {
    const quiet = now - l.lastRt;
    const v = l.st.current;
    if (quiet > SILENCE_MS && v.isView && l.writtenAt < l.lastRt) {
      const r = v.row(); pendingViews.set(vkey(r), r);
      l.writtenAt = l.lastRt;
    }
    if (quiet > RESUME_MS) {
      sessions.delete(k);
      finished.set(k, { attempt: l.st.attemptNo, at: now });
    }
  }
  for (const [k, f] of finished) if (now - f.at > 24 * 3_600_000) finished.delete(k);
}

/**
 * Write what is due. Called every FLUSH_MS; tests call it directly with their
 * own clock. Never throws: a failed write is kept for the next flush.
 */
export async function flushQoe(now = Date.now()): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    sweep(now);
    const views = [...pendingViews.entries()];
    pendingViews.clear();
    const minutes = sink.take();
    const c = [...counts.values()]; counts = new Map();
    try {
      if (views.length) await writeViews(views.map(([, v]) => v));
      stats.viewsWritten += views.length;
      // a view written now replaces itself next time: its key is its id
      if (minutes.length) await addMinutes(minutes);
      stats.minuteRowsWritten += minutes.length;
      if (c.length) await addCollectorCounts(c);
      stats.lastError = null;
    } catch (e) {
      stats.flushFailures++;
      stats.lastError = (e as Error).message;
      requeue(views, minutes, c);
    }
    // The play gate's decisions (report 7) go in the same beat; its own buffer and bound.
    await flushGate();
  })().finally(() => { flushing = null; });
  return flushing;
}

function requeue(views: Array<[string, ViewRow]>, minutes: MinuteRow[], c: Array<{ account_id: string; minute: number; accepted: number; rejected: number; reasons: Record<string, number> }>) {
  // Newer versions of the same view (arrived during the failed write) win.
  for (const [k, v] of views) if (!pendingViews.has(k)) pendingViews.set(k, v);
  while (pendingViews.size > MAX_PENDING_VIEWS) { const first = pendingViews.keys().next().value as string; pendingViews.delete(first); stats.droppedViews++; }
  for (const m of minutes) sink.merge(m);
  for (const x of c) {
    const k = x.account_id + '|' + x.minute;
    const have = counts.get(k);
    if (!have) counts.set(k, x);
    else { have.accepted += x.accepted; have.rejected += x.rejected; for (const [r, n] of Object.entries(x.reasons)) have.reasons[r] = (have.reasons[r] ?? 0) + n; }
  }
}

/** What is held in memory now (the console's telemetry panel, tests). */
export function collectorState() {
  return { sessions: sessions.size, pendingViews: pendingViews.size, pendingMinuteRows: sink.rows.size, ...stats,
    gate: { pending: gatePending(), ...gateStats } };
}

/** For tests: forget everything held in memory. */
export function resetCollector(): void {
  sessions.clear(); finished.clear(); pendingViews.clear(); sink = new MinuteSink(); counts = new Map();
  Object.assign(stats, { ingested: 0, viewsWritten: 0, minuteRowsWritten: 0, flushFailures: 0, droppedViews: 0, lastError: null });
}
