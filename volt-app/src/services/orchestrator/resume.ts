// ============================================================================
//  AUTO CONNECT — putting the fleet back after a reboot.
//
//  The question: after the control plane restarts, which streams should be on
//  air, and what is the fastest way to get them there?
//
//  ------------------------------------------------------------------------
//  ADOPT BEFORE RESTART. This is the whole reason the pass is worth writing
//  rather than just calling start on everything.
//
//  A task container accepts no inbound connections. It pulls from its source,
//  pushes segments to storage and pushes status to the API — so it does not
//  care whether the control plane exists. A control plane that restarts in
//  thirty seconds comes back to encoders that never stopped encoding and
//  stations that never left the relay. Restarting those would take a working
//  channel off air, lose the live edge, cut the recording in two and pay for a
//  fresh container, in order to reach a state it was already in.
//
//  So the order is:
//
//    1. ASK THE LAUNCHER about the open instance rows. If any task is `alive`,
//       ADOPT it: mark the owner live again, reopen the day's recording, and
//       touch nothing else. This is instant and interrupts nobody.
//    2. If every task is definitely `dead`, the row is a leftover claim. Reap
//       it and start fresh.
//    3. If the launcher says `unknown`, DO NOTHING THIS PASS. An unreachable
//       API is not a dead task, and starting a second encoder into the same
//       output namespace is far worse than waiting twenty seconds. The retry
//       is what makes waiting cheap.
//
//  ------------------------------------------------------------------------
//  WHAT MAKES A STREAM A CANDIDATE is intent, not status.
//
//    desired_state = 'running'   somebody started it
//    AND no recorded stop        nobody has since decided it should be off
//    AND auto_connect            the operator has not opted this one out
//
//  `status` is deliberately not consulted. It is a cache of an observation and
//  it is routinely wrong after a crash — and run-on-mac.sh rewrites it to
//  'ended' before the API even boots, so anything keyed on it would be
//  defeated by a line in a shell script.
//
//  ------------------------------------------------------------------------
//  FIVE ATTEMPTS, TWENTY SECONDS APART, THEN STOP AND SAY WHY.
//
//  Unbounded retry against a source that is genuinely gone launches a
//  container every twenty seconds for as long as the process lives, and every
//  one of them is billable. The counter is in the database, not in memory, so
//  a control plane that crashes mid-recovery does not restart the count and
//  loop forever. Giving up is recorded with the reason, and any manual start
//  or stop clears it, so the operator is never stuck with a stream the system
//  has quietly written off.
// ============================================================================
import { query, one } from '../../db';
import { config } from '../../config';
import type { Orchestrator } from './service';
import type { Liveness } from './launcher';

export type OwnerKind = 'channel' | 'event';

export interface ResumeCandidate {
  kind: OwnerKind;
  id: string;
  name: string;
  attempts: number;
}

export interface ResumeOutcome {
  kind: OwnerKind;
  id: string;
  name: string;
  /**
   * adopted    a task was already running; we simply re-attached to it
   * started    nothing was running; a fresh one was launched
   * waiting    the launcher could not say; nothing was touched this pass
   * failed     the start threw; will be retried until the attempt cap
   * gave_up    the attempt cap was reached; the reason is recorded on the row
   */
  result: 'adopted' | 'started' | 'waiting' | 'failed' | 'gave_up';
  error?: string;
}

export interface ResumeResult {
  considered: number;
  adopted: number;
  started: number;
  waiting: number;
  failed: number;
  gaveUp: number;
  outcomes: ResumeOutcome[];
}

/**
 * Streams that should be running and are not known to be.
 *
 * `resume_last_attempt_at` orders the list so the least-recently-attempted is
 * always reached first: with a large fleet and a bounded batch, ordering by
 * anything else would let one unlucky stream be starved behind its neighbours
 * for as long as the process lives.
 */
