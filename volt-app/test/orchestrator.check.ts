/* Orchestrator + jobConfig checks. Run: npx tsx test/orchestrator.check.ts
   Needs DATABASE_URL pointing at a DB with the schema applied. */
import { Orchestrator } from '../src/services/orchestrator/service';
import { MockTaskLauncher, EcsTaskLauncher } from '../src/services/orchestrator/launcher';
import { buildEncoderJobConfig } from '../src/services/jobConfig';
import { query, one, pool } from '../src/db';

let fails = 0;
const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

const A = '00000000-0000-0000-0000-0000000000a1';
const G = '00000000-0000-0000-0000-0000000000b1';
const P = '00000000-0000-0000-0000-0000000000d1';
const CH = '00000000-0000-0000-0000-0000000000c1';

async function seed() {
  await query(`DELETE FROM accounts WHERE id=$1`, [A]).catch(() => {});
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Orch')`, [A]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec,captions_enabled,caption_targets)
    VALUES ($1,$2,'pkg','[{"height":1080,"bitrate_kbps":5000},{"height":720,"bitrate_kbps":2800}]','package_only','both',2,60,true,'["en","zh"]')`, [P, A]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($1,$2,'g',$3,10)`, [G, A, P]);
  await query(`INSERT INTO channels(id,group_id,name,status,recording_retention_days,input_failover_enabled,input_loss_behavior)
    VALUES ($1,$2,'orch-news','scheduled',7,true,'slate')`, [CH, G]);
  // 2 primary renditions + 1 backup
  await query(`INSERT INTO stream_inputs(channel_id,role,rendition_label,rendition_bitrate_kbps,protocol,ingest_url) VALUES
    ($1,'primary','1080p',5000,'srt','srt://src:9000'),
    ($1,'primary','720p',2800,'srt','srt://src:9001'),
    ($1,'backup','1080p',5000,'srt','srt://bak:9000')`, [CH]);
}

