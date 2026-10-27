/**
 * Several live captions streams on one GPU (build queue 2.4b).
 *
 * ECS can only reserve whole GPUs, so every Whisper task used to take a T4 to
 * itself and two captioned channels paid for two g4dn servers. With
 * FLEET_CAPTIONS_GPU_SHARING a captions task reserves no GPU and placement
 * keeps the GPU from being overcommitted by its memory and its time.
 *
 *   1. The model: GPU time and GPU memory per Whisper model, and the shared
 *      form of the same estimate (no GPU reserved, same cost and signature).
 *   2. The fit test on a g4dn.xlarge: two small-model streams share it; GPU
 *      memory, GPU time, a whole-GPU neighbour and the task slots each refuse.
 *   3. End to end through the database: assignStream and recordAssignment for
 *      three small-model streams against one running g4dn.xlarge. The first
 *      two land on it, the third is planned on a new server that must avoid
 *      it; with sharing off the second already needs a new server.
 *   4. The launcher against a mocked ECS client: the shared task definition
 *      with no GPU and the avoid constraint, a pinned shared launch, and the
 *      fall back to a whole GPU (recorded as such) when ECS will not start it.
 *   5. The Terraform: the shared task definition, the names and switch the
 *      control plane is given, off by default, and the GPU hosts' runtime.
 *
 * A real T4 running two streams side by side is Christian's to run on AWS
 * (PLACEMENT.md, captions on a shared GPU).
 *
 * Run: DATABASE_URL=... npx tsx test/captions-gpu-sharing.check.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

Object.assign(process.env, {
  ORCH_LAUNCHER: 'ecs', FLEET_PLACEMENT: 'true', FLEET_LEARN: 'false', ECS_CLUSTER: 'volt',
  CAPTIONS_TASK_DEF: 'volt-staging-captions', CAPTIONS_SHARED_TASK_DEF: 'volt-staging-captions-shared',
  ECS_SPOT_PROVIDER: 'volt-spot', ECS_ONDEMAND_PROVIDER: 'volt-ondemand',
  ECS_GPU_PROVIDER: 'volt-gpu', FLEET_GPU_TYPES: 'g4dn.xlarge', ECS_SUBNETS: 'subnet-a', ECS_SECURITY_GROUPS: 'sg-enc',
});
delete process.env.FLEET_POOLS;

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string, extra?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}${extra === undefined ? '' : ` -- ${JSON.stringify(extra)}`}`); }
}

const HOST = 'i-gpu-captions-1';

(async () => {
  const { estimateWhisperLoad, shareGpu, unshareGpu } = await import('../src/services/fleet/streamLoad');
  const { sizeWhisper } = await import('../src/services/captionsPlan');
  const { fits, occupy, capacityOf, DEFAULT_FIT } = await import('../src/services/fleet/capacity');
  const whisper = (modelSize: string, needsMt: boolean) => estimateWhisperLoad({ estVramGb: sizeWhisper(modelSize, needsMt).vramGb, needsMt, modelSize });

  console.log('1. the model');
  const small = whisper('small', false);
  ok(small.load.vramMib === 2560 && small.load.gpuShare === 0.2, `small Whisper holds 2.5 GiB of GPU memory and a fifth of the GPU's time (${small.load.vramMib} MiB, ${small.load.gpuShare})`);
  ok(whisper('medium', true).load.gpuShare > whisper('small', false).load.gpuShare && whisper('small', true).load.gpuShare > small.load.gpuShare, 'a larger model and translation each cost more GPU time');
  ok(small.reservation.gpus === 1 && !small.sharesGpu, 'unshared, the task reserves a whole GPU (as before)');
  const sSmall = shareGpu(small);
  ok(sSmall.sharesGpu === true && sSmall.reservation.gpus === 0 && sSmall.load.gpus === 0, 'shared, it reserves no GPU');
  ok(sSmall.signature === small.signature && sSmall.load.cpuUnits === small.load.cpuUnits && sSmall.load.vramMib === small.load.vramMib, 'same cost and signature either way (its history carries over)');
  ok(unshareGpu(sSmall).reservation.gpus === 1 && !unshareGpu(sSmall).sharesGpu, 'and back to a whole GPU');
  ok(shareGpu({ ...small, taskKind: 'transcode' } as any).sharesGpu !== true, 'only captions tasks share (an NVENC encoder keeps its GPU)');

  console.log('2. the fit test on a g4dn.xlarge');
  const cap = capacityOf('g4dn.xlarge', {})!;
  ok(cap.gpus === 1 && cap.gpuMemoryMib === 15360, `a T4 with 15 GiB usable (${cap.gpuMemoryMib} MiB)`);
  const empty = { reserved: { cpuUnits: 0, memoryMib: 0, gpus: 0 }, tasks: 0, cpuUnits: 0, netBps: 0, gpuShare: 0 };
  const add = (e: any) => ({ reservation: e.reservation, load: e.load, sharesGpu: e.sharesGpu });
  const one1 = occupy(empty, add(sSmall));
  const f2 = fits(cap, one1, add(sSmall), DEFAULT_FIT);
  ok(f2.ok, `a second small-model stream fits beside the first (CPU ${Math.round(f2.cpuAfter * 100)}% after)`, f2.reason);
  const two = occupy(one1, add(sSmall));
  const f3 = fits(cap, two, add(sSmall), DEFAULT_FIT);
  ok(!f3.ok && /task slot/.test(f3.reason ?? ''), `a third does not: a g4dn.xlarge has two task network interfaces ("${f3.reason}")`);
  const big = { ...cap, taskSlots: 8, cpuUnits: 32768, memoryMib: 120000 };
  const medMt = shareGpu(whisper('medium', true));
  const fm = fits(big, occupy(empty, add(medMt)), add(medMt), DEFAULT_FIT);
  ok(!fm.ok && /GPU memory would run short/.test(fm.reason ?? ''), `two medium models with translation do not share a T4's memory ("${fm.reason}")`);
  const large = shareGpu(whisper('large-v3', false));
  const fl = fits(big, occupy(empty, add(large)), add(large), DEFAULT_FIT);
  ok(!fl.ok && /GPU would be \d+% busy/.test(fl.reason ?? ''), `two large models would keep the GPU too busy ("${fl.reason}")`);
  const whole = occupy(empty, add(small));
  const fw = fits(cap, whole, add(sSmall), DEFAULT_FIT);
  ok(!fw.ok && /reserved whole/.test(fw.reason ?? ''), `a sharer never joins a task that reserved the GPU whole ("${fw.reason}")`);
  const fx = fits(cap, one1, add(small), DEFAULT_FIT);
  ok(!fx.ok && /shared by captions/.test(fx.reason ?? ''), `and a whole-GPU task never lands on sharers ("${fx.reason}")`);
  const fs1 = fits(cap, empty, add(sSmall), DEFAULT_FIT);
  const noGpu = capacityOf('c7i.xlarge', {})!;
  ok(fs1.ok && fits(noGpu, empty, add(sSmall), DEFAULT_FIT).reason === 'needs a GPU', 'an empty T4 takes it; a CPU server never does');

  console.log('3. end to end through the database');
  const { query, one, pool } = await import('../src/db');
  const { assignStream, recordAssignment } = await import('../src/services/fleet/assign');
  const { loadFleetSnapshot } = await import('../src/services/fleet/snapshot');
  const cleanup = async () => {
    await query(`DELETE FROM instances WHERE task_arn LIKE 'arn:test:captions-share:%'`);
    await query(`DELETE FROM compute_hosts WHERE external_id = $1`, [HOST]);
  };
  await cleanup();
  const host = await one<{ id: string }>(
    `INSERT INTO compute_hosts(kind, external_id, instance_type, availability_zone, lifecycle, vcpus, memory_mib, state)
     VALUES ('ec2', $1, 'g4dn.xlarge', 'ap-southeast-2a', 'on_demand', 4, 15400, 'up') RETURNING id`, [HOST]);
  let n = 0;
  const start = async (streamId: string) => {
    const a = await assignStream({ streamId, streamClass: 'captions', accountId: null, estimate: whisper('small', false) });
    const arn = `arn:test:captions-share:${++n}`;
    await query(`INSERT INTO instances(task_arn, is_gpu, instance_type, lifecycle, role, task_kind, state, launched_at)
                 VALUES ($1, true, 'g4dn.xlarge', 'on_demand', 'captions', 'captions', 'running', now())`, [arn]);
    await recordAssignment(arn, a);
    return { a, arn };
  };

  process.env.FLEET_CAPTIONS_GPU_SHARING = 'true';
  const c1 = await start('cap-1');
  ok(c1.a.decision.action === 'existing_host' && c1.a.hints?.ec2InstanceId === HOST && c1.a.hints?.sharedGpu === true && c1.a.hints?.gpus === 0,
    'the first stream goes on the running GPU server, sharing, no GPU reserved', c1.a.hints);
  const r1 = await one<any>(`SELECT reserved_gpus, placement_decision FROM instances WHERE task_arn = $1`, [c1.arn]);
  ok(r1.reserved_gpus === 0 && r1.placement_decision.vramMib === 2560 && r1.placement_decision.sharesGpu === true, 'recorded: no GPU reserved, 2.5 GiB of GPU memory held, sharing', r1);
  const snap = (await loadFleetSnapshot()).find((h) => h.externalId === HOST)!;
  ok(snap.tasks.length === 1 && snap.tasks[0].load.vramMib === 2560 && snap.tasks[0].reservation.gpus === 0, 'the next placement reads its GPU memory back from the fleet snapshot', snap.tasks[0]?.load);
  const c2 = await start('cap-2');
  ok(c2.a.decision.action === 'existing_host' && c2.a.hints?.ec2InstanceId === HOST && c2.a.hints?.sharedGpu === true,
    'the second small-model stream shares the same g4dn.xlarge', c2.a.decision);
  const c3 = await start('cap-3');
  const d3: any = c3.a.decision;
  ok(d3.action === 'new_host' && d3.capacityProvider === 'volt-gpu' && d3.instanceType === 'g4dn.xlarge', `the third goes to a new g4dn.xlarge (${d3.action}: ${d3.reason})`);
  ok(d3.considered?.some((c: any) => c.hostId === host!.id && /task slot/.test(c.reason)), 'saying why the running one was refused', d3.considered);
  ok(JSON.stringify(c3.a.hints?.avoidEc2InstanceIds) === JSON.stringify([HOST]) && c3.a.hints?.sharedGpu === true,
    'and telling ECS not to binpack it onto the full one', c3.a.hints);

  await cleanup();
  await query(`INSERT INTO compute_hosts(kind, external_id, instance_type, availability_zone, lifecycle, vcpus, memory_mib, state)
               VALUES ('ec2', $1, 'g4dn.xlarge', 'ap-southeast-2a', 'on_demand', 4, 15400, 'up')`, [HOST]);
  process.env.FLEET_CAPTIONS_GPU_SHARING = 'false';
  const o1 = await start('cap-off-1');
  const o2 = await start('cap-off-2');
  ok(o1.a.decision.action === 'existing_host' && o1.a.hints?.gpus === 1 && !o1.a.hints?.sharedGpu, 'sharing off: the first reserves the GPU whole', o1.a.hints);
  ok(o2.a.decision.action === 'new_host' && (o2.a.decision as any).considered?.some((c: any) => c.reason === 'GPU already taken') && !(o2.a.decision as any).avoidEc2InstanceIds,
    'and the second needs a server of its own (as before this item)', o2.a.decision);
  process.env.FLEET_CAPTIONS_GPU_SHARING = 'true';
  process.env.FLEET_PLACEMENT = 'false';
  const np = await assignStream({ streamId: 'cap-np', streamClass: 'captions', accountId: null, estimate: whisper('small', false) });
  ok(!np.hints && np.estimate.reservation.gpus === 1 && !np.estimate.sharesGpu, 'with placement off nothing was checked, so the task reserves its GPU whole');
  process.env.FLEET_PLACEMENT = 'true';
  const savedShared = process.env.CAPTIONS_SHARED_TASK_DEF;
  const { fleetSettings } = await import('../src/services/fleet/placementConfig');
  const { config } = await import('../src/config');
  ok(fleetSettings().captionsGpuSharing === true, 'the switch is on with both halves set');
  (config.orchestrator as any).captionsSharedTaskDef = '';
  ok(fleetSettings().captionsGpuSharing === false, 'and off when no shared task definition is named, even with the switch on');
  (config.orchestrator as any).captionsSharedTaskDef = savedShared;
  await cleanup();

  console.log('4. the launcher');
  const { EcsTaskLauncher } = await import('../src/services/orchestrator/launcher');
  const sent: any[] = [];
  let refuseShared = false;
  const launcher = new EcsTaskLauncher();
  (launcher as any).ecs = {
    send: async (cmd: any) => {
      sent.push(cmd.input);
      if (refuseShared && cmd.input.taskDefinition === 'volt-staging-captions-shared') return { tasks: [], failures: [{ reason: 'MEMBER' }] };
      return { tasks: [{ taskArn: `arn:aws:ecs:x:0:task/volt/${sent.length}`, capacityProviderName: 'volt-gpu' }] };
    },
  };
  const job = { engine: 'whisper' };
  const newHints: any = { ...c3.a.hints };
  await launcher.launchCaptions('cap-3', job, newHints);
  const i1 = sent[0];
  const cc1 = i1.overrides.containerOverrides[0];
  ok(i1.taskDefinition === 'volt-staging-captions-shared' && cc1.name === 'captions', `a shared launch uses the task definition that reserves no GPU (${i1.taskDefinition})`);
  ok(!cc1.resourceRequirements, 'with no GPU in the override either');
  ok(i1.placementConstraints?.[0]?.type === 'memberOf' && i1.placementConstraints[0].expression === `not(ec2InstanceId in ['${HOST}'])`, `a planned new server avoids the running one (${i1.placementConstraints?.[0]?.expression})`);
  ok(i1.capacityProviderStrategy?.[0]?.capacityProvider === 'volt-gpu', 'in the GPU pool');
  await launcher.launchCaptions('cap-2', job, { ...c2.a.hints! });
  ok(sent[1].taskDefinition === 'volt-staging-captions-shared' && sent[1].placementConstraints?.[0]?.expression === `ec2InstanceId == ${HOST}`, 'a shared launch onto a running server is pinned to it');
  refuseShared = true;
  const fbHints: any = { ...c3.a.hints };
  const fb = await launcher.launchCaptions('cap-3', job, fbHints);
  const last = sent[sent.length - 1];
  ok(last.taskDefinition === 'volt-staging-captions' && last.overrides.containerOverrides[0].resourceRequirements?.[0]?.value === '1' && !last.placementConstraints,
    'when ECS will not start the shared task, captions start anyway on a whole GPU (the pool scales out for it)', last);
  ok(!!fb.taskArn && fbHints.sharedGpu === false && fbHints.gpus === 1, 'and the hints now say so, so the record matches what ran', fbHints);
  const before = sent.length;
  await launcher.launchCaptions('cap-x', job, { capacityProvider: 'volt-gpu', gpus: 1 });
  ok(sent.length === before + 1 && sent[before].taskDefinition === 'volt-staging-captions', 'a launch without the sharing hint is unchanged');

  console.log('5. the Terraform');
  const TF = join(__dirname, '../../deploy/terraform');
  const tf = readdirSync(TF).filter((f) => f.endsWith('.tf')).map((f) => readFileSync(join(TF, f), 'utf8')).join('\n');
  const blockOf = (head: string) => {
    const at = tf.indexOf(head); if (at < 0) return '';
    let d = 0;
    for (let i = at + head.length - 1; i < tf.length; i++) { if (tf[i] === '{') d++; else if (tf[i] === '}' && --d === 0) return tf.slice(at, i + 1); }
    return '';
  };
  const shared = blockOf('resource "aws_ecs_task_definition" "captions_shared" {');
  ok(!!shared && /family\s*=\s*"\$\{local\.name\}-captions-shared"/.test(shared), 'a shared captions task definition');
  ok(!/resourceRequirements/.test(shared) && /NVIDIA_VISIBLE_DEVICES", value = "all"/.test(shared), 'reserving no GPU and asking the NVIDIA runtime for it');
  ok(/name\s*=\s*"captions"/.test(shared) && /aws_ecr_repository\.repo\["volt-captions"\]/.test(shared), 'the same container name and image as the whole-GPU one');
  ok(/\{ name = "CAPTIONS_SHARED_TASK_DEF", value = "\$\{local\.name\}-captions-shared" \}/.test(tf), 'its name is given to the control plane');
  ok(/\{ name = "FLEET_CAPTIONS_GPU_SHARING", value = var\.captions_gpu_sharing \? "true" : "false" \}/.test(tf), 'the switch comes from captions_gpu_sharing');
  const v = blockOf('variable "captions_gpu_sharing" {');
  ok(/type\s*=\s*bool/.test(v) && /default\s*=\s*false/.test(v), 'which is off by default until the real-T4 check');
  ok(/%\{if var\.captions_gpu_sharing~\}[\s\S]*nvidia-ctk runtime configure --runtime=docker --set-as-default[\s\S]*%\{endif~\}/.test(blockOf('resource "aws_launch_template" "ecs_gpu" {')),
    'GPU servers make NVIDIA the default container runtime when sharing is on');
  ok(/resourceRequirements = \[\{ type = "GPU", value = "1" \}\]/.test(blockOf('resource "aws_ecs_task_definition" "captions" {')), 'the whole-GPU task definition is unchanged (the fall back)');

  await pool.end().catch(() => {});
  console.log(`\ncaptions-gpu-sharing: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
