// ============================================================================
//  ENGINE-AWARE LAUNCHER — the one seam the orchestrator goes through.
//
//  It wraps whatever TaskLauncher the deployment uses (mock, local, docker,
//  ECS) and implements the same interface, so orchestrator/service.ts, resume,
//  reconcile and fleet need NO change to support a vendor engine:
//
//    job.engine absent or 'builtin'  -> straight to the base launcher. This is
//                                       every channel today, byte-identical.
//    encode_only vendor              -> provision + start the vendor job, AND
//                                       launch our own packager (package_only
//                                       job from engine.packagerJob). The
//                                       returned taskArn is OUR packager's, so
//                                       every existing liveness, placement and
//                                       teardown path works unchanged. The
//                                       vendor handle rides in engine_bindings.
//    full vendor                     -> provision + start the vendor job only.
//                                       taskArn = `engine:<id>:<externalRef>`,
//                                       and stop / isRunning route to the
//                                       vendor by that prefix.
//
//  If anything fails half way, what was started is stopped before the error
//  propagates, for the same reason the orchestrator does it: a running
//  encoder nobody has a record of is a bill nobody can stop.
// ============================================================================
import type { LaunchResult, Liveness, TaskLauncher } from '../orchestrator/launcher';
import type { Placement } from '../fleet/placement';
import { getEngine, validateForEngine } from './registry';
import type { EngineHandle, EngineMode } from './types';

export interface EngineBinding {
  taskArn: string;
  engineId: string;
  mode: EngineMode;
  streamKind: 'channel' | 'event';
  streamId: string;
  handle: EngineHandle;
}

/** Where bindings live. The DB store is the default; tests pass a Map. */
export interface BindingStore {
  save(b: EngineBinding): Promise<void>;
  byArn(taskArn: string): Promise<EngineBinding | null>;
  close(taskArn: string, reason: string): Promise<void>;
}

export const dbBindingStore: BindingStore = {
  async save(b) {
    const { query } = await import('../../db');
    await query(
      `INSERT INTO engine_bindings (task_arn, engine_id, mode, stream_kind, stream_id, external_ref, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (task_arn) DO UPDATE SET external_ref = EXCLUDED.external_ref, meta = EXCLUDED.meta, stopped_at = NULL`,
      [b.taskArn, b.engineId, b.mode, b.streamKind, b.streamId, b.handle.externalRef, JSON.stringify(b.handle.meta ?? {})]
    );
  },
  async byArn(taskArn) {
    const { one } = await import('../../db');
    const r = await one<any>(`SELECT * FROM engine_bindings WHERE task_arn = $1`, [taskArn]);
    return r ? {
      taskArn: r.task_arn, engineId: r.engine_id, mode: r.mode, streamKind: r.stream_kind,
      streamId: r.stream_id, handle: { externalRef: r.external_ref, meta: r.meta ?? {} },
    } : null;
  },
  async close(taskArn, reason) {
    const { query } = await import('../../db');
    await query(`UPDATE engine_bindings SET stopped_at = now(), stop_reason = $2 WHERE task_arn = $1 AND stopped_at IS NULL`, [taskArn, reason]);
  },
};

export const ENGINE_ARN_PREFIX = 'engine:';

export class EngineAwareLauncher implements TaskLauncher {
  describePlacement?: (taskArn: string) => Promise<Placement | null>;

  constructor(private base: TaskLauncher, private store: BindingStore = dbBindingStore) {
    // Keep the OPTIONAL shape honest: only offer placement if the base can.
    if (typeof base.describePlacement === 'function') {
      this.describePlacement = async (arn: string) =>
        arn.startsWith(ENGINE_ARN_PREFIX) ? null : base.describePlacement!(arn);
    }
  }

  async launchEncoder(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    const sel = job.engine as { id?: string; mode?: EngineMode | null; stream_kind?: 'channel' | 'event' } | undefined;
    const engineId = sel?.id ?? 'builtin';
    if (engineId === 'builtin') return this.base.launchEncoder(streamId, job);

    const engine = getEngine(engineId);
    if (!engine) throw new Error(`Encode engine "${engineId}" is not installed on this deployment.`);
    const mode: EngineMode = sel?.mode ?? engine.descriptor.defaultMode;
    const { engine: _drop, ...neutral } = job;

    const errors = validateForEngine(engineId, neutral, mode).filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`${engine.descriptor.name} cannot run this profile: ${errors.map((e) => e.message).join(' ')}`);

    const handle = await engine.provision(streamId, neutral, mode);
    let res: LaunchResult | null = null;
    try {
      if (mode === 'encode_only') {
        if (!engine.packagerJob) throw new Error(`${engine.descriptor.name} declares encode_only but has no packagerJob()`);
        res = await this.base.launchEncoder(streamId, engine.packagerJob(neutral));
      } else {
        res = { taskArn: `${ENGINE_ARN_PREFIX}${engineId}:${handle.externalRef}`, lifecycle: 'on_demand' };
      }
      await this.store.save({ taskArn: res.taskArn, engineId, mode, streamKind: sel?.stream_kind ?? 'channel', streamId, handle });
      await engine.start(handle);
      return res;
    } catch (e) {
      await engine.stop(handle, 'launch failed').catch(() => {});
      if (res && !res.taskArn.startsWith(ENGINE_ARN_PREFIX)) await this.base.stopTask(res.taskArn, 'engine launch failed').catch(() => {});
      if (res) await this.store.close(res.taskArn, 'launch failed').catch(() => {});
      throw e;
    }
  }

  async stopTask(taskArn: string, reason: string): Promise<void> {
    const b = await this.store.byArn(taskArn).catch(() => null);
    if (b) {
      const engine = getEngine(b.engineId);
      // Vendor first: it is the one billing per minute.
      if (engine) await engine.stop(b.handle, reason).catch((e) => console.error(`[engines] ${b.engineId} stop failed for ${taskArn}`, e));
      await this.store.close(taskArn, reason).catch(() => {});
    }
    if (!taskArn.startsWith(ENGINE_ARN_PREFIX)) await this.base.stopTask(taskArn, reason);
  }

  async isRunning(taskArn: string): Promise<Liveness> {
    if (!taskArn.startsWith(ENGINE_ARN_PREFIX)) return this.base.isRunning(taskArn);
    const b = await this.store.byArn(taskArn).catch(() => null);
    if (!b) return 'unknown';
    const engine = getEngine(b.engineId);
    if (!engine) return 'unknown';      // adapter removed: we cannot tell, so we do not reconcile
    return engine.isRunning(b.handle).catch(() => 'unknown' as Liveness);
  }

  // Everything else is ours, not the engine's.
  launchRadio(id: string, job: Record<string, any>) { return this.base.launchRadio(id, job); }
  launchThumbnailer(job: Record<string, any>) { return this.base.launchThumbnailer(job); }
  launchCaptions(id: string, job: Record<string, any>) { return this.base.launchCaptions(id, job); }
}

export function withEngines(base: TaskLauncher): TaskLauncher {
  return new EngineAwareLauncher(base);
}
