// ============================================================================
//  WHAT AUTO-CONNECT IS DOING ABOUT THIS STREAM, AS ONE DECISION.
//
//  Pure, and in its own file, because the rule has been wrong twice and both
//  times it was wrong in a way that looked fine on the page it was written on.
//
//    First it showed nothing while a stream was being retried, so recovery was
//    invisible and "resume is not working" was the only available conclusion.
//
//    Then it read resume_attempts > 0 as "retrying", and a fully healthy
//    station with audio on the meter and every gate green announced that auto
//    reconnect was retrying, attempt 1 of 5.
//
//  THE SECOND ONE IS THE INTERESTING MISTAKE. resume_attempts is a BUDGET
//  LEDGER, not a live activity flag. An attempt is spent at launch and
//  deliberately NOT cleared by a successful start, because a crash loop starts
//  successfully every single time and clearing it there would make the cap
//  unreachable. The count is handed back by expireStaleBudgets once the run has
//  outlived the budget TTL, which is ten minutes of staying up. So for ten
//  minutes after any recovery, a perfectly healthy stream carries attempts=1.
//  The number was right. The sentence built from it was not.
//
//  What makes "retrying" TRUE is that the stream is not up. And the authority
//  on that is the pipeline health, never the status column: `status='live'` is
//  a claim that something was started, not evidence that it is running. That
//  distinction has bitten this codebase in three separate places now.
// ============================================================================

/** The pipeline's roll-up, as pipelineHealth.ts computes it. */
export type OverallState =
  | 'idle' | 'starting' | 'ready' | 'onair' | 'degraded' | 'error' | 'stopped';

export type RecoveryKind = 'none' | 'retrying' | 'gave_up' | 'auto_off' | 'not_armed';

export interface RecoveryView {
  kind: RecoveryKind;
  /** One sentence for an operator, or '' when there is nothing to say. */
  text: string;
  /** The encoder's own words for why it last stopped, verbatim, or null. */
  lastError: string | null;
}

/** Attempts before auto-connect stops trying (config.orchestrator.resumeMaxAttempts). */
export const RESUME_MAX_ATTEMPTS = 5;

/**
 * Up means BYTES ARE MOVING, not that a row says live.
 *
 * `starting` is deliberately excluded. A stream that is starting after a failed
 * attempt is exactly when the retry count is worth showing, and calling that
 * "up" would hide the one moment the operator most wants it.
 */
export function isUp(state?: OverallState | string | null): boolean {
  return state === 'onair' || state === 'ready' || state === 'degraded';
}

/**
 * Decide what, if anything, to tell the operator about recovery.
 *
 * Takes the raw row because the channel and radio payloads spell these fields
 * differently — one maps to camelCase, the other spreads the database row — and
 * a shared rule that only understood one of them would be shared in name only.
 */
export function recoveryView(row: any, state?: OverallState | string | null): RecoveryView {
  const none: RecoveryView = { kind: 'none', text: '', lastError: null };
  if (!row) return none;

  const pick = (a: string, b: string) => row[a] ?? row[b] ?? null;
  const attempts = Number(pick('resumeAttempts', 'resume_attempts') ?? 0) || 0;
  const gaveUpAt = pick('resumeGaveUpAt', 'resume_gave_up_at');
  const lastError = pick('resumeLastError', 'resume_last_error');
  const autoConnect = pick('autoConnect', 'auto_connect');
  const wantsToRun = pick('desiredState', 'desired_state') === 'running';

  // GIVE-UP OUTRANKS EVERYTHING, including a stream that is somehow up: it means
  // nothing will bring this back on its own, which stays true until a person
  // presses Start, and that is worth saying whatever else is happening.
  if (gaveUpAt) {
    const when = new Date(gaveUpAt).toLocaleString();
    return {
      kind: 'gave_up',
      text: `Auto reconnect gave up at ${when} after ${attempts} attempt${attempts === 1 ? '' : 's'}. Starting it again clears this.`,
      lastError,
    };
  }

  // Running. Whatever it took to get here is history, and history belongs in
  // the event log rather than in a banner over a working stream.
  if (isUp(state)) return none;

  if (autoConnect === false && wantsToRun) {
    return {
      kind: 'auto_off',
      text: 'Auto reconnect is switched off for this stream, so nothing will restart it if it stops.',
      lastError,
    };
  }

  if (attempts > 0) {
    return {
      kind: 'retrying',
      text: `Auto reconnect is retrying: attempt ${attempts} of ${RESUME_MAX_ATTEMPTS}.`,
      lastError,
    };
  }

  // NOT ARMED: the stream is meant to run, is not up, and this run never
  // reached a healthy pipeline. Auto connect only puts back a stream that has
  // proved itself, so nothing is going to retry this; the failure has been
  // left where it fell for the operator to read. Only worth saying once there
  // is a failure to read: a stream still coming up is simply starting.
  const armedAt = pick('resumeArmedAt', 'resume_armed_at');
  if (wantsToRun && !armedAt && (lastError || state === 'error') && state !== 'starting') {
    return {
      kind: 'not_armed',
      text: 'This start did not reach a healthy pipeline, so auto reconnect is not armed and nothing will retry it. Open QC for the likely reason, fix it, then press Start.',
      lastError,
    };
  }

  return none;
}
