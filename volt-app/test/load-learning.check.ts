/* Load learning against a real database (build queue 2.4a): runs that
   happened are read back from instances + host_samples, the load model is
   fitted from them, a NEW ladder's first estimate moves towards what such
   work really costs, the projection report shows the error per class, the
   storage projection is recorded at launch, and placement passes over a
   server whose task disk would run short.

   Run: DATABASE_URL=... npx tsx test/load-learning.check.ts */
process.env.FLEET_PLACEMENT = 'false';
import { query, one, pool } from '../src/db';
import { estimateEncoderLoad, type LoadEstimate } from '../src/services/fleet/streamLoad';
import { componentOf } from '../src/services/fleet/loadFit';
import { observedRuns, currentLoadFits, projectionReport, resetLoadFitCache } from '../src/services/fleet/loadLearning';
import { assignStream, recordAssignment } from '../src/services/fleet/assign';
import { loadFleetSnapshot } from '../src/services/fleet/snapshot';
import { occupancyOf } from '../src/services/fleet/fleetModel';

let fails = 0, passes = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c || extra === undefined ? '' : ` -- ${JSON.stringify(extra)}`)); if (c) passes++; else fails++; };

const A = '00000000-0000-0000-0000-0000000a4a01';
const G = '00000000-0000-0000-0000-0000000a4b01';
const P = '00000000-0000-0000-0000-0000000a4d01';
const CH = '00000000-0000-0000-0000-0000000a4c01';
// Big enough that no run's real cost reaches 100 % of the host (a capped
// reading would teach the model a wrong, lower cost).
const VCPUS = 16;

// The real cost of each component on this (synthetic) fleet: x264 is 40 %
// dearer than the starting coefficient, decode 20 % cheaper.
const TRUE: Record<string, number> = { 'encode:x264': 1.4, 'decode:h264': 0.8, 'decode:hevc': 0.8 };
const trueCpu = (e: LoadEstimate) => e.lines.reduce((s, l) => s + l.cpuUnits * (TRUE[componentOf(l)] ?? 1), 0);

const LADDERS = [
  [[1080, 5000], [720, 3000], [480, 1500], [360, 800]],
  [[720, 3000], [480, 1500]],
  [[1080, 6000], [720, 3500]],
  [[480, 1200], [360, 700], [240, 400]],
  [[1080, 4500], [540, 2000]],
  [[720, 2500]],
];
const pick = (i: number, salt: number, n: number) => Math.floor((((i + 1) * 2654435761 + salt * 40503) % 4294967296) / 4294967296 * n);
const histJob = (i: number) => ({
  workflow: 'transcode', fps: [25, 30, 50][pick(i, 2, 3)], gpu: false,
  ladder: LADDERS[pick(i, 1, LADDERS.length)].map(([height, bitrate_kbps]) => ({ height, bitrate_kbps })),
  inputs: [{ role: 'primary' }],
});
const histProbe = (i: number) => ({ video: { codec: pick(i, 5, 2) ? 'hevc' : 'h264', width: 1920, height: 1080, fps: [25, 30, 50][pick(i, 2, 3)], bitrate_kbps: 4000 + pick(i, 6, 8) * 2000 }, audio: [{}] });
const RUNS = 30;

async function cleanup() {
  await query(`DELETE FROM instances WHERE channel_id=$1`, [CH]);
  await query(`DELETE FROM compute_hosts WHERE external_id LIKE 'i-learn-%'`);
  await query(`DELETE FROM channels WHERE id=$1`, [CH]);
  await query(`DELETE FROM groups WHERE id=$1`, [G]);
  await query(`DELETE FROM output_profiles WHERE id=$1`, [P]);
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
}

async function host(ext: string, state: 'up' | 'gone', type = 'c7i.4xlarge', vcpus = VCPUS) {
  return (await one<{ id: string }>(
    `INSERT INTO compute_hosts(kind, external_id, instance_type, availability_zone, lifecycle, vcpus, memory_mib, state, first_seen_at, last_seen_at)
     VALUES ('ec2',$1,$2,'ap-southeast-2a','on_demand',$3,$4,$5, now() - interval '3 days', now()) RETURNING id`, [ext, type, vcpus, vcpus * 1920, state]))!.id;
}

