import { config } from '../../config';
import { makeLocalLauncher } from './localLauncher';
import { makeDockerLauncher } from './dockerLauncher';
import type { Placement } from '../fleet/placement';
import { attrMap, lifecycleFromProvider, regionFromAz } from '../fleet/placement';

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
/**
 * What a liveness check can honestly answer.
 *
 * `unknown` is a first-class answer, and it is the reason this is not a
 * boolean. A launcher that cannot reach its control plane, or that has been
 * restarted and lost its process table, genuinely does not know whether the
 * task lives. Treating "I cannot tell" as "it is dead" would tear down healthy
 * channels on every network hiccup and on every control-plane restart, which
 * is a far worse failure than the one being fixed. Only a definite `dead`
 * reconciles anything.
 */
export type Liveness = 'alive' | 'dead' | 'unknown';

/**
 * WHERE AND HOW BIG, from placement (services/fleet/assign.ts).
 *
 * Optional on every launch, and every field optional within it: a launcher
 * that cannot use a hint ignores it (local and docker run on one box), and a
 * launch with no hints behaves exactly as it did before placement existed.
 */
export interface LaunchHints {
  /** Task-level reservation, sized from the stream's output settings. */
  cpuUnits?: number;
  memoryMib?: number;
  gpus?: number;
  /** The one capacity provider to launch into (a pool sized for this stream). */
  capacityProvider?: string;
  /** Pin to this running server (ECS memberOf on ec2InstanceId). */
  ec2InstanceId?: string;
  /** Our compute_hosts id for the pinned server (bookkeeping only). */
  hostId?: string;
  /**
   * Captions only: share the GPU instead of reserving it whole (the task
   * definition that reserves none, CAPTIONS_SHARED_TASK_DEF). launchCaptions
   * clears it, and sets gpus to 1, when it had to fall back to a whole GPU, so
   * what is recorded is what ran.
   */
  sharedGpu?: boolean;
  /** Servers the task must not land on (a new server was planned; ECS memberOf with not()). */
  avoidEc2InstanceIds?: string[];
}

export interface TaskLauncher {
  launchEncoder(streamId: string, jobConfig: Record<string, any>, hints?: LaunchHints): Promise<LaunchResult>;
  /**
   * Launch a radio station.
   *
   * Radio used to be the one workflow that did not come through here: the
   * control plane spawned ffmpeg as its own child, so a station was invisible
   * to the launcher, invisible to `isRunning`, and impossible to reap the way
   * every other task is reaped. That is what made a control-plane restart take
   * every station off air, and what made the station's `instances` row meter
   * forever afterwards.
   *
   * It is a separate entry point from launchEncoder rather than a flag on it
   * because it is a different IMAGE: volt-radio carries ffmpeg alone, with no
   * Shaka Packager and no SPEKE client, since there is no video to package and
   * audio radio is not DRM'd. Sizing differs by roughly an order of magnitude.
   */
  launchRadio(streamId: string, jobConfig: Record<string, any>, hints?: LaunchHints): Promise<LaunchResult>;
  launchThumbnailer(jobConfig: Record<string, any>): Promise<LaunchResult>;
  /** Launch the separate captions/whisper add-on task (own image + GPU sizing). */
  launchCaptions(streamId: string, jobConfig: Record<string, any>, hints?: LaunchHints): Promise<LaunchResult>;
  stopTask(taskArn: string, reason: string): Promise<void>;
  /**
   * IS THIS TASK STILL RUNNING?
   *
   * The question nobody could ask. Without it the only record of a running
   * encoder was the `instances` row, and only stopStream ever cleared it — so
   * a crashed encoder left its channel `live` and billing indefinitely, and
   * the reconciler that was supposed to catch exactly that asked the claim to
   * vouch for itself. The launcher is the party that actually knows, so this
   * is where the answer belongs.
   */
  isRunning(taskArn: string): Promise<Liveness>;
  /**
   * WHERE DID THIS TASK ACTUALLY LAND?
   *
   * Optional, and optional is the honest shape. A launcher that genuinely
   * cannot tell (an old mock in a test, a future backend that does not expose
   * placement) should not be forced to fabricate one, and a caller must not be
   * able to mistake a fabrication for an observation. Absent method and null
   * return mean the same thing: nothing is recorded, and the fleet view shows
   * the task without a host rather than inventing a host to hang it on.
   *
   * This is asked on the orchestrator tick rather than at launch, because at
   * the moment RunTask returns the task is usually still PROVISIONING and has
   * no container instance yet. Asking once, early, would have recorded null
   * forever for most tasks.
   */
  describePlacement?(taskArn: string): Promise<Placement | null>;
}

