// ============================================================================
//  MEDIA JOBS IN THEIR OWN TASKS (build queue 2.1a-4).
//
//  Clip extract, VOD encode, loop preparation, intro detection and the other
//  jobs that run ffmpeg, ffprobe, the packager or Python cannot run inside the
//  control plane on AWS: its image carries none of them, on purpose, so it
//  stays small and starts fast (2.1a's decision, Christian, 27 Oct 2026). On
//  AWS (MEDIA_JOBS_MODE=ecs) the worker therefore does not run those jobs
//  itself. It claims one as usual, hands the lease to a fresh ECS task of the
//  media-jobs image (the same code plus the tools), and moves on. The task
//  runs the same handler through runClaimedJob below and reports through the
//  same queue: heartbeats, success, failure, all conditional on still holding
//  the lease. Nothing else changes for the rest of Volt.
//
//  Why a task per job rather than a long-running pool: media work comes in
//  bursts and is idle most of the day, so a task per job costs nothing while
//  there is nothing to do, each job gets a scratch disk sized for it, and a
//  heavy encode never shares a machine with the API.
//
//  Safety comes from the queue's lease, not from watching the task:
//    - the hand-over gives the job a longer lease (MEDIA_JOB_START_GRACE_S,
//      default 10 minutes) so a task that takes a while to be placed and pull
//      its image is not reaped before it starts;
//    - once the task runs it heartbeats every 30 s (lease 120 s);
//    - a task that never starts, or dies, stops heartbeating, the reaper puts
//      the job back in the queue and the next attempt gets a new task;
//    - a task whose lease was taken from it (reaped, cancelled) sees its
//      heartbeat refused and stops, so two tasks never finish the same job.
//
//  The Mac and any deployment without MEDIA_JOBS_MODE=ecs run every job in
//  process exactly as before.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { query } from '../../db';
import { fail, getJob, heartbeat, succeed, LEASE_SECONDS, type JobRow } from './queue';
import { errorCodeOf } from './errorCode';

/** The job types whose handlers run ffmpeg, ffprobe, the packager or Python. */
export const DEFAULT_MEDIA_JOB_TYPES = [
  'clip.extract',                                   // clip extract
  'vod.encode', 'vod.repackage', 'vod.ladder',      // VOD encode, repackage, ladder probe
  'filler.build', 'filler.preview', 'filler.thumbs', // loop preparation, house preview, stills
  'vod.markers',                                    // intro and credits detection
  'vod.image', 'frames.index', 'trickplay.build', 'trickplay.ladder',
  'qc.run', 'reframe.analyse', 'reframe.render', 'ad.condition',
  'archive.recording', 'vod.subtitles', 'vod.describe',
];

export interface MediaJobsConfig {
  /** 'inprocess' (the Mac, the default) or 'ecs' (AWS: one task per job). */
  mode: 'inprocess' | 'ecs';
  taskDef: string;
  types: Set<string>;
  /** Most media tasks running at once; more waits queued (a cost ceiling). */
  maxTasks: number;
  /** Lease given at hand-over, long enough for a task to be placed and start. */
  startGraceS: number;
  /** Prefer Fargate Spot: a job interrupted by Spot is simply retried. */
  spot: boolean;
  subnets: string[];
  securityGroups: string[];
}

/** Read every call, so a test (or a live settings change) takes effect at once. */
export function mediaJobsConfig(env: NodeJS.ProcessEnv = process.env): MediaJobsConfig {
  const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const types = list(env.MEDIA_JOB_TYPES);
  return {
    mode: env.MEDIA_JOBS_MODE === 'ecs' ? 'ecs' : 'inprocess',
    taskDef: env.MEDIA_JOB_TASK_DEF || 'volt-media-jobs',
    types: new Set(types.length ? types : DEFAULT_MEDIA_JOB_TYPES),
    maxTasks: Math.max(1, Number(env.MEDIA_JOB_MAX_TASKS ?? 20) || 20),
    startGraceS: Math.max(LEASE_SECONDS, Number(env.MEDIA_JOB_START_GRACE_S ?? 600) || 600),
    spot: env.MEDIA_JOB_SPOT !== 'false',
    // The task needs the database, so by default it joins the control plane's
    // network (ECS_SECURITY_GROUPS is the encoders', which only reach the bucket).
    subnets: list(env.MEDIA_JOB_SUBNETS ?? env.ECS_SUBNETS),
    securityGroups: list(env.MEDIA_JOB_SECURITY_GROUPS ?? env.ECS_SECURITY_GROUPS),
  };
}

/** True when this job should run in its own task rather than in this process. */
export function runsInOwnTask(type: string, cfg = mediaJobsConfig()): boolean {
  return cfg.mode === 'ecs' && cfg.types.has(type);
}

/** What a task is told: which job, and the lease holder name it must use. */
export interface MediaJobSpec { jobId: string; workerId: string; type: string }

/** The one call the dispatcher needs; EcsTaskLauncher and MockTaskLauncher have it. */
export interface MediaJobLauncher {
  launchMediaJob(spec: MediaJobSpec): Promise<{ taskArn: string }>;
}

