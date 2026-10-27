/**
 * The encoder's task disk on AWS (build queue 2.4c).
 *
 * On AWS the recording is the copy in S3, but the packager keeps the whole run
 * on the task disk, which fills a 30 GiB root in about six hours of a 1080p
 * ladder. s3-uploader.sh now keeps only a window locally (LOCAL_KEEP_SECONDS):
 * a segment goes only after a segment sync that started after it was written
 * finished cleanly, so it is in S3 first. This suite runs the real script with
 * a stand-in `aws` (a local folder as the bucket) and checks:
 *
 *   - old segments go, and every one of them is in the bucket, same size;
 *   - recent segments, init segments, manifests and the caption file stay;
 *   - a failed sync removes nothing;
 *   - no LOCAL_KEEP_SECONDS (the Mac, and any local output) removes nothing,
 *     and a local output never starts the uploader at all (encoder.py);
 *   - the window is never shorter than the job's DVR window plus two minutes;
 *   - the control plane's disk projection counts the window, not the whole
 *     run, so a 1080p ladder that could not be placed on a 30 GiB server for
 *     24 hours now can;
 *   - Terraform sets the root volumes, the window and FLEET_TASK_DISK_GIB.
 *
 * No database, no API. Needs bash, python3 and GNU find (the encoder image
 * and the check container have them; macOS's BSD find does not).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateEncoderLoad } from '../src/services/fleet/streamLoad';
import { localWindowSeconds, projectStorage, scratchMibAt } from '../src/services/fleet/storageProjection';
import { choosePlacement } from '../src/services/fleet/placementPlanner';
import { fleetSettings } from '../src/services/fleet/placementConfig';

let passed = 0, failed = 0;
function ok(msg: string, cond: unknown, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`, detail ?? ''); }
}

const ROOT = join(__dirname, '../..');
const UPLOADER = join(ROOT, 'volt-encoder/bin/s3-uploader.sh');

// A stand-in for `aws s3 sync <src> s3://bucket/prefix/`: copies new or changed
// files into $FAKE_S3/<bucket>/<prefix>, honouring --exclude/--include in
// order like the CLI, and logs each call. FAKE_AWS_FAIL=1 makes every segment
// sync fail after copying nothing, the way a lost network would.
const FAKE_AWS = `#!/usr/bin/env python3
import fnmatch, os, shutil, sys
args = sys.argv[1:]
open(os.environ["FAKE_LOG"], "a").write(" ".join(args) + "\\n")
assert args[:2] == ["s3", "sync"], args
rest = args[2:]
pos, rules, i = [], [], 0
while i < len(rest):
    a = rest[i]
    if a in ("--exclude", "--include"):
        rules.append((a, rest[i + 1])); i += 2
    elif a in ("--cache-control", "--content-type", "--endpoint-url"):
        i += 2
    elif a.startswith("--"):
        i += 1
    else:
        pos.append(a); i += 1
src, dest = pos
manifests = any(r == ("--include", "*.m3u8") for r in rules)
if os.environ.get("FAKE_AWS_FAIL") == "1" and not manifests:
    sys.stderr.write("upload failed: network unreachable\\n"); sys.exit(1)
root = os.path.join(os.environ["FAKE_S3"], dest[len("s3://"):])
for d, _, files in os.walk(src):
    for f in files:
        rel = os.path.relpath(os.path.join(d, f), src)
        keep = True
        for kind, pat in rules:
            if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(f, pat):
                keep = kind == "--include"
        if not keep:
            continue
        out = os.path.join(root, rel)
        s = os.stat(os.path.join(d, f))
        if os.path.exists(out) and os.path.getsize(out) == s.st_size:
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copyfile(os.path.join(d, f), out)
`;

interface Run { dir: string; bucket: string; log: string; out: string; code: number | null }

/** A run folder as the packager leaves it: renditions with init + numbered segments, manifests, captions. */
function seedRun(ages: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-'));
  const now = Date.now() / 1000;
  for (const [rel, ageSec] of Object.entries(ages)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, `${rel} `.repeat(50));
    utimesSync(p, now - ageSec, now - ageSec);
  }
  return dir;
}