/** Records intent, hands back fake ARNs. Deterministic for tests. */
export class MockTaskLauncher implements TaskLauncher {
  public launched: Array<{ kind: string; streamId?: string; job: Record<string, any>; hints?: LaunchHints }> = [];
  public stopped: string[] = [];
  /**
   * Arns THIS instance handed out.
   *
   * A mock task is an in-process fiction. It cannot outlive the process that
   * invented it, so an arn this object never issued names something that is
   * not running — see isRunning below for why that distinction had teeth.
   */
  public issued = new Set<string>();
  /**
   * Stream ids whose LAUNCH fails, staging the transient kind of failure that
   * auto-connect exists for: the scheduler refused the task, capacity was not
   * there, the API throttled, the host went away. Every one of those can come
   * right on the next attempt, which is what makes retrying them correct.
   *
   * Deliberately NOT the same thing as an unstartable configuration. A channel
   * with no source also fails to start, and retrying that five times over ten
   * minutes changes nothing, so the orchestrator refuses it up front and the
   * resume pass gives up on it at once (services/sourceReadiness.ts). A test
   * for the retry budget therefore has to break the LAUNCH, not the config, or
   * it is quietly asserting the other path.
   */
  public failLaunchFor = new Set<string>();
  private n = 0;
  async launchEncoder(streamId: string, job: Record<string, any>, hints?: LaunchHints): Promise<LaunchResult> {
    if (this.failLaunchFor.has(streamId)) throw new Error('mock: the launcher refused the task');
    this.launched.push({ kind: 'encoder', streamId, job, hints });
    const arn = `mock:encoder:${streamId}:${++this.n}`;
    this.issued.add(arn);
    return { taskArn: arn, lifecycle: 'spot' };
  }
  async launchThumbnailer(job: Record<string, any>): Promise<LaunchResult> {
    this.launched.push({ kind: 'thumbnailer', job });
    const arn = `mock:thumb:${++this.n}`;
    this.issued.add(arn);
    return { taskArn: arn, lifecycle: 'on_demand' };
  }
  async launchCaptions(streamId: string, job: Record<string, any>, hints?: LaunchHints): Promise<LaunchResult> {
    this.launched.push({ kind: 'captions', streamId, job, hints });
    const arn = `mock:captions:${streamId}:${++this.n}`;
    this.issued.add(arn);
    return { taskArn: arn, lifecycle: 'on_demand' };
  }
  async launchRadio(streamId: string, job: Record<string, any>, hints?: LaunchHints): Promise<LaunchResult> {
    this.launched.push({ kind: 'radio', streamId, job, hints });
    const arn = `mock:radio:${streamId}:${++this.n}`;
    this.issued.add(arn);
    return { taskArn: arn, lifecycle: 'on_demand' };
  }
  async stopTask(taskArn: string): Promise<void> {
    this.stopped.push(taskArn);
  }
  /** Alive until stopped. `deadArns` lets a test stage a CRASH, which is the
   *  case that matters: nobody stopped the task, it simply is not there any
   *  more. `unknownArns` stages an unreachable control plane. */
  public deadArns = new Set<string>();
  public unknownArns = new Set<string>();
  /**
   * AN ARN THIS PROCESS NEVER ISSUED IS DEAD.
   *
   * This used to return 'alive' for any arn it had not been told about, which
   * sounds harmless and was not. Every arn is unknown to a freshly started
   * process, so after ANY restart the mock vouched for every instance row in
   * the database — including rows left open by the previous run. Nothing could
   * ever be reaped, the owning channels stayed billable, and their recordings
   * stayed 'recording' forever with no station running.
   *
   * A mock task is a fiction that lives in this object. If this object did not
   * issue the arn, there is nothing behind it. That is the same reasoning
   * LocalTaskLauncher already applies to its child processes: if the control
   * plane restarted, its children died with it.
   *
   * `unknownArns` still stages the genuinely-cannot-tell case for tests that
   * need it, so the three-valued contract is unchanged.
   */
  async isRunning(taskArn: string): Promise<Liveness> {
    if (this.unknownArns.has(taskArn)) return 'unknown';
    if (this.deadArns.has(taskArn) || this.stopped.includes(taskArn)) return 'dead';
    return this.issued.has(taskArn) ? 'alive' : 'dead';
  }