export async function resumeCandidates(cooldownSeconds: number, limit = 200): Promise<ResumeCandidate[]> {
  const sql = (table: string, kind: OwnerKind) => `
    SELECT '${kind}'::text AS kind, o.id, o.name, o.resume_attempts AS attempts,
           o.resume_last_attempt_at
      FROM ${table} o
     WHERE o.desired_state = 'running'
       AND o.auto_connect
       AND o.resume_gave_up_at IS NULL
       AND o.resume_attempts < $1
       -- AND THE STREAM HAS PROVED ITSELF. Auto connect puts back a stream
       -- that WAS working. A run that never reached server + input + encoder
       -- + output all healthy is a failed start, and relaunching a failed
       -- start five times only buries the reason it failed. The stamp is
       -- written by armProvenStreams and cleared by a person's Start or Stop.
       AND o.resume_armed_at IS NOT NULL
       -- AND WE DO NOT ALREADY BELIEVE IT IS ON AIR.
       --
       -- This pass repairs a mismatch between intent and reality. A stream the
       -- control plane records as live, with an open task row behind that
       -- record, is not a mismatch and there is nothing here to do.
       --
       -- Without this clause an adopted stream is a candidate again on the very
       -- next pass, for ever: adoption clears resume_attempts but sets no
       -- cooldown, so it re-qualifies immediately, and every pass then spends a
       -- launcher round trip and a write re-adopting something that never
       -- stopped. A demo machine logged "adopted Groove Salad - its task never
       -- stopped" every twenty seconds for the life of the process.
       --
       -- The header above says status is not consulted for INTENT, and it still
       -- is not: intent is desired_state. This is a different question, asked
       -- after boot reconciliation has already corrected status, and paired
       -- with the task row so a stale 'live' with nothing behind it stays a
       -- candidate. The mirror case, a live record whose task is a dead claim,
       -- belongs to reconcileStreamStatus on the orchestrator tick; it marks
       -- the owner ended and this pass picks it up next time round.
       AND NOT (o.status = 'live' AND EXISTS (
                  SELECT 1 FROM instances i
                   WHERE i.${kind === 'channel' ? 'channel_id' : 'event_id'} = o.id
                     AND i.terminated_at IS NULL
                     AND i.role = 'primary'))
       -- The cooldown. Without it a pass that runs more often than the retry
       -- interval would burn all five attempts in a few seconds and give up
       -- before a source that is merely slow to come back ever had a chance.
       AND (o.resume_last_attempt_at IS NULL
            OR o.resume_last_attempt_at < now() - make_interval(secs => $2))`;
  return query<ResumeCandidate>(
    `${sql('channels', 'channel')}
     UNION ALL
     ${sql('events', 'event')}
     ORDER BY resume_last_attempt_at NULLS FIRST
     LIMIT $3`,
    [config.orchestrator.resumeMaxAttempts, cooldownSeconds, limit]
  );
}

/** Is anything actually running for this owner right now? */
async function liveness(orch: Orchestrator, kind: OwnerKind, id: string): Promise<Liveness> {
  const col = kind === 'channel' ? 'channel_id' : 'event_id';
  const open = await query<any>(
    `SELECT task_arn FROM instances
      WHERE ${col} = $1 AND terminated_at IS NULL AND role = 'primary'`,
    [id]
  );
  if (!open.length) return 'dead';

  const launcher = orch.launcherForFleet();
  let sawUnknown = false;
  for (const inst of open) {
    // A LEGACY IN-PROCESS STATION (config.orchestrator.radioMode ===
    // 'inprocess'). The launcher has never heard of its arn, so asking the
    // launcher would answer 'dead' for a station that is playing right now,
    // and auto-connect would tear it down and rebuild it every retry interval.
    // That is not a hypothetical: it took a passing end-to-end radio suite
    // apart the first time this pass ran alongside it.
    //
    // The process table is the only thing that knows. After a real reboot it
    // is empty, which is the correct answer — an in-process station dies with
    // the process that spawned it, which is the whole reason radio was moved
    // to containers.
    if (String(inst.task_arn ?? '').startsWith('radio:')) {
      if (kind === 'channel') {
        try {
          const { isRadioRunning } = await import('../radio/pipeline');
          if (isRadioRunning(id)) return 'alive';
        } catch { sawUnknown = true; }
      }
      continue;
    }
    let state: Liveness = 'unknown';
    try { state = await launcher.isRunning(inst.task_arn); }
    catch { state = 'unknown'; }
    if (state === 'alive') return 'alive';
    if (state === 'unknown') sawUnknown = true;
  }
  // ANY doubt wins over a definite dead. Deciding "dead" on an incomplete
  // answer means launching a second encoder into the same output namespace as
  // a possibly-live first one, which corrupts the live edge rather than merely
  // costing money.
  return sawUnknown ? 'unknown' : 'dead';
}

