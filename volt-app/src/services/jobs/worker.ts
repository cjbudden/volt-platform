// ============================================================================
//  WORKER — the loop that runs jobs.
//
//  Deliberately started in the API process for now, and honest about it: this
//  is a single-node worker. What makes that acceptable is that the CONTRACT is
//  already multi-node safe — claims are leased and taken with SKIP LOCKED, the
//  reaper recovers stranded work, and handlers are addressed by job type. Moving
//  the loop into its own process later is a deployment change, not a rewrite,
//  and no caller has to know.
// ============================================================================
import { randomUUID } from 'node:crypto';
import { claim, fail, heartbeat, reapExpiredLeases, succeed, type JobRow } from './queue';

export interface JobContext {
  job: JobRow;
  /** Extend the lease and report progress. Long handlers must call this. */
  progress: (pct: number, note?: string) => Promise<void>;
  /** True once the worker is stopping; a long handler should bail out politely. */
  isCancelled: () => boolean;
}

/** A handler returns its result, or throws. Throwing `PermanentError` skips retries. */
export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

/** For failures a retry cannot fix: a missing source, an impossible range. */
export class PermanentError extends Error {
  code: string;
  constructor(message: string, code = 'permanent') {
    super(message);
    this.name = 'PermanentError';
    this.code = code;
  }
}

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, fn: JobHandler): void {
  if (handlers.has(type)) throw new Error(`[jobs] handler already registered for ${type}`);
  handlers.set(type, fn);
}

export function registeredTypes(): string[] {
  return [...handlers.keys()];
}

export interface WorkerHandle {
  stop: () => Promise<void>;
  id: string;
}

/**
 * Start polling. `concurrency` is how many jobs may run at once in this process;
 * keep it low, because these are ffmpeg-shaped jobs, not database queries.
 */
export function startWorker(opts: {
  concurrency?: number; pollMs?: number; reapMs?: number;
} = {}): WorkerHandle {
  const id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const concurrency = opts.concurrency ?? 2;
  const pollMs = opts.pollMs ?? 2000;
  const reapMs = opts.reapMs ?? 30_000;
  let stopping = false;
  let active = 0;

  async function runOne(job: JobRow) {
    const fn = handlers.get(job.type);
    if (!fn) {
      // Registered types are what we claim, so this means a handler was removed
      // while work for it was queued. Permanent: retrying cannot help.
      await fail(job.id, `no handler registered for job type ${job.type}`,
        { code: 'no_handler', permanent: true });
      return;
    }
    try {
      const result = await fn({
        job,
        progress: (pct, note) => heartbeat(job.id, pct, note),
        isCancelled: () => stopping,
      });
      await succeed(job.id, result ?? {});
    } catch (e) {
      const permanent = e instanceof PermanentError;
      await fail(job.id, e, {
        code: permanent ? (e as PermanentError).code : undefined,
        permanent,
      });
    }
  }

  const poll = setInterval(async () => {
    if (stopping) return;
    try {
      while (active < concurrency && !stopping) {
        const job = await claim(registeredTypes(), id);
        if (!job) break;
        active++;
        runOne(job).finally(() => { active--; });
      }
    } catch (e) {
      console.error('[jobs] poll error', e);
    }
  }, pollMs);

  const reap = setInterval(() => {
    reapExpiredLeases().catch((e) => console.error('[jobs] reap error', e));
  }, reapMs);

  poll.unref?.();
  reap.unref?.();
  console.log(`[jobs] worker ${id} up (concurrency ${concurrency}, ${handlers.size} handler(s))`);

  return {
    id,
    stop: async () => {
      stopping = true;
      clearInterval(poll);
      clearInterval(reap);
      // Let in-flight handlers notice isCancelled() and unwind. Anything still
      // running when we exit is recovered by the reaper on the next boot.
      const deadline = Date.now() + 5000;
      while (active > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