  /**
   * Staged placement. The DEFAULT IS A SHARED EC2 HOST, on purpose: sharing is
   * the case the fleet view exists for and the case every off-by-one lives in,
   * so it is what a test gets unless it asks for something else. `placements`
   * overrides per arn, and `unplaceable` stages a launcher that cannot answer.
   */
  public defaultPlacement: Placement | null = {
    hostKind: 'ec2', externalId: 'i-mock000000000001', instanceType: 'c6i.2xlarge',
    availabilityZone: 'ap-southeast-1a', lifecycle: 'on_demand', vcpus: 8, memoryMib: 16384,
  };
  public placements = new Map<string, Placement | null>();
  public unplaceable = new Set<string>();
  async describePlacement(taskArn: string): Promise<Placement | null> {
    if (this.unplaceable.has(taskArn)) return null;
    if (this.placements.has(taskArn)) return this.placements.get(taskArn)!;
    return this.defaultPlacement;
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

  /**
   * Build the RunTaskCommand input (kept separate so it can be unit-tested).
   *
   * PACKING. Every launch asks ECS to BINPACK on CPU: of the servers that can
   * take the task, the one with the least CPU left wins, so new work fills
   * running servers before ECS scales out a new one. Without a strategy ECS was
   * free to spread tasks across half-empty servers, which is the fragmentation
   * consolidation would otherwise have to undo with live moves.
   *
   * HINTS (services/fleet/assign.ts) narrow that further: the reservation is
   * sized to the stream (a task-level cpu/memory override, so a package-only
   * channel no longer reserves the same half-server as a full 1080p ladder),
   * the pool is the one sized for it, and a chosen server is pinned with a
   * memberOf constraint. With no hints the input is what it always was, plus
   * binpack.
   */
  runTaskInput(taskDef: string, containerName: string, env: Record<string, string>, hints?: LaunchHints): Record<string, any> {
    const o = config.orchestrator;
    const container: Record<string, any> = {
      name: containerName,
      environment: Object.entries(env).map(([name, value]) => ({ name, value })),
    };
    if (hints?.gpus) container.resourceRequirements = [{ type: 'GPU', value: String(hints.gpus) }];
    const overrides: Record<string, any> = { containerOverrides: [container] };
    if (hints?.cpuUnits) overrides.cpu = String(hints.cpuUnits);
    if (hints?.memoryMib) overrides.memory = String(hints.memoryMib);
    const input: Record<string, any> = {
      cluster: o.ecsCluster,
      taskDefinition: taskDef,
      count: 1,
      capacityProviderStrategy: hints?.capacityProvider
        ? [{ capacityProvider: hints.capacityProvider, weight: 1 }]
        : [
            { capacityProvider: o.spotProvider, weight: 4 },
            { capacityProvider: o.onDemandProvider, weight: 1, base: 1 },
          ],
      placementStrategy: [{ type: 'binpack', field: 'cpu' }],
      networkConfiguration: this.netConfig(),
      overrides,
      propagateTags: 'TASK_DEFINITION',
    };
    if (hints?.ec2InstanceId) {
      input.placementConstraints = [{ type: 'memberOf', expression: `ec2InstanceId == ${hints.ec2InstanceId}` }];
    } else if (hints?.avoidEc2InstanceIds?.length) {
      // A planned NEW server. A task that reserves no GPU would otherwise be
      // binpacked onto a running GPU server whose GPU placement refused (CPU
      // and memory there still have room). The expression limit is 2000
      // characters: about 90 ids, far more GPU servers than one pool runs.
      const ids = hints.avoidEc2InstanceIds.slice(0, 90).map((i) => `'${i}'`).join(', ');
      input.placementConstraints = [{ type: 'memberOf', expression: `not(ec2InstanceId in [${ids}])` }];
    }
    return input;
  }

  private async run(taskDef: string, containerName: string, env: Record<string, string>, hints?: LaunchHints): Promise<LaunchResult> {
    const { RunTaskCommand } = await import('@aws-sdk/client-ecs');
    const ecs = await this.client();
    let out = await ecs.send(new RunTaskCommand(this.runTaskInput(taskDef, containerName, env, hints) as any));
    // A pinned server can fill up between the plan and the launch (another
    // start, a task that grew). That must cost a better choice, never the
    // start: retry once unpinned, in the same pool, and let binpack choose.
    if (!out.tasks?.[0]?.taskArn && hints?.ec2InstanceId) {
      console.warn(`[ecs] pinned placement on ${hints.ec2InstanceId} refused (${JSON.stringify(out.failures ?? [])}); retrying unpinned`);
      const { ec2InstanceId: _pin, hostId: _h, ...rest } = hints;
      out = await ecs.send(new RunTaskCommand(this.runTaskInput(taskDef, containerName, env, rest) as any));
    }
    const task = out.tasks?.[0];
    if (!task?.taskArn) throw new Error(`ECS RunTask returned no task: ${JSON.stringify(out.failures ?? [])}`);
    const lifecycle = (task.capacityProviderName ?? '').includes('spot') ? 'spot' : 'on_demand';
    return { taskArn: task.taskArn, lifecycle };
  }

  launchEncoder(streamId: string, job: Record<string, any>, hints?: LaunchHints) {
    return this.run(config.orchestrator.encoderTaskDef, 'encoder', {
      JOB_CONFIG_JSON: JSON.stringify(job),
    }, hints);
  }
  launchThumbnailer(job: Record<string, any>) {
    return this.run(config.orchestrator.thumbnailerTaskDef, 'thumbnailer', {
      THUMB_CONFIG_JSON: JSON.stringify(job),
    });
  }
  launchRadio(streamId: string, job: Record<string, any>, hints?: LaunchHints) {
    // A station is long-lived and tiny. It still takes the same spot-preferring
    // capacity strategy as everything else, because the station reconnects to
    // its source on restart and the relay's listeners reconnect to the mount,
    // so a spot interruption costs a few seconds of audio rather than a manual
    // recovery.
    return this.run(config.orchestrator.radioTaskDef, 'radio', {
      JOB_CONFIG_JSON: JSON.stringify(job),
    }, hints);
  }
  async launchCaptions(streamId: string, job: Record<string, any>, hints?: LaunchHints) {
    // GPU-only capacity: the captions task def targets a GPU capacity provider so
    // this heavy add-on never lands on the lean encoder fleet.
    const env = { CAPTIONS_CONFIG_JSON: JSON.stringify(job) };
    const shared = config.orchestrator.captionsSharedTaskDef;
    if (hints?.sharedGpu && shared) {
      // SHARING THE GPU. The shared task definition reserves no GPU (ECS can
      // only reserve whole ones) and sees it through the GPU AMI's NVIDIA
      // runtime; placement has already checked GPU memory and GPU time.
      try {
        return await this.run(shared, 'captions', env, { ...hints, gpus: 0 });
      } catch (e) {
        // Most likely a planned new server that ECS would not start for a
        // task asking no GPU, behind a constraint that excludes every running
        // one. A whole GPU is what makes ECS scale the pool out, and captions
        // that start on their own server beat captions that do not start.
        console.warn(`[ecs] shared-GPU captions launch for ${streamId} failed (${(e as Error).message}); reserving a whole GPU`);
      }
      hints.sharedGpu = false;
      hints.gpus = 1;
      delete hints.avoidEc2InstanceIds;
      delete hints.ec2InstanceId;
      delete hints.hostId;
    }
    return this.run(config.orchestrator.captionsTaskDef, 'captions', env, hints);
  }
  /**
   * A FAST channel's playout (volt-fast image, bin/fast_playout.py). Not on the
   * TaskLauncher interface: it is not a stream the orchestrator runs, it is
   * supervised by services/fast/playoutRunner.ts, and only ECS has a task for
   * it (local runs it as a child process). A playout writes text, so the
   * reservation is a sliver of a server: an eighth of a vCPU, 256 MiB.
   */
  launchFast(channelId: string, job: Record<string, any>, taskDef: string) {
    return this.run(taskDef, 'fast', { FAST_CONFIG_JSON: JSON.stringify(job) }, { cpuUnits: 128, memoryMib: 256 });
  }
  async stopTask(taskArn: string, reason: string): Promise<void> {
    const { StopTaskCommand } = await import('@aws-sdk/client-ecs');
    const ecs = await this.client();
    await ecs.send(new StopTaskCommand({ cluster: config.orchestrator.ecsCluster, task: taskArn, reason }));
  }

  /**
   * DescribeTasks is the authority. ECS keeps a stopped task describable for
   * about an hour, so a task that has crashed answers STOPPED rather than
   * vanishing — which is exactly the case this exists to catch. A task old
   * enough to have aged out of the API returns nothing, and a MISSING failure
   * means the same thing: it is not running.
   *
   * Any error is `unknown`, never `dead`. A throttle or a network blip must
   * not be read as "every channel crashed".
   */
  async isRunning(taskArn: string): Promise<Liveness> {
    try {
      const { DescribeTasksCommand } = await import('@aws-sdk/client-ecs');
      const ecs = await this.client();
      const out = await ecs.send(new DescribeTasksCommand({
        cluster: config.orchestrator.ecsCluster, tasks: [taskArn],
      }) as any);
      const task = out.tasks?.[0];
      if (!task) {
        // MISSING is a definite answer; anything else we cannot interpret.
        const why = out.failures?.[0]?.reason;
        return why === 'MISSING' ? 'dead' : 'unknown';
      }
      const status = String(task.lastStatus ?? '').toUpperCase();
      if (status === 'STOPPED' || status === 'DEACTIVATING' || status === 'STOPPING') return 'dead';
      return 'alive';
    } catch (e) {
      console.warn('[ecs] could not determine liveness of', taskArn, e);
      return 'unknown';
    }
  }

  /**
   * Placement, from ECS alone. No EC2 client is needed and none is imported.
   *
   * DescribeTasks gives the container instance arn (EC2 capacity) or does not
   * (Fargate), and that single field is the fork:
   *
   *   containerInstanceArn present -> EC2. DescribeContainerInstances then
   *     yields the real ec2InstanceId, and its ATTRIBUTES carry
   *     `ecs.instance-type` and `ecs.availability-zone` — which is why this
   *     needs no @aws-sdk/client-ec2 and no ec2:DescribeInstances permission.
   *     registeredResources carry the host's total CPU and MEMORY, so vcpus is
   *     derived from the 1024-units-per-vCPU convention rather than from a
   *     hardcoded table of instance sizes that would rot.
   *
   *   absent -> Fargate. The task IS the machine, so the task arn is the host
   *     identity and the reserved cpu/memory are all there is to report. There
   *     is deliberately no attempt to synthesise a host CPU figure.
   *
   * Any failure returns null. A throttled DescribeContainerInstances must not
   * be recorded as "this task has no host", and it is not: null leaves the
   * previous observation in place, because attachInstanceToHost COALESCEs.
   */
  async describePlacement(taskArn: string): Promise<Placement | null> {
    try {
      const { DescribeTasksCommand, DescribeContainerInstancesCommand } =
        await import('@aws-sdk/client-ecs');
      const ecs = await this.client();
      const cluster = config.orchestrator.ecsCluster;
      const out: any = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }) as any);
      const task = out.tasks?.[0];
      if (!task) return null;

