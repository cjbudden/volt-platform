// ============================================================================
//  Pipeline health — the five-gate model (SERVER → INPUT → ENCODER → OUTPUT →
//  PUBLIC) computed from REAL telemetry only (stream_status + stream_events +
//  the encoder log tail). This is the single source of truth for:
//    - the detail page badge (no more false OUTPUT ERROR on "starting")
//    - the one primary error message / banner
//    - the QC / diagnose page (per-gate state + real reasons)
//
//  A gate is a GATE: a later gate can only be healthy if the earlier ones are.
//  States: idle | starting | healthy | degraded | failed | stopped.
//    - starting  = warming up; NOT an error.
//    - degraded  = still on air but not right (e.g. output stalled, on backup).
//    - failed    = down and blocking the gates after it.
//    - stopped   = a person/scheduler ended it (never an error).
// ============================================================================

export type GateName = 'server' | 'input' | 'encoder' | 'output' | 'public';
export type GateStatus = 'idle' | 'starting' | 'healthy' | 'degraded' | 'failed' | 'stopped';

export interface Gate {
  gate: GateName;
  label: string;
  status: GateStatus;
  detail: string;          // human reason (real ffmpeg/packager text where relevant)
  billable: boolean;       // does this gate cost money while up? (server only)
}

export interface PipelineHealth {
  gates: Gate[];
  primaryError: { gate: GateName; label: string; message: string } | null;
  onAir: boolean;          // output is being served
  live: boolean;           // owner.status === 'live'
}

interface Ev { seq?: number; type: string; detail: any; ts?: any }

function d(detail: any): any {
  if (!detail) return {};
  if (typeof detail === 'string') { try { return JSON.parse(detail); } catch { return { text: detail }; } }
  return detail;
}

/** A channel.stop reason that means "someone/something asked it to stop", not a crash. */
function isCleanStop(reason: string): boolean {
  return /^(stopped|operator|signal:SIG(TERM|INT)|server_window_closed|.*window.*)/i.test(reason || '')
    && !/exited rc=|stall|fatal|error/i.test(reason || '');
}

export interface HealthInput {
  ownerStatus: string;                        // 'live' | 'ended' | 'idle' | 'scheduled' | ...
  st: any | null;                             // stream_status row
  events: Ev[];                               // newest-first
  logTailErrors: string[];                    // recent error lines from encoder.log
  hasPrimarySource: boolean;                  // a primary source is configured
  packagingLabel: string;                     // 'HLS + DASH' etc.
}

