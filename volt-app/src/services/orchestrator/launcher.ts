import { config } from '../../config';
import { makeLocalLauncher } from './localLauncher';

/**
 * TaskLauncher abstracts "run/stop an encoder or thumbnailer container" so the
 * orchestrator logic is testable without AWS. The mock records intent (used
 * locally, in the e2e harness, and in unit tests); the ECS launcher runs real
 * Fargate/EC2 tasks with a Spot + on-demand capacity-provider strategy.
 */
export interface LaunchResult {
  taskArn: string;
  lifecycle: 'spot' | 'on_demand';
}
export interface TaskLauncher {
  launchEncoder(streamId: string, jobConfig: Record<string, any>): Promise<LaunchResult>;
  launchThumbnailer(jobConfig: Record<string, any>): Promise<LaunchResult>;
  /** Launch the separate captions/whisper add-on task (own image + GPU sizing). */
  launchCaptions(streamId: string, jobConfig: Record<string, any>): Promise<LaunchResult>;
  stopTask(taskArn: string, reason: string): Promise<void>;
}

/** Records intent, hands back fake ARNs. Deterministic for tests. */
export class MockTaskLauncher implements TaskLauncher {
  public launched: Array<{ kind: string; streamId?: string; job: Record<string, any> }> = [];
  public stopped: string[] = [];
  private n = 0;
  async launchEncoder(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    this.launched.push({ kind: 'encoder', streamId, job });
    return { taskArn: `mock:encoder:${streamId}:${++this.n}`, lifecycle: 'spot' };
  }
  async launchThumbnailer(job: Record<string, any>): Promise<LaunchResult> {
    this.launched.push({ kind: 'thumbnailer', job });
    return { taskArn: `mock:thumb:${++this.n}`, lifecycle: 'on_demand' };
  }
  async launchCaptions(streamId: string, job: Record<string, any>): Promise<LaunchResult> {
    this.launched.push({ kind: 'captions', streamId, job });
    return { taskArn: `mock:captions:${streamId}:${++this.n}`, lifecycle: 'on_demand' };
  }
  async stopTask(taskArn: string): Promise<void> {
    this.stopped.push(taskArn);
  }
}

/**
 * Real ECS launcher. Uses a capacity-provider strategy so tasks prefer Spot and
 * fall back to on-demand (base:1 on-demand keeps a channel stable if Spot is
 * unavailable). The job config is passed via the JOB_CONFIG_JSON env override so
 * no per-task files are needed. Requires @aws-sdk/client-ecs.
 */
export class EcsTaskLauncher implements TaskLauncher {
  private ecs: any;
  private async client() {
    if (!this.ecs) {
      const { ECSClient } = await import('@aws-sdk/client-ecs');
      this.ecs = new ECSClient({ region: config.aws.region });
    }
    return this.ecs;
  }

  private netConfig() {
    return {
      awsvpcConfiguration: {
        subnets: config.orchestrator.subnets,
        securityGroups: config.orchestrator.securityGroups,
        assignPublicIp: 'DISABLED',
      },
    };
  }

  /** Build the RunTaskCommand input (kept separate so it can be unit-tested). */
  runTaskInput(taskDef: string, containerName: string, env: Record<string, string>): Record<string, any> {
    const o = config.orchestrator;
    return {
      cluster: o.ecsCluster,
      taskDefinition: taskDef,
      count: 1,
      capacityProviderStrategy: [
        { capacityProvider: o.spotProvider, weight: 4 },
        { capacityProvider: o.onDemandProvider, weight: 1, base: 1 },
      ],
      networkConfiguration: this.netConfig(),
      overrides: {
        containerOverrides: [
          {
            name: containerName,
            environment: Object.entries(env).map(([name, value]) => ({ name, value })),
          },
        ],
      },
      propagateTags: 'TASK_DEFINITION',
    };
  }

  private async run(taskDef: string, containerName: string, env: Record<string, string>): Promise<LaunchResult> {
    const { RunTaskCommand } = await import('@aws-sdk/client-ecs');
    const ecs = await this.client();
    const input = this.runTaskInput(taskDef, containerName, env);
    const out = await ecs.send(new RunTaskCommand(input as any));
    const task = out.tasks?.[0];
    if (!task?.taskArn) throw new Error(`ECS RunTask returned no task: ${JSON.stringify(out.failures ?? [])}`);
    const lifecycle = (task.capacityProviderName ?? '').includes('spot') ? 'spot' : 'on_demand';
    return { taskArn: task.taskArn, lifecycle };
  }

  launchEncoder(streamId: string, job: Record<string, any>) {
    return this.run(config.orchestrator.encoderTaskDef, 'encoder', {
      JOB_CONFIG_JSON: JSON.stringify(job),
    });
  }
  launchThumbnailer(job: Record<string, any>) {
    return this.run(config.orchestrator.thumbnailerTaskDef, 'thumbnailer', {
      THUMB_CONFIG_JSON: JSON.stringify(job),
    });
  }
  launchCaptions(streamId: string, job: Record<string, any>) {
    // GPU-only capacity: the captions task def targets a GPU capacity provider so
    // this heavy add-on never lands on the lean encoder fleet.
    return this.run(config.orchestrator.captionsTaskDef, 'captions', {
      CAPTIONS_CONFIG_JSON: JSON.stringify(job),
    });
  }
  async stopTask(taskArn: string, reason: string): Promise<void> {
    const { StopTaskCommand } = await import('@aws-sdk/client-ecs');
    const ecs = await this.client();
    await ecs.send(new StopTaskCommand({ cluster: config.orchestrator.ecsCluster, task: taskArn, reason }));
  }
}

export function makeLauncher(): TaskLauncher {
  switch (config.orchestrator.launcher) {
    case 'ecs':
      return new EcsTaskLauncher();
    case 'local':
      // real on-box encoder.py / thumbnailer.py child processes (no AWS)
      return makeLocalLauncher();
    default:
      return new MockTaskLauncher();
  }
}
