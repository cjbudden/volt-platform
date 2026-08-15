// ============================================================================
//  Pipeline health — the five-gate model (SERVER → INPUT → ENCODER → OUTPUT →
//  PUBLIC) computed from REAL telemetry only (stream_status + stream_events +
//  the encoder log tail). Single source of truth for the badge, the primary
//  error banner, and the QC / diagnose page.
//
//  A gate is a GATE: a later gate can only be healthy if the earlier ones are.
//  States: idle | starting | healthy | degraded | failed | stopped.
//    - starting  = warming up; NOT an error.
//    - degraded  = still on air but not right (e.g. output stalled, on backup).
//    - failed    = down and blocking the gates after it.
//    - stopped   = a person/scheduler ended it (never an error).
//
//  IMPORTANT: the encoder can die on its own (e.g. packager crash) BEFORE the
//  control plane flips the channel out of 'live'. So we do NOT trust the stale
//  'live' status: a crash-reason channel.stop / input.error in the current run
//  means the pipeline is down NOW, and we report it that way.
// ============================================================================

export type GateName = 'server' | 'input' | 'encoder' | 'output' | 'public';
export type GateStatus = 'idle' | 'starting' | 'healthy' | 'degraded' | 'failed' | 'stopped';

export interface Gate {
  gate: GateName;
  label: string;
  status: GateStatus;
  detail: string;
  billable: boolean;
}

export interface PipelineHealth {
  gates: Gate[];
  primaryError: { gate: GateName; label: string; message: string } | null;
  onAir: boolean;
  live: boolean;
}

interface Ev { seq?: number; type: string; detail: any; ts?: any }

function d(detail: any): any {
  if (!detail) return {};
  if (typeof detail === 'string') { try { return JSON.parse(detail); } catch { return { text: detail }; } }
  return detail;
}

/** A channel.stop reason that means "asked to stop", not a crash. */
function isCleanStop(reason: string): boolean {
  return /^(stopped|operator|signal:SIG(TERM|INT)|server_window_closed|.*window.*)/i.test(reason || '')
    && !/exited rc=|stall|fatal|error|bind|file_failure/i.test(reason || '');
}

export interface HealthInput {
  ownerStatus: string;
  st: any | null;
  events: Ev[];               // newest-first
  logTailErrors: string[];    // recent error lines from encoder.log (newest-first)
  hasPrimarySource: boolean;
  packagingLabel: string;
  outputFresh?: boolean;      // GROUND TRUTH: the origin manifest is advancing on disk now
}