/**
 * Record that an attempt happened, whatever came of it.
 *
 * ONE ATTEMPT IS ONE RESTART, counted here, at the moment the restart is made.
 * It used to be counted only when the start THREW, which missed the case that
 * actually matters: a start that succeeds and dies a second later. That is now
 * counted here too, and countFlap no longer counts it a second time, so five
 * attempts means five relaunches rather than two and a half.
 *
 * A null error is not "no attempt". It is an attempt whose outcome is not known
 * yet, which is exactly what a successful launch is. The give-up therefore
 * turns on the COUNT, not on whether this particular call had an error to
 * report; the reason is filled in by whichever call last had one.
 */
async function stampAttempt(kind: OwnerKind, id: string, error: string | null, attempts: number): Promise<void> {
  const table = kind === 'channel' ? 'channels' : 'events';
  const giveUp = attempts + 1 >= config.orchestrator.resumeMaxAttempts;
  const wasUp = giveUp ? await one<any>(`SELECT resume_gave_up_at FROM ${table} WHERE id = $1`, [id]) : null;
  await query(
    `UPDATE ${table}
        SET resume_attempts = resume_attempts + 1,
            resume_last_attempt_at = now(),
            resume_last_error = COALESCE($2, resume_last_error),
            resume_gave_up_at = CASE WHEN $3 THEN now() ELSE resume_gave_up_at END
      WHERE id = $1`,
    [id, error?.slice(0, 300) ?? null, giveUp]
  );
  if (giveUp && !wasUp?.resume_gave_up_at) await announceGiveUp(kind, id);
}

/**
 * Auto connect giving up is exactly the moment somebody needs to know, and
 * until now it only showed if somebody happened to open the channel page.
 * The account's owners and admins are told: in the console inbox always, by
 * email and push where those are configured. Only on the transition into
 * given up, so a channel sitting given up does not repeat itself every tick.
 */
async function announceGiveUp(kind: OwnerKind, id: string): Promise<void> {
  const table = kind === 'channel' ? 'channels' : 'events';
  const row = await one<any>(
    `SELECT o.name, o.resume_last_error, o.resume_attempts, g.account_id
       FROM ${table} o JOIN groups g ON g.id = o.group_id WHERE o.id = $1`, [id]).catch(() => null);
  if (!row) return;
  const { notifyAccountAdmins } = await import('../notifications');
  const what = kind === 'channel' ? 'channel' : 'event';
  await notifyAccountAdmins(row.account_id, 'auto_connect.gave_up',
    `${row.name}: auto connect has stopped trying`,
    `Volt tried to bring the ${what} "${row.name}" back ${row.resume_attempts} time(s) and has stopped.\n\n` +
    `Last error: ${row.resume_last_error ?? 'none recorded'}\n\nOpen the ${what} in the console to see what happened and start it again.`,
    { kind, id, name: row.name });
}

