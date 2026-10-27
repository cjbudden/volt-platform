/**
 * The chaos and scaling harness (build queue 2.8).
 *
 * deploy/loadtest/chaos-lib.mjs holds the five scenario plans (kill an encoder
 * task, lose a source, fail a zone, interrupt a Spot server, scale out under
 * viewer load), the run loop and the judge. The real run needs the Tier-2 AWS
 * stack, so this proves everything up to the AWS call: a dry run touches
 * nothing and prints the real commands, a real run refuses without naming its
 * stack or against production, the judge passes and fails made-up timelines
 * on the budgets the code sets, and a whole run against a fake AWS and a fake
 * Volt sends the right commands with the right ids. Also that the Terraform
 * for the experiments is off by default and documented.
 * No database, no API, no AWS, no terraform binary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const ROOT = join(__dirname, '../..');

const TF = {
  ecs_cluster: { value: 'volt' },
  control_plane_url: { value: 'http://volt-staging-alb.example.com' },
  api_edge_domain: { value: 'd111.cloudfront.net' },
  role_services: { value: { api_admin: 'volt-staging-cp', api_public: 'volt-staging-api-public', scheduler: null, worker: null } },
  chaos_stack: { value: { stack_name: 'volt-staging', region: 'eu-west-1', db_instance_id: 'volt-staging-pg', db_multi_az: true } },
  chaos_experiment_templates: { value: { 'az-eu-west-1a': 'EXT1a', 'az-eu-west-1b': 'EXT1b', 'spot-interrupt': 'EXTspot' } },
};

const forbidden = () => { throw new Error('a dry run must not call out'); };
const noIo = { exec: forbidden, getJson: forbidden, getText: forbidden, prompt: forbidden, sleep: forbidden, spawn: forbidden, readJson: forbidden, now: () => 0 };

(async () => {
  const L: any = await import(join(ROOT, 'deploy/loadtest/chaos-lib.mjs'));
  const stack = L.readStack(TF);

  console.log('reads the stack from terraform output');
  ok(stack.cluster === 'volt' && stack.region === 'eu-west-1' && stack.stackName === 'volt-staging', 'cluster, region and stack name');
  ok(stack.apiBase === 'https://d111.cloudfront.net' && stack.playBase === 'https://d111.cloudfront.net', 'the API and playback through the edge when there is one');
  ok(stack.apiPublicService === 'volt-staging-api-public' && stack.dbMultiAz === true, 'the api-public service and the database');
  const noEdge = L.readStack({ ...TF, api_edge_domain: undefined });
  ok(noEdge.apiBase === 'http://volt-staging-alb.example.com', 'the load balancer when there is no edge');
  ok(L.readStack({}).cluster === '<ecs cluster>', 'placeholders when nothing is known, so a dry run still reads');

  console.log('dry run: prints the real commands and touches nothing');
  for (const name of Object.keys(L.SCENARIOS)) {
    const lines: string[] = [];
    let threw = null;
    try {
      const r = await L.run(name, stack, { dryRun: true, channels: ['ch-1'], az: 'eu-west-1a' }, { ...noIo, log: (l: string) => lines.push(l) });
      ok(r.dryRun === true && r.plan.expect.length >= 2, `${name}: a plan with expectations`);
    } catch (e) { threw = e; }
    ok(!threw, `${name}: no call made${threw ? ` (${(threw as Error).message})` : ''}`);
    ok(lines.some((l) => l.startsWith('  expect')) && lines.some((l) => l.startsWith('  undo')), `${name}: says what is expected and how it is undone`);
  }
  const dl = (name: string, o: any = {}) => { const out: string[] = []; return L.run(name, stack, { dryRun: true, channels: ['ch-1'], ...o }, { ...noIo, log: (l: string) => out.push(l) }).then(() => out.join('\n')); };
  ok((await dl('kill-encoder')).includes('$ aws --region eu-west-1 ecs stop-task --cluster volt --task <task arn>'), 'kill-encoder stops the task on the stack\'s cluster');
  const az = await dl('fail-az', { az: 'eu-west-1b' });
  ok(az.includes('fis start-experiment --experiment-template-id EXT1b'), 'fail-az starts the zone\'s own template');
  ok(az.includes('Name=availability-zone,Values=eu-west-1b') && az.includes('ec2 stop-instances'), 'and stops the encoder servers in that zone');
  ok(az.includes('rds reboot-db-instance --db-instance-identifier volt-staging-pg --force-failover'), 'and fails a Multi-AZ database over');
  const az1 = await L.run('fail-az', L.readStack({ ...TF, chaos_stack: { value: { ...TF.chaos_stack.value, db_multi_az: false } } }), { dryRun: true, az: 'eu-west-1a' }, { ...noIo, log: () => {} });
  ok(!az1.plan.steps.some((s: any) => s.argv?.includes('reboot-db-instance')), 'a single-zone database is left alone');
  ok((await dl('spot-interrupt')).includes('--experiment-template-id EXTspot'), 'spot-interrupt starts the Spot template');
  ok((await dl('scale-out', { peak: 5000 })).includes('PEAK=5000') && (await dl('scale-out')).includes('--services volt-staging-api-public'), 'scale-out drives k6 and watches api-public');
  const ls = await dl('lose-source', { stopSource: 'pkill -f primary', startSource: 'sh start.sh' });
  ok(ls.includes('Stop the primary source') && !ls.includes('press Enter'), 'lose-source runs given commands rather than asking');
  let unk = null; try { L.plan('melt-down', stack); } catch (e) { unk = e; }
  ok(unk && /unknown scenario/.test((unk as Error).message), 'an unknown scenario is refused');

  console.log('a real run refuses the wrong stack');
  ok(L.guard(stack, {}).some((p: string) => p.includes('--confirm volt-staging')), 'no --confirm');
  ok(L.guard(stack, { confirm: 'volt-other' }).length === 1, '--confirm naming another stack');
  ok(L.guard(stack, { confirm: 'volt-staging' }).length === 0, '--confirm naming this stack');
  const prod = L.readStack({ ...TF, chaos_stack: { value: { ...TF.chaos_stack.value, stack_name: 'volt-prod' } } });
  ok(L.guard(prod, { confirm: 'volt-prod' }).some((p: string) => /production/.test(p)), 'production is refused');
  ok(L.guard(prod, { confirm: 'volt-prod', allowProd: true }).length === 0, 'unless --allow-prod');
  ok(L.guard(L.readStack({}), { confirm: '<stack>' }).some((p: string) => /not known/.test(p)), 'an unknown stack is refused');
  let refused = null;
  try { await L.run('kill-encoder', stack, { channels: ['ch-1'] }, { ...noIo, log: () => {} }); } catch (e) { refused = e; }
  ok(refused && /--confirm/.test((refused as Error).message), 'run() itself checks before calling anything');

  console.log('playlists');
  const media = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXTINF:4,\nc.ts\n';
  ok(L.mediaSequence(media) === 103, 'the newest segment number from the media sequence');
  ok(L.mediaSequence('#EXTM3U\n') === null, 'none when the playlist has no sequence');
  ok(L.firstVariant('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8\n', 'https://e/live/x/') === 'https://e/live/x/v0/index.m3u8', 'the first rendition behind a master');
  ok(L.longestStall([{ t: 0, seq: 1 }, { t: 4, seq: 2 }, { t: 20, seq: 2 }, { t: 22, seq: 3 }]) === 18, 'the longest time the sequence stood still');

  console.log('judge: kill an encoder');
  const live = (t: number, task: string, seq: number | null, extra: any = {}) => ({ t, api: true, status: 'live', overall: 'onair', taskArn: task, seq, ...extra });
  const good = [live(-1, 'A', 10), { t: 30, api: true, status: 'ended', overall: 'stopped', taskArn: null, seq: 10 }, live(100, 'B', 10), live(104, 'B', 11)];
  let j = L.judge('kill-encoder', { ch: good }, { originalTasks: { ch: 'A' } });
  ok(j.pass, `back on a new task in time passes (${j.results.map((r: any) => r.detail).join('; ')})`);
  j = L.judge('kill-encoder', { ch: [live(-1, 'A', 10), { t: 30, api: true, status: 'ended', taskArn: null, seq: 10 }] }, { originalTasks: { ch: 'A' } });
  ok(!j.pass && j.results.find((r: any) => r.id === 'back' && !r.ok), 'never back fails');
  j = L.judge('kill-encoder', { ch: [live(-1, 'A', 10), { t: 30, api: true, status: 'ended', taskArn: null, seq: 10 }, live(300, 'B', 10), live(304, 'B', 11)] }, { originalTasks: { ch: 'A' } });
  ok(!j.pass && /back at 304 s \(budget 240 s\)/.test(j.results.find((r: any) => r.id === 'back').detail), 'back too late fails');
  j = L.judge('kill-encoder', { ch: [live(-1, 'A', 10), { t: 30, api: true, status: 'ended', taskArn: null, seq: 10 }, live(300, 'B', 10), live(304, 'B', 11)] }, { originalTasks: { ch: 'A' }, newServer: true });
  ok(j.pass, 'but inside the budget when a new server had to start');
  j = L.judge('kill-encoder', { ch: [live(-1, 'A', 10), { t: 30, api: true, status: 'ended', taskArn: null, seq: 10 }, live(60, 'B', 10), live(80, 'C', 10), live(100, 'D', 10), live(104, 'D', 11)] }, { originalTasks: { ch: 'A' } });
  ok(j.results.find((r: any) => r.id === 'one-relaunch' && !r.ok), 'a relaunch storm fails');
  j = L.judge('kill-encoder', { ch: [live(-1, 'A', 10), live(100, 'B', 10), live(104, 'B', 10)] }, { originalTasks: { ch: 'A' } });
  ok(j.results.find((r: any) => r.id === 'back' && !r.ok), 'on air on a new task but the playlist not moving is not back');
  j = L.judge('kill-encoder', { ch: [live(-1, 'A', 10), { t: 10, api: false, status: null, taskArn: null, seq: 10 }, live(200, 'B', 10), live(204, 'B', 11)] }, { originalTasks: { ch: 'A' } });
  ok(j.results.find((r: any) => r.id === 'noticed' && !r.ok), 'an unreachable API is not the control plane noticing');

  console.log('judge: lose a source');
  const src = (t: number, active: string, seq: number, extra: any = {}) => ({ t, api: true, status: 'live', overall: 'onair', activeSource: active, fallback: false, seq, ...extra });
  const ls1 = [src(-1, 'primary', 1), src(2, 'primary', 2), src(6, 'backup', 3), src(10, 'backup', 4), src(60, 'backup', 16, { phase: 'restored' }), src(64, 'backup', 17, { phase: 'restored' }), src(76, 'primary', 20, { phase: 'restored' })];
  for (let t = 14; t < 60; t += 4) ls1.splice(ls1.length - 3, 0, src(t, 'backup', 4 + (t - 10) / 4));
  j = L.judge('lose-source', ls1);
  ok(j.pass, `to backup in 6 s, no gap, primary 16 s after it returned (${j.results.map((r: any) => r.detail).join('; ')})`);
  const ls2 = ls1.map((s: any) => (s.t >= 6 && s.t < 30 ? { ...s, seq: 3 } : s));
  j = L.judge('lose-source', ls2);
  ok(!j.pass && j.results.find((r: any) => r.id === 'no-stall' && !r.ok), 'a playlist that stopped for 24 s fails');
  j = L.judge('lose-source', ls1.map((s: any) => (s.phase === 'restored' ? { ...s, activeSource: 'backup' } : s)));
  ok(j.results.find((r: any) => r.id === 'failback' && !r.ok), 'no return to primary fails');
  j = L.judge('lose-source', ls1.map((s: any) => (s.t > 0 && s.phase !== 'restored' ? { ...s, activeSource: 'primary', fallback: true } : s)));
  ok(j.results.find((r: any) => r.id === 'switched').ok, 'filler with no backup counts as switched');
  j = L.judge('lose-source', ls1.map((s: any) => (s.t > 0 && s.phase !== 'restored' ? { ...s, activeSource: 'primary' } : s)));
  ok(j.results.find((r: any) => r.id === 'switched' && !r.ok), 'staying on a dead primary fails');

  console.log('judge: lose a zone');
  const api = (down: [number, number]) => Array.from({ length: 100 }, (_, i) => ({ t: i * 5, api: !(i * 5 >= down[0] && i * 5 < down[1]) }));
  const chBack = [live(-1, 'A', 1), { t: 20, api: true, status: 'ended', overall: 'stopped', taskArn: null, seq: 1 }, live(300, 'B', 1), live(304, 'B', 2)];
  const chFine = [live(-1, 'C', 1), live(10, 'C', 2), live(20, 'C', 3)];
  j = L.judge('fail-az', { api: api([20, 80]), channels: { a: chBack, b: chFine } });
  ok(j.pass, `a 60 s API gap and both channels on air (${j.results.map((r: any) => r.detail).join('; ')})`);
  j = L.judge('fail-az', { api: api([20, 300]), channels: { a: chBack } });
  ok(j.results.find((r: any) => r.id === 'api-up' && !r.ok), 'a 280 s API outage fails');
  j = L.judge('fail-az', { api: api([0, 0]), channels: { a: chBack.slice(0, 2) } });
  ok(j.results.find((r: any) => r.id === 'streams-back' && !r.ok), 'a channel still down fails');

  console.log('judge: scale out');
  const k = L.readK6Summary({ metrics: { gate_ms: { 'p(95)': 180.4 }, http_req_failed: { value: 0.002 } } });
  ok(k.p95Ms === 180.4 && k.errorRate === 0.002, 'reads p95 and the error rate from the k6 summary');
  j = L.judge('scale-out', { tasks: [{ running: 2 }, { running: 6 }, { running: 4 }], k6: k });
  ok(j.pass, `2 to 6 tasks, p95 and errors inside (${j.results.map((r: any) => r.detail).join('; ')})`);
  j = L.judge('scale-out', { tasks: [{ running: 2 }, { running: 2 }], k6: { p95Ms: 450, errorRate: 0.05 } });
  ok(j.results.filter((r: any) => !r.ok).length === 3, 'no scale-out, slow and failing: three failures');
  j = L.judge('scale-out', { tasks: [{ running: 2 }, { running: 3 }], k6: {} });
  ok(!j.pass, 'no k6 summary is not a pass');

  console.log('a whole run against a fake AWS and a fake Volt');
  {
    let clock = 0;
    const calls: string[][] = [];
    let task = 'arn:task/A', status = 'live', killedAt = -1, seq = 100;
    const io = {
      now: () => clock, sleep: async (ms: number) => { clock += ms; }, log: () => {}, prompt: forbidden, spawn: forbidden, readJson: forbidden,
      exec: (argv: string[]) => { calls.push(argv); if (argv.includes('stop-task')) { killedAt = clock; status = 'ended'; task = ''; } return ''; },
      getJson: async (url: string, h: any) => {
        if (url.endsWith('/health/ready')) return { ok: true };
        if (!h?.authorization?.includes('sk_test')) throw new Error('401');
        const t = (clock - killedAt) / 1000;
        if (killedAt >= 0 && t > 90 && !task) { task = 'arn:task/B'; status = 'live'; }
        return { status, health: { overall: status === 'live' ? 'onair' : 'stopped' }, statusBoard: { activeSource: 'primary', fallback: 'Not engaged' }, instances: task ? [{ task_arn: task }] : [] };
      },
      getText: async (url: string) => {
        if (url.endsWith('master.m3u8')) return '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0.m3u8\n';
        if (status === 'live') seq++;
        return `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXTINF:4,\ns.ts\n`;
      },
    };
    const r = await L.run('kill-encoder', stack, { channels: ['ch-1'], confirm: 'volt-staging', key: 'sk_test_1' }, io);
    const stop = calls.find((c) => c.includes('stop-task'));
    ok(stop && stop.includes('arn:task/A') && stop.includes('volt'), 'stopped the task the API reported, on the right cluster');
    ok(r.pass, `judged a pass (${r.results.map((x: any) => x.detail).join('; ')})`);
    ok(calls.length === 1, 'and sent nothing else to AWS');
  }
  {
    let clock = 0;
    const calls: string[][] = [];
    const io = {
      now: () => clock, sleep: async (ms: number) => { clock += ms; }, log: () => {}, prompt: forbidden, spawn: forbidden, readJson: forbidden,
      exec: (argv: string[]) => {
        calls.push(argv);
        if (argv.includes('start-experiment')) return JSON.stringify({ experiment: { id: 'EXP1' } });
        if (argv.includes('describe-instances')) return 'i-1\ti-2\n';
        return '';
      },
      getJson: async (url: string) => { if (url.endsWith('/health/ready') && clock > 20000 && clock < 60000) throw new Error('503'); return { status: 'live', health: { overall: 'onair' }, statusBoard: {}, instances: [{ task_arn: 'T' }] }; },
      getText: async (url: string) => (url.endsWith('master.m3u8') ? '#EXTM3U\nv0.m3u8\n' : `#EXT-X-MEDIA-SEQUENCE:${Math.floor(clock / 4000)}\n`),
    };
    const r = await L.run('fail-az', stack, { channels: ['ch-1'], confirm: 'volt-staging', key: 'sk_test_1', az: 'eu-west-1a' }, io);
    const stopI = calls.find((c) => c.includes('stop-instances'));
    ok(calls[0].includes('EXT1a'), 'fail-az started the zone\'s template');
    ok(stopI && stopI.includes('i-1') && stopI.includes('i-2') && !stopI.includes('<instances in az>'), 'and stopped exactly the servers listed in that zone');
    ok(calls.some((c) => c.includes('--force-failover')), 'and failed the database over');
    ok(r.pass, `a 40 s API gap judged a pass (${r.results.map((x: any) => x.detail).join('; ')})`);
  }

  console.log('Terraform: off by default and documented');
  const tf = readFileSync(join(ROOT, 'deploy/terraform/chaos.tf'), 'utf8');
  const ex = readFileSync(join(ROOT, 'deploy/terraform/terraform.tfvars.example'), 'utf8');
  ok(/variable "enable_chaos_experiments"[\s\S]*?default\s*=\s*false/.test(tf), 'enable_chaos_experiments defaults to false');
  const gated = (tf.match(/^resource "[^"]+" "[^"]+" \{\n\s*(count|for_each)\s*=\s*var\.enable_chaos_experiments/gm) || []).length;
  ok(gated === (tf.match(/^resource /gm) || []).length && gated >= 5, `every resource is behind the switch (${gated})`);
  ok(/aws:network:disrupt-connectivity[\s\S]*?key\s*=\s*"duration"/.test(tf), 'a cut-off zone is restored by itself after the fault time');
  ok(/send-spot-instance-interruptions[\s\S]*?COUNT\(1\)/.test(tf), 'the Spot interruption hits one server');
  ok(/# enable_chaos_experiments = false/.test(ex) && /# chaos_fault_seconds = /.test(ex), 'both variables have a line in terraform.tfvars.example');
  const sheet = readFileSync(join(ROOT, 'deploy/loadtest/CHAOS.md'), 'utf8');
  for (const name of Object.keys(L.SCENARIOS)) ok(sheet.includes(`chaos.mjs ${name}`), `the run sheet covers ${name}`);
  ok(!/—/.test(sheet + tf + readFileSync(join(ROOT, 'deploy/loadtest/chaos-lib.mjs'), 'utf8')), 'no em dashes');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
