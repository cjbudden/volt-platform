/**
 * Per-run S3 prefixes (build queue 2.2).
 *
 * On AWS the encoder used to mirror its output straight to <kind>/<id>/ in the
 * bucket, so a restart wrote seg_N.m4s over the run before it, and two
 * encoders on one stream (a move between servers, CONSOLIDATION.md blocker 1)
 * would overwrite each other. Now each run uploads under
 * <kind>/<id>/runs/<runId>/, and the uploader writes the stable playlists
 * (media pointed into the run) and current_run.txt at the stream's root.
 *
 * This suite runs the real s3-uploader.sh and run_pointer.py with a stand-in
 * `aws` (a local folder as the bucket), the encoder's own uploader_dests, and
 * the control plane's loop reading (variantManifest) against a small
 * S3-compatible server through the real AWS SDK:
 *
 *   - a run's media and playlists land under runs/<runId>/, none at the root;
 *   - the root playlists point into the run, the pointer names it, and a
 *     player resolving the root master reaches the run's own bytes;
 *   - a second run with the same file names never writes over the first; the
 *     pointer moves to it at its first pass;
 *   - the older run, still uploading, never takes the stream back;
 *   - a run with no playlist yet does not move the pointer;
 *   - without a run id the old flat layout is kept (encoders and tests from
 *     before 2.2), and `s3.per_run: false` asks for it;
 *   - the edge's loop for a rights variant is read from the run the pointer
 *     names, and from the root when there is no pointer.
 *
 * No database needed (the FAST lookup fails closed). Needs bash and python3.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';

let passed = 0, failed = 0;
function ok(msg: string, cond: unknown, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`, detail ?? ''); }
}

const ROOT = join(__dirname, '../..');
const BIN = join(ROOT, 'volt-encoder/bin');
const UPLOADER = join(BIN, 's3-uploader.sh');

// `aws s3 sync <dir> s3://b/p/` with --exclude/--include in order, and
// `aws s3 cp` in both directions, over $FAKE_S3/<bucket>/<key>.
const FAKE_AWS = `#!/usr/bin/env python3
import fnmatch, os, shutil, sys
args = sys.argv[1:]
open(os.environ["FAKE_LOG"], "a").write(" ".join(args) + "\\n")
root = os.environ["FAKE_S3"]
def loc(u):
    assert u.startswith("s3://"), u
    return os.path.join(root, u[5:])
assert args[0] == "s3", args
op, rest = args[1], args[2:]
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
if op == "cp":
    src, dst = pos
    if src.startswith("s3://"):
        if not os.path.exists(loc(src)):
            sys.stderr.write("fatal error: An error occurred (404) when calling the HeadObject operation\\n"); sys.exit(1)
        shutil.copyfile(loc(src), dst)
    else:
        os.makedirs(os.path.dirname(loc(dst)), exist_ok=True)
        shutil.copyfile(src, loc(dst))
    sys.exit(0)
assert op == "sync", args
src, dst = pos
dest_root = loc(dst)
for d, _, files in os.walk(src):
    for f in files:
        rel = os.path.relpath(os.path.join(d, f), src)
        keep = True
        for kind, pat in rules:
            if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(f, pat):
                keep = kind == "--include"
        if not keep:
            continue
        out = os.path.join(dest_root, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copyfile(os.path.join(d, f), out)
`;

const MASTER = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n720p/index_cc.m3u8\n';
const media = (n: number) => `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n${
  Array.from({ length: n }, (_, i) => `#EXTINF:4.0,\nseg_${i + 1}.m4s\n`).join('')}`;

function seedRun(tag: string, segs: number, playlists = true): string {
  const dir = mkdtempSync(join(tmpdir(), `run-${tag}-`));
  mkdirSync(join(dir, '720p'), { recursive: true });
  writeFileSync(join(dir, '720p/init.mp4'), `init ${tag}`);
  for (let i = 1; i <= segs; i++) writeFileSync(join(dir, `720p/seg_${i}.m4s`), `seg ${i} of ${tag}`);
  if (playlists) {
    writeFileSync(join(dir, 'master_cc.m3u8'), MASTER);
    writeFileSync(join(dir, '720p/index_cc.m3u8'), media(segs));
    writeFileSync(join(dir, 'manifest_cc.mpd'), '<MPD><Period><SegmentTemplate media="720p/seg_$Number$.m4s" initialization="720p/init.mp4"/></Period></MPD>');
  }
  return dir;
}

const work = mkdtempSync(join(tmpdir(), 'fakeaws-'));
mkdirSync(join(work, 'bin'));
writeFileSync(join(work, 'bin/aws'), FAKE_AWS); chmodSync(join(work, 'bin/aws'), 0o755);
const S3 = join(work, 's3');
const LOG = join(work, 'aws.log'); writeFileSync(LOG, '');
const STREAM = 's3://origin/channel/c1/';
const inBucket = (key: string) => join(S3, 'origin/channel/c1', key);
const read = (key: string) => (existsSync(inBucket(key)) ? readFileSync(inBucket(key), 'utf8') : null);

function startUploader(dir: string, args: string[]) {
  const child = spawn('bash', [UPLOADER, dir, ...args], {
    env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, FAKE_S3: S3, FAKE_LOG: LOG,
      LOCAL_KEEP_SECONDS: '', JOB_CONFIG: join(work, 'none.json'), JOB_CONFIG_JSON: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return {
    child,
    get out() { return out; },
    stop: async () => { child.kill('SIGTERM'); await new Promise((r) => child.on('exit', r)); return out; },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const R1 = '20261112T190000Z', R2 = '20261112T193000Z';

/** Follow the root master the way a player does, to the bytes of its first segment. */
function playFromRoot(): { segKey: string; bytes: string | null } {
  const master = read('master_cc.m3u8') ?? '';
  const variant = master.split('\n').find((l) => l && !l.startsWith('#'))!;
  const pl = read(variant) ?? '';
  const seg = pl.split('\n').find((l) => l && !l.startsWith('#'))!;
  const segKey = posix.normalize(posix.join(posix.dirname(variant), seg));
  return { segKey, bytes: read(segKey) };
}