/**
 * Stop trying, now, and say why.
 *
 * The counter is still incremented so the attempt is visible in the history
 * rather than a give-up appearing from nowhere, but the give-up stamp does not
 * wait for the cap: nothing about a missing source improves by trying it again
 * in two minutes.
 */
async function giveUpNow(kind: OwnerKind, id: string, error: string): Promise<void> {
  const table = kind === 'channel' ? 'channels' : 'events';
  const wasUp = await one<any>(`SELECT resume_gave_up_at FROM ${table} WHERE id = $1`, [id]);
  await query(
    `UPDATE ${table}
        SET resume_attempts = resume_attempts + 1,
            resume_last_attempt_at = now(),
            resume_last_error = $2,
            resume_gave_up_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 300)]
  );
  if (!wasUp?.resume_gave_up_at) await announceGiveUp(kind, id);
}

/**
 * Adoption ends the recovery: clear the counters.
 *
 * NOTE WHAT THIS IS NOT CALLED FOR ANY MORE. It used to run after a successful
 * startStream too, and that was the bug that made the give-up cap unreachable.
 * A start returning does not mean the stream recovered; it means a process was
 * launched. In a crash loop every launch succeeds and the encoder dies a second
 * later, so the counter the crash had just incremented was zeroed by the very
 * next start and the count read 1, 1, 1, 1 for ever.
 *
 * Adoption is different, and is why this function still exists: it is only ever
 * reached when the launcher has confirmed a task is ALIVE. That is evidence,
 * not optimism. The budget is otherwise handed back by countFlap, when a run
 * ends having outlived the flap window.
 */
async function clearAttempts(kind: OwnerKind, id: string): Promise<void> {
  await query(
    `UPDATE ${kind === 'channel' ? 'channels' : 'events'}
        SET resume_attempts = 0, resume_last_error = NULL, resume_gave_up_at = NULL
      WHERE id = $1`,
    [id]
  );
}

/**
 * EXPIRE A RECOVERY BUDGET THAT BELONGS TO A LOOP THAT IS OVER.
 *
 * The five-attempt cap stops a stream relaunching every twenty seconds against
 * a source that is gone. It was never meant to be a permanent verdict, and as
 * written it was one: the counter lives in the database and nothing reset it,
 * so a station that hit the cap stayed given up across every restart of the
 * control plane and never auto-started again. An operator restarting the server
 * and finding a station that will not come back has been given the opposite of
 * what auto connect is for.
 *
 * The test is TIME SINCE THE LAST ATTEMPT, not "did we restart". A restart is
 * not special: what matters is whether the attempts that were spent belong to
 * the situation happening now. Ten minutes of quiet is far longer than the
 * twenty second retry interval, so a genuine loop can never age out midway
 * through itself, and anything older is a different situation.
 *
 * Returns how many were freed, so a boot that unsticks a fleet says so.
 */
export async function expireStaleBudgets(): Promise<number> {
  const ttl = config.orchestrator.resumeBudgetTtlSeconds;
  if (!(ttl > 0)) return 0;
  let freed = 0;
  for (const table of ['channels', 'events']) {
    const rows = await query<{ id: string }>(
      `UPDATE ${table}
          SET resume_attempts = 0, resume_gave_up_at = NULL
        WHERE desired_state = 'running'
          AND auto_connect
          AND (resume_attempts > 0 OR resume_gave_up_at IS NOT NULL)
          AND resume_last_attempt_at IS NOT NULL
          AND resume_last_attempt_at < now() - make_interval(secs => $1)
        RETURNING id`,
      [ttl]
    );
    freed += rows.length;
  }
  // resume_last_error is deliberately NOT cleared. The budget is spent; the
  // reason it was spent is still the most recent thing known about why this
  // stream stopped, and an operator looking at it after a restart should still
  // see it.
  return freed;
}

/**
 * One pass.
 *
 * Each candidate is independent: one stream whose source is unreachable must
 * not prevent the other thirty-nine from coming back, which is why every
 * outcome is caught per owner rather than allowed to abort the pass.
 */
export async function resumeOnce(orch: Orchestrator): Promise<ResumeResult> {
  const out: ResumeResult = {
    considered: 0, adopted: 0, started: 0, waiting: 0, failed: 0, gaveUp: 0, outcomes: [],
  };
  const cooldown = config.orchestrator.resumeRetrySeconds;
  // Free anything whose loop is long over, BEFORE choosing candidates, so a
  // freed stream is picked up on this pass rather than the next one.
  const freed = await expireStaleBudgets().catch((e) => {
    console.error('[resume] could not expire stale budgets', e); return 0;
  });
  if (freed) console.log(`[resume] ${freed} stream(s) had a stale recovery budget; giving them a fresh start`);
  // Arm anything that has proved itself since the last pass, BEFORE choosing
  // candidates, so a stream that came good and then dropped inside one
  // interval is still recovered.
  await armProvenStreams().catch((e) => console.error('[resume] arming pass failed', e));
  const candidates = await resumeCandidates(cooldown);
  out.considered = candidates.length;

  for (const c of candidates) {
    const state = await liveness(orch, c.kind, c.id);

    // ---- already running: adopt, do not restart ---------------------------
    if (state === 'alive') {
      try {
        await orch.adoptRunning(c.kind, c.id);
        await clearAttempts(c.kind, c.id);
        out.adopted++;
        out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'adopted' });
        console.log(`[resume] adopted ${c.kind} ${c.name} (${c.id}) — its task never stopped`);
      } catch (e) {
        out.failed++;
        out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'failed', error: String(e) });
        await stampAttempt(c.kind, c.id, `adopt failed: ${String((e as any)?.message ?? e)}`, c.attempts);
      }
      continue;
    }

    // ---- cannot tell: leave it entirely alone -----------------------------
    if (state === 'unknown') {
      out.waiting++;
      out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'waiting' });
      // NOT stamped as an attempt. A launcher we cannot reach is not five
      // chances used up; it is no information. Stamping here would burn the
      // whole retry budget during a brief API outage and give up on a fleet
      // that was fine.
      console.log(`[resume] ${c.kind} ${c.name} (${c.id}) — launcher cannot say; leaving it alone this pass`);
      continue;
    }

    // ---- definitely not running: start it ---------------------------------
    try {
      // 'resume', not 'operator': this must not clear the attempt counter it
      // is in the middle of spending. See StartIntent.
      await orch.startStream(c.kind, c.id, 'resume');
      // DELIBERATELY NOT clearAttempts. Launching is not recovering. The
      // counter is spent here and handed back only once a run proves itself by
      // outliving the flap window. See clearAttempts and countFlap.
      await stampAttempt(c.kind, c.id, null, c.attempts);
      out.started++;
      out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'started' });
      console.log(`[resume] started ${c.kind} ${c.name} (${c.id}) — auto connect, attempt ${c.attempts + 1}`);
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      // A CONFIGURATION FAULT IS NOT WORTH FIVE ATTEMPTS.
      //
      // Auto-connect exists for streams that were running and stopped being
      // able to: a source that dropped, a task that died, a host that went
      // away. Every one of those can come right on its own, which is what the
      // retries are for.
      //
      // "This channel has no source" cannot. Retrying it five times over ten
      // minutes changes nothing, buries the real reason under four identical
      // failures, and spends the recovery budget of a channel that will need it
      // for a real fault later. So a NotStartable goes straight to gave-up with
      // its reason recorded. Pressing Start once the source is filled in clears
      // the give-up exactly as it always did — see StartIntent 'operator'.
      if ((e as any)?.configuration === true) {
        await giveUpNow(c.kind, c.id, msg);
        out.gaveUp++;
        out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'gave_up', error: msg });
        console.error(`[resume] not retrying ${c.kind} ${c.name} (${c.id}), this needs a person: ${msg}`);
        continue;
      }
      await stampAttempt(c.kind, c.id, msg, c.attempts);
      const gaveUp = c.attempts + 1 >= config.orchestrator.resumeMaxAttempts;
      if (gaveUp) {
        out.gaveUp++;
        out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'gave_up', error: msg });
        console.error(`[resume] giving up on ${c.kind} ${c.name} (${c.id}) after ${config.orchestrator.resumeMaxAttempts} attempts: ${msg}`);
      } else {
        out.failed++;
        out.outcomes.push({ kind: c.kind, id: c.id, name: c.name, result: 'failed', error: msg });
        console.warn(`[resume] ${c.kind} ${c.name} (${c.id}) attempt ${c.attempts + 1} failed, will retry in ${cooldown}s: ${msg}`);
      }
    }
  }
  return out;
}

// ---- ARMING: proof of a healthy run -----------------------------------------
//
//  THE GATES THAT COUNT are the four the platform controls: SERVER, INPUT,
//  ENCODER and OUTPUT. PUBLIC is deliberately left out: whether the operator
//  has taken the stream on air is a publishing decision, not evidence that the
//  pipeline works, and a private but perfectly healthy stream must still come
//  back after a reboot.
//
//  One pass, cheap: only owners that want to run, are not yet armed, and are
//  believed live are examined, and examining one is the same health read the
//  list page already does per row.
const ARMING_GATES = ['server', 'input', 'encoder', 'output'] as const;

export interface ArmOutcome { kind: OwnerKind; id: string; name: string }

export async function armProvenStreams(): Promise<ArmOutcome[]> {
  // Two queries, not one UNION: `c.* UNION ALL e.*` only works while channels and
  // events happen to have the same column list, and they do not. Postgres refused
  // it on every pass ("each UNION query must have the same number of columns"), so
  // nothing was ever armed and auto connect never brought a stream back.
  const chRows = await query<any>(
    `SELECT c.*, 'channel'::text AS owner_kind FROM channels c
      WHERE c.desired_state = 'running' AND c.auto_connect
        AND c.resume_armed_at IS NULL AND c.status = 'live'
      LIMIT 200`);
  const evRows = await query<any>(
    `SELECT e.*, 'event'::text AS owner_kind FROM events e
      WHERE e.desired_state = 'running' AND e.auto_connect
        AND e.resume_armed_at IS NULL AND e.status = 'live'
      LIMIT 200`);
  const rows = [...chRows, ...evRows].slice(0, 200);
  const armed: ArmOutcome[] = [];
  if (!rows.length) return armed;
  const { loadChannelHealthLite } = await import('../channelDetail');
  const { loadRadioHealth } = await import('../radio/detail');
  const now = Date.now();
  for (const o of rows) {
    try {
      // owner_kind, not kind: channels have their OWN `kind` column ('tv' | 'radio'),
      // and with `c.*` beside a literal `AS kind` the row came back with kind='tv'.
      // Every channel then took the events branch below, updated no row and was
      // never armed, so auto connect could not bring any channel back.
      const kind = o.owner_kind as OwnerKind;
      const health = (kind === 'channel' && o.radio_config)
        ? await loadRadioHealth(o, now)
        : await loadChannelHealthLite(o, now, kind);
      const proven = ARMING_GATES.every((g) => health.gates.find((x) => x.gate === g)?.status === 'healthy');
      if (!proven) continue;
      const table = kind === 'channel' ? 'channels' : 'events';
      const r = await query<{ id: string }>(
        `UPDATE ${table} SET resume_armed_at = now()
          WHERE id = $1 AND resume_armed_at IS NULL AND desired_state = 'running'
          RETURNING id`, [o.id]);
      if (!r.length) continue;
      await query(
        `INSERT INTO stream_events(${kind === 'channel' ? 'channel_id' : 'event_id'}, type, detail, ts)
         VALUES ($1, 'autoconnect.armed', $2::jsonb, now())`,
        [o.id, JSON.stringify({ message: 'server, input, encoder and output all healthy: auto connect is armed for this stream' })]
      ).catch(() => { /* the stamp is what matters */ });
      armed.push({ kind, id: o.id, name: o.name });
      console.log(`[resume] armed auto connect for ${kind} ${o.name} (${o.id}): all four gates healthy`);
    } catch (e) {
      console.warn('[resume] could not evaluate arming for', o.owner_kind, o.id, e);
    }
  }
  return armed;
}

/** The new run has to prove itself again (a person's Start), or nothing
 *  should be running at all (a person's Stop). */
export async function clearArmed(kind: OwnerKind, id: string): Promise<void> {
  await query(
    `UPDATE ${kind === 'channel' ? 'channels' : 'events'} SET resume_armed_at = NULL WHERE id = $1`,
    [id]
  );
}

/**
 * A PERSON SWITCHING AUTO CONNECT OFF OR ON, by hand, mid-flight.
 *
 * Off halts the retry loop right now (the candidate query requires
 * auto_connect) and leaves everything else exactly as it is: the counters,
 * the last error, the log. The operator asked to look, not to tidy. On clears
 * a give-up so the stream is eligible again, and leaves arming to the health
 * pass: the stream still has to be seen healthy before it is put back
 * automatically.
 */
export async function setAutoConnect(kind: OwnerKind, id: string, enabled: boolean, actor: string): Promise<void> {
  const table = kind === 'channel' ? 'channels' : 'events';
  if (enabled) {
    await query(
      `UPDATE ${table} SET auto_connect = true, resume_attempts = 0, resume_gave_up_at = NULL, updated_at = now()
        WHERE id = $1`, [id]);
  } else {
    await query(`UPDATE ${table} SET auto_connect = false, updated_at = now() WHERE id = $1`, [id]);
  }
  await query(
    `INSERT INTO stream_events(${kind === 'channel' ? 'channel_id' : 'event_id'}, type, detail, ts)
     VALUES ($1, $2, $3::jsonb, now())`,
    [id, enabled ? 'autoconnect.enabled' : 'autoconnect.stopped',
     JSON.stringify({ message: enabled ? 'auto connect switched on' : 'auto connect stopped by hand; nothing will restart this stream until it is switched on again', actor })]
  ).catch(() => { /* best effort */ });
}

/**
 * Clear a stream's give-up state so the operator is never permanently stuck.
 *
 * Called when someone starts a stream by hand. Without it, a stream the system
 * has written off stays written off even after the person fixes whatever was
 * wrong, and the only cure is a database edit.
 */
export async function clearGiveUp(kind: OwnerKind, id: string): Promise<void> {
  await query(
    `UPDATE ${kind === 'channel' ? 'channels' : 'events'}
        SET resume_attempts = 0, resume_last_error = NULL, resume_gave_up_at = NULL
      WHERE id = $1`,
    [id]
  );
}

/** What the console shows about a stream's recovery, if anything. */
export async function resumeStatus(kind: OwnerKind, id: string) {
  const row = await one<any>(
    `SELECT auto_connect, desired_state, stop_requested_at, stop_requested_by,
            resume_attempts, resume_last_attempt_at, resume_last_error, resume_gave_up_at, resume_armed_at
       FROM ${kind === 'channel' ? 'channels' : 'events'} WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    autoConnect: row.auto_connect,
    desiredState: row.desired_state as 'running' | 'stopped',
    stoppedAt: row.stop_requested_at,
    stoppedBy: row.stop_requested_by,
    attempts: row.resume_attempts,
    lastAttemptAt: row.resume_last_attempt_at,
    lastError: row.resume_last_error,
    gaveUpAt: row.resume_gave_up_at,
    armedAt: row.resume_armed_at,
    maxAttempts: config.orchestrator.resumeMaxAttempts,
  };
}
