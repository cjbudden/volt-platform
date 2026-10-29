// ============================================================================
//  VALIDATE SOURCE: the no-probe check behind the station form's button.
//
//  Builds real media with ffmpeg (MP3, ADTS AAC, an HLS stream, a DASH stream),
//  serves it on a local port the way each protocol does (an Icecast-style
//  endless MP3 with ICY headers and metadata, HLS, DASH, and a mount that
//  answers 200 with an HTML page), and validates each the way the console
//  does. Also pins the pure sniffers and the MPD reader.
//
//  Usage: npx tsx test/source-validate.check.ts   (needs ffmpeg to build media)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSource, sniffAudio, sniffContainer, parseMpd, kindFor } from '../src/services/sourceValidate';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));
const ff = (args: string[]) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' }).status === 0;

(async () => {
  console.log('== kind ==');
  truthy('protocol icecast', kindFor('https://x/a', 'icecast') === 'icecast');
  truthy('.m3u8 is HLS', kindFor('https://x/a.m3u8') === 'hls');
  truthy('.mpd is DASH', kindFor('https://x/a.mpd?t=1') === 'dash');
  truthy('SRT listener is a push', kindFor('srt://0.0.0.0:9000', 'srt') === 'push');
  truthy('SRT caller is not a push', kindFor('srt://h:9000?mode=caller', 'srt') === 'unknown');
  truthy('a bare https URL is sniffed', kindFor('https://x/stream') === null);

  console.log('\n== sniffers ==');
  truthy('HTML is not media', !sniffContainer(Buffer.from('<!DOCTYPE html><html>')).ok);
  const ts = Buffer.alloc(188 * 2); ts[0] = 0x47; ts[188] = 0x47;
  truthy('MPEG-TS sync bytes', sniffContainer(ts).container === 'MPEG-TS');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypiso6')]);
  truthy('fMP4 ftyp', /fMP4/.test(sniffContainer(mp4).container));
  truthy('random bytes are not audio', sniffAudio(Buffer.alloc(4096, 0x55)) === null);

  const dir = mkdtempSync(join(tmpdir(), 'volt-validate-'));
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-ac', '2'];
  if (!ff([...tone, '-t', '20', '-c:a', 'libmp3lame', '-b:a', '128k', join(dir, 'a.mp3')])) { bad('ffmpeg builds MP3', 'ffmpeg failed'); process.exit(1); }
  ff([...tone, '-t', '4', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', join(dir, 'a.aac')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', ...tone, '-t', '8', '-c:v', 'libx264', '-g', '50', '-c:a', 'aac', '-shortest',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', join(dir, 'v.m3u8')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', ...tone, '-t', '8', '-c:v', 'libx264', '-g', '50', '-c:a', 'aac', '-shortest',
    '-f', 'dash', '-seg_duration', '2', join(dir, 'm.mpd')]);

  const mp3 = readFileSync(join(dir, 'a.mp3'));
  const s1 = sniffAudio(mp3.subarray(5000));
  truthy('MP3 frames found mid-stream', s1?.codec === 'MP3' && s1.sampleRate === 44100 && s1.bitrateKbps === 128 && s1.channels === 2, JSON.stringify(s1));
  const s2 = sniffAudio(readFileSync(join(dir, 'a.aac')));
  truthy('ADTS AAC frames', s2?.codec === 'AAC-LC' && s2.sampleRate === 44100, JSON.stringify(s2));
  const mpdText = existsSync(join(dir, 'm.mpd')) ? readFileSync(join(dir, 'm.mpd'), 'utf8') : '';
  const mpd = parseMpd(mpdText, 'http://h/live/m.mpd');
  truthy('MPD: video and audio sets', mpd?.sets.some((s) => s.type === 'video') && mpd?.sets.some((s) => s.type === 'audio'), JSON.stringify(mpd));
  truthy('MPD: init address worked out', mpd?.sets.every((s) => s.init?.startsWith('http://h/live/')), JSON.stringify(mpd?.sets.map((s) => s.init)));
  truthy('MPD: not an MPD', parseMpd('<html/>', 'http://h/') === null);

  // An Icecast-style server: endless MP3 with ICY headers and a metadata block every 8000 bytes.
  const META = 8000;
  const srv = createServer((req, res) => {
    const p = (req.url || '').split('?')[0];
    if (p === '/live.mp3') {
      const wantMeta = req.headers['icy-metadata'] === '1';
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Test FM', 'icy-genre': 'Tones', 'icy-br': '128', ...(wantMeta ? { 'icy-metaint': String(META) } : {}) });
      let off = 0; let since = 0;
      const tick = setInterval(() => {
        let chunk = mp3.subarray(off % mp3.length, (off % mp3.length) + 4000); off += chunk.length;
        if (wantMeta) {
          const parts: Buffer[] = [];
          while (chunk.length) {
            const take = Math.min(chunk.length, META - since);
            parts.push(chunk.subarray(0, take)); chunk = chunk.subarray(take); since += take;
            if (since === META) {
              const txt = Buffer.from("StreamTitle='Artist - Song';"); const n = Math.ceil(txt.length / 16);
              const blk = Buffer.alloc(1 + n * 16); blk[0] = n; txt.copy(blk, 1); parts.push(blk); since = 0;
            }
          }
          chunk = Buffer.concat(parts);
        }
        if (!res.write(chunk)) { /* backpressure: fine for a test */ }
      }, 20);
      req.on('close', () => clearInterval(tick));
      return;
    }
    if (p === '/broken.mp3') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><h1>Mount not found</h1>'); return; }
    if (p === '/station.pls') { res.writeHead(200, { 'content-type': 'audio/x-scpls' }); res.end(`[playlist]\nFile1=http://127.0.0.1:${(srv.address() as any).port}/live.mp3\n`); return; }
    const f = join(dir, p.slice(1));
    if (!p.slice(1) || p.includes('..') || !existsSync(f)) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': p.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : p.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;

  console.log('\n== Icecast ==');
  const ice = await validateSource(`${base}/live.mp3`, 'icecast');
  truthy('works, playable as is', ice.ok && ice.kind === 'icecast', JSON.stringify(ice));
  truthy('audio check finds MP3 frames', ice.checks.find((c) => c.id === 'audio')?.state === 'pass');
  truthy('now playing read from the ICY block', ice.icy?.nowPlaying === 'Artist - Song', JSON.stringify(ice.icy));
  truthy('station name for the Use button', ice.icy?.station.name === 'Test FM');
  truthy('facts: codec, 44.1 kHz', ice.facts.some((f) => f.k === 'Codec' && f.v === 'MP3') && ice.facts.some((f) => f.v === '44.1 kHz'), JSON.stringify(ice.facts));
  truthy('sample offered as plain audio', ice.preview?.kind === 'audio' && ice.preview.url === `${base}/live.mp3`);
  const sniffed = await validateSource(`${base}/live.mp3`);
  truthy('no protocol: sniffed as Icecast', sniffed.kind === 'icecast' && sniffed.ok, JSON.stringify(sniffed.checks));
  const pls = await validateSource(`${base}/station.pls`);
  truthy('a .pls resolves to the mount', pls.ok && pls.url === `${base}/live.mp3`, JSON.stringify(pls));
  const broken = await validateSource(`${base}/broken.mp3`, 'icecast');
  truthy('a 200 HTML page fails on audio', !broken.ok && broken.checks.find((c) => c.id === 'audio')?.state === 'fail' && !broken.preview, JSON.stringify(broken.checks));
  const down = await validateSource('http://127.0.0.1:1/x.mp3', 'icecast');
  truthy('nothing listening fails on connect', !down.ok && down.checks.find((c) => c.id === 'connect')?.state === 'fail');

  console.log('\n== HLS ==');
  const hls = await validateSource(`${base}/v.m3u8`, 'hls');
  truthy('segment downloads and is MPEG-TS', hls.checks.find((c) => c.id === 'segment')?.detail.includes('MPEG-TS'), JSON.stringify(hls.checks));
  truthy('a finished playlist warns, still ok', hls.ok && hls.checks.find((c) => c.id === 'live')?.state === 'warn');
  truthy('sample offered as HLS', hls.preview?.kind === 'hls');
  const hls404 = await validateSource(`${base}/nope.m3u8`, 'hls');
  truthy('a missing playlist fails', !hls404.ok && hls404.checks[0]?.state === 'fail');

  console.log('\n== DASH ==');
  const dash = await validateSource(`${base}/m.mpd`, 'dash');
  truthy('manifest + init segment pass', dash.ok && dash.checks.find((c) => c.id === 'segment')?.state === 'pass', JSON.stringify(dash.checks));
  truthy('sample offered as DASH', dash.preview?.kind === 'dash');
  const notDash = await validateSource(`${base}/broken.mp3`, 'dash');
  truthy('an HTML page is not a manifest', !notDash.ok);

  console.log('\n== fence ==');
  const file = await validateSource('file:///etc/hostname', 'hls');
  truthy('file: is never read', !file.ok && file.checks[0]?.state === 'fail');
  const push = await validateSource('rtmp://ingest/live', 'rtmp');
  truthy('RTMP is a push note', !push.ok && push.kind === 'push');

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
