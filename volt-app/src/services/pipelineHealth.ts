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
import { config } from '../config';
import { diagnoseFailure, eventLine, type FailureDiagnosis } from './failureDiagnosis';

export type GateStatus = 'idle' | 'starting' | 'ready' | 'healthy' | 'degraded' | 'failed' | 'stopped';

export interface Gate {
  gate: GateName;
  label: string;
  status: GateStatus;
  detail: string;
  billable: boolean;
}

export type OverallStatus = 'idle' | 'starting' | 'ready' | 'onair' | 'degraded' | 'error' | 'stopped';

export interface PipelineHealth {
  gates: Gate[];
  primaryError: { gate: GateName; label: string; message: string } | null;
  onAir: boolean;
  live: boolean;
  /**
   * A fault was recorded, but the run is young enough that it is still being
   * given a chance to recover. Presented as 'starting' rather than 'error'.
   */
  settling?: boolean;
  /** The fault that was recorded, kept verbatim from the moment it happened. */
  settlingReason?: string | null;
  // ONE consistent roll-up of the gates, used everywhere (list + detail) so the
  // channel's status never disagrees with itself:
  //   error    — a gate failed (blocks the pipeline)
  //   degraded — a gate is degraded (e.g. transient output stall); recovers on its own
  //   onair    — published AND serving valid content (green / LIVE)
  //   ready    — output is valid but private (ready to go on air)
  //   starting — live and warming up, no error yet
  //   stopped/idle — not running
  overall: OverallStatus;
  /** What the platform thinks went wrong, when something did. See failureDiagnosis.ts. */
  diagnosis?: FailureDiagnosis | null;
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
  outputAgeMs?: number | null; // ms since the newest manifest was rewritten (null = none yet)
  onAirPublished?: boolean;   // the operator has taken this channel ON AIR (public URL open)
  /**
   * WHEN THE RUN NOW IN PROGRESS WAS LAUNCHED, epoch ms.
   *
   * The orchestrator writes status='live' the moment it launches the task, but
   * the encoder does not post channel.start until a second or two later. In
   * that gap the newest channel.start in the table belongs to the PREVIOUS run,
   * and its channel.stop is newer still -- so the run window below would
   * describe a station that is starting perfectly well using the reason the
   * last one died. That is the error that flashes on screen at every startup
   * and then vanishes.
   *
   * Optional, and absent means "no boundary known", which is exactly the old
   * behaviour. A caller that cannot say when the run started is not made worse.
   */
  runStartedAt?: number | null;
  /** Auto connect state, so the diagnosis can say whether a retry is coming. */
  recovery?: {
    autoConnect?: boolean; armed?: boolean; attempts?: number; maxAttempts?: number;
    gaveUp?: boolean; lastError?: string | null;
  } | null;
}

/** The auto connect columns of a channel or event row, in the shape the
 *  diagnosis wants. One place, so the three health builders agree. */
export function recoveryOf(row: any): NonNullable<HealthInput['recovery']> | null {
  if (!row) return null;
  return {
    autoConnect: row.auto_connect !== false,
    armed: row.resume_armed_at != null,
    attempts: Number(row.resume_attempts ?? 0) || 0,
    maxAttempts: config.orchestrator.resumeMaxAttempts,
    gaveUp: row.resume_gave_up_at != null,
    lastError: row.resume_last_error ?? null,
  };
}

