/* Placement end to end: a real Orchestrator start, against a real database,
   sizes the stream from its settings, pins it to the fullest running server
   that can take it, records why, and the advisor writes its consolidation
   pass. Plus the exact RunTask input the ECS launcher builds from the hints.

   Run: DATABASE_URL=... npx tsx test/placement-e2e.check.ts */
process.env.FLEET_PLACEMENT = 'true';
import { Orchestrator } from '../src/services/orchestrator/service';
import { MockTaskLauncher, EcsTaskLauncher } from '../src/services/orchestrator/launcher';
import { adviseConsolidation } from '../src/services/fleet/advisor';
import { loadFleetSnapshot } from '../src/services/fleet/snapshot';
import { query, one, pool } from '../src/db';

let fails = 0, passes = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c || extra === undefined ? '' : ` -- ${JSON.stringify(extra)}`)); if (c) passes++; else fails++; };

const A = '00000000-0000-0000-0000-00000000fa01';
const G = '00000000-0000-0000-0000-00000000fb01';
const P = '00000000-0000-0000-0000-00000000fd01';
const CH1 = '00000000-0000-0000-0000-00000000fc01';
const CH2 = '00000000-0000-0000-0000-00000000fc02';
const HOSTS = ['i-fleet-busy', 'i-fleet-quiet'];

async function cleanup() {
  await query(`DELETE FROM instances WHERE channel_id = ANY($1::uuid[])`, [[CH1, CH2]]);
  await query(`DELETE FROM compute_hosts WHERE external_id = ANY($1)`, [HOSTS]);
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
  await query(`DELETE FROM fleet_plans`);
}