async function uploaderPart() {
  console.log('the uploader: per-run prefixes and the pointer');
  // ---- run 1 -----------------------------------------------------------------
  const run1 = seedRun('r1', 3);
  const u1 = startUploader(run1, [`${STREAM}runs/${R1}/`, '1', R1, STREAM]);
  await sleep(2500);
  ok('run 1 media under its own prefix', read(`runs/${R1}/720p/seg_1.m4s`) === 'seg 1 of r1');
  ok('run 1 playlists under its own prefix too', read(`runs/${R1}/720p/index_cc.m3u8`) === media(3));
  ok('no media at the stream root', !existsSync(inBucket('720p/seg_1.m4s')) && !existsSync(inBucket('720p/init.mp4')));
  ok('the pointer names run 1', read('current_run.txt') === R1, read('current_run.txt'));
  ok('the root master is the run\'s, unchanged (it names its playlists beside it)', read('master_cc.m3u8') === MASTER);
  ok('the root media playlist points into run 1', (read('720p/index_cc.m3u8') ?? '').includes(`\n../runs/${R1}/720p/seg_1.m4s\n`)
    && (read('720p/index_cc.m3u8') ?? '').includes(`URI="../runs/${R1}/720p/init.mp4"`), read('720p/index_cc.m3u8'));
  ok('the root DASH manifest points into run 1', (read('manifest_cc.mpd') ?? '').includes(`media="runs/${R1}/720p/seg_$Number$.m4s"`));
  let p = playFromRoot();
  ok('a player from the stable URL reaches run 1\'s bytes', p.bytes === 'seg 1 of r1', p);
  ok('the uploader says the run is live', /run 20261112T190000Z is live/.test(u1.out), u1.out);

  // ---- run 2 starts, same file names, while run 1 still uploads ---------------
  const run2 = seedRun('r2', 2);
  const u2 = startUploader(run2, [`${STREAM}runs/${R2}/`, '1', R2, STREAM]);
  await sleep(2500);
  ok('run 2 media under its own prefix', read(`runs/${R2}/720p/seg_1.m4s`) === 'seg 1 of r2');
  ok('run 1\'s seg_1 is not written over', read(`runs/${R1}/720p/seg_1.m4s`) === 'seg 1 of r1');
  ok('the pointer moved to run 2 at its first pass', read('current_run.txt') === R2, read('current_run.txt'));
  // run 1 keeps uploading and now finds a newer pointer: it stops publishing
  writeFileSync(join(run1, '720p/seg_4.m4s'), 'seg 4 of r1');
  writeFileSync(join(run1, '720p/index_cc.m3u8'), media(4));
  await sleep(2500);
  ok('run 1 still uploads its own media', read(`runs/${R1}/720p/seg_4.m4s`) === 'seg 4 of r1');
  ok('run 1 never takes the stream back', read('current_run.txt') === R2 && (read('720p/index_cc.m3u8') ?? '').includes(`../runs/${R2}/`)
    && !(read('720p/index_cc.m3u8') ?? '').includes(R1), read('720p/index_cc.m3u8'));
  ok('run 1 says why it stopped publishing', /a newer run \(20261112T193000Z\) holds the stream; run 20261112T190000Z stops/.test(u1.out), u1.out);
  p = playFromRoot();
  ok('a player from the stable URL now reaches run 2\'s bytes', p.bytes === 'seg 1 of r2', p);
  // run 1's final sync on shutdown does not take it back either
  await u1.stop();
  ok('run 1\'s final sync leaves the pointer on run 2', read('current_run.txt') === R2);
  // run 2's closing playlists reach the root on its final sync
  writeFileSync(join(run2, '720p/index_cc.m3u8'), media(2) + '#EXT-X-ENDLIST\n');
  await u2.stop();
  ok('run 2\'s closing playlist reaches the stable copy', (read('720p/index_cc.m3u8') ?? '').includes('#EXT-X-ENDLIST'));

  // ---- a run with nothing playable yet ----------------------------------------
  const R3 = '20261112T200000Z';
  const run3 = seedRun('r3', 1, false);
  const u3 = startUploader(run3, [`${STREAM}runs/${R3}/`, '1', R3, STREAM]);
  await sleep(2200);
  await u3.stop();
  ok('a run with no playlist yet uploads its media', read(`runs/${R3}/720p/seg_1.m4s`) === 'seg 1 of r3');
  ok('and does not move the pointer', read('current_run.txt') === R2, read('current_run.txt'));

  // ---- no run id: the layout before 2.2 ---------------------------------------
  const flat = seedRun('flat', 1);
  const uf = startUploader(flat, ['s3://origin/channel/c2/', '1']);
  await sleep(2200);
  await uf.stop();
  ok('three arguments keep the flat layout', existsSync(join(S3, 'origin/channel/c2/720p/seg_1.m4s')));
  ok('and write no pointer', !existsSync(join(S3, 'origin/channel/c2/current_run.txt')) && !existsSync(join(S3, 'origin/channel/c2/runs')));
}