export function computePipelineHealth(inp: HealthInput): PipelineHealth {
  const { ownerStatus, st, events, logTailErrors, hasPrimarySource } = inp;
  const live = ownerStatus === 'live';
  const ended = ownerStatus === 'ended';

  // Only reason about the CURRENT run: everything at/after the latest channel.start.
  // events is newest-first, so the current run's start is the first channel.start we hit.
  const startIdx = events.findIndex((e) => e.type === 'channel.start');
  const run = startIdx >= 0 ? events.slice(0, startIdx + 1) : events.slice();
  const firstOf = (rx: RegExp) => run.find((e) => rx.test(e.type));
  // "unresolved" = the failure event has no recovery event newer than it (newer = lower index)
  const unresolved = (failRx: RegExp, okRx: RegExp) => {
    const fi = run.findIndex((e) => failRx.test(e.type));
    if (fi < 0) return null;
    const oi = run.findIndex((e) => okRx.test(e.type));
    return (oi < 0 || oi > fi) ? run[fi] : null;   // no recovery, or recovery is older
  };

  const stall = unresolved(/output\.stalled/, /output\.resumed/);
  const srcDown = unresolved(/source\.down/, /source\.up/);
  const inputErr = unresolved(/input\.error/, /source\.up/);
  const lastStop = firstOf(/channel\.stop/);
  const stopReason = lastStop ? String(d(lastStop.detail).reason || 'stopped') : '';
  const crashedStop = !!lastStop && !isCleanStop(stopReason);

  const outputAvailable = !!st?.output_available;
  const packagerOk = !!st?.packager_ok;
  const reporting = !!st;
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};
  const primary = sstates['primary'] || null;
  const primaryUp = primary?.state === 'up';
  const firstErrLine = logTailErrors[0];

  const gates: Gate[] = [];

  // ---- 1) SERVER (the billable compute) ------------------------------------
  gates.push({
    gate: 'server', label: 'Server', billable: true,
    ...(live
      ? { status: 'healthy' as GateStatus, detail: 'encoder compute up' }
      : ended
        ? (crashedStop
            ? { status: 'failed' as GateStatus, detail: `stopped: ${stopReason}` }
            : { status: 'stopped' as GateStatus, detail: stopReason ? `stopped (${stopReason})` : 'stopped' })
        : { status: 'idle' as GateStatus, detail: 'no server running (£0)' }),
  });

  // ---- 2) INPUT (is the source arriving?) ----------------------------------
  let inputStatus: GateStatus; let inputDetail: string;
  if (!live) { inputStatus = ended ? 'stopped' : 'idle'; inputDetail = hasPrimarySource ? 'source configured · idle' : 'no source configured'; }
  else if (inputErr) { inputStatus = 'failed'; inputDetail = String(d(inputErr.detail).message || firstErrLine || 'input error'); }
  else if (srcDown) { inputStatus = 'failed'; inputDetail = firstErrLine || 'source down — no signal'; }
  else if (primaryUp) { inputStatus = 'healthy'; inputDetail = String(primary?.detail || 'receiving'); }
  else if (reporting) { inputStatus = 'starting'; inputDetail = 'waiting for the source to arrive'; }
  else { inputStatus = 'starting'; inputDetail = 'connecting to source'; }
  gates.push({ gate: 'input', label: 'Input', billable: false, status: inputStatus, detail: inputDetail });

  // ---- 3) ENCODER (running & keeping up?) -----------------------------------
  let encStatus: GateStatus; let encDetail: string;
  if (!live) { encStatus = ended ? 'stopped' : 'idle'; encDetail = 'not running'; }
  else if (crashedStop && /exited rc=/i.test(stopReason)) { encStatus = 'failed'; encDetail = firstErrLine || stopReason; }
  else if (packagerOk) { encStatus = 'healthy'; encDetail = 'transcoding · packager healthy'; }
  else { encStatus = 'starting'; encDetail = 'starting encoder + packager'; }
  gates.push({ gate: 'encoder', label: 'Encoder', billable: false, status: encStatus, detail: encDetail });

  // ---- 4) OUTPUT (segments advancing?) -------------------------------------
  let outStatus: GateStatus; let outDetail: string;
  if (!live) { outStatus = ended ? 'stopped' : 'idle'; outDetail = 'no output'; }
  else if (stall) { outStatus = 'degraded'; outDetail = String(d(stall.detail).message || 'output stalled — no new segments'); }
  else if (outputAvailable) { outStatus = 'healthy'; outDetail = `advancing · ${inp.packagingLabel}`; }
  else if (inputStatus === 'failed' || encStatus === 'failed') { outStatus = 'idle'; outDetail = 'waiting on the upstream gate'; }
  else { outStatus = 'starting'; outDetail = 'waiting for the first segments'; }
  gates.push({ gate: 'output', label: 'Output', billable: false, status: outStatus, detail: outDetail });

  // ---- 5) PUBLIC (being served) --------------------------------------------
  const onAir = live && outStatus === 'healthy';
  gates.push({
    gate: 'public', label: 'On air', billable: false,
    status: !live ? (ended ? 'stopped' : 'idle') : onAir ? 'healthy' : 'starting',
    detail: onAir ? 'output served to viewers' : !live ? 'off air' : 'not on air yet',
  });

  // ---- primary error: first failed/degraded gate, with its real reason ------
  const order: GateName[] = ['server', 'input', 'encoder', 'output', 'public'];
  let primaryError: PipelineHealth['primaryError'] = null;
  for (const name of order) {
    const g = gates.find((x) => x.gate === name)!;
    if (g.status === 'failed' || g.status === 'degraded') {
      primaryError = { gate: g.gate, label: g.label, message: g.detail };
      break;
    }
  }

  return { gates, primaryError, onAir, live };
}
