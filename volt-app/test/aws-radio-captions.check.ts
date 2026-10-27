/**
 * Radio and live captions on AWS (build queue 2.1b).
 *
 * Two halves. First the Terraform: the radio and captions task definitions,
 * their image repositories and the GPU pool exist, and the names the control
 * plane is given (RADIO_TASK_DEF, CAPTIONS_TASK_DEF, ECS_GPU_PROVIDER) are the
 * names Terraform creates, with the container names EcsTaskLauncher overrides.
 * A mismatch there is a RunTask that fails at the first station start on AWS,
 * which no Mac run would ever show.
 *
 * Then the launch itself, through the real EcsTaskLauncher, placement planner
 * and load estimates, against a mocked ECS client: a whisper captions task goes
 * to the GPU pool with one GPU, a station to the small Spot pool, and with the
 * GPU pool turned off (gpu_max = 0) captions say why they cannot be placed.
 *
 * No database, no AWS, no terraform binary. TF_DIR points the first half at
 * another copy of deploy/terraform (used to show it fails on the stack before
 * this item).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

const ROOT = join(__dirname, '../..');
const TF = process.env.TF_DIR || join(ROOT, 'deploy/terraform');
const tfAll = readdirSync(TF).filter((f) => f.endsWith('.tf')).map((f) => readFileSync(join(TF, f), 'utf8')).join('\n');

/** The text of one top-level block, `resource "<type>" "<name>" { ... }`, by brace matching. */
function block(kind: string, type: string, name: string): string | null {
  const head = `${kind} "${type}" "${name}" {`;
  const at = tfAll.indexOf(head);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + head.length - 1; i < tfAll.length; i++) {
    if (tfAll[i] === '{') depth++;
    else if (tfAll[i] === '}' && --depth === 0) return tfAll.slice(at, i + 1);
  }
  return null;
}
const attr = (b: string | null, k: string) => (b?.match(new RegExp(`\\b${k}\\s*=\\s*"([^"]*)"`)) ?? [])[1];
/** Value of `{ name = "<n>", value = <expr> }` in the control plane's env list. */
const envExpr = (n: string) => (tfAll.match(new RegExp(`\\{ name = "${n}", value = (.+?) \\},?\\s*$`, 'm')) ?? [])[1]?.trim();

// The launcher's own container names, read from its source so the two cannot drift.
const launcherSrc = readFileSync(join(__dirname, '../src/services/orchestrator/launcher.ts'), 'utf8');
const containerOf = (cfgKey: string) => (launcherSrc.match(new RegExp(`config\\.orchestrator\\.${cfgKey}, '([a-z-]+)'`)) ?? [])[1];

