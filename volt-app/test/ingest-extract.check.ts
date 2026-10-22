// Real files through extract(): needs ffmpeg/ffprobe.
//   npx tsx test/ingest-extract.check.ts [dir]
// The suite makes its three files itself when they are not in the folder. It
// used to expect someone to have made them by hand in /tmp/ingx, so on a clean
// machine it failed on a missing file and said nothing about the extractor.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extract, candidates } from '../src/services/ingest/metadata';
const dir = process.argv[2] || join(tmpdir(), 'volt-ingest-extract');
function ff(args: string[]) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) console.log('ffmpeg: ' + (r.stderr || r.error));
}
if (!existsSync(`${dir}/song.mp3`) || !existsSync(`${dir}/clip.mov`) || !existsSync(`${dir}/wrongext.mp3`)) {
  mkdirSync(dir, { recursive: true });
  // 2 s of tone with real ID3v2 tags, written by ffmpeg's own muxer.
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k',
    '-id3v2_version', '3', '-metadata', 'title=Blue Train', '-metadata', 'artist=John Coltrane',
    '-metadata', 'genre=Jazz', '-metadata', 'track=1/5', join(dir, 'song.mp3')]);
  // 640x360 at 25 fps with AAC audio in a QuickTime container.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'clip.mov')]);
  // The same MOV under a .mp3 name: the sniffer must believe the bytes, not the name.
  copyFileSync(join(dir, 'clip.mov'), join(dir, 'wrongext.mp3'));
}
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };
(async () => {
  const s = await extract(`${dir}/song.mp3`, { originalName: 'song.mp3', bytes: 1 });
  check('mp3 with id3 is audio/mpeg', [s.type.mime, s.type.kind, s.type.id3Bytes > 0], ['audio/mpeg', 'audio', true]);
  check('id3 read from a real ffmpeg tag', [s.id3?.title, s.id3?.artist, s.id3?.genre, s.id3?.track], ['Blue Train', 'John Coltrane', 'Jazz', '1/5']);
  check('probe duration about 2 s', Math.round(s.probe?.durationSec ?? 0), 2);
  const c = candidates(s);
  check('candidates prefer id3', [c.name, c.performer, c.durationSec != null], ['Blue Train', 'John Coltrane', true]);
  const v = await extract(`${dir}/clip.mov`, { originalName: 'clip.mov', bytes: 1 }, 'video/quicktime');
  check('mov sniffed', [v.type.container, v.type.kind, v.type.extensionMismatch], ['quicktime', 'video', false]);
  check('probe video and audio', [v.probe?.video?.width, v.probe?.video?.height, v.probe?.video?.fps, v.probe?.audio?.codec], [640, 360, 25, 'aac']);
  const w = await extract(`${dir}/wrongext.mp3`, { originalName: 'wrongext.mp3', bytes: 1 }, 'audio/mpeg');
  check('a .mp3 that is a MOV is recorded as video with a mismatch', [w.type.kind, w.type.container, w.type.extensionMismatch], ['video', 'quicktime', true]);
  console.log(`ingest-extract: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
