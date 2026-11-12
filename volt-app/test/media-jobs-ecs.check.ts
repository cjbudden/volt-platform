// ============================================================================
//  MEDIA JOBS IN THEIR OWN TASKS (build queue 2.1a-4), against Postgres.
//
//  On AWS the control plane's image has no ffmpeg, packager or Python, so its
//  worker hands every media job (clip extract, VOD encode, loop preparation,
//  intro detection and the rest) to a task of the volt-media-jobs image, which
//  runs that one job and exits. This suite checks:
//
//    1. the Terraform and images: the task definition, its repository, the
//       container name the launcher overrides, the settings the control plane
//       is given, Fargate Spot, PassRole and TagResource, the image carrying
//       the tools while the control-plane image does not, the deploy driver
//       building it;
//    2. the RunTask the real EcsTaskLauncher sends, against a mocked ECS client;
//    3. the worker with MEDIA_JOBS_MODE=ecs and the mock launcher: clip
//       extract, VOD encode, loop preparation and intro detection are handed
//       to a task each and never run in the control plane, light jobs still
//       run in it, the hand-over lease covers a slow start, the task's run
//       completes the job, and every failure path (launch refused, a task that
//       never starts, a lease taken away mid-run, a handler error, the task
//       ceiling) leaves the job where the queue expects it;
//    4. the real entrypoint (src/tools/run-media-job.ts) as its own process,
//       with every handler registered, running a real job to its end.
//
//  Run: DATABASE_URL=... npx tsx test/media-jobs-ecs.check.ts
// ============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.argv[2] === 'types') {
  // Child: what the media-jobs task registers (the same list as index.ts).
  (async () => {
    const { registerAllJobHandlers } = await import('../src/services/jobs/registerAll');
    const { registeredTypes } = await import('../src/services/jobs/worker');
    await registerAllJobHandlers();
    console.log('TYPES ' + JSON.stringify(registeredTypes()));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch(async (e) => { console.error(e); process.exit(1); });
}

async function main() {
  let pass = 0, failed = 0;
  const ok = (c: unknown, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { failed++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ROOT = join(__dirname, '../..');

  // ------------------------------------------------------- 1. Terraform, images
  const TF = join(ROOT, 'deploy/terraform');
  if (existsSync(TF)) {
    console.log('-- the Terraform and the images');
    const tf = readdirSync(TF).filter((f) => f.endsWith('.tf')).map((f) => readFileSync(join(TF, f), 'utf8')).join('\n');
    const block = (head: string) => {
      const at = tf.indexOf(head); if (at < 0) return '';
      let depth = 0;
      for (let i = at + head.length - 1; i < tf.length; i++) {
        if (tf[i] === '{') depth++; else if (tf[i] === '}' && --depth === 0) return tf.slice(at, i + 1);
      }
      return '';
    };
    const td = block('resource "aws_ecs_task_definition" "media_jobs" {');
    ok(/"volt-media-jobs"/.test((tf.match(/ecr_repos\s*=\s*\[([^\]]*)\]/) ?? [])[1] ?? ''), 'an image repository for volt-media-jobs');
    ok(td.includes('family                   = "${local.name}-media-jobs"'), 'a media-jobs task definition');
    ok(/requires_compatibilities\s*=\s*\["FARGATE"\]/.test(td) && /network_mode\s*=\s*"awsvpc"/.test(td), 'Fargate and awsvpc (the launcher sends Fargate providers and subnets)');
    ok(/ephemeral_storage\s*\{\s*size_in_gib\s*=\s*var\.media_job_disk_gib/.test(td), 'its own scratch disk, sized by media_job_disk_gib');
    ok(/task_role_arn\s*=\s*aws_iam_role\.control_plane\.arn/.test(td), 'the control plane task role (database secrets, the bucket)');
    ok(td.includes('repo["volt-media-jobs"]') && td.includes('var.control_plane_image_tag'), 'the volt-media-jobs image at the control plane release tag (the same code and schema)');
    ok(/environment\s*=\s*concat\(local\.control_plane_env, local\.scale_env/.test(td) && /secrets\s*=\s*concat\(local\.control_plane_secrets/.test(td), "the control plane's settings and secrets");
    const launcherSrc = readFileSync(join(__dirname, '../src/services/orchestrator/launcher.ts'), 'utf8');
    const container = (launcherSrc.match(/name: '(media-job)',\s*\n\s*environment: \[\s*\n\s*\{ name: 'MEDIA_JOB_ID'/) ?? [])[1];
    ok(container && td.includes(`name      = "${container}"`), 'the container name the launcher overrides is the one Terraform defines', String(container));
    const env = (n: string) => (tf.match(new RegExp(`\\{ name = "${n}", value = (.+?) \\},?\\s*$`, 'm')) ?? [])[1]?.trim();
    ok(env('MEDIA_JOBS_MODE') === '"ecs"', 'the control plane is told MEDIA_JOBS_MODE=ecs');
    ok(env('MEDIA_JOB_TASK_DEF') === '"${local.name}-media-jobs"', 'MEDIA_JOB_TASK_DEF names the task definition Terraform creates');
    ok(env('MEDIA_JOB_SECURITY_GROUPS') === 'aws_security_group.control_plane.id', "media tasks join the control plane's security group (the database allows it)");
    ok(env('MEDIA_JOB_MAX_TASKS') === 'tostring(var.media_job_max_tasks)', 'the task ceiling comes from media_job_max_tasks');
    ok(/"FARGATE_SPOT"/.test(block('resource "aws_ecs_cluster_capacity_providers" "main" {')), 'Fargate Spot is a capacity provider of the cluster');
    const cpPolicy = block('data "aws_iam_policy_document" "control_plane" {');
    ok(/iam:PassRole[\s\S]*aws_iam_role\.control_plane\.arn/.test(cpPolicy), 'the control plane may pass its own role to a media task');
    ok(/"ecs:RunTask"[^\]]*"ecs:TagResource"/.test(cpPolicy), 'and tag the task at RunTask');
    const example = readFileSync(join(TF, 'terraform.tfvars.example'), 'utf8');
    ok(['media_job_cpu', 'media_job_memory', 'media_job_disk_gib', 'media_job_max_tasks'].every((v) => example.includes(`# ${v} =`)), 'every new variable has a line in terraform.tfvars.example');
    const cov = JSON.parse(readFileSync(join(TF, 'env-coverage.json'), 'utf8')).settings;
    ok(['FFMPEG_BIN', 'FFPROBE_BIN', 'PACKAGER_BIN', 'PYTHON_BIN', 'FFMPEG_PATH'].every((k) => cov[k]?.item === '2.1a-4b'),
      'the tool settings point at 2.1a-4b (the control plane still runs some tools itself)');
  } else {
    console.log('-- deploy/ not in this copy: Terraform checks skipped');
  }
  const df = readFileSync(join(__dirname, '../Dockerfile.media-jobs'), 'utf8');
  ok(/apt-get install[\s\S]*\bffmpeg\b[\s\S]*\bpython3\b/.test(df) && /shaka-packager[\s\S]*\/usr\/local\/bin\/packager/.test(df), 'the media-jobs image carries ffmpeg, Python and the packager');
  ok(/COPY volt-encoder\/bin \/opt\/volt-encoder\/bin/.test(df) && /ENCODER_BIN=\/opt\/volt-encoder\/bin/.test(df), "and volt-encoder's scripts where the handlers look for them");
  ok(/CMD \["node", "dist\/tools\/run-media-job\.js"\]/.test(df) && existsSync(join(__dirname, '../src/tools/run-media-job.ts')), 'it runs the media-job entrypoint');
  const cpDf = readFileSync(join(__dirname, '../Dockerfile'), 'utf8');
  ok(!/apt-get[\s\S]*ffmpeg|packager|python3/.test(cpDf), 'the control-plane image still carries none of the tools');
  const drv = join(ROOT, 'scripts/deploy/drivers/ecs.mjs');
  if (existsSync(drv)) {
    const d = readFileSync(drv, 'utf8');
    ok(/'media-jobs': \{ repo: 'volt-media-jobs', dockerfile: 'volt-app\/Dockerfile\.media-jobs', context: '\.' \}/.test(d)
      && /DEFAULT_IMAGES = \[[^\]]*'media-jobs'/.test(d) && /'media-jobs': 'media-jobs'/.test(d),
      'deploy.mjs builds and pushes volt-media-jobs and moves its task family');
  }

  // -------------------------------------------------- 2. the real RunTask input
  console.log('-- EcsTaskLauncher.launchMediaJob against a mocked ECS client');
  Object.assign(process.env, {
    ECS_CLUSTER: 'volt', MEDIA_JOB_TASK_DEF: 'volt-staging-media-jobs',
    MEDIA_JOB_SUBNETS: 'subnet-a,subnet-b', MEDIA_JOB_SECURITY_GROUPS: 'sg-cp', ECS_SECURITY_GROUPS: 'sg-encoder',
  });
  const { EcsTaskLauncher, MockTaskLauncher } = await import('../src/services/orchestrator/launcher');
  const ecs = new EcsTaskLauncher();
  const sent: any[] = [];
  (ecs as any).ecs = { send: async (cmd: any) => { sent.push(cmd.input); return { tasks: [{ taskArn: 'arn:aws:ecs:x:1:task/volt/abc', capacityProviderName: 'FARGATE_SPOT' }] }; } };
  const r = await ecs.launchMediaJob({ jobId: 'j-1', workerId: 'task:w-1', type: 'vod.encode' });
  const inp = sent[0] ?? {};
  ok(r.taskArn === 'arn:aws:ecs:x:1:task/volt/abc' && r.lifecycle === 'spot', 'returns the task and reads Spot from its capacity provider');
  ok(inp.taskDefinition === 'volt-staging-media-jobs' && inp.cluster === 'volt' && inp.count === 1, 'one task of MEDIA_JOB_TASK_DEF in the cluster');
  ok(JSON.stringify(inp.capacityProviderStrategy) === JSON.stringify([{ capacityProvider: 'FARGATE_SPOT', weight: 3 }, { capacityProvider: 'FARGATE', weight: 1 }]), 'Fargate Spot first, Fargate on-demand beside it');
  ok(!inp.placementStrategy, 'no binpack strategy (Fargate refuses one)');
  const net = inp.networkConfiguration?.awsvpcConfiguration ?? {};
  ok(net.subnets?.join() === 'subnet-a,subnet-b' && net.securityGroups?.join() === 'sg-cp' && net.assignPublicIp === 'DISABLED', "the control plane's subnets and security group, not the encoders'");
  const ov = inp.overrides?.containerOverrides?.[0] ?? {};
  ok(ov.name === 'media-job' && JSON.stringify(ov.environment) === JSON.stringify([{ name: 'MEDIA_JOB_ID', value: 'j-1' }, { name: 'MEDIA_JOB_WORKER', value: 'task:w-1' }]), 'the task is told its job and its lease holder name');
  ok(inp.tags?.some((t: any) => t.key === 'volt:job' && t.value === 'j-1') && inp.tags?.some((t: any) => t.key === 'volt:job-type' && t.value === 'vod.encode'), 'tagged with the job and its type');
  process.env.MEDIA_JOB_SPOT = 'false';
  ok(JSON.stringify(ecs.mediaJobInput({ jobId: 'j', workerId: 'w', type: 't' }).capacityProviderStrategy) === JSON.stringify([{ capacityProvider: 'FARGATE', weight: 1 }]), 'MEDIA_JOB_SPOT=false: on-demand only');
  delete process.env.MEDIA_JOB_SPOT;
  (ecs as any).ecs = { send: async () => ({ tasks: [], failures: [{ reason: 'RESOURCE:ENI' }] }) };
  let threw = '';
  try { await ecs.launchMediaJob({ jobId: 'j', workerId: 'w', type: 't' }); } catch (e) { threw = (e as Error).message; }
  ok(/RESOURCE:ENI/.test(threw), 'a refused RunTask is an error carrying the reason');

  // --------------------------------------------- 3. the worker, mode ecs, mock
  console.log('-- the worker with MEDIA_JOBS_MODE=ecs and the mock launcher');
  const { pool, query, one } = await import('../src/db');
  const { migrate } = await import('../src/services/migrate');
  await migrate();
  const { enqueue, getJob, reapExpiredLeases, LEASE_SECONDS } = await import('../src/services/jobs/queue');
  const { registerHandler, startWorker, handlerFor, PermanentError } = await import('../src/services/jobs/worker');
  const mj = await import('../src/services/jobs/mediaJobs');
  await query(`DELETE FROM jobs`);

  // Stand-in handlers under the real type names: the worker must not run the
  // media ones in this process; the task (runClaimedJob) runs them.
  const ranHere: string[] = [];
  const ranInTask: string[] = [];
  let inTask = false;
  let gate: (() => void) | null = null;
  const NAMED = ['clip.extract', 'vod.encode', 'filler.build', 'vod.markers'];
  for (const t of NAMED) {
    registerHandler(t, async (ctx: any) => {
      (inTask ? ranInTask : ranHere).push(t);
      if (ctx.job.payload?.wait) await new Promise<void>((res) => { gate = res; });
      if (ctx.job.payload?.boom) throw new Error('ffmpeg exited 1');
      if (ctx.job.payload?.permanent) throw new PermanentError('the source is missing', 'source_missing');
      await ctx.progress(50, 'half');
      return { done: t };
    });
  }
  registerHandler('social.publish', async () => { ranHere.push('social.publish'); return {}; });

  const mock = new MockTaskLauncher();
  mj.setMediaJobLauncher(mock as any);
  process.env.MEDIA_JOBS_MODE = 'ecs';
  process.env.MEDIA_JOB_MAX_TASKS = '10';
  const launchedFor = (id: string) => mock.launched.find((l) => l.kind === 'media-job' && l.job.jobId === id);

  const jobs: Record<string, any> = {};
  for (const t of NAMED) jobs[t] = await enqueue({ type: t, payload: { n: 1 } });
  const light = await enqueue({ type: 'social.publish' });
  const w = startWorker({ concurrency: 2, pollMs: 50, reapMs: 3_600_000 });
  for (let i = 0; i < 60 && mock.launched.filter((l) => l.kind === 'media-job').length < NAMED.length; i++) await sleep(50);
  await sleep(200);
  await w.stop();

  for (const t of NAMED) {
    const l = launchedFor(jobs[t].id);
    const row = await getJob(jobs[t].id);
    ok(l && l.job.type === t, `${t}: handed to its own task through the launcher`);
    ok(row?.state === 'running' && row?.claimed_by === l?.job.workerId && /^task:/.test(row?.claimed_by ?? ''), `${t}: the lease is held in the task's name`);
  }
  ok(!ranHere.some((t) => NAMED.includes(t)), 'no media job ran in the control plane', JSON.stringify(ranHere));
  ok((await getJob(light.id))?.state === 'succeeded' && ranHere.includes('social.publish'), 'a light job still runs in the control plane');
  const enc = await getJob(jobs['vod.encode'].id);
  const graceLeft = (new Date(enc!.lease_until as any).getTime() - Date.now()) / 1000;
  ok(graceLeft > 500 && graceLeft <= 600, 'the hand-over lease covers a slow task start (10 minutes)', graceLeft.toFixed(0));
  const att = await one<any>(`SELECT claimed_by FROM job_attempts WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1`, [enc!.id]);
  ok(att?.claimed_by === enc!.claimed_by, "the attempt records the task's lease holder");
  ok((await mj.runningMediaTasks()) === NAMED.length, 'the running media tasks are counted');

  // The tasks start and run their jobs.
  inTask = true;
  for (const t of NAMED) {
    const l = launchedFor(jobs[t].id)!;
    const outcome = await mj.runClaimedJob(l.job.jobId, l.job.workerId, handlerFor);
    const row = await getJob(jobs[t].id);
    ok(outcome === 'succeeded' && row?.state === 'succeeded' && (row?.result as any)?.done === t && row?.attempts === 1, `${t}: the task ran it to success, one attempt`);
  }
  ok(JSON.stringify(ranInTask) === JSON.stringify(NAMED), 'each job ran once, in its task');
  ok((await mj.runningMediaTasks()) === 0, 'no media task counted once they finished');
  ranInTask.length = 0;

  // A task started a second time for the same job (an ECS retry) does nothing.
  const again = await mj.runClaimedJob(jobs['vod.encode'].id, launchedFor(jobs['vod.encode'].id)!.job.workerId, handlerFor);
  ok(again === 'missing' && ranInTask.length === 0, 'a second task for a finished job does nothing');

  // Launch refused: back in the queue with the reason, attempt counted.
  async function dispatchOne(type: string, payload: Record<string, unknown> = {}) {
    const j = await enqueue({ type, payload });
    const w2 = startWorker({ concurrency: 1, pollMs: 30, reapMs: 3_600_000 });
    for (let i = 0; i < 60 && (await getJob(j.id))?.state === 'queued' && !(await getJob(j.id))?.last_error; i++) await sleep(30);
    await w2.stop();
    return j;
  }
  mock.failMediaJobs = true;
  const refused = await dispatchOne('clip.extract');
  let rrow = await getJob(refused.id);
  ok(rrow?.state === 'queued' && rrow?.error_code === 'task_launch_failed' && /could not start a task/.test(rrow?.last_error ?? '') && rrow?.attempts === 1,
    'a refused launch puts the job back in the queue with the reason (retried after the backoff)', `${rrow?.state} ${rrow?.error_code}`);
  ok(rrow!.claimed_by === null && new Date(rrow!.run_after as any).getTime() > Date.now() + 20_000, 'with the backoff before the next attempt');
  mock.failMediaJobs = false;

  // A task that never starts: the lease runs out, the reaper requeues, and a
  // late start of that task finds the job no longer its own.
  inTask = false;
  const lost = await dispatchOne('filler.build');
  const lostWorker = launchedFor(lost.id)!.job.workerId;
  await query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id=$1`, [lost.id]);
  await reapExpiredLeases();
  rrow = await getJob(lost.id);
  ok(rrow?.state === 'queued' && rrow?.error_code === 'lease_expired', 'a task that never started: the reaper puts the job back');
  inTask = true;
  const late = await mj.runClaimedJob(lost.id, lostWorker, handlerFor);
  ok(late === 'missing' && ranInTask.length === 0, 'and that task starting late does not run it');
  await query(`DELETE FROM jobs WHERE id=$1`, [lost.id]);

  // The lease taken away mid-run (reaped and handed to another attempt): the
  // task notices at its next heartbeat and does not finish the job.
  inTask = false;
  const taken = await dispatchOne('vod.markers', { wait: true });
  const takenWorker = launchedFor(taken.id)!.job.workerId;
  inTask = true;
  const running = mj.runClaimedJob(taken.id, takenWorker, handlerFor, { keepAliveMs: 40 });
  for (let i = 0; i < 50 && !gate; i++) await sleep(20);
  await query(`UPDATE jobs SET claimed_by = 'task:someone-else' WHERE id=$1`, [taken.id]);
  await sleep(150);
  (gate as any)?.(); gate = null;
  const takenOutcome = await running;
  rrow = await getJob(taken.id);
  ok(takenOutcome === 'lost' && rrow?.state === 'running' && rrow?.claimed_by === 'task:someone-else', 'a task whose lease was taken does not finish the job', `${takenOutcome} ${rrow?.state}`);
  await query(`DELETE FROM jobs WHERE id=$1`, [taken.id]);

  // Cancelled while the task runs: the task stops.
  inTask = false;
  const cancelled = await dispatchOne('vod.markers', { wait: true });
  inTask = true;
  const runC = mj.runClaimedJob(cancelled.id, launchedFor(cancelled.id)!.job.workerId, handlerFor, { keepAliveMs: 40 });
  for (let i = 0; i < 50 && !gate; i++) await sleep(20);
  const { cancel } = await import('../src/services/jobs/queue');
  await cancel(cancelled.id);
  await sleep(150);
  (gate as any)?.(); gate = null;
  ok((await runC) === 'lost' && (await getJob(cancelled.id))?.state === 'cancelled', 'a job cancelled while its task runs stays cancelled');

  // Handler errors in the task follow the queue's rules.
  inTask = false;
  const boom = await dispatchOne('vod.encode', { boom: true });
  inTask = true;
  const boomOutcome = await mj.runClaimedJob(boom.id, launchedFor(boom.id)!.job.workerId, handlerFor);
  rrow = await getJob(boom.id);
  ok(boomOutcome === 'failed' && rrow?.state === 'queued' && /ffmpeg exited 1/.test(rrow?.last_error ?? ''), 'a failing job in its task is requeued with its reason while attempts remain');
  inTask = false;
  const perm = await dispatchOne('clip.extract', { permanent: true });
  inTask = true;
  await mj.runClaimedJob(perm.id, launchedFor(perm.id)!.job.workerId, handlerFor);
  rrow = await getJob(perm.id);
  ok(rrow?.state === 'failed' && rrow?.error_code === 'source_missing', 'a permanent error fails it at once, with its code');
  await query(`DELETE FROM jobs`);

  // The ceiling: with MEDIA_JOB_MAX_TASKS=2 only two tasks are out at once;
  // the others wait queued and light work is still done.
  inTask = false;
  process.env.MEDIA_JOB_MAX_TASKS = '2';
  const before = mock.launched.length;
  const many = [];
  for (let i = 0; i < 4; i++) many.push(await enqueue({ type: 'vod.encode', payload: { i } }));
  const light2 = await enqueue({ type: 'social.publish' });
  const w3 = startWorker({ concurrency: 2, pollMs: 30, reapMs: 3_600_000 });
  await sleep(600);
  const out1 = mock.launched.length - before;
  const states1 = await query<any>(`SELECT state, count(*)::int AS n FROM jobs WHERE type='vod.encode' GROUP BY state`);
  ok(out1 === 2 && states1.find((s: any) => s.state === 'queued')?.n === 2, 'at the ceiling further media jobs wait in the queue', JSON.stringify(states1));
  ok((await getJob(light2.id))?.state === 'succeeded', 'light jobs are not held back by the ceiling');
  // One finishes; the next goes out.
  inTask = true;
  const first = mock.launched.slice(before).find((l) => l.kind === 'media-job')!;
  await mj.runClaimedJob(first.job.jobId, first.job.workerId, handlerFor);
  await sleep(400);
  await w3.stop();
  ok(mock.launched.length - before === 3, 'when one finishes the next is handed out');
  process.env.MEDIA_JOB_MAX_TASKS = '10';
  await query(`DELETE FROM jobs`);

  // The Mac (no MEDIA_JOBS_MODE): media jobs run in process, nothing launched.
  delete process.env.MEDIA_JOBS_MODE;
  inTask = false; ranHere.length = 0;
  const before2 = mock.launched.length;
  const local = await enqueue({ type: 'vod.encode' });
  const w4 = startWorker({ concurrency: 1, pollMs: 30, reapMs: 3_600_000 });
  for (let i = 0; i < 60 && (await getJob(local.id))?.state !== 'succeeded'; i++) await sleep(30);
  await w4.stop();
  ok((await getJob(local.id))?.state === 'succeeded' && ranHere.includes('vod.encode') && mock.launched.length === before2, 'without MEDIA_JOBS_MODE=ecs a media job runs in process as before');
  ok(mj.mediaJobsConfig({}).mode === 'inprocess' && !mj.runsInOwnTask('vod.encode', mj.mediaJobsConfig({})), 'the default is in process');
  ok(mj.mediaJobsConfig({ MEDIA_JOBS_MODE: 'ecs' }).startGraceS >= LEASE_SECONDS, 'the start grace is never shorter than the lease');
  await query(`DELETE FROM jobs`);

  // ------------------------------------------ 4. the real entrypoint, a process
  console.log('-- the media-jobs entrypoint as its own process, every handler registered');
  const tsx = join(__dirname, '../node_modules/.bin/tsx');
  const types = spawnSync(tsx, [__filename, 'types'], { encoding: 'utf8', env: process.env, timeout: 120_000 });
  const reg: string[] = JSON.parse((types.stdout.match(/TYPES (.*)/) ?? [])[1] ?? '[]');
  const missing = mj.DEFAULT_MEDIA_JOB_TYPES.filter((t) => !reg.includes(t));
  ok(reg.length > 0 && missing.length === 0, `every media job type has a handler in the task (${mj.DEFAULT_MEDIA_JOB_TYPES.length})`, missing.join(',') || types.stderr.slice(-400));
  const usage = spawnSync(tsx, [join(__dirname, '../src/tools/run-media-job.ts')], { encoding: 'utf8', env: { ...process.env, MEDIA_JOB_ID: '', MEDIA_JOB_WORKER: '' }, timeout: 120_000 });
  ok(usage.status === 2, 'without a job the entrypoint refuses (exit 2)');
  // A real handler (intro and credits detection) for an asset that does not
  // exist: the task runs it and records how it ended, through the queue.
  const real = await enqueue({ type: 'vod.markers', payload: { assetId: '00000000-0000-4000-8000-00000000abcd' } });
  const realWorker = 'task:check-real';
  await query(`UPDATE jobs SET state='running', attempts=1, claimed_by=$2, claimed_at=now(), lease_until=now()+interval '10 minutes' WHERE id=$1`, [real.id, realWorker]);
  await query(`INSERT INTO job_attempts (job_id, attempt, claimed_by) VALUES ($1,1,$2)`, [real.id, realWorker]);
  const proc = spawnSync(tsx, [join(__dirname, '../src/tools/run-media-job.ts')], { encoding: 'utf8', env: { ...process.env, MEDIA_JOB_ID: real.id, MEDIA_JOB_WORKER: realWorker }, timeout: 150_000 });
  rrow = await getJob(real.id);
  const closed = await one<any>(`SELECT finished_at FROM job_attempts WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1`, [real.id]);
  ok(proc.status === 0 && rrow?.state !== 'running' && closed?.finished_at, `the task ran the real handler and recorded the outcome (${rrow?.state}${rrow?.last_error ? ': ' + rrow.last_error.slice(0, 80) : ''})`, `exit ${proc.status} ${proc.stderr.slice(-300)}`);
  const wrong = spawnSync(tsx, [join(__dirname, '../src/tools/run-media-job.ts')], { encoding: 'utf8', env: { ...process.env, MEDIA_JOB_ID: real.id, MEDIA_JOB_WORKER: 'task:not-me' }, timeout: 120_000 });
  ok(wrong.status === 1, 'a task whose job is not its own exits 1 and changes nothing');

  mj.setMediaJobLauncher(null);
  await pool.end();
  console.log(`\nmedia-jobs-ecs: ${pass}/${pass + failed} passed`);
  process.exit(failed === 0 ? 0 : 1);
}