async function seed() {
  await cleanup();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Fleet')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
    VALUES ($1,$2,'pkg','[{"height":1080,"bitrate_kbps":5000},{"height":720,"bitrate_kbps":3000}]','package_only','both',4,60)`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  for (const [id, name] of [[CH1, 'fleet-one'], [CH2, 'fleet-two']]) {
    await query(`INSERT INTO channels(id,group_id,name,status,recording_retention_days) VALUES ($1,$2,$3,'scheduled',7)`, [id, G, name]);
    await query(`INSERT INTO stream_inputs(channel_id,role,rendition_label,rendition_bitrate_kbps,protocol,ingest_url) VALUES
      ($1,'primary','1080p',5000,'hls','https://src.example/1080.m3u8'),
      ($1,'primary','720p',3000,'hls','https://src.example/720.m3u8')`, [id]);
  }
  // Two running c7i.xlarge servers, an hour of samples each: one at 35% CPU, one at 10%.
  for (const [ext, cpu] of [[HOSTS[0], 35], [HOSTS[1], 10]] as const) {
    const h = await one<{ id: string }>(
      `INSERT INTO compute_hosts(kind, external_id, instance_type, availability_zone, lifecycle, vcpus, memory_mib, state, first_seen_at, last_seen_at)
       VALUES ('ec2',$1,'c7i.xlarge','ap-southeast-2a','on_demand',4,7680,'up', now() - interval '2 hours', now()) RETURNING id`, [ext]);
    await query(
      `INSERT INTO host_samples(host_id, at, source, cpu_pct, mem_pct, net_in_bps, net_out_bps, tasks_on_host)
       SELECT $1, now() - make_interval(mins => g), 'cloudwatch', $2, 20, 50000000, 50000000, 1 FROM generate_series(0, 59) g`, [h!.id, cpu]);
  }
}

async function main() {
  await seed();
  const snap = await loadFleetSnapshot();
  const busy = snap.find((h) => h.externalId === HOSTS[0]);
  ok('snapshot: both servers with capacity from instance type + registered resources', snap.filter((h) => HOSTS.includes(h.externalId)).length === 2 && busy?.capacity.cpuUnits === 4096);
  ok('snapshot: an hour of samples is a trusted window', !!busy?.observed && busy.observed.coverage >= 0.9 && busy.observed.windowMinutes >= 55, busy?.observed);

  const mock = new MockTaskLauncher();
  const orch = new Orchestrator(mock);
  await orch.startStream('channel', CH1);
  const h1 = mock.launched.find((l) => l.streamId === CH1)?.hints;
  ok('start: launched with placement hints', !!h1);
  ok('start: pinned to the FULLEST server that fits (35%, not 10%)', h1?.ec2InstanceId === HOSTS[0], h1);
  ok('start: reservation sized from settings, far below the 2048-unit task definition', !!h1?.cpuUnits && h1.cpuUnits < 2048, h1);

  const row = await one<any>(`SELECT * FROM instances WHERE channel_id=$1 AND terminated_at IS NULL`, [CH1]);
  ok('row: load estimate recorded', row?.est_cpu_units > 0 && Number(row.est_net_in_bps) === 8_000_000, { cpu: row?.est_cpu_units, net: row?.est_net_in_bps });
  ok('row: assigned host recorded before telemetry sees it', !!row?.assigned_host_id && row.host_id === null);
  ok('row: decision with reasons recorded', row?.placement_decision?.action === 'existing_host' && Array.isArray(row.placement_decision.lines));
  ok('row: signature recorded for calibration', typeof row?.load_signature === 'string' && row.load_signature.startsWith('pkg|'));

  // The second start must see the first one's load straight away.
  const snap2 = await loadFleetSnapshot();
  const busy2 = snap2.find((h) => h.externalId === HOSTS[0])!;
  ok('second placement sees the pending task on the server', busy2.tasks.length === 1 && busy2.tasks[0].pending === true);
  await orch.startStream('channel', CH2);
  const h2 = mock.launched.find((l) => l.streamId === CH2)?.hints;
  ok('second start: still packs onto a running server', !!h2?.ec2InstanceId, h2);

  // Advisor: one pass recorded, nothing moved.
  const plan = await adviseConsolidation();
  const rows = await query(`SELECT * FROM fleet_plans WHERE kind='consolidation'`);
  ok('advisor: pass recorded', rows.length === 1 && !!plan);
  ok('advisor: pending placements make the window untrusted, so nothing is planned', plan!.drain.length === 0);
  ok('advisor: moved nothing', mock.stopped.length === 0);

  // Placement off: the stream is still sized and recorded, but launches exactly as before.
  await orch.stopStream('channel', CH2, 'placement-e2e');
  process.env.FLEET_PLACEMENT = 'false';
  const before = mock.launched.length;
  await orch.startStream('channel', CH2);
  const h3 = mock.launched.slice(before).find((l) => l.streamId === CH2);
  ok('placement off: no hints, default launch', !!h3 && h3.hints === undefined);
  process.env.FLEET_PLACEMENT = 'true';

  // The RunTask input the ECS launcher builds.
  const l = new EcsTaskLauncher();
  const plain = l.runTaskInput('volt-encoder', 'encoder', { JOB_CONFIG_JSON: '{}' });
  ok('ecs: no hints keeps spot+on-demand strategy', plain.capacityProviderStrategy.length === 2 && !plain.placementConstraints && !plain.overrides.cpu);
  ok('ecs: every launch binpacks on CPU', plain.placementStrategy?.[0]?.type === 'binpack' && plain.placementStrategy[0].field === 'cpu');
  const pinned = l.runTaskInput('volt-encoder', 'encoder', { JOB_CONFIG_JSON: '{}' }, { cpuUnits: 768, memoryMib: 704, capacityProvider: 'volt-ondemand', ec2InstanceId: 'i-abc' });
  ok('ecs: hints set task-level cpu/memory', pinned.overrides.cpu === '768' && pinned.overrides.memory === '704');
  ok('ecs: hints launch into exactly one pool', pinned.capacityProviderStrategy.length === 1 && pinned.capacityProviderStrategy[0].capacityProvider === 'volt-ondemand');
  ok('ecs: pinned with memberOf on ec2InstanceId', pinned.placementConstraints?.[0]?.expression === 'ec2InstanceId == i-abc');
  const gpu = l.runTaskInput('volt-captions', 'captions', {}, { gpus: 1 });
  ok('ecs: GPU reserved through resourceRequirements', gpu.overrides.containerOverrides[0].resourceRequirements?.[0]?.value === '1');

  await cleanup();
  console.log(`\nplacement-e2e: ${passes} passed, ${fails} failed`);
  await pool.end();
  process.exit(fails ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
