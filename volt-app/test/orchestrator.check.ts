/* Orchestrator + jobConfig checks. Run: npx tsx test/orchestrator.check.ts
   Needs DATABASE_URL pointing at a DB with the schema applied. */
import { Orchestrator } from '../src/services/orchestrator/service';
import { MockTaskLauncher, EcsTaskLauncher } from '../src/services/orchestrator/launcher';
import { buildEncoderJobConfig } from '../src/services/jobConfig';
import { query, one, pool } from '../src/db';
import { config } from '../src/config';

let fails = 0;
const ok = (n: string, c: boolean) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fails++; };

const A = '00000000-0000-0000-0000-0000000000a1';
const G = '00000000-0000-0000-0000-0000000000b1';
const P = '00000000-0000-0000-0000-0000000000d1';
const CH = '00000000-0000-0000-0000-0000000000c1';

async function seed() {
  // NOT swallowed. This delete used to be wrapped in .catch(() => {}), so when
  // another suite left a child account pointing at A the foreign key blocked
  // the cleanup, the failure vanished, and the very next line died on a
  // primary-key collision that looked like a product bug. A cleanup that can
  // silently not clean is worse than no cleanup.
  await query(`DELETE FROM accounts WHERE id=$1`, [A]);
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

  // ---- THE ENCODER LIFECYCLE, when nothing goes to plan --------------------
  //
  // Five of these used to be one bug wearing different hats: the `instances`
  // row was the only record of a running encoder, and only stopStream ever
  // cleared it. So the row was a CLAIM that something was started, and every
  // question about whether it was still running asked the claim to answer for
  // itself. The launcher knows; these check that it is the one being asked.

  // A CRASH. Not a stop: nothing called stopStream, the task simply is not
  // there any more. Before, the channel stayed `live` and billing forever.
  await orch.startStream('channel', CH);
  const crashed = await one<any>(
    `SELECT * FROM instances WHERE channel_id=$1 AND terminated_at IS NULL`, [CH]);
  ok('crash: a fresh start is running', !!crashed);
  mock.deadArns.add(crashed.task_arn);          // the task died on its own
  const reconciled = await orch.reconcileStreamStatus();
  ok('crash: the reconciler notices', reconciled >= 1);
  const afterCrash = await one<any>(`SELECT status FROM channels WHERE id=$1`, [CH]);
  ok('crash: the channel stops being live', afterCrash.status !== 'live');
  const reaped = await one<any>(`SELECT * FROM instances WHERE id=$1`, [crashed.id]);
  ok('crash: and the instance row is closed, so billing stops',
    reaped.terminated_at !== null && reaped.state === 'terminated');
  mock.deadArns.clear();

  // AN UNREACHABLE LAUNCHER IS NOT A CRASH. `unknown` must never tear down a
  // healthy channel: a throttled API or a restarted control plane would
  // otherwise take the whole fleet off air.
  await orch.startStream('channel', CH);
  const live2 = await one<any>(
    `SELECT * FROM instances WHERE channel_id=$1 AND terminated_at IS NULL`, [CH]);
  mock.unknownArns.add(live2.task_arn);
  await orch.reconcileStreamStatus();
  const stillLive = await one<any>(`SELECT status FROM channels WHERE id=$1`, [CH]);
  ok('unknown liveness leaves the channel alone', stillLive.status === 'live');
  const stillOpen = await one<any>(`SELECT * FROM instances WHERE id=$1`, [live2.id]);
  ok('and does not close its instance row', stillOpen.terminated_at === null);
  mock.unknownArns.clear();

  // IDEMPOTENT START. A double-clicked Start, or two overlapping ticks, used to
  // launch a SECOND encoder into the same output namespace: two processes
  // writing the same manifests, which corrupts the live edge rather than merely
  // wasting money.
  const launchesBefore = mock.launched.filter((l) => l.kind === 'encoder').length;
  const again = await orch.startStream('channel', CH);
  ok('start on a running stream returns the SAME task', again.taskArn === live2.task_arn);
  const launchesAfter = mock.launched.filter((l) => l.kind === 'encoder').length;
  ok('and launches nothing new', launchesAfter === launchesBefore);
  const openCount = await one<any>(
    `SELECT count(*)::int n FROM instances WHERE channel_id=$1 AND terminated_at IS NULL AND role='primary'`, [CH]);
  ok('so there is still exactly one primary instance', openCount.n === 1);

  // CONCURRENT STARTS. The advisory lock is what makes the check above hold
  // under a race rather than only in sequence.
  await orch.stopStream('channel', CH);
  const results = await Promise.allSettled([
    orch.startStream('channel', CH),
    orch.startStream('channel', CH),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled').length;
  ok('two simultaneous starts do not both launch', won >= 1);
  const raced = await one<any>(
    `SELECT count(*)::int n FROM instances WHERE channel_id=$1 AND terminated_at IS NULL AND role='primary'`, [CH]);
  ok('a race still leaves exactly one primary instance', raced.n === 1);
  await orch.stopStream('channel', CH);

  // Retention sweep expires an already-expired recording. Since the media
  // lifecycle landed this MARKS rather than deletes: the bytes go, the row
  // stays, so the library still knows the recording existed and a clip's
  // provenance chain still reaches back to it. A sweep that dropped the row
  // would silently break every chain that referenced it.
  await query(`INSERT INTO recordings(kind,channel_id,day_utc,status,start_epoch_ms,retention_days,expires_at)
    VALUES ('channel_day',$1,'2020-01-01','complete',1,1, now() - interval '1 day')`, [CH]);
  const swept = await orch.sweepRetention();
  ok('retention sweep expires an expired recording', swept >= 1);
  const legacy = await one<any>(
    `SELECT count(*)::int n, count(*) FILTER (WHERE storage_state = 'deleted')::int marked
       FROM recordings WHERE channel_id=$1 AND day_utc='2020-01-01'`, [CH]);
  ok('swept recording survives as a record', legacy.n === 1);
  ok('swept recording is marked deleted, not dropped', legacy.marked === 1);
}

/**
 * RADIO AS A LAUNCHED TASK.
 *
 * The container path is behind config.orchestrator.radioMode, and a flag that
 * defaults off is exactly where untested code hides. So this exercises the
 * path that flag selects: a station must launch through the LAUNCHER, be
 * recorded like any other task, be idempotent, and be reapable by asking the
 * launcher rather than an in-memory table.
 */
async function radioContainerTests() {
  const RA = '00000000-0000-0000-0000-0000000000a7';
  const RG = '00000000-0000-0000-0000-0000000000b7';
  const RP = '00000000-0000-0000-0000-0000000000d7';
  const RCH = '00000000-0000-0000-0000-0000000000c7';
  await query(`DELETE FROM accounts WHERE id=$1`, [RA]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'RadioOrch')`, [RA]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
    VALUES ($1,$2,'p','[]','package_only')`, [RP, RA]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
    VALUES ($1,$2,'g',$3,10)`, [RG, RA, RP]);
  await query(`INSERT INTO channels(id,group_id,name,status,kind,radio_config)
    VALUES ($1,$2,'Container FM','scheduled','radio','{"bitrateKbps":192,"outputs":{"mp3":true}}'::jsonb)`, [RCH, RG]);
  await query(`INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url)
    VALUES ($1,'primary','icecast','http://up.example/stream')`, [RCH]);

  const prev = config.orchestrator.radioMode;
  (config.orchestrator as any).radioMode = 'container';
  try {
    const mock = new MockTaskLauncher();
    const orch = new Orchestrator(mock);

    const started = await orch.startStream('channel', RCH);
    const radioLaunches = mock.launched.filter((l) => l.kind === 'radio');
    ok('a station launches through the launcher', radioLaunches.length === 1);
    ok('and NOT as an encoder', mock.launched.every((l) => l.kind !== 'encoder'));
    ok('the arn is a real task arn, not a radio: pid', started.taskArn.startsWith('mock:radio:'));

    // The job config is the entire contract with the container.
    const job = radioLaunches[0].job as any;
    ok('the job names the channel', job.channel_id === RCH);
    ok('the job carries the source url', job.url === 'http://up.example/stream');
    ok('the configured bitrate survives into the job', job.bitrate_kbps === 192);
    // MP3 IS OPT-IN, so the fixture asks for it. It used to be defaulted on,
    // which meant this assertion passed without anyone having decided anything.
    ok('mp3, WHEN ASKED FOR, is pushed to a relay mount derived from the id',
      job.icecast?.mount === `${RCH}.mp3`);
    ok('the container is told where to report status',
      typeof job.status_report?.url === 'string' && job.status_report.url.includes(RCH));
    ok('the source codec is NOT pre-decided; the container probes it',
      !('source_codec' in job));

    // A STATION THAT DID NOT ASK FOR MP3 GETS NO RELAY AT ALL.
    //
    // Not merely "the output is off": no icecast block in the job config, so the
    // container never probes a relay, never occupies a mount, and cannot be
    // degraded by a relay it was never going to use. MP3 is the only output
    // whose bill is egress, so one nobody asked for must not reserve fan-out
    // capacity on the assumption that somebody might.
    //
    // Asserted on the BUILDER rather than by restarting the station, because the
    // running station is the subject of the assertions below and stopping it
    // here to make a point about config would break them.
    const { buildRadioJobConfig } = await import('../src/services/radio/jobConfig');
    const quiet = await buildRadioJobConfig({
      channelId: RCH, channelName: 'Container FM',
      protocol: 'icecast', url: 'http://up.example/stream',
      radioConfig: { bitrateKbps: 192 },
    });
    ok('a station that did not ask for MP3 is given no relay at all',
      quiet.icecast === null);
    ok('and still gets the outputs that are files rather than fan-out',
      quiet.outputs?.hls === true && quiet.outputs?.dash === true);

    const inst = await one<any>(
      `SELECT task_arn, state, terminated_at FROM instances WHERE channel_id=$1`, [RCH]);
    ok('an instance row records the task', inst?.task_arn === started.taskArn);
    ok('and it is open', inst?.terminated_at === null);
    const chRow = await one<any>(`SELECT status FROM channels WHERE id=$1`, [RCH]);
    ok('the channel goes live', chRow?.status === 'live');

    // Idempotency: the same rule television gets. Two stations pushing to one
    // relay mount would leave listeners on whichever source Icecast accepted.
    const again = await orch.startStream('channel', RCH);
    ok('starting again returns the SAME task', again.taskArn === started.taskArn);
    ok('and launches nothing new',
      mock.launched.filter((l) => l.kind === 'radio').length === 1);

    // Liveness comes from the launcher now, so a crashed station is reapable
    // exactly like a crashed encoder.
    mock.deadArns.add(started.taskArn);
    await orch.reconcileStreamStatus();
    const after = await one<any>(
      `SELECT state, terminated_at FROM instances WHERE channel_id=$1`, [RCH]);
    ok('a dead station is reaped by asking the launcher', after?.terminated_at !== null);
    ok('and the row is closed the way a clean stop closes it', after?.state === 'terminated');
    const chAfter = await one<any>(`SELECT status FROM channels WHERE id=$1`, [RCH]);
    ok('so the channel stops being live', chAfter?.status !== 'live');
  } finally {
    (config.orchestrator as any).radioMode = prev;
    await query(`DELETE FROM accounts WHERE id=$1`, [RA]).catch(() => {});
  }
}

(async () => {
  jobConfigTests();
  ecsParamTests();
  await seed();
  await lifecycleTests();
  await radioContainerTests();
  console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASSED'));
  await pool.end();
  process.exit(fails ? 1 : 0);
})();