export const TASK_WORKER_PREFIX = 'task:';

/** Media jobs currently held by a task (started or starting). */
export async function runningMediaTasks(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM jobs WHERE state = 'running' AND claimed_by LIKE '${TASK_WORKER_PREFIX}%'`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The types this worker should claim now. In ecs mode, once MEDIA_JOB_MAX_TASKS
 * tasks are out, media types are left queued (they keep their order) and only
 * the light jobs are claimed.
 */
export async function claimableTypes(all: string[], cfg = mediaJobsConfig()): Promise<string[]> {
  if (cfg.mode !== 'ecs') return all;
  if (await runningMediaTasks() < cfg.maxTasks) return all;
  return all.filter((t) => !cfg.types.has(t));
}

let defaultLauncher: MediaJobLauncher | null = null;
/** Tests replace the launcher (MockTaskLauncher); AWS uses EcsTaskLauncher. */
export function setMediaJobLauncher(l: MediaJobLauncher | null) { defaultLauncher = l; }
async function launcher(): Promise<MediaJobLauncher> {
  if (defaultLauncher) return defaultLauncher;
  const { EcsTaskLauncher } = await import('../orchestrator/launcher');
  return new EcsTaskLauncher();
}

/**
 * Hand a job this worker has just claimed to its own task. Returns the task's
 * ARN, or null when the launch failed (the job is then back in the queue with
 * the usual backoff, or failed if its attempts are spent).
 */
export async function dispatchToTask(job: JobRow, claimedBy: string, cfg = mediaJobsConfig()): Promise<string | null> {
  const workerId = `${TASK_WORKER_PREFIX}${randomUUID()}`;
  // Hand the lease over first, so the task can take it the moment it starts,
  // and lengthen it to cover the start-up.
  const moved = await query(
    `UPDATE jobs SET claimed_by = $3, lease_until = now() + make_interval(secs => $4),
            progress_note = COALESCE(progress_note, 'Starting')
      WHERE id = $1 AND state = 'running' AND claimed_by = $2 RETURNING id`,
    [job.id, claimedBy, workerId, cfg.startGraceS]);
  if (!moved.length) return null;   // cancelled between the claim and here
  await query(`UPDATE job_attempts SET claimed_by = $2
                WHERE id = (SELECT id FROM job_attempts WHERE job_id = $1 ORDER BY attempt DESC LIMIT 1)`,
    [job.id, workerId]);
  try {
    const { taskArn } = await (await launcher()).launchMediaJob({ jobId: job.id, workerId, type: job.type });
    console.log(`[jobs] ${job.type} ${job.id} handed to task ${taskArn}`);
    return taskArn;
  } catch (e) {
    // ECS refused (capacity, throttling, a bad task definition). Retryable:
    // the next attempt asks again after the backoff.
    await fail(job.id, `could not start a task for this job: ${(e as Error).message}`,
      { code: 'task_launch_failed', workerId });
    return null;
  }
}

export type HandlerLookup = (type: string) => ((ctx: any) => Promise<Record<string, unknown> | void>) | undefined;

/**
 * Inside the task: run the job this task was started for, holding the lease as
 * `workerId`. Answers what happened, for the exit code and the tests.
 */
export async function runClaimedJob(jobId: string, workerId: string, handlerFor: HandlerLookup,
  opts: { keepAliveMs?: number } = {}): Promise<'succeeded' | 'failed' | 'lost' | 'missing'> {
  const job = await getJob(jobId);
  if (!job || job.state !== 'running' || job.claimed_by !== workerId) {
    // Reaped and given to another, cancelled, or already finished: not ours.
    console.warn(`[media-job] ${jobId} is not held by ${workerId} (state ${job?.state ?? 'none'}); nothing to do`);
    return 'missing';
  }
  const fn = handlerFor(job.type);
  if (!fn) {
    await fail(job.id, `no handler for job type ${job.type} in the media-jobs image`,
      { code: 'no_handler', permanent: true, workerId });
    return 'failed';
  }
  let lost = false;
  const beat = async (pct?: number, note?: string) => {
    if (lost) return;
    if (!(await heartbeat(job.id, pct, note, workerId))) lost = true;
  };
  await beat(undefined, 'Running');
  // Kept alive on a timer as well as by the handler's own progress reports,
  // because a long ffmpeg step can go minutes without one.
  const timer = setInterval(() => { beat().catch(() => {}); }, opts.keepAliveMs ?? 30_000);
  timer.unref?.();
  try {
    const { PermanentError } = await import('./worker');
    try {
      const result = await fn({ job, progress: (p: number, n?: string) => beat(p, n), isCancelled: () => lost });
      if (lost) return 'lost';
      return (await succeed(job.id, result ?? {}, workerId)) ? 'succeeded' : 'lost';
    } catch (e) {
      if (lost) return 'lost';
      const done = await fail(job.id, e, { code: errorCodeOf(e), permanent: e instanceof PermanentError, workerId });
      return done ? 'failed' : 'lost';
    }
  } finally {
    clearInterval(timer);
  }
}
