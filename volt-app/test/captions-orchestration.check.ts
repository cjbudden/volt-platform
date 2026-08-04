/* Captions add-on orchestration: whisper launches a SEPARATE GPU captions task +
   instances row; gladia does not (rides the encoder); none does not. Torn down on
   stop. Needs DATABASE_URL with the schema applied.
   Run: npx tsx test/captions-orchestration.check.ts */
import { Orchestrator } from '../src/services/orchestrator/service';
import { MockTaskLauncher } from '../src/services/orchestrator/launcher';
import { query, pool } from '../src/db';

let fails = 0;
const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

const A = '00000000-0000-0000-0000-0000000ca001';
const G = '00000000-0000-0000-0000-0000000cab01';
const P = '00000000-0000-0000-0000-0000000cad01';
const CH = '00000000-0000-0000-0000-0000000cac01';

async function seed(provider: 'none' | 'whisper' | 'gladia') {
  await query(`DELETE FROM instances WHERE channel_id=$1`, [CH]).catch(() => {});
  await query(`DELETE FROM channels WHERE id=$1`, [CH]).catch(() => {});
  await query(`DELETE FROM groups WHERE id=$1`, [G]).catch(() => {});
  await query(`DELETE FROM output_profiles WHERE id=$1`, [P]).catch(() => {});
  await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
  await query(`INSERT INTO accounts(id,name,captions_provider) VALUES ($1,'Cap',$2)`, [A, provider]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec,captions_enabled,caption_source_lang,caption_targets)
    VALUES ($1,$2,'pkg','[{"height":720,"bitrate_kbps":2800}]','package_only','both',2,60,true,'en','["en","ms","zh","ta"]')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status,recording_retention_days) VALUES ($1,$2,'cap-news','scheduled',7)`, [CH, G]);
  await query(`INSERT INTO stream_inputs(channel_id,role,rendition_label,rendition_bitrate_kbps,protocol,ingest_url) VALUES ($1,'primary','720p',2800,'srt','srt://src:9000')`, [CH]);
}

async function run() {
  // --- whisper: separate captions task launched + tracked, then torn down ---
  await seed('whisper');
  let mock = new MockTaskLauncher();
  let orch = new Orchestrator(mock);
  await orch.startStream('channel', CH);
  const capLaunch = mock.launched.filter((l) => l.kind === 'captions');
  ok('whisper: a separate captions task is launched', capLaunch.length === 1);
  ok('whisper: captions job carries engine + targets + out_prefix',
     capLaunch[0]?.job.engine === 'whisper' &&
     JSON.stringify(capLaunch[0]?.job.targets) === '["en","ms","zh","ta"]' &&
     capLaunch[0]?.job.needs_mt === true &&
     String(capLaunch[0]?.job.out_prefix).endsWith('/subtitles'));
  const capRows = await query<any>(`SELECT * FROM instances WHERE channel_id=$1 AND role='captions'`, [CH]);
  ok('whisper: captions instance row recorded (GPU, sized)', capRows.length === 1 && capRows[0].is_gpu === true && capRows[0].instance_type === 'g4dn.xlarge');
  await orch.stopStream('channel', CH);
  const capArn = capRows[0].task_arn;
  ok('whisper: captions task stopped on stop', mock.stopped.includes(capArn));
  const stillUp = await query<any>(`SELECT * FROM instances WHERE channel_id=$1 AND terminated_at IS NULL`, [CH]);
  ok('whisper: no instances left running after stop', stillUp.length === 0);

  // --- gladia: NO separate task (rides encoder), no captions instance row ---
  await seed('gladia');
  mock = new MockTaskLauncher();
  orch = new Orchestrator(mock);
  await orch.startStream('channel', CH);
  ok('gladia: no separate captions task', mock.launched.filter((l) => l.kind === 'captions').length === 0);
  ok('gladia: no captions instance row', (await query<any>(`SELECT 1 FROM instances WHERE channel_id=$1 AND role='captions'`, [CH])).length === 0);
  await orch.stopStream('channel', CH);

  // --- none: captions fully off, no task ---
  await seed('none');
  mock = new MockTaskLauncher();
  orch = new Orchestrator(mock);
  await orch.startStream('channel', CH);
  ok('none: no captions task launched', mock.launched.filter((l) => l.kind === 'captions').length === 0);
  await orch.stopStream('channel', CH);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await pool.end();
  process.exit(fails ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
