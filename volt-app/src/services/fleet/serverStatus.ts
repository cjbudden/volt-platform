// ============================================================================
//  THE SERVER, IN WORDS A CUSTOMER USES.
//
//  People running a channel should never need to know what a CPU unit, an
//  instance type or a capacity provider is. They need to know three things:
//  is it running, is anything wrong, and if so what do I do. Everything the
//  placement and load model decided is translated into exactly that here.
//
//  Every issue comes with a fix the person can actually carry out, or says
//  plainly that it is ours to fix. "Contact support" is only used when the
//  cause is genuinely on the platform side (a pool that is not configured).
// ============================================================================
import { query } from '../../db';
import { estimateEncoderLoad, describeForPeople, type LoadEstimate } from './streamLoad';

export interface ServerIssue { what: string; fix: string; ours: boolean }

export interface ServerStatus {
  state: 'running' | 'starting' | 'stopped';
  headline: string;
  detail: string;
  /** 'your settings' until enough runs like this one have been measured. */
  sizedFrom: 'your settings' | 'measured runs like this one';
  issue: ServerIssue | null;
}

interface DecisionLike { action?: string; reason?: string; notes?: string[] }

/** Pure: what to tell the person, from the stream state and the stored decision. */
export function describeServer(input: {
  streamLive: boolean;
  taskRunning: boolean;
  /** The task has been placed on a server (the reconciler saw it land). */
  placed: boolean;
  minutesSinceLaunch: number | null;
  decision: DecisionLike | null;
  basis: string | null;
  estimate: LoadEstimate | null;
}): ServerStatus {
  const sizedFrom = input.basis === 'observed' ? 'measured runs like this one' : 'your settings';
  const detail = input.estimate ? describeForPeople(input.estimate) : 'Server capacity is assigned and managed automatically.';
  const d = input.decision;

  if (!input.taskRunning) {
    return { state: 'stopped', headline: 'Not running', detail, sizedFrom, issue: null };
  }

  if (d?.action === 'unplaceable') {
    const dedicated = /dedicated/.test(d.reason ?? '');
    const gpu = /GPU/.test(d.reason ?? '');
    const issue: ServerIssue = dedicated
      ? { what: 'Your plan runs on dedicated servers, and they are not set up for your account yet.', fix: 'This is on our side. Your stream was started on shared capacity in the meantime. Contact support to have your dedicated servers enabled.', ours: true }
      : gpu
        ? { what: 'This channel is set to encode on a GPU, and GPU servers are not available on this deployment.', fix: 'Switch the output profile to standard (CPU) encoding, or contact support to enable GPU servers.', ours: false }
        : { what: 'These output settings need more processing than one server provides, so the stream was started with standard sizing and may drop frames under load.', fix: 'Remove the highest rendition or lower the frame rate in the output profile, or switch the profile to GPU encoding if it is available to you.', ours: false };
    return { state: input.streamLive ? 'running' : 'starting', headline: input.streamLive ? 'Running, with a warning' : 'Starting', detail, sizedFrom, issue };
  }

  if (!input.placed) {
    const fresh = d?.action === 'new_host';
    const late = (input.minutesSinceLaunch ?? 0) > 10;
    return {
      state: 'starting',
      headline: fresh ? 'Starting a server for this stream' : 'Starting',
      detail: fresh ? 'No running server had room, so a new one is being started. This normally takes a few minutes.' : detail,
      sizedFrom,
      issue: late
        ? { what: 'A server has been requested for more than 10 minutes and has not come up.', fix: 'This is on our side and we have been alerted. Stopping and starting the stream will not speed it up.', ours: true }
        : null,
    };
  }

  return { state: input.streamLive ? 'running' : 'starting', headline: input.streamLive ? 'Running' : 'Starting', detail, sizedFrom, issue: null };
}

/** IO wrapper used by the channel detail page. */
export async function serverStatusFor(args: {
  kind: 'channel' | 'event';
  id: string;
  streamLive: boolean;
  workflow: string | null;
  ladder: Array<{ height: number; bitrate_kbps: number }>;
  sources: any[];
  watermark: boolean;
  gpu: boolean;
}): Promise<ServerStatus> {
  const col = args.kind === 'channel' ? 'channel_id' : 'event_id';
  const rows = await query<{ placement_decision: any; load_basis: string | null; host_id: string | null; mins: string | number | null }>(
    `SELECT placement_decision, load_basis, host_id, EXTRACT(EPOCH FROM (now() - launched_at)) / 60 AS mins
       FROM instances WHERE ${col} = $1 AND terminated_at IS NULL AND role = 'primary'
      ORDER BY launched_at DESC LIMIT 1`,
    [args.id]
  ).catch(() => []);
  const row = rows[0];
  // The estimate from the stream's own settings, so a stopped channel still
  // says what it will need. Inputs as the job would carry them.
  const job = {
    workflow: args.workflow === 'package_only' ? 'package_only' : 'transcode',
    gpu: args.gpu, ladder: args.ladder, watermark: args.watermark ? {} : undefined,
    inputs: args.sources.map((s: any) => ({ role: s.role, bitrate_kbps: s.rendition_bitrate_kbps ?? undefined })),
  };
  const probe = args.sources.find((s: any) => s.role === 'primary')?.probe ?? null;
  let estimate: LoadEstimate | null = null;
  try { estimate = estimateEncoderLoad(job, probe); } catch { estimate = null; }
  return describeServer({
    streamLive: args.streamLive,
    taskRunning: !!row,
    placed: !!row?.host_id,
    minutesSinceLaunch: row?.mins != null ? Number(row.mins) : null,
    decision: row?.placement_decision ?? null,
    basis: row?.load_basis ?? null,
    estimate,
  });
}