(async () => {
  console.log(`the Terraform (${TF === join(ROOT, 'deploy/terraform') ? 'this tree' : TF})`);
  const repos = (tfAll.match(/ecr_repos\s*=\s*\[([^\]]*)\]/) ?? [])[1] ?? '';
  ok(/"volt-radio"/.test(repos), 'an image repository for volt-radio');
  ok(/"volt-captions"/.test(repos), 'an image repository for volt-captions');

  const cases = [
    { key: 'radioTaskDef', env: 'RADIO_TASK_DEF', res: 'radio', repo: 'volt-radio', gpu: false },
    { key: 'captionsTaskDef', env: 'CAPTIONS_TASK_DEF', res: 'captions', repo: 'volt-captions', gpu: true },
  ];
  for (const c of cases) {
    const b = block('resource', 'aws_ecs_task_definition', c.res);
    ok(!!b, `a ${c.res} task definition`);
    const family = attr(b, 'family');
    ok(family === `\${local.name}-${c.res}`, `its family is ${family}`);
    ok(envExpr(c.env) === `"\${local.name}-${c.res}"`, `${c.env} given to the control plane is that family (${envExpr(c.env) ?? 'not set'})`);
    const want = containerOf(c.key);
    ok(!!want && attr(b, 'name') === want, `its container is "${attr(b, 'name')}", the name the launcher overrides ("${want}")`);
    ok(new RegExp(`aws_ecr_repository\\.repo\\["${c.repo}"\\]`).test(b ?? ''), `its image comes from the ${c.repo} repository`);
    ok(/requires_compatibilities\s*=\s*\["EC2"\]/.test(b ?? '') && attr(b, 'network_mode') === 'awsvpc', 'EC2 and awsvpc, like the encoder (the launcher sends subnets and binpack)');
    ok(/task_role_arn\s*=\s*aws_iam_role\.encoder_task\.arn/.test(b ?? ''), 'the encoder task role, so the bucket access and PassRole already cover it');
    ok(/name = "S3_BUCKET", value = aws_s3_bucket\.origin\.id/.test(b ?? ''), 'it is told the origin bucket');
    ok(/type = "GPU", value = "1"/.test(b ?? '') === c.gpu, c.gpu ? 'it asks ECS for one GPU' : 'it asks for no GPU');
  }
  const passRole = (tfAll.match(/"iam:PassRole"\][\s\S]*?resources\s*=\s*\[([^\]]*)\]/) ?? [])[1] ?? '';
  ok(/encoder_task\.arn/.test(passRole) && /task_execution\.arn/.test(passRole), 'the control plane may pass both roles those tasks use');

  const cp = block('resource', 'aws_ecs_capacity_provider', 'gpu');
  ok(!!cp && attr(cp, 'name') === '${var.project}-gpu', `a GPU capacity provider (${attr(cp, 'name') ?? 'none'})`);
  ok(/aws_ecs_capacity_provider\.gpu\[\*\]\.name/.test(block('resource', 'aws_ecs_cluster_capacity_providers', 'main') ?? ''), 'the cluster uses it');
  ok(envExpr('ECS_GPU_PROVIDER') === 'join("", aws_ecs_capacity_provider.gpu[*].name)', 'ECS_GPU_PROVIDER is its name, empty when the pool is off');
  ok(envExpr('FLEET_GPU_TYPES') === 'join(",", var.gpu_instance_types)', 'FLEET_GPU_TYPES is the pool\'s instance types');
  const asg = block('resource', 'aws_autoscaling_group', 'gpu');
  ok(/min_size\s*=\s*0/.test(asg ?? '') && /desired_capacity\s*=\s*0/.test(asg ?? ''), 'the GPU group starts at zero servers (no cost until captions run)');
  ok(/on_demand_percentage_above_base_capacity\s*=\s*100/.test(asg ?? ''), 'and is on demand only (the planner never puts captions on Spot)');
  ok(/protect_from_scale_in\s*=\s*true/.test(asg ?? '') && /managed_termination_protection\s*=\s*"ENABLED"/.test(cp ?? ''), 'a server carrying captions is never scaled in');
  const lt = block('resource', 'aws_launch_template', 'ecs_gpu');
  ok(/data\.aws_ssm_parameter\.ecs_gpu_ami/.test(lt ?? '') && /amazon-linux-2023\/gpu\/recommended/.test(block('data', 'aws_ssm_parameter', 'ecs_gpu_ami') ?? ''), 'GPU servers boot the ECS GPU AMI');
  ok(/ECS_ENABLE_GPU_SUPPORT=true/.test(lt ?? '') && /ECS_CLUSTER=\$\{var\.project\}/.test(lt ?? ''), 'and join the cluster with GPU support on');

  const cov = JSON.parse(readFileSync(join(TF, 'env-coverage.json'), 'utf8')).settings as Record<string, any>;
  const left = Object.entries(cov).filter(([, v]) => v.item === '2.1b').map(([k]) => k);
  ok(left.length === 0, `nothing in env-coverage.json waits on 2.1b any more${left.length ? ` (${left.join(', ')})` : ''}`);
  const ice = Object.entries(cov).filter(([k]) => k.startsWith('ICECAST_'));
  ok(ice.length > 0 && ice.every(([, v]) => v.class === 'not-on-aws-yet' && v.item === '2.1c'), 'the Icecast relay is named as waiting on 2.1c');
  ok(/^\| 2\.1c \|/m.test(readFileSync(join(ROOT, 'BUILD_QUEUE.md'), 'utf8')), 'queue item 2.1c exists');

  console.log('launching through the real launcher, mocked ECS');
  Object.assign(process.env, {
    ORCH_LAUNCHER: 'ecs', ECS_CLUSTER: 'volt', RADIO_TASK_DEF: 'volt-staging-radio', CAPTIONS_TASK_DEF: 'volt-staging-captions',
    ECS_SPOT_PROVIDER: 'volt-spot', ECS_ONDEMAND_PROVIDER: 'volt-ondemand',
    ECS_SPOT_LARGE_PROVIDER: 'volt-spot-large', ECS_ONDEMAND_LARGE_PROVIDER: 'volt-ondemand-large',
    ECS_GPU_PROVIDER: 'volt-gpu', FLEET_GPU_TYPES: 'g4dn.xlarge', ECS_SUBNETS: 'subnet-a,subnet-b', ECS_SECURITY_GROUPS: 'sg-enc',
  });
  delete process.env.FLEET_POOLS;
  const { EcsTaskLauncher } = await import('../src/services/orchestrator/launcher');
  const { fleetSettings } = await import('../src/services/fleet/placementConfig');
  const { choosePlacement } = await import('../src/services/fleet/placementPlanner');
  const { estimateWhisperLoad, estimateRadioLoad } = await import('../src/services/fleet/streamLoad');
  const { resolveCaptionsPlan, buildCaptionsJobConfig } = await import('../src/services/captionsPlan');
  const { RunTaskCommand } = await import('@aws-sdk/client-ecs');

  const sent: any[] = [];
  const launcher = new EcsTaskLauncher();
  (launcher as any).ecs = {
    send: async (cmd: any) => {
      sent.push(cmd);
      const cp = cmd.input?.capacityProviderStrategy?.[0]?.capacityProvider ?? '';
      return { tasks: [{ taskArn: `arn:aws:ecs:ap-southeast-1:000000000000:task/volt/${sent.length}`, capacityProviderName: cp }] };
    },
  };
  const hintsFor = (d: any, est: any) => d.action === 'new_host'
    ? { cpuUnits: est.reservation.cpuUnits, memoryMib: est.reservation.memoryMib, gpus: est.reservation.gpus, capacityProvider: d.capacityProvider }
    : undefined;

  // captions: whisper small with a translated target
  const plan = resolveCaptionsPlan({ accountProvider: 'whisper', captionsEnabled: true, sourceLang: 'en', targets: ['en', 'es'], modelSize: 'small', cpuInEncoder: false });
  ok(plan.runsSeparateTask && plan.needsGpu, 'a whisper plan runs as its own GPU task');
  const capEst = estimateWhisperLoad({ estVramGb: plan.estVramGb, needsMt: plan.needsMt, modelSize: plan.modelSize });
  const policy = fleetSettings().placementPolicy;
  ok(policy.pools.some((p) => p.gpu && p.provider === 'volt-gpu' && p.lifecycle === 'on_demand' && p.types[0] === 'g4dn.xlarge'), 'the GPU pool Terraform names is in the placement policy');
  const capDecision: any = choosePlacement({ streamId: 'ch-cap', streamClass: 'captions', accountId: null, isolation: 'shared', load: capEst.load, reservation: capEst.reservation, needsGpu: true }, [], policy);
  ok(capDecision.action === 'new_host' && capDecision.capacityProvider === 'volt-gpu' && capDecision.instanceType === 'g4dn.xlarge', `captions are placed on a new g4dn.xlarge in the GPU pool (${capDecision.action}, ${capDecision.capacityProvider ?? capDecision.reason})`);
  const capJob = buildCaptionsJobConfig('ch-cap', plan, 's3://volt-origin/channel/ch-cap/audio/index.m3u8', 0, 'channel/ch-cap/subtitles');
  const capRes = await launcher.launchCaptions('ch-cap', capJob, hintsFor(capDecision, capEst));
  const capCmd = sent[0];
  ok(capCmd instanceof RunTaskCommand, 'one RunTask sent for the captions task');
  const ci = capCmd?.input ?? {};
  ok(ci.taskDefinition === 'volt-staging-captions' && ci.cluster === 'volt', `into the captions task definition on the cluster (${ci.taskDefinition}, ${ci.cluster})`);
  const cc = ci.overrides?.containerOverrides?.[0] ?? {};
  ok(cc.name === attr(block('resource', 'aws_ecs_task_definition', 'captions'), 'name'), `overriding the container Terraform defines ("${cc.name}")`);
  ok(cc.resourceRequirements?.[0]?.type === 'GPU' && cc.resourceRequirements[0].value === '1', 'with one GPU reserved');
  ok(ci.capacityProviderStrategy?.length === 1 && ci.capacityProviderStrategy[0].capacityProvider === 'volt-gpu', 'only into the GPU pool, never the encoder fleet');
  const capCfg = JSON.parse(cc.environment?.find((e: any) => e.name === 'CAPTIONS_CONFIG_JSON')?.value ?? '{}');
  ok(capCfg.engine === 'whisper' && /channel\/ch-cap\/audio/.test(JSON.stringify(capCfg)) && /channel\/ch-cap\/subtitles/.test(JSON.stringify(capCfg)), 'its job reads the stream\'s audio and writes beside it in the bucket');
  ok(Number(ci.overrides?.memory) > 0 && Number(ci.overrides.memory) <= 16384 && Number(ci.overrides?.cpu) <= 4096, `sized to fit the server (${ci.overrides?.cpu} CPU units, ${ci.overrides?.memory} MiB)`);
  ok(ci.networkConfiguration?.awsvpcConfiguration?.subnets?.join(',') === 'subnet-a,subnet-b', 'in the private subnets Terraform passes');
  ok(capRes.lifecycle === 'on_demand' && /task\/volt\/1$/.test(capRes.taskArn), 'answered on demand with its task arn');

  // radio: a 128 kbps station with HLS and DASH
  const radioJob = { bitrate_kbps: 128, outputs: { hls: true, dash: true } };
  const rEst = estimateRadioLoad(radioJob);
  const rDecision: any = choosePlacement({ streamId: 'st-1', streamClass: 'radio', accountId: null, isolation: 'shared', load: rEst.load, reservation: rEst.reservation, needsGpu: false }, [], policy);
  ok(rDecision.action === 'new_host' && rDecision.capacityProvider === 'volt-spot', `a station goes to the small Spot pool (${rDecision.capacityProvider ?? rDecision.reason})`);
  const rRes = await launcher.launchRadio('st-1', radioJob, hintsFor(rDecision, rEst));
  const ri = sent[1]?.input ?? {};
  const rc = ri.overrides?.containerOverrides?.[0] ?? {};
  ok(ri.taskDefinition === 'volt-staging-radio', `into the radio task definition (${ri.taskDefinition})`);
  ok(rc.name === attr(block('resource', 'aws_ecs_task_definition', 'radio'), 'name'), `overriding the container Terraform defines ("${rc.name}")`);
  ok(!rc.resourceRequirements, 'with no GPU');
  ok(JSON.parse(rc.environment?.find((e: any) => e.name === 'JOB_CONFIG_JSON')?.value ?? '{}').bitrate_kbps === 128, 'carrying the station\'s job');
  ok(Number(ri.overrides?.cpu) < 1024 && Number(ri.overrides?.memory) < 1024, `a sliver of a server (${ri.overrides?.cpu} CPU units, ${ri.overrides?.memory} MiB)`);
  ok(rRes.lifecycle === 'spot', 'answered as Spot');
  await launcher.launchRadio('st-2', radioJob);
  const plain = sent[2]?.input ?? {};
  ok(plain.capacityProviderStrategy?.length === 2 && plain.capacityProviderStrategy.some((s: any) => s.capacityProvider === 'volt-ondemand' && s.base === 1), 'with placement off a station keeps Spot with the on-demand base');

  console.log('the GPU pool turned off (gpu_max = 0)');
  process.env.ECS_GPU_PROVIDER = '';
  const off: any = choosePlacement({ streamId: 'ch-cap', streamClass: 'captions', accountId: null, isolation: 'shared', load: capEst.load, reservation: capEst.reservation, needsGpu: true }, [], fleetSettings().placementPolicy);
  ok(off.action === 'unplaceable' && /needs a GPU and no GPU server pool is configured/.test(off.reason), `captions say why they cannot be placed ("${off.reason}")`);

  console.log(`\naws-radio-captions: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