const OLD = 3600, MID = 2000, NEW = 30;
const LAYOUT: Record<string, number> = {
  'video_1080/init.mp4': OLD, 'video_720/init.mp4': OLD, 'audio/init.mp4': OLD,
  'video_1080/seg_1.m4s': OLD, 'video_1080/seg_2.m4s': OLD, 'video_1080/seg_3.m4s': MID, 'video_1080/seg_4.m4s': NEW,
  'video_720/seg_1.m4s': OLD, 'video_720/seg_2.m4s': OLD, 'video_720/seg_3.m4s': MID, 'video_720/seg_4.m4s': NEW,
  'audio/seg_1.m4s': OLD, 'audio/seg_2.m4s': OLD, 'audio/seg_3.m4s': MID, 'audio/seg_4.m4s': NEW,
  'subtitles/en/sub_1.vtt': OLD, 'subtitles/en/sub_2.vtt': NEW,
  'subtitles/en.vtt': OLD,                       // the end-of-run caption file: not a numbered segment
  'master.m3u8': OLD, 'video_1080/stream.m3u8': OLD, 'manifest.mpd': OLD,
  'notes/seg_final.m4s': OLD,                    // not numbered: never removed
};
const SEGS_OLD = Object.keys(LAYOUT).filter((k) => LAYOUT[k] === OLD && /\/(seg|sub)_\d+\./.test(k));
const SEGS_MID = Object.keys(LAYOUT).filter((k) => LAYOUT[k] === MID);
const KEPT_ALWAYS = Object.keys(LAYOUT).filter((k) => !/\/(seg|sub)_\d+\./.test(k) || LAYOUT[k] === NEW);