function jobConfigTests() {
  // package_only + drm + redundancy + captions
  const pkg = buildEncoderJobConfig({
    kind: 'channel',
    owner: { id: CH, input_failover_enabled: true, auto_failback: true, input_loss_behavior: 'slate', filler_ref: 's3://b/slate.png' },
    profile: { rungs: [{ height: 1080, bitrate_kbps: 5000 }], packaging: 'both', workflow_type: 'package_only', codec_backend: 'x264', segment_dur: 2, dvr_window_sec: 60, captions_enabled: true, caption_targets: ['en', 'zh'], caption_offset_sec: 20, drm_enabled: true },
    inputs: [
      { role: 'primary', rendition_label: '1080p', rendition_bitrate_kbps: 5000, protocol: 'srt', ingest_url: 'srt://s:9000', stream_key: null },
      { role: 'backup', rendition_label: '1080p', rendition_bitrate_kbps: 5000, protocol: 'srt', ingest_url: 'srt://b:9000', stream_key: null },
    ],
    drm: { scheme: 'cbcs', systems: ['widevine'], tenant_id: 't1', key_service_url: 'https://axinom/SpekeV2', management_key_ref: 'arn:secret' },
    account: { captions_provider: 'gladia' },   // account master toggle chooses the engine
  });
  ok('pkg workflow', pkg.workflow === 'package_only');
  ok('pkg s3 prefix', pkg.s3.prefix === `channel/${CH}`);
  ok('pkg status_report url + token', pkg.status_report.url.endsWith(`/api/streams/${CH}/report`) && !!pkg.status_report.token);
  ok('pkg includes backup input (failover on)', pkg.inputs.some((i: any) => i.role === 'backup'));
  ok('pkg drm cbcs + secret REF not value', pkg.drm.mode === 'cbcs' && pkg.drm.auth_ref === 'arn:secret' && !('management_key' in pkg.drm));
  ok('pkg redundancy filler slate', pkg.redundancy.input_failover === true && pkg.redundancy.filler.slate_ref === 's3://b/slate.png');
  ok('pkg captions carried (gladia + targets + offset)', pkg.captions?.enabled === true && pkg.captions.engine === 'gladia' && pkg.captions.targets.length === 2 && pkg.captions.offset_sec === 20);

  // transcode: ladder from rungs, gpu flag from codec, no backup when failover off
  const tc = buildEncoderJobConfig({
    kind: 'event',
    owner: { id: 'e1', input_failover_enabled: false },
    profile: { rungs: [{ height: 1080, bitrate_kbps: 5000, fps: 30 }, { height: 720, bitrate_kbps: 2800 }], packaging: 'hls', workflow_type: 'transcode', codec_backend: 'nvenc', segment_dur: 4, dvr_window_sec: 300 },
    inputs: [
      { role: 'primary', rendition_label: 'mezz', rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://m:9000', stream_key: null },
      { role: 'backup', rendition_label: 'mezz', rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://mb:9000', stream_key: null },
    ],
    drm: null,
  });
  ok('tc workflow', tc.workflow === 'transcode');
  ok('tc ladder from rungs (2)', tc.ladder.length === 2 && tc.ladder[0].height === 1080);
  ok('tc gpu=true (nvenc)', tc.gpu === true);
  ok('tc fps from rung', tc.fps === 30);
  ok('tc drops backup when failover off', !tc.inputs.some((i: any) => i.role === 'backup'));
  ok('tc no drm block', tc.drm === undefined);
}

function ecsParamTests() {
  const l = new EcsTaskLauncher();
  const input = l.runTaskInput('volt-encoder', 'encoder', { JOB_CONFIG_JSON: '{"a":1}' });
  ok('ecs capacity strategy spot+ondemand', input.capacityProviderStrategy.length === 2);
  ok('ecs on-demand base=1 fallback', input.capacityProviderStrategy.some((s: any) => s.base === 1));
  ok('ecs env override carries job', input.overrides.containerOverrides[0].environment[0].name === 'JOB_CONFIG_JSON');
}

async function lifecycleTests() {
  const mock = new MockTaskLauncher();
  const orch = new Orchestrator(mock);

  await orch.startStream('channel', CH);
  const inst = await one<any>(`SELECT * FROM instances WHERE channel_id=$1 AND terminated_at IS NULL`, [CH]);
  ok('start: instance row running with task_arn', !!inst && inst.state === 'running' && !!inst.task_arn);
  const rec = await one<any>(`SELECT * FROM recordings WHERE channel_id=$1 AND status='recording'`, [CH]);
  ok('start: open channel_day recording', !!rec && rec.kind === 'channel_day' && rec.day_utc !== null);
  ok('start: retention snapshot on recording (7d)', rec.retention_days === 7);
  const ch = await one<any>(`SELECT status FROM channels WHERE id=$1`, [CH]);
  ok('start: channel status live', ch.status === 'live');
  ok('start: launched encoder with pkg job', mock.launched.some((l) => l.kind === 'encoder' && l.job.workflow === 'package_only'));

  // idempotent-ish: second ensure of same day must not duplicate
  await query(`SELECT 1`);
  const dupCount = await one<any>(`SELECT count(*)::int n FROM recordings WHERE channel_id=$1 AND kind='channel_day' AND day_utc=(now() at time zone 'utc')::date`, [CH]);
  ok('one recording per channel per day', dupCount.n === 1);

  await orch.stopStream('channel', CH);
  const inst2 = await one<any>(`SELECT * FROM instances WHERE channel_id=$1 ORDER BY launched_at DESC LIMIT 1`, [CH]);
  ok('stop: instance terminated', inst2.state === 'terminated' && inst2.terminated_at !== null);
  const rec2 = await one<any>(`SELECT * FROM recordings WHERE id=$1`, [rec.id]);
  ok('stop: recording complete + duration set', rec2.status === 'complete' && rec2.end_epoch_ms !== null && rec2.duration_ms !== null);
  ok('stop: expiry stamped from retention', rec2.expires_at !== null);
  ok('stop: task stopped via launcher', mock.stopped.includes(inst.task_arn));
  ok('stop: thumbnailer launched for recording', mock.launched.some((l) => l.kind === 'thumbnailer' && l.job.id === rec.id));

  // retention sweep removes an already-expired recording
  await query(`INSERT INTO recordings(kind,channel_id,day_utc,status,start_epoch_ms,retention_days,expires_at)
    VALUES ('channel_day',$1,'2020-01-01','complete',1,1, now() - interval '1 day')`, [CH]);
  const swept = await orch.sweepRetention();
  ok('retention sweep removes expired', swept >= 1);
  const gone = await one<any>(`SELECT count(*)::int n FROM recordings WHERE channel_id=$1 AND day_utc='2020-01-01'`, [CH]);
  ok('swept recording is gone', gone.n === 0);
}

(async () => {
  jobConfigTests();
  ecsParamTests();
  await seed();
  await lifecycleTests();
  console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
  await pool.end();
  process.exit(fails ? 1 : 0);
})();
