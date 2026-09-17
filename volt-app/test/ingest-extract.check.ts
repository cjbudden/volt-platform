// Real files through extract(): needs ffmpeg/ffprobe. Files are made by the
// runner (see DOCS.md). Run after building to /tmp/ing:
//   node /tmp/ing/test/ingest-extract.check.js /tmp/ingx
import { extract, candidates } from '../src/services/ingest/metadata';
const dir = process.argv[2] || '/tmp/ingx';
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