      const capacityProvider = task.capacityProviderName ?? null;
      const lifecycle = lifecycleFromProvider(capacityProvider);
      const az: string | null = task.availabilityZone ?? null;
      const cpuUnits = task.cpu != null ? Number(task.cpu) : null;
      const taskMemoryMib = task.memory != null ? Number(task.memory) : null;

      if (!task.containerInstanceArn) {
        return {
          hostKind: 'fargate',
          externalId: taskArn,
          containerInstanceArn: null,
          instanceType: 'fargate',
          availabilityZone: az,
          region: regionFromAz(az) ?? config.aws.region,
          lifecycle, capacityProvider,
          // The microVM is sized by the task, so host totals and task
          // reservation are the same number rather than two observations.
          vcpus: cpuUnits != null ? cpuUnits / 1024 : null,
          memoryMib: taskMemoryMib,
          cpuUnits, taskMemoryMib,
        };
      }

      const ci: any = await ecs.send(new DescribeContainerInstancesCommand({
        cluster, containerInstances: [task.containerInstanceArn],
      }) as any);
      const inst = ci.containerInstances?.[0];
      const attrs = attrMap(inst?.attributes);
      const totals: Record<string, number> = {};
      for (const r of inst?.registeredResources ?? []) {
        if (r?.name && r.integerValue != null) totals[r.name] = Number(r.integerValue);
      }
      const hostAz = attrs['ecs.availability-zone'] || az;
      return {
        hostKind: 'ec2',
        externalId: inst?.ec2InstanceId ?? task.containerInstanceArn,
        containerInstanceArn: task.containerInstanceArn,
        instanceType: attrs['ecs.instance-type'] || null,
        availabilityZone: hostAz ?? null,
        region: regionFromAz(hostAz) ?? config.aws.region,
        lifecycle, capacityProvider,
        vcpus: totals.CPU != null ? totals.CPU / 1024 : null,
        memoryMib: totals.MEMORY ?? null,
        cpuUnits, taskMemoryMib,
      };
    } catch (e) {
      console.warn('[ecs] could not describe placement of', taskArn, e);
      return null;
    }
  }
}

/**
 * The launcher the orchestrator uses, wrapped so a profile can name a vendor
 * encode engine (services/engines, volt/ENGINES.md). With every profile on the
 * default 'builtin' engine the wrapper passes straight through.
 */
export function makeLauncher(): TaskLauncher {
  // Lazy require: engines import types from this file.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const engines = require('../engines') as typeof import('../engines');
  engines.registerEngines();
  return engines.withEngines(makeBaseLauncher());
}

function makeBaseLauncher(): TaskLauncher {
  switch (config.orchestrator.launcher) {
    case 'ecs':
      return new EcsTaskLauncher();
    case 'local':
      // real on-box encoder.py / thumbnailer.py child processes (no AWS)
      return makeLocalLauncher();
    case 'docker':
      // real encoder inside the Linux image (ffmpeg+SRT+Shaka), production-identical
      return makeDockerLauncher();
    default:
      return new MockTaskLauncher();
  }
}