function encoderPart() {
  console.log('the encoder: where it uploads');
  const py = `
import sys, json; sys.path.insert(0, ${JSON.stringify(BIN)})
import encoder
base = {"channel_id": "c1", "s3": {"bucket": "origin", "prefix": "channel/c1"}}
print(json.dumps([
  encoder.uploader_dests(base, "${R1}"),
  encoder.uploader_dests({**base, "s3": {**base["s3"], "per_run": False}}, "${R1}"),
  encoder.uploader_dests({"channel_id": "c9", "s3": {"bucket": "origin"}}, "${R1}"),
  encoder.uploader_dests(base, None),
]))`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  let v: any = null;
  try { v = JSON.parse(r.stdout.trim().split('\n').pop()!); } catch { /* reported below */ }
  ok('encoder.py imports', !!v, r.stderr.slice(-600));
  if (!v) return;
  ok('a run uploads to <prefix>/runs/<runId>/ with the stream root for the pointer',
    v[0][0] === `s3://origin/channel/c1/runs/${R1}/` && v[0][1] === 's3://origin/channel/c1/', v[0]);
  ok('s3.per_run false keeps the flat layout', v[1][0] === 's3://origin/channel/c1/' && v[1][1] === null, v[1]);
  ok('no prefix: the channel id, per run', v[2][0] === `s3://origin/c9/runs/${R1}/`, v[2]);
  ok('no run id: flat', v[3][1] === null, v[3]);
  const src = readFileSync(join(BIN, 'encoder.py'), 'utf8');
  ok('every run gets an id, not only local ones', /RUN_ID = time\.strftime\("%Y%m%dT%H%M%SZ", time\.gmtime\(\)\)\n    if is_local\(cfg\) and d:/.test(src));
  ok('channel.start carries the run id', src.includes('_events.channel_start(cfg["workflow"], nrend, run_id=RUN_ID)'));
}