export function computePipelineHealth(inp: HealthInput): PipelineHealth {
  const { ownerStatus, st, events, logTailErrors } = inp;
  const live = ownerStatus === 'live';
  const ended = ownerStatus === 'ended';

  // reason only about the CURRENT run: everything at/after the latest channel.start
  const startIdx = events.findIndex((e) => e.type === 'channel.start');
  const run = startIdx >= 0 ? events.slice(0, startIdx + 1) : events.slice();
  const firstOf = (rx: RegExp) => run.find((e) => rx.test(e.type));
  const unresolved = (failRx: RegExp, okRx: RegExp) => {
    const fi = run.findIndex((e) => failRx.test(e.type));
    if (fi < 0) return null;
    const oi = run.findIndex((e) => okRx.test(e.type));
    return (oi < 0 || oi > fi) ? run[fi] : null;
  };

  const stall = unresolved(/output\.stalled/, /output\.resumed/);
  const srcDown = unresolved(/source\.down/, /source\.up/);
  const inputErr = unresolved(/input\.error/, /source\.up/);
  const lastStop = firstOf(/channel\.stop/);
  const stopReason = lastStop ? String(d(lastStop.detail).reason || 'stopped') : '';
  const crashed = !!lastStop && !isCleanStop(stopReason);

  // Which gate the crash belongs to. Packager/Shaka/bind/file_failure => encoder;
  // relay/transcode/input/ffmpeg exit => input.
  const inputErrMsg = inputErr ? String(d(inputErr.detail).message || '') : '';
  const crashIsEncoder = crashed && /packager|shaka|bind|file_failure|encoder/i.test(stopReason + ' ' + inputErrMsg);
  const crashIsInput = crashed && !crashIsEncoder;

  const outputAvailable = !!st?.output_available;
  const packagerOk = !!st?.packager_ok;
  const reporting = !!st;
  const sstates: Record<string, any> = (st && st.sources && typeof st.sources === 'object') ? st.sources : {};
  const primary = sstates['primary'] || null;
  const primaryUp = primary?.state === 'up';
  const firstErrLine = logTailErrors[0];
  // encoder is genuinely running only if live AND it hasn't crashed this run
  const effLive = live && !crashed;

  const gates: Gate[] = [];

  // ---- 1) SERVER (billable compute) ----------------------------------------
  gates.push({
    gate: 'server', label: 'Server', billable: true,
    ...(live
      ? { status: 'healthy' as GateStatus, detail: 'encoder compute up' }
      : ended
        ? (crashed
            ? { status: 'failed' as GateStatus, detail: `stopped: ${stopReason}` }
            : { status: 'stopped' as GateStatus, detail: stopReason ? `stopped (${stopReason})` : 'stopped' })
        : { status: 'idle' as GateStatus, detail: 'no server running (£0)' }),
  });

  // ---- 2) INPUT (is the source arriving?) ----------------------------------
  let inputStatus: GateStatus; let inputDetail: string;
  if (crashIsInput) { inputStatus = 'failed'; inputDetail = inputErrMsg || firstErrLine || stopReason; }
  else if (!live && !crashed) { inputStatus = ended ? 'stopped' : 'idle'; inputDetail = inp.hasPrimarySource ? 'source configured · idle' : 'no source configured'; }
  else if (inputErr) { inputStatus = 'failed'; inputDetail = inputErrMsg || firstErrLine || 'input error'; }
  else if (srcDown) { inputStatus = 'failed'; inputDetail = firstErrLine || 'source down — no signal'; }
  else if (primaryUp) { inputStatus = 'healthy'; inputDetail = crashIsEncoder ? 'receiving — but the encoder failed' : String(primary?.detail || 'receiving'); }
  else if (reporting) { inputStatus = 'starting'; inputDetail = 'waiting for the source to arrive'; }
  else { inputStatus = 'starting'; inputDetail = 'connecting to source'; }
  gates.push({ gate: 'input', label: 'Input', billable: false, status: inputStatus, detail: inputDetail });

  // ---- 3) ENCODER (running & keeping up?) -----------------------------------
  let encStatus: GateStatus; let encDetail: string;
  if (crashIsEncoder) { encStatus = 'failed'; encDetail = firstErrLine || stopReason; }
  else if (crashIsInput) { encStatus = 'idle'; encDetail = 'no input to encode'; }
  else if (!live) { encStatus = ended ? 'stopped' : 'idle'; encDetail = 'not running'; }
  else if (packagerOk) { encStatus = 'healthy'; encDetail = 'transcoding · packager healthy'; }
  else { encStatus = 'starting'; encDetail = 'starting encoder + packager'; }
  gates.push({ gate: 'encoder', label: 'Encoder', billable: false, status: encStatus, detail: encDetail });

  // ---- 4) OUTPUT (segments advancing?) -------------------------------------
  // GROUND TRUTH first: if the origin manifest is actually advancing on disk, the
  // output IS healthy — don't trust a stale/optimistic encoder flag over reality.
  let outStatus: GateStatus; let outDetail: string;
  if (crashed) { outStatus = 'failed'; outDetail = `no output — ${stopReason}`; }
  else if (!live) { outStatus = ended ? 'stopped' : 'idle'; outDetail = 'no output'; }
  else if (inp.outputFresh || outputAvailable) { outStatus = 'healthy'; outDetail = `advancing · ${inp.packagingLabel}`; }
  else if (stall) { outStatus = 'degraded'; outDetail = String(d(stall.detail).message || 'output stalled — no new segments'); }
  else if (inputStatus === 'failed' || encStatus === 'failed') { outStatus = 'idle'; outDetail = 'waiting on the upstream gate'; }
  else { outStatus = 'starting'; outDetail = 'waiting for the first segments'; }
  gates.push({ gate: 'output', label: 'Output', billable: false, status: outStatus, detail: outDetail });

  // ---- 5) PUBLIC (being served) --------------------------------------------
  const onAir = effLive && outStatus === 'healthy';
  gates.push({
    gate: 'public', label: 'On air', billable: false,
    status: !effLive ? (ended || crashed ? 'stopped' : 'idle') : onAir ? 'healthy' : 'starting',
    detail: onAir ? 'output served to viewers' : crashed ? 'off air (pipeline failed)' : !live ? 'off air' : 'not on air yet',
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

  return { gates, primaryError, onAir, live: effLive };
}
