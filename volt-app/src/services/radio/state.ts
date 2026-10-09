// ============================================================================
//  RADIO RUN STATE — is this station running, and what is it doing?
//
//  Radio used to answer this from a Map in the control-plane process. That was
//  only ever true of the process that happened to have started the station, so
//  it was wrong the moment a station ran anywhere else: in a container, on a
//  second node, or after a restart. It is the reason the read side blocked
//  radio from being deployed like everything else.
//
//  Television has never had that problem, because it answers the same question
//  from two durable sources and no memory at all:
//
//    THE INSTANCE ROW   what was launched, and whether it has been closed. The
//                       reconciler keeps it honest by asking the launcher, so a
//                       crashed task stops counting within a tick.
//    STATUS REPORTS     what the task itself says it is doing, POSTed to
//                       /api/streams/:id/report and landing in stream_status.
//
//  This module puts radio on the same footing. It works for a station running
//  as a container AND for one still spawned in process, because the in-process
//  path writes the same instance row; the legacy path just gets a sharper
//  answer by also consulting the process table, which costs nothing and
//  disappears with it.
//
//  WHAT CHANGED IN MEANING. "Running" is now a claim the reconciler audits
//  rather than a live process handle, so there is up to one tick of lag between
//  a station dying and this saying so. That is exactly the lag television has
//  always had, and it is the price of an answer that is true from any process.
//  Freshness of the output is what closes the gap for an operator, and the
//  health model already reads that separately.
// ============================================================================
import { query, one } from '../../db';
import { config } from '../../config';
import { currentRunId } from '../liveOrigin';
import { icyState } from './icyMeta';

export interface RadioRunState {
  running: boolean;
  /** The launched task, or a `radio:<pid>:<runId>` arn in the legacy path. */
  taskArn: string | null;
  runId: string | null;
  startedAt: number | null;
  /** Listener count is owned by the relay, not by us. Null unless known. */
  listeners: number | null;
  icy: ReturnType<typeof icyState>;
}

const NOT_RUNNING = (channelId: string): RadioRunState => ({
  running: false, taskArn: null, runId: null, startedAt: null,
  listeners: null, icy: icyState(channelId),
});

/**
 * True when a `radio:` arn's in-process pipeline is genuinely still there.
 *
 * Only meaningful for the legacy path, and deliberately imported lazily so the
 * container path never pulls the in-process pipeline module in at all.
 */
async function legacyPipelineAlive(channelId: string): Promise<boolean> {
  const { isRadioRunning } = await import('./pipeline');
  return isRadioRunning(channelId);
}

export async function radioRunState(channelId: string): Promise<RadioRunState> {
  const inst = await one<any>(
    `SELECT task_arn, launched_at FROM instances
      WHERE channel_id = $1 AND terminated_at IS NULL
      ORDER BY launched_at DESC LIMIT 1`,
    [channelId]
  );
  if (!inst) return NOT_RUNNING(channelId);

  const arn = String(inst.task_arn ?? '');
  const legacy = arn.startsWith('radio:');

  // A legacy station's process table is in THIS process and is authoritative
  // when it says no: the row may simply not have been reconciled yet.
  if (legacy && !(await legacyPipelineAlive(channelId))) return NOT_RUNNING(channelId);

  let listeners: number | null = null;
  if (legacy) {
    const { radioStatus } = await import('./pipeline');
    const rs = radioStatus(channelId);
    if (rs.running) listeners = rs.listeners;
  }

  return {
    running: true,
    taskArn: arn || null,
    // The run id comes from the pointer the station itself writes, so it is
    // correct whichever process wrote it.
    runId: currentRunId(channelId),
    startedAt: inst.launched_at ? new Date(inst.launched_at).getTime() : null,
    listeners,
    icy: icyState(channelId),
  };
}

/** Just the boolean, for callers that only gate on it. */
export async function isRadioRunningNow(channelId: string): Promise<boolean> {
  return (await radioRunState(channelId)).running;
}

/**
 * The same question for many stations at once.
 *
 * The radio list page asked it per row, which was free against a Map and is a
 * query per station against the database. One query instead.
 */
export async function radioRunStates(channelIds: string[]): Promise<Map<string, RadioRunState>> {
  const out = new Map<string, RadioRunState>();
  if (!channelIds.length) return out;
  const rows = await query<any>(
    `SELECT DISTINCT ON (channel_id) channel_id, task_arn, launched_at
       FROM instances
      WHERE channel_id = ANY($1) AND terminated_at IS NULL
      ORDER BY channel_id, launched_at DESC`,
    [channelIds]
  );
  const open = new Map<string, any>(rows.map((r: any) => [r.channel_id, r]));
  for (const id of channelIds) {
    const inst = open.get(id);
    if (!inst) { out.set(id, NOT_RUNNING(id)); continue; }
    const arn = String(inst.task_arn ?? '');
    if (arn.startsWith('radio:') && !(await legacyPipelineAlive(id))) {
      out.set(id, NOT_RUNNING(id));
      continue;
    }
    // A REAL LISTENER COUNT, INCLUDING FOR CONTAINERISED STATIONS.
    //
    // This used to read a count only for a `radio:` arn -- the legacy in-process
    // path where the control plane held every listener socket. A containerised
    // station never matched, so `listeners` was permanently null and the console
    // rendered it as a confident "0 MP3 listeners": the absence of a measurement
    // shown as a measurement of zero.
    //
    // The on-demand gateway terminates the connections itself, so its count is
    // the truth for every station regardless of how the station runs. Null still
    // means "we do not know", which is now only true of the legacy path when its
    // pipeline is not running.
    let listeners: number | null = null;
    {
      const { feedState } = await import('./mp3Gateway');
      const f = feedState(id);
      if (f) listeners = f.listeners;
      else if (arn.startsWith('radio:')) {
        const { radioStatus } = await import('./pipeline');
        const rs = radioStatus(id);
        if (rs.running) listeners = rs.listeners;
      } else {
        // No feed means nobody is listening over MP3 right now. That IS zero,
        // and it is measured: the gateway would exist if anyone were attached.
        listeners = 0;
      }
    }
    out.set(id, {
      running: true, taskArn: arn || null, runId: currentRunId(id),
      startedAt: inst.launched_at ? new Date(inst.launched_at).getTime() : null,
      listeners, icy: icyState(id),
    });
  }
  return out;
}

/** True when stations run as containers; the legacy path is going away. */
export function radioIsContainerised(): boolean {
  return config.orchestrator.radioMode === 'container';
}