async function seed() {
  await cleanup();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Learning')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
    VALUES ($1,$2,'tx','[{"height":720,"bitrate_kbps":3000}]','transcode','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'learn','scheduled')`, [CH, G]);

  // RUNS finished runs, each alone on its own (now gone) server for two hours,
  // the server measuring what the work really cost.
  for (let i = 0; i < RUNS; i++) {
    const e = estimateEncoderLoad(histJob(i), histProbe(i));
    const h = await host(`i-learn-hist-${i}`, 'gone');
    const cpuPct = (trueCpu(e) / (VCPUS * 1024)) * 100;
    const startH = 48 + i * 3;
    await query(
      `INSERT INTO instances(channel_id, task_arn, is_gpu, role, state, launched_at, terminated_at, host_id, task_kind,
                             est_cpu_units, est_net_in_bps, est_net_out_bps, load_basis, load_signature, placement_decision)
       VALUES ($1,$2,false,'primary','stopped', now() - make_interval(hours => $3), now() - make_interval(hours => $3 - 2), $4,'transcode',
               $5,$6,$7,'estimate',$8,$9::jsonb)`,
      [CH, `arn:learn:${i}`, startH, h, e.load.cpuUnits, e.load.netInBps, e.load.netOutBps, e.signature,
       JSON.stringify({ action: 'new_host', lines: e.lines, storage: e.storage })]);
    // One reading a minute from 10 to 115 minutes in; cpu wobbles +-3 %, the
    // uploader sends exactly the projected bytes.
    await query(
      `INSERT INTO host_samples(host_id, at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host)
       SELECT $1, now() - make_interval(hours => $2) + make_interval(mins => g), 'cloudwatch',
              LEAST(99, $3 * (1 + 0.03 * sin(g))), 30, $4, $5, 1
         FROM generate_series(10, 115) g`,
      [h, startH, cpuPct, e.load.netInBps, e.load.netOutBps]);
  }
  // A run on a shared server (two tasks) teaches nothing per task and must be ignored.
  const shared = await host('i-learn-shared', 'gone');
  const e0 = estimateEncoderLoad(histJob(0), histProbe(0));
  await query(`INSERT INTO instances(channel_id, task_arn, is_gpu, state, launched_at, terminated_at, host_id, task_kind, placement_decision)
               VALUES ($1,'arn:learn:shared',false,'stopped', now() - interval '30 hours', now() - interval '28 hours', $2,'transcode',$3::jsonb)`,
    [CH, shared, JSON.stringify({ lines: e0.lines })]);
  await query(`INSERT INTO host_samples(host_id, at, source, cpu_pct, tasks_on_host)
               SELECT $1, now() - interval '30 hours' + make_interval(mins => g), 'cloudwatch', 95, 2 FROM generate_series(10, 100) g`, [shared]);
}

async function main() {
  await seed();
  resetLoadFitCache();

  // 1. The runs read back.
  const runs = await observedRuns(30);
  ok(`runs: the ${RUNS} solo runs are read back, the shared-server run is not`, runs.length === RUNS, runs.length);
  ok('runs: family from the host type', runs.every((r) => r.family === 'c7i'));
  ok('runs: about 1.75 hours of readings each', runs.every((r) => r.hours > 1.6 && r.hours < 1.9), runs[0]?.hours);

  // 2. The fit.
  const fits = await currentLoadFits(true);
  const c7i = fits.byFamily.c7i;
  console.log('   learned:', c7i && Object.fromEntries(Object.entries(c7i.cpu).map(([k, v]) => [k, v.multiplier])));
  ok('fit: c7i has its own fit from every run', !!c7i && c7i.runs === RUNS, c7i?.runs);
  // Looser than the pure check: readings wobble, p95 sits above the mean, and
  // 30 runs pull less hard against the prior. The new-ladder check below is
  // the one that matters (the total, within 5 %).
  ok('fit: x264 encode moved most of the way to its real cost (1.4x, within 10 %)', !!c7i && Math.abs(c7i.cpu['encode:x264'].multiplier - 1.4) < 0.14, c7i?.cpu['encode:x264']);
  ok('fit: the error shrinks (median before vs after)', !!c7i && c7i.cpuErrorBefore > 0.15 && c7i.cpuErrorAfter < 0.05, c7i && [c7i.cpuErrorBefore, c7i.cpuErrorAfter]);

  // 3. A ladder that has NEVER run: its first estimate moves towards the observed cost.
  const newJob = { workflow: 'transcode', fps: 30, gpu: false, inputs: [{ role: 'primary' }],
    ladder: [{ height: 1080, bitrate_kbps: 7000 }, { height: 900, bitrate_kbps: 5000 }, { height: 540, bitrate_kbps: 1800 }] };
  const newProbe = { video: { codec: 'h264', width: 1920, height: 1080, fps: 30, bitrate_kbps: 9000 }, audio: [{}] };
  const raw = estimateEncoderLoad(newJob, newProbe);
  const truth = trueCpu(raw);
  const a = await assignStream({ streamId: CH, streamClass: 'channel', accountId: A, estimate: raw });
  console.log(`   new ladder: constants ${raw.load.cpuUnits}, learned ${a.estimate.load.cpuUnits}, real ${Math.round(truth)}`);
  ok('new ladder: sized from the learned fit (basis fitted)', a.estimate.basis === 'fitted' && a.estimate.fit?.family === 'c7i', [a.estimate.basis, a.estimate.fit]);
  ok('new ladder: first estimate within 5 % of the real cost (the constants were 20 % or more off)',
    Math.abs(a.estimate.load.cpuUnits - truth) / truth < 0.05 && Math.abs(raw.load.cpuUnits - truth) / truth > 0.2,
    { raw: raw.load.cpuUnits, learned: a.estimate.load.cpuUnits, truth });
  process.env.FLEET_LEARN = 'false';
  const off = await assignStream({ streamId: CH, streamClass: 'channel', accountId: A, estimate: raw });
  ok('FLEET_LEARN=false: the starting coefficients are used', off.estimate.basis === 'estimate' && off.estimate.load.cpuUnits === raw.load.cpuUnits);
  delete process.env.FLEET_LEARN;

  // 4. What is recorded at launch keeps the unfitted lines and the storage projection.
  await query(`INSERT INTO instances(channel_id, task_arn, is_gpu, state, launched_at) VALUES ($1,'arn:learn:record',false,'running', now())`, [CH]);
  await recordAssignment('arn:learn:record', a);
  const rec = await one<any>(`SELECT load_basis, placement_decision FROM instances WHERE task_arn='arn:learn:record'`);
  ok('record: basis fitted', rec?.load_basis === 'fitted');
  ok('record: unfitted lines kept for later learning', rec?.placement_decision?.baseLines?.[0]?.cpuUnits === raw.lines[0].cpuUnits);
  ok('record: storage projection stored', rec?.placement_decision?.storage?.s3BytesPerHour === raw.storage.s3BytesPerHour && raw.storage.s3BytesPerHour > 0);
  await query(`DELETE FROM instances WHERE task_arn='arn:learn:record'`);

  // 5. Projection against actual, per class.
  const rep = await projectionReport(30);
  const tx = rep.classes.find((c) => c.taskKind === 'transcode');
  console.log('   report:', JSON.stringify(tx));
  ok('report: the transcode class counts the solo runs', tx?.runs === RUNS, tx?.runs);
  ok('report: CPU shows the constants under-projected (median actual/projected above 1.15)', (tx?.cpu.medianRatio ?? 0) > 1.15, tx?.cpu);
  ok('report: network projection matched (ratio 1)', tx?.network.medianRatio === 1, tx?.network);
  ok('report: storage written matches the bitrate projection within 1 %', !!tx?.storage.medianRatio && Math.abs(tx.storage.medianRatio - 1) < 0.01, tx?.storage);

  // 6. Placement passes over a server whose task disk would run short.
  process.env.FLEET_PLACEMENT = 'true';
  process.env.FLEET_TASK_DISK_GIB = '30';
  const full = await host('i-learn-diskfull', 'up', 'c7i.xlarge', 4);
  const roomy = await host('i-learn-diskroomy', 'up', 'c7i.xlarge', 4);
  for (const [h, cpu] of [[full, 30], [roomy, 10]] as const) {
    await query(`INSERT INTO host_samples(host_id, at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host)
                 SELECT $1, now() - make_interval(mins => g), 'cloudwatch', $2, 20, 1000000, 1000000, 1 FROM generate_series(0, 59) g`, [h, cpu]);
  }
  // On the fuller server: a stream that has written 5 hours at 900 MiB/h, so
  // by the end of the 24 hour horizon it will hold about 26 GiB.
  await query(`INSERT INTO instances(channel_id, task_arn, is_gpu, state, launched_at, host_id, task_kind, capacity_provider,
                                     est_cpu_units, est_memory_mib, cpu_units, memory_mib, placement_decision)
               VALUES ($1,'arn:learn:disk',false,'running', now() - interval '5 hours', $2,'package_only','volt-ondemand',
                       300, 400, 512, 512, '{"storage":{"scratchMibPerHour":900}}'::jsonb)`, [CH, full]);
  const snap = await loadFleetSnapshot();
  const fullSnap = snap.find((h) => h.externalId === 'i-learn-diskfull');
  ok('snapshot: the task disk size reaches capacity', fullSnap?.capacity.diskMib === 30720, fullSnap?.capacity);
  ok('snapshot: what the running stream will hold at the horizon (29 hours x 900 MiB)', Math.round(occupancyOf(fullSnap!, 'conservative')!.diskMib ?? 0) === 26100, occupancyOf(fullSnap!, 'conservative'));
  const small = estimateEncoderLoad({ workflow: 'package_only', inputs: [{ role: 'primary', bitrate_kbps: 300 }, { role: 'primary', bitrate_kbps: 200 }] });
  const placed = await assignStream({ streamId: CH, streamClass: 'channel', accountId: A, estimate: small });
  const d = placed.decision as any;
  ok('disk: the busier server is passed over, the stream goes to the one with disk room',
    d.action === 'existing_host' && placed.hints?.ec2InstanceId === 'i-learn-diskroomy', { action: d.action, host: placed.hints?.ec2InstanceId, considered: d.considered });
  ok('disk: the reason names the task disk', (d.considered ?? []).some((c: any) => /task disk would run short/.test(c.reason)), d.considered);
  // A long full-HD ladder writes far more in 24 hours than a 30 GiB disk holds.
  const big = await assignStream({ streamId: CH, streamClass: 'channel', accountId: A, estimate: estimateEncoderLoad(histJob(0), histProbe(0)) });
  ok('disk: a ladder that would outgrow an empty server\'s disk is unplaceable, launched with default sizing, and says why',
    (big.decision as any).action === 'unplaceable' && /task disk/.test((big.decision as any).reason) && big.hints === undefined, big.decision);
  // An encoder that keeps only a local window (build queue 2.4c) stores its
  // cap with the decision; the snapshot counts no more than that.
  await query(`UPDATE instances SET placement_decision='{"storage":{"scratchMibPerHour":900,"scratchCapMib":1500}}'::jsonb WHERE task_arn='arn:learn:disk'`);
  const capped = (await loadFleetSnapshot()).find((h) => h.externalId === 'i-learn-diskfull');
  ok('snapshot: a stream keeping a local window holds no more than its cap (1500 MiB)', Math.round(occupancyOf(capped!, 'conservative')!.diskMib ?? 0) === 1500, occupancyOf(capped!, 'conservative'));
  await query(`UPDATE instances SET placement_decision='{"storage":{"scratchMibPerHour":900}}'::jsonb WHERE task_arn='arn:learn:disk'`);
  delete process.env.FLEET_TASK_DISK_GIB;
  const noDisk = await assignStream({ streamId: CH, streamClass: 'channel', accountId: A, estimate: small });
  ok('disk: with no disk size set, placement is as before (the fuller server)', noDisk.hints?.ec2InstanceId === 'i-learn-diskfull', noDisk.hints);

  await cleanup();
  console.log(`\nload-learning: ${passes} passed, ${fails} failed`);
  await pool.end();
  process.exit(fails ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
