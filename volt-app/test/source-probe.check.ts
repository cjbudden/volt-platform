// ============================================================================
//  CHECK SOURCE: the probe behind the Validate button, against real media.
//
//  Builds a short HLS stream with ffmpeg (H.264 + two AAC tracks), serves it on
//  a local HTTP port, and probes it the way the console does. Also pins the
//  fence: a local path, a file: URL, or a playlist whose segment points at a
//  local file must never be read, and push listeners are answered with a note
//  rather than "unreachable".
//
//  Usage: npx tsx test/source-probe.check.ts   (needs ffmpeg + ffprobe)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSource, probeUrlProblem } from '../src/services/sourceProbe';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));

(async () => {
  console.log('== the fence ==');
  truthy('a bare path is refused', probeUrlProblem('/etc/passwd'));
  truthy('file: is refused', probeUrlProblem('file:///etc/passwd'));
  truthy('concat: is refused', probeUrlProblem('concat:a|b') ?? 'refused (no scheme slashes)');
  truthy('https is allowed', probeUrlProblem('https://cdn.example/a.m3u8') === null);
  truthy('srt is allowed', probeUrlProblem('srt://h:9000?mode=caller') === null);
  const f = await probeSource('file:///etc/hostname', 'hls');
  truthy('probing a file: URL does not read it', !f.ok && !f.reachable && /cannot be checked/.test(f.error ?? ''), JSON.stringify(f));

  console.log('\n== push listeners ==');
  const srt = await probeSource('srt://0.0.0.0:9000?streamid=x', 'srt');
  truthy('an SRT listener gets a note, not an error', srt.ok && !srt.reachable && /push source/.test(srt.note ?? ''));
  const rtmp = await probeSource('rtmp://ingest/live', 'rtmp');
  truthy('RTMP gets the push note', rtmp.ok && /push source/.test(rtmp.note ?? ''));
  const ndi = await probeSource('STUDIO (Cam 1)', 'ndi');
  truthy('NDI is explained, not attempted', ndi.ok && /local network/.test(ndi.note ?? ''));

  if (spawnSync('ffmpeg', ['-version']).error) { console.log('SKIP ffmpeg not installed: real-media checks not run'); finish(); return; }

  console.log('\n== real media ==');
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '4', '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-g', '50', '-c:a', 'aac', '-ac', '2', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', join(dir, 'index.m3u8')]);
  truthy('ffmpeg built a test HLS stream', r.status === 0 && existsSync(join(dir, 'index.m3u8')), String(r.stderr));
  // a hostile playlist: a segment that is a local file
  writeFileSync(join(dir, 'evil.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n');
  const srv = createServer((req, res) => {
    const p = join(dir, (req.url ?? '/').split('?')[0]);
    if (!p.startsWith(dir) || !existsSync(p)) { res.statusCode = 404; res.end(); return; }
    res.end(readFileSync(p));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as any).port;
  const p = await probeSource(`http://127.0.0.1:${port}/index.m3u8`, 'hls');
  truthy('reachable', p.ok && p.reachable, JSON.stringify(p));
  truthy('video is H.264 640x360 at 25 fps', p.video?.codec === 'h264' && p.video?.width === 640 && p.video?.height === 360 && p.video?.fps === 25, JSON.stringify(p.video));
  truthy('both audio tracks with their languages', (p.audio ?? []).length === 2 && p.audio![0].language === 'eng' && p.audio![1].language === 'fra', JSON.stringify(p.audio));
  truthy('container reported', /hls/.test(p.container?.format ?? ''), JSON.stringify(p.container));
  const e = await probeSource(`http://127.0.0.1:${port}/evil.m3u8`, 'hls');
  truthy('a playlist pointing at a local file is not followed', !(e.reachable && e.video), JSON.stringify(e));
  const miss = await probeSource(`http://127.0.0.1:${port}/nope.m3u8`, 'hls');
  truthy('a missing stream is reported plainly', !miss.ok && /Could not read/.test(miss.error ?? ''), JSON.stringify(miss));
  srv.close();
  finish();
})();

function finish() { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