async function runUploader(env: Record<string, string>, seconds = 3.5): Promise<Run> {
  const dir = seedRun(LAYOUT);
  const work = mkdtempSync(join(tmpdir(), 'fakeaws-'));
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'bin/aws'), FAKE_AWS); chmodSync(join(work, 'bin/aws'), 0o755);
  const bucket = join(work, 's3');
  const log = join(work, 'aws.log'); writeFileSync(log, '');
  const child = spawn('bash', [UPLOADER, dir, 's3://origin/channel/c1/runs/r1/', '1'], {
    env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, FAKE_S3: bucket, FAKE_LOG: log,
      LOCAL_KEEP_SECONDS: '', JOB_CONFIG: join(work, 'none.json'), JOB_CONFIG_JSON: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  child.kill('SIGTERM');
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  return { dir, bucket: join(bucket, 'origin/channel/c1/runs/r1'), log, out, code };
}

const here = (r: Run, rel: string) => existsSync(join(r.dir, rel));
const inS3 = (r: Run, rel: string) => existsSync(join(r.bucket, rel));

async function main() {
  const gnuFind = spawnSync('find', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU');
  if (!gnuFind) { console.log('  skip uploader cases: GNU find not on this machine (the encoder image has it)'); }

  if (gnuFind) {
    // 1. A window on: old segments go, after reaching S3.
    const a = await runUploader({ LOCAL_KEEP_SECONDS: '600', JOB_CONFIG_JSON: JSON.stringify({ dvr_seconds: 300 }) });
    ok('window: the uploader says how much it keeps', /keeping 600s of segments locally/.test(a.out), a.out);
    ok('window: every old numbered segment is gone from the task disk', SEGS_OLD.every((k) => !here(a, k)), SEGS_OLD.filter((k) => here(a, k)));
    ok('window: every one of them is in S3, same size',
      SEGS_OLD.every((k) => inS3(a, k) && statSync(join(a.bucket, k)).size === `${k} `.repeat(50).length), SEGS_OLD.filter((k) => !inS3(a, k)));
    ok('window: segments 2000 s old (past a 600 s window) go too, after reaching S3', SEGS_MID.every((k) => !here(a, k) && inS3(a, k)));
    ok('window: init segments, manifests, the caption file and recent segments stay', KEPT_ALWAYS.every((k) => here(a, k)), KEPT_ALWAYS.filter((k) => !here(a, k)));
    ok('window: the uploader logs what it removed', /removed \d+ local segments older than 600s \(already in S3\)/.test(a.out), a.out);
    ok('window: S3 is never told to delete (no --delete on any sync)', !/--delete/.test(readFileSync(a.log, 'utf8')));
    ok('window: SIGTERM still ends with the final sync and exit 0', a.code === 0 && /final sync on shutdown/.test(a.out), { code: a.code });

    // 2. The sync fails: nothing goes.
    const b = await runUploader({ LOCAL_KEEP_SECONDS: '600', FAKE_AWS_FAIL: '1' });
    ok('failed sync: no segment is removed', Object.keys(LAYOUT).every((k) => here(b, k)), Object.keys(LAYOUT).filter((k) => !here(b, k)));
    ok('failed sync: nothing claims to have been removed', !/removed \d+ local segments/.test(b.out));

    // 3. No window (the Mac): the whole run stays, and is mirrored.
    const c = await runUploader({});
    ok('no window: every file stays on the disk', Object.keys(LAYOUT).every((k) => here(c, k)));
    ok('no window: and every segment is in S3', SEGS_OLD.concat(SEGS_MID).every((k) => inS3(c, k)));
    ok('no window: the uploader says it keeps every segment', /keeping every segment locally/.test(c.out), c.out);

    // 4. The DVR window is longer than the setting: the window grows to DVR + 2 minutes.
    const d = await runUploader({ LOCAL_KEEP_SECONDS: '600', JOB_CONFIG_JSON: JSON.stringify({ dvr_seconds: 3000 }) });
    ok('long DVR: the window is the DVR plus two minutes (3120 s)', /keeping 3120s of segments locally/.test(d.out), d.out);
    ok('long DVR: segments older than that go', SEGS_OLD.every((k) => !here(d, k) && inS3(d, k)));
    ok('long DVR: a segment inside the DVR window stays', SEGS_MID.every((k) => here(d, k)));

    // 5. The config file path (JOB_CONFIG) works the same as the env JSON.
    const cfgFile = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'config.json');
    writeFileSync(cfgFile, JSON.stringify({ dvr_seconds: 3000 }));
    const e = await runUploader({ LOCAL_KEEP_SECONDS: '600', JOB_CONFIG: cfgFile }, 2.5);
    ok('config file: the DVR window is read from /job/config.json as well', /keeping 3120s/.test(e.out), e.out);

    // 6. A bad value is treated as off, not as zero seconds.
    const f = await runUploader({ LOCAL_KEEP_SECONDS: 'half an hour' }, 2.5);
    ok('bad value: keeps everything', Object.keys(LAYOUT).every((k) => here(f, k)) && /keeping every segment/.test(f.out), f.out);
  }

  // 7. A local output never runs the uploader (the Mac's local runs are the recordings).
  const enc = readFileSync(join(ROOT, 'volt-encoder/bin/encoder.py'), 'utf8');
  ok('local output: encoder.py starts the uploader only when the output is not local',
    /if is_local\(cfg\):\s*\n\s*log\(f"local mode: writing directly to \{OUT_DIR\}; S3 uploader skipped"\)\s*\n\s*else:\s*\n\s*start_uploader\(cfg\)/.test(enc));

  // 8. The control plane's projection.
  ok('window seconds: off without ENCODER_LOCAL_KEEP_SECONDS', localWindowSeconds({ dvr_seconds: 300 }, null) === null);
  ok('window seconds: off for a local output', localWindowSeconds({ output: { mode: 'local' }, dvr_seconds: 300 }, 1800) === null);
  ok('window seconds: the setting when the DVR is short', localWindowSeconds({ dvr_seconds: 300 }, 1800) === 1800);
  ok('window seconds: DVR plus two minutes when that is longer', localWindowSeconds({ dvr_seconds: 7200 }, 1800) === 7320);
  const p = projectStorage(8000, null, 1800);
  ok('projection: the cap is the rate over the window plus slack', Math.abs((p.scratchCapMib ?? 0) - p.scratchMibPerHour * (1920 / 3600)) < 1, p);
  ok('projection: no window, no cap', projectStorage(8000).scratchCapMib === null);
  ok('disk at horizon: capped by the window', scratchMibAt(3000, 5, 24, 1600) === 1600);
  ok('disk at horizon: below the cap it is the rate times the time', scratchMibAt(30, 1, 2, 1600) === 90);
  ok('disk at horizon: no cap is the whole run, as before', scratchMibAt(3000, 5, 24) === 87000);

  const ladder = { workflow: 'transcode', gpu: false, dvr_seconds: 300, s3: { bucket: 'b', prefix: 'channel/c1' },
    ladder: [[1080, 6000], [720, 3500], [540, 2000], [360, 800]].map(([height, bitrate_kbps]) => ({ height, bitrate_kbps })),
    inputs: [{ role: 'primary' }] };
  const probe = { video: { codec: 'h264', width: 1920, height: 1080, fps: 25, bitrate_kbps: 8000 }, audio: [{}] };
  delete process.env.ENCODER_LOCAL_KEEP_SECONDS;
  const whole = estimateEncoderLoad(ladder, probe);
  process.env.ENCODER_LOCAL_KEEP_SECONDS = '1800';
  const windowed = estimateEncoderLoad(ladder, probe);
  const onMac = estimateEncoderLoad({ ...ladder, output: { mode: 'local' } }, probe);
  ok('estimate: a 1080p ladder with a window is capped near 30 minutes of output',
    windowed.storage.scratchCapMib != null && windowed.storage.scratchCapMib > 0 && windowed.storage.scratchCapMib < windowed.storage.scratchMibPerHour, windowed.storage);
  ok('estimate: the same ladder without the setting keeps the whole run', whole.storage.scratchCapMib === null);
  ok('estimate: a local output keeps the whole run even with the setting', onMac.storage.scratchCapMib === null);
  ok('estimate: S3 still gets every byte (s3BytesPerHour unchanged)', windowed.storage.s3BytesPerHour === whole.storage.s3BytesPerHour);

  // 9. Placement: the ladder that a 30 GiB disk could not hold for 24 hours now fits.
  process.env.FLEET_TASK_DISK_GIB = '30';
  process.env.ECS_ONDEMAND_LARGE_PROVIDER = 'volt-ondemand-large';
  const s = fleetSettings();
  const req = (e: typeof whole) => ({ streamId: 'c1', streamClass: 'channel' as const, accountId: null, isolation: 'shared' as const,
    load: e.load, reservation: e.reservation, needsGpu: e.needsGpu,
    diskMib: scratchMibAt(e.storage.scratchMibPerHour, 0, s.diskHorizonHours, e.storage.scratchCapMib) });
  const before = choosePlacement(req(whole), [], s.placementPolicy) as any;
  const after = choosePlacement(req(windowed), [], s.placementPolicy) as any;
  ok('placement: the whole run over 24 hours does not fit a 30 GiB task disk (as on HEAD)', before.action === 'unplaceable' && /task disk/.test(before.reason), before);
  ok('placement: with the window it goes on a new server', after.action === 'new_host', after);
  delete process.env.FLEET_TASK_DISK_GIB; delete process.env.ECS_ONDEMAND_LARGE_PROVIDER; delete process.env.ENCODER_LOCAL_KEEP_SECONDS;

  // 10. Terraform.
  const tf = (f: string) => readFileSync(join(ROOT, 'deploy/terraform', f), 'utf8');
  const cluster = tf('ecs_cluster.tf'), gpu = tf('ecs_capacity_gpu.tf'), svc = tf('ecs_services.tf'), vars = tf('variables.tf'), ex = tf('terraform.tfvars.example');
  const vol = (s: string, v: string) => new RegExp(`block_device_mappings \\{[\\s\\S]*?device_name = "/dev/xvda"[\\s\\S]*?volume_size\\s+= var\\.${v}[\\s\\S]*?volume_type\\s+= "gp3"[\\s\\S]*?encrypted\\s+= true`).test(s);
  ok('terraform: the CPU launch template (small and large pools) sets a gp3 encrypted root', vol(cluster, 'encoder_root_volume_gib'));
  ok('terraform: the large pools use that launch template', (tf('ecs_capacity_large.tf').match(/launch_template_id = aws_launch_template\.ecs\.id/g) ?? []).length === 2);
  ok('terraform: the GPU launch template sets its own root', vol(gpu, 'gpu_root_volume_gib'));
  ok('terraform: stopped tasks give their disk back after 15 minutes on both', [cluster, gpu].every((s) => /ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=15m/.test(s)));
  const encDef = svc.slice(svc.indexOf('resource "aws_ecs_task_definition" "encoder"'), svc.indexOf('resource "aws_ecs_task_definition" "thumbnailer"'));
  ok('terraform: the encoder task keeps the window (LOCAL_KEEP_SECONDS)', /name = "LOCAL_KEEP_SECONDS", value = tostring\(var\.encoder_local_keep_seconds\)/.test(encDef));
  ok('terraform: the control plane knows the disk and the window',
    /name = "FLEET_TASK_DISK_GIB", value = tostring\(var\.encoder_root_volume_gib\)/.test(svc) && /name = "ENCODER_LOCAL_KEEP_SECONDS", value = tostring\(var\.encoder_local_keep_seconds\)/.test(svc));
  ok('terraform: the three variables are declared and in the example',
    ['encoder_root_volume_gib', 'gpu_root_volume_gib', 'encoder_local_keep_seconds'].every((v) => vars.includes(`variable "${v}"`) && ex.includes(`# ${v} =`)));
  ok('terraform: FLEET_TASK_DISK_GIB is no longer listed as left at its default', !tf('env-coverage.json').includes('"FLEET_TASK_DISK_GIB"'));

  console.log(`\nencoder-task-disk: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
