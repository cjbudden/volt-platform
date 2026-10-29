// ============================================================================
//  MP3 BURST ON CONNECT: a listener joining a running feed hears it at once.
//
//  The station page's unmute reconnects to the MP3 output. Without a burst the
//  gateway sent nothing until the next HLS segment landed (up to 4 s), and the
//  browser then wanted its own pre-roll: a long silence after the click. With
//  it, a new listener gets the last few seconds immediately, starting on a
//  whole MP3 frame.
//
//  Runs a real live HLS (ffmpeg, 4 s segments) and the real gateway; no
//  database (listeners carry no account, so no session row is written).
//  Usage: npx tsx test/mp3-burst.check.ts   (needs ffmpeg)
// ============================================================================
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'volt-burst-'));
process.env.ORIGIN_DIR = WORK;
const ID = '00000000-0000-4000-8000-00000000b057';

let pass = 0, fail = 0;
const truthy = (m: string, v: unknown, d = '') => { if (v) { console.log('PASS ' + m); pass++; } else { console.log(`FAIL ${m} -- ${d || JSON.stringify(v)}`); fail++; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { attachListener, burstFrom, stopFeed } = await import('../src/services/radio/mp3Gateway');
  const { mp3FrameOffset } = await import('../src/services/sourceValidate');

  // pure: the burst starts on a frame and never exceeds its cap
  const junk = Buffer.from([1, 2, 3, 0xff, 0x00]);
  const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;   // 128k 44.1k
  const b = burstFrom([junk, frame, frame, frame], 10_000);
  truthy('burst starts on an MP3 frame', b.length === 417 * 3 && b[0] === 0xff && b[1] === 0xfb, String(b.length));
  truthy('burst honours its cap', burstFrom([frame, frame, frame, frame], 900).length <= 900);
  truthy('no frame, no burst', burstFrom([junk], 100).length === 0);
  truthy('frame offset skips junk', mp3FrameOffset(Buffer.concat([junk, frame, frame])) === junk.length);

  const audio = join(WORK, ID, 'audio');
  mkdirSync(audio, { recursive: true });
  const enc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
    '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments', join(audio, 'index.m3u8')], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !existsSync(join(audio, 'index.m3u8')); i++) await sleep(250);
  await sleep(9000);

  const srv = createServer(async (req, res) => {
    const r = await attachListener(ID, req, res, { bitrateKbps: 128 });
    if (!r.ok) { res.statusCode = 503; res.end(r.reason); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;

  /** Connect, and report ms to the first byte and bytes received within `windowMs` of it. */
  const listen = (windowMs: number) => new Promise<{ first: number; bytes: number; head: Buffer }>((done) => {
    const t0 = Date.now(); let first = -1; let bytes = 0; const head: Buffer[] = [];
    const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.on('data', (c: Buffer) => {
        if (first < 0) { first = Date.now() - t0; setTimeout(() => { req.destroy(); done({ first, bytes, head: Buffer.concat(head) }); }, windowMs); }
        bytes += c.length; if (head.length < 4) head.push(c);
      });
    });
    req.on('error', () => {});
  });

  const one = await listen(500);
  console.log(`  first listener: first byte after ${one.first} ms, ${one.bytes} bytes in 500 ms`);
  truthy('first listener gets audio', one.first >= 0 && one.bytes > 0);
  await sleep(1500);   // inside the linger: the feed is running, between segments
  const two = await listen(300);
  console.log(`  joining listener: first byte after ${two.first} ms, ${two.bytes} bytes in 300 ms`);
  truthy('a joining listener gets its first byte at once (< 300 ms)', two.first >= 0 && two.first < 300, String(two.first));
  truthy('and about 3 s of audio straight away (>= 32 KB)', two.bytes >= 32_000, String(two.bytes));
  truthy('the burst begins on an MP3 frame', two.head[0] === 0xff && (two.head[1] & 0xe0) === 0xe0, two.head.subarray(0, 4).toString('hex'));

  stopFeed(ID, 'test'); enc.kill('SIGKILL'); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