export function computePipelineHealth(inp: HealthInput): PipelineHealth {
  const { ownerStatus, st, events, logTailErrors } = inp;
  const live = ownerStatus === 'live';
  const ended = ownerStatus === 'ended';

  // REASON ONLY ABOUT THE CURRENT RUN, and about nothing that predates it.
  //
  // Two boundaries, because one is not enough. The channel.start boundary finds
  // the newest run the ENCODER has reported. The launch boundary discards
  // anything older than the run the ORCHESTRATOR has actually started. During
  // the gap between the two -- every startup passes through it -- only the
  // second one exists, and without it the previous run's crash is read as this
  // run's state.
  const runStartedAt = inp.runStartedAt ?? null;
  const fresh = runStartedAt == null
    ? events
    : events.filter((e) => {
        const t = e.ts ? Date.parse(String(e.ts)) : NaN;
        // A GRACE OF ONE SECOND on the boundary itself. The launch timestamp and
        // the encoder's first event are written by different processes against
        // different clocks, and losing a legitimate channel.start to a few
        // milliseconds of skew would be a worse bug than the one being fixed.
        return !Number.isFinite(t) || t >= runStartedAt - 1000;
      });
  const startIdx = fresh.findIndex((e) => e.type === 'channel.start');
  const run = startIdx >= 0 ? fresh.slice(0, startIdx + 1) : fresh.slice();
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
  // A source problem is described from the SOURCE side. The log tail also carries
  // the packager's own glog warnings ("W1009 12:00:00 ... representation.cc:429] Found
  // a gap ..."), which are not about the input and mean nothing to an operator; one of
  // them was shown as the Input gate's error during a failover (9 Oct).
  const isPackagerLine = (l: string) => /^[WEIF]\d{4} \d|\.cc:\d+\]|kRoundingErrorGrace|shaka|packager/i.test(l);
  const firstErrLine = logTailErrors.find((l) => !isPackagerLine(l));
  // encoder is genuinely running only if live AND it hasn't crashed this run
  const effLive = live && !crashed;

  // OUTPUT GROUND TRUTH: the origin manifest mtime. Shaka rewrites it every segment,
  // so if it stops advancing the pipeline has stalled RIGHT NOW — regardless of what a
  // stale encoder flag says. This is what makes a transient stall blip amber and then
  // clear when segments resume, instead of sitting falsely green.
  const STALE_MS = 15000;
  const outAge = inp.outputAgeMs ?? null;
  const outFresh = outAge != null ? outAge < STALE_MS : !!inp.outputFresh;
  const manifestSeen = outAge != null;
  const outStalled = effLive && manifestSeen && outAge! >= STALE_MS;
  const stalledFor = outStalled ? `${Math.round(outAge! / 1000)}s` : '';

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
  else if (srcDown) {
    // With failover, losing ONE source is not a failed input: the selector is already
    // on the next one. Say which source went and what is on air instead.
    const groups = Object.entries(sstates).filter(([k]) => k !== 'filler');
    const down = groups.filter(([, v]: any) => v?.state === 'down').map(([k]) => k);
    const upNow = groups.filter(([, v]: any) => v?.state === 'up').map(([k]) => k);
    const active = String(st?.active_source || '');
    if (active && active !== 'filler' && upNow.includes(active)) {
      inputStatus = 'degraded';
      inputDetail = `${down.length ? down.join(' and ') : 'a source'} lost · ${active} on air`;
    } else if (active === 'filler') {
      inputStatus = 'failed';
      inputDetail = 'all sources lost · the channel slate or loop is on air';
    } else {
      inputStatus = 'failed';
      inputDetail = firstErrLine || 'source down — no signal';
    }
  }
  else if (primaryUp && outStalled) { inputStatus = 'degraded'; inputDetail = firstErrLine || `source may have dropped — output stalled ${stalledFor}`; }
  else if (primaryUp) { inputStatus = 'healthy'; inputDetail = crashIsEncoder ? 'receiving — but the encoder failed' : String(primary?.detail || 'receiving'); }
  else if (reporting) { inputStatus = 'starting'; inputDetail = 'waiting for the source to arrive'; }
  else { inputStatus = 'starting'; inputDetail = 'connecting to source'; }
  gates.push({ gate: 'input', label: 'Input', billable: false, status: inputStatus, detail: inputDetail });

  // ---- 3) ENCODER (running & keeping up?) -----------------------------------
  let encStatus: GateStatus; let encDetail: string;
  if (crashIsEncoder) { encStatus = 'failed'; encDetail = firstErrLine || stopReason; }
  else if (crashIsInput) { encStatus = 'idle'; encDetail = 'no input to encode'; }
  else if (!live) { encStatus = ended ? 'stopped' : 'idle'; encDetail = 'not running'; }
  else if (outStalled) { encStatus = 'degraded'; encDetail = firstErrLine || `no new segments for ${stalledFor}`; }
  else if (packagerOk || outFresh) { encStatus = 'healthy'; encDetail = 'transcoding · packager healthy'; }
  else { encStatus = 'starting'; encDetail = 'starting encoder + packager'; }
  gates.push({ gate: 'encoder', label: 'Encoder', billable: false, status: encStatus, detail: encDetail });

  // ---- 4) OUTPUT (segments advancing?) -------------------------------------
  // GROUND TRUTH first: if the origin manifest is actually advancing on disk, the
  // output IS healthy — don't trust a stale/optimistic encoder flag over reality.
  let outStatus: GateStatus; let outDetail: string;
  if (crashed) { outStatus = 'failed'; outDetail = `no output — ${stopReason}`; }
  else if (!live) { outStatus = ended ? 'stopped' : 'idle'; outDetail = 'no output'; }
  else if (outFresh) { outStatus = 'healthy'; outDetail = `advancing · ${inp.packagingLabel}`; }
  else if (outStalled) { outStatus = 'degraded'; outDetail = firstErrLine || `output stalled — no new segments for ${stalledFor}`; }
  else if (stall) { outStatus = 'degraded'; outDetail = String(d(stall.detail).message || 'output stalled — no new segments'); }
  else if (inputStatus === 'failed' || encStatus === 'failed') { outStatus = 'idle'; outDetail = 'waiting on the upstream gate'; }
  else if (outputAvailable && !manifestSeen) { outStatus = 'starting'; outDetail = 'packaging — first segments not on disk yet'; }
  else { outStatus = 'starting'; outDetail = 'waiting for the first segments'; }
  gates.push({ gate: 'output', label: 'Output', billable: false, status: outStatus, detail: outDetail });

  // ---- 5) PUBLIC / ON AIR --------------------------------------------------
  // The model:
  //   NOT published        -> READY (blue) when the output is valid but private, else
  //                           idle/starting/stopped. Nothing is public.
  //   published + valid    -> HEALTHY (green): the public URL is serving live content.
  //   published + NOT valid-> FAILED (red): we are on air but the public stream has no
  //                           valid content, so viewers can't watch — surface the error.
  // "valid content" = the packaged output is actually advancing (outputFresh ground truth).
  const outputValid = effLive && outStatus === 'healthy';
  const published = !!inp.onAirPublished;
  let pubStatus: GateStatus; let pubDetail: string;
  if (published) {
    if (outputValid) { pubStatus = 'healthy'; pubDetail = 'on air · public can watch'; }
    else if (crashed) { pubStatus = 'failed'; pubDetail = `on air but the public stream failed: ${stopReason}`; }
    else if (!effLive) { pubStatus = 'failed'; pubDetail = 'on air but the stream is down'; }
    else { pubStatus = 'failed'; pubDetail = `on air but no valid content: ${outDetail}`; }
  } else if (!effLive) {
    pubStatus = ended || crashed ? 'stopped' : 'idle';
    pubDetail = crashed ? 'off air (pipeline failed)' : 'off air';
  } else if (outputValid) {
    pubStatus = 'ready'; pubDetail = 'ready — private until you go on air';
  } else {
    pubStatus = 'starting'; pubDetail = 'warming up';
  }
  gates.push({ gate: 'public', label: 'On air', billable: false, status: pubStatus, detail: pubDetail });

  // ==========================================================================
  //  THE SETTLING WINDOW: record the fault now, present it as an error later.
  //
  //  A pipeline takes seconds to come up, and auto connect retries a genuine
  //  failure every twenty seconds without anybody watching. So a fault in the
  //  first moments is usually one of two things that need no operator: the
  //  pipeline still starting, or a blip the system is about to fix. Showing red
  //  for both is how an operator learns to ignore red.
  //
  //  WHAT THIS IS NOT. It does not suppress, delay or discard the fault. Every
  //  gate keeps its real detail, `settling` names the reason, and the caller can
  //  render "starting - retrying after <reason>". The only thing that changes is
  //  the STATUS a failed gate reports, and only while the run is young.
  //
  //  It applies to a LIVE run inside the window and to nothing else. A stopped
  //  station reads stopped immediately; a station that has been failing for two
  //  minutes reads error, which is the case that actually needs a person.
  // ==========================================================================
  const settleMs = Math.max(0, config.health.settleSeconds * 1000);
  const runAgeMs = runStartedAt == null ? null : Date.now() - runStartedAt;
  // IN THE WINDOW is not the same as SETTLING. A healthy station in its first
  // ninety seconds is healthy, not "starting": the flag has to mean "a fault was
  // recorded and is being held back", or every station reads as still coming up
  // for its first minute and a half and the word stops meaning anything.
  const inWindow = live && runAgeMs != null && runAgeMs < settleMs;
  let settlingReason: string | null = null;
  if (inWindow) {
    for (const g of gates) {
      if (g.status !== 'failed') continue;
      // The reason is kept verbatim and carried on the gate. Losing it here
      // would mean re-deriving it later from whatever is left in the log, which
      // is how a startup failure ends up reported as something else entirely.
      settlingReason = settlingReason ?? g.detail;
      g.status = 'starting';
      g.detail = `starting — ${g.detail}`;
    }
  }

  // Settling only if something was actually held back.
  const settling = settlingReason != null;

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

  // ONE overall roll-up, derived from the gates so list + detail always agree.
  const anyFailed = gates.some((g) => g.status === 'failed');
  const anyDegraded = gates.some((g) => g.status === 'degraded');
  let overall: OverallStatus;
  // SETTLING WINS over the crash-derived roll-up. Converting the gates alone
  // was not enough: `effLive` is false whenever the run has recorded a crash, so
  // a settling station rolled up to 'idle' -- which reads as "nothing is
  // happening" for a station that is actively being retried. While the window
  // is open the honest word is 'starting'.
  if (settling) overall = 'starting';
  else if (anyFailed) overall = 'error';
  else if (anyDegraded) overall = 'degraded';
  else if (published && outputValid) overall = 'onair';
  else if (!effLive) overall = ended ? 'stopped' : 'idle';
  else if (outputValid) overall = 'ready';
  else overall = 'starting';

  // `onAir` is TRUE only when actually live to the public: published AND serving valid
  // content. `live` = the encoder run is up (billable), regardless of publish state.
  const diagnosis = diagnoseFailure({
    gates, primaryError, settlingReason,
    eventLines: run.filter((e) => /error|stop|down|stall|fail|silence|static/i.test(e.type)).map(eventLine),
    logLines: logTailErrors,
    recovery: inp.recovery ?? null,
  });

  return {
    gates, primaryError, onAir: published && outputValid, live: effLive, overall,
    // Named so the console can say "starting, retrying" with the captured
    // reason rather than either a bare spinner or a red box.
    settling: settling || false,
    settlingReason,
    diagnosis,
  };
}