async function loopPart() {
  console.log('the control plane: the loop for a rights variant, from the live run');
  const objects = new Map<string, Buffer>();
  const gets: string[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname.slice(1));
    gets.push(key);
    const v = objects.get(key);
    if (req.method === 'GET' && v) { res.writeHead(200, { 'content-length': v.length }); res.end(v); return; }
    res.writeHead(404, { 'content-type': 'application/xml' });
    res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>no</Message></Error>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${(srv.address() as any).port}`;
  process.env.S3_FORCE_PATH_STYLE = '1';
  process.env.AWS_ACCESS_KEY_ID ??= 'test'; process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.VARIANT_SOURCE_CACHE_MS = '0';
  const { config } = await import('../src/config');
  (config as any).env = 'production';
  config.aws.s3Bucket = 'origin';
  const vm = await import('../src/services/variantManifest');
  const id = randomUUID();
  const loop = (tag: string) => Buffer.from(JSON.stringify({ hash: tag, segment_seconds: 2, tracks: {
    '720p': { kind: 'video', init: '720p/init.mp4', segments: [{ uri: '720p/seg_1.m4s', dur: 2 }] } } }));

  // an encoder from before 2.2: flat layout, no pointer
  objects.set(`origin/channel/${id}/filler/filler.json`, loop('flat'));
  objects.set(`origin/channel/${id}/filler/720p/seg_1.m4s`, Buffer.from('flat seg'));
  ok('no pointer: no run folder', (await vm.cloudRunDir('channel', id)) === '');
  let l = await vm.loadLoop('channel', id);
  ok('no pointer: the loop from the root, as before', l?.hash === 'flat' && l?.base === '../../filler/', l);
  ok('no pointer: its bytes from the root', (await l?.read?.('720p/seg_1.m4s'))?.toString() === 'flat seg');

  // a run with the pointer: the loop is in the run's folder
  objects.set(`origin/channel/${id}/runs/${R2}/filler/filler.json`, loop('run2'));
  objects.set(`origin/channel/${id}/runs/${R2}/filler/720p/seg_1.m4s`, Buffer.from('run2 seg'));
  objects.set(`origin/channel/${id}/current_run.txt`, Buffer.from(`${R2}\n`));
  ok('the pointer names the run folder', (await vm.cloudRunDir('channel', id)) === `runs/${R2}/`);
  l = await vm.loadLoop('channel', id);
  ok('the loop is read from the live run', l?.hash === 'run2', l);
  ok('its segment URLs point into the run', l?.base === `../../runs/${R2}/filler/`, l?.base);
  ok('its bytes come from the run', (await l?.read?.('720p/seg_1.m4s'))?.toString() === 'run2 seg');
  ok('a path that climbs out is refused', (await l?.read?.('../../x.m4s')) === null);
  // a pointer that is not a run id is ignored, never used as a path
  objects.set(`origin/channel/${id}/current_run.txt`, Buffer.from('../../other'));
  ok('a bad pointer is not a path', (await vm.cloudRunDir('channel', id)) === '');
  // the delivered playlists are read where they always were: the root copies
  objects.set(`origin/event/${id}/master_cc.m3u8`, Buffer.from(MASTER));
  ok('delivered playlists still read at the root', (await vm.readDelivered('event', id, 'master_cc.m3u8')) === MASTER);
  srv.close();
}

async function main() {
  await uploaderPart();
  encoderPart();
  await loopPart();
  const python = spawnSync('python3', [join(BIN, 'test_run_pointer.py')], { cwd: BIN, encoding: 'utf8' });
  const m = /run_pointer: (\d+) passed, (\d+) failed/.exec(python.stdout);
  ok(`run_pointer.py unit tests (${m ? m[1] : '?'} passed)`, python.status === 0 && m && m[2] === '0', python.stdout + python.stderr);
  console.log(`\ncloud-runs: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
