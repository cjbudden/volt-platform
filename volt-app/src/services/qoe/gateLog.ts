// ============================================================================
//  THE PLAY GATE'S DECISIONS, TIMED, BY SID (QOE_REPORTING.md section 3,
//  report 7: DRM and access).
//
//  The player tells the gate its play attempt's sid (POST /api/availability),
//  so each decision the API makes can be joined to the view it belongs to: a
//  view that failed at the entitlement step is then attributed to WHY the gate
//  said no (geo, rights window, payment, sign in, the app's restrictions),
//  not just to "gate-451".
//
//  NEVER ON THE GATE'S PATH. recordGate only appends to a bounded in-memory
//  buffer; the rows go to the analytics database (qoe_gate) in one batch
//  every 10 s, with the collector's flush. A slow or absent analytics database
//  costs the gate nothing: the buffer is capped (MAX_PENDING) and the oldest
//  rows are dropped and counted beyond it.
//
//  QOE_GATE_LOG=off turns it off. Answers served from the edge cache never
//  reach the API, so they are not here: this is the gate's own work, not a
//  count of viewers.
// ============================================================================
import { analyticsPool } from './analyticsDb';
import { chInsert } from './clickhouse';
import { forEachTarget, qoeChDatabase } from './storeSwitch';

export const MAX_PENDING = 50_000;
export const FLUSH_MS = 10_000;

/** What the gate decided, in words a report can group by. */
export type GateReason = 'allowed' | 'replacement' | 'geo' | 'rights' | 'payment' | 'sign_in' | 'group' | 'rules' | 'availability'
  | 'app_restriction' | 'unknown_asset' | 'error';

export interface GateRow {
  account_id: string; app_id: string | null; sid: string | null; at: number; method: 'GET' | 'POST';
  status: number; mode: string | null; reason: GateReason; layer: string | null; rule_id: string | null;
  asset_id: string | null; asset_kind: string | null; country: string | null; ms: number;
}

/** What decide() learned on the way, so the reason can be told apart (modules/apps.ts). */
export interface GateNote { accountId?: string; appId?: string | null; kind?: string | null; geo?: string | null; rights?: any }

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * THE REASON, from the answer and the rights decision behind it:
 *   200 play / replacement                     allowed / replacement
 *   403 "blocked: ..." (referrer, origin, IP)  app_restriction
 *   404                                        unknown_asset
 *   account or channel geo                     geo
 *   the programme on air (blackout, licence)   rights
 *   on-demand availability: paid               payment
 *                           geo                geo
 *                           not published, scheduled, expired: availability
 *   access rules: geo, members_only, group, payment_required, other
 */
export function classifyGate(status: number, body: any, note: GateNote): { reason: GateReason; layer: string | null; ruleId: string | null } {
  const r = note.rights ?? null;
  const layer: string | null = r?.layer ?? null;
  const ruleId: string | null = r?.rule?.ruleId ?? null;
  if (status === 200) return { reason: body?.mode === 'replacement' ? 'replacement' : 'allowed', layer, ruleId };
  if (status === 404) return { reason: 'unknown_asset', layer, ruleId };
  if (status === 403 && typeof body?.error === 'string' && body.error.startsWith('blocked:')) return { reason: 'app_restriction', layer, ruleId };
  if (status >= 500) return { reason: 'error', layer, ruleId };
  if (layer === 'account' || layer === 'channel') return { reason: 'geo', layer, ruleId };
  if (layer === 'programme') return { reason: 'rights', layer, ruleId };
  if (layer === 'rules') {
    const why = r?.rule?.reason;
    return { reason: why === 'geo' ? 'geo' : why === 'members_only' ? 'sign_in' : why === 'group' ? 'group' : why === 'payment_required' ? 'payment' : 'rules', layer, ruleId };
  }
  if (layer === 'on_demand') {
    const why = String(r?.reason ?? '');
    if (/payment|entitlement/i.test(why) || status === 402) return { reason: 'payment', layer, ruleId };
    if (/not available in/i.test(why)) return { reason: 'geo', layer, ruleId };
    if (r?.rule?.reason === 'members_only' || body?.mode === 'sign_in') return { reason: 'sign_in', layer, ruleId };
    return { reason: 'availability', layer, ruleId };
  }
  if (status === 402) return { reason: 'payment', layer, ruleId };
  if (body?.mode === 'sign_in') return { reason: 'sign_in', layer, ruleId };
  return { reason: 'rules', layer, ruleId };
}

let pending: GateRow[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
export const gateStats = { recorded: 0, written: 0, dropped: 0, flushFailures: 0, lastError: null as string | null };

const enabled = () => (process.env.QOE_GATE_LOG ?? 'on') !== 'off';

/** Note one decision. Never throws, never waits. */
export function recordGate(row: GateRow): void {
  try {
    if (!enabled() || !UUID.test(row.account_id)) return;
    pending.push({
      ...row,
      app_id: row.app_id && UUID.test(row.app_id) ? row.app_id : null,
      sid: row.sid ? row.sid.slice(0, 64) : null,
      asset_id: row.asset_id ? row.asset_id.slice(0, 64) : null,
      ms: Math.max(0, Math.round(row.ms)),
    });
    gateStats.recorded++;
    if (pending.length > MAX_PENDING) { const n = pending.length - MAX_PENDING; pending.splice(0, n); gateStats.dropped += n; }
    if (!timer) { timer = setInterval(() => { void flushGate(); }, FLUSH_MS); timer.unref?.(); }
  } catch { /* the gate never fails because of its log */ }
}

/** Write what is buffered (the collector's flush calls this too). Never throws. */
export async function flushGate(): Promise<void> {
  if (flushing) return flushing;
  if (!pending.length) return;
  flushing = (async () => {
    const rows = pending; pending = [];
    try {
      await forEachTarget({
        // While moving to ClickHouse, decisions before the switch minute are copied there from Postgres (storeSwitch.ts).
        clickhouse: (since) => chInsert('qoe_gate', rows.filter((r) => since == null || r.at >= since).map((r) => ({ ...r, at: new Date(r.at).toISOString() })), qoeChDatabase()),
        postgres: async () => {
          const p = await analyticsPool();
          for (let i = 0; i < rows.length; i += 2000) {
            const part = rows.slice(i, i + 2000).map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
            await p.query(
              `INSERT INTO qoe_gate (account_id, app_id, sid, at, method, status, mode, reason, layer, rule_id, asset_id, asset_kind, country, ms)
               SELECT account_id, app_id, sid, at, method, status, mode, reason, layer, rule_id, asset_id, asset_kind, country, ms
               FROM jsonb_populate_recordset(NULL::qoe_gate, $1::jsonb)`, [JSON.stringify(part)]);
          }
        },
      });
      gateStats.written += rows.length; gateStats.lastError = null;
    } catch (e) {
      gateStats.flushFailures++; gateStats.lastError = (e as Error).message;
      // Kept for the next flush, newest last, within the cap.
      pending = rows.concat(pending);
      if (pending.length > MAX_PENDING) { const n = pending.length - MAX_PENDING; pending.splice(0, n); gateStats.dropped += n; }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

/** For tests. */
export function resetGateLog(): void {
  pending = [];
  Object.assign(gateStats, { recorded: 0, written: 0, dropped: 0, flushFailures: 0, lastError: null });
}
export function gatePending(): number { return pending.length; }
