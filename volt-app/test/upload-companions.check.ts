// ============================================================================
//  COMPANIONS IN AN UPLOAD (services/ingest/companionMatch.ts), pinned. No
//  database: the library lookup is handed in.
//
//  Twelve Elephants Dream subtitle files dropped in the Media Library became
//  twelve "videos" queued to encode. They are companions of the video, found
//  by name like a watchfolder's, and their languages keep their region.
//
//  Usage: npx tsx test/upload-companions.check.ts
// ============================================================================
import { planCompanions, companionType } from '../src/services/ingest/companionMatch';
import { nameHints, languageName } from '../src/services/companions/formats';

let pass = 0, fail = 0;
const eq = (m: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('PASS ' + m); pass++; }
  else { console.log(`FAIL ${m} -- expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); fail++; }
};

// A library holding the video, an unrelated one, and a record the old
// behaviour made FROM a subtitle file (it must never be a match).
const LIB = [
  { id: 'ed', title: 'Elephants Dream', original_filename: 'Elephants_Dream.mp4', created_at: '2026-11-01' },
  { id: 'bad', title: 'Elephants Dream Zh', original_filename: 'Elephants_Dream_zh.vtt', created_at: '2026-11-08' },
  { id: 'bbb', title: 'Big Buck Bunny', original_filename: 'big_buck_bunny.mov', created_at: '2026-10-01' },
];
const lib = async (_a: string, stem: string) => LIB.filter((r) => stem.toLowerCase().startsWith(r.original_filename.replace(/\.[^.]+$/, '').toLowerCase()));

(async () => {
  console.log('== what is a companion ==');
  eq('vtt', companionType('a.vtt'), 'caption');
  eq('srt upper case', companionType('A.SRT'), 'caption');
  eq('nfo sidecar', companionType('movie.nfo'), 'sidecar');
  eq('mp4 is not', companionType('a.mp4'), null);

  console.log('== subtitles alone, video already in the library ==');
  const names = ['Elephants_Dream_zh.vtt', 'Elephants_Dream_zh_tw.vtt', 'Elephants_Dream_zh-Hant.srt', 'Elephants_Dream_ta.vtt'];
  const p1 = await planCompanions('acct', names.map((name) => ({ name, bytes: 2000 })), lib);
  eq('every one goes to the video, never to the zh record', p1.map((p) => p?.match && p.match.in === 'library' ? p.match.assetId : null), ['ed', 'ed', 'ed', 'ed']);

  console.log('== video and subtitles dropped together ==');
  const p2 = await planCompanions('acct', [
    { name: 'Show-e1.mp4' }, { name: 'Show-e10.mp4' }, { name: 'Show-e10_en.vtt' }, { name: 'Show-e1_fr.srt' }, { name: 'Elephants_Dream_vi.vtt' },
  ], lib);
  eq('videos are not companions', [p2[0], p2[1]], [null, null]);
  eq('e10 subtitles to e10, not e1', p2[2]?.match, { in: 'batch', index: 1, name: 'Show-e10.mp4' });
  eq('e1 subtitles to e1', p2[3]?.match, { in: 'batch', index: 0, name: 'Show-e1.mp4' });
  eq('a library video still matches in a mixed drop', p2[4]?.match && p2[4].match.in, 'library');

  console.log('== same name in the drop and the library: the drop wins ==');
  const p3 = await planCompanions('acct', [{ name: 'Elephants_Dream.mp4' }, { name: 'Elephants_Dream_en.vtt' }], lib);
  eq('the video being uploaded now', p3[1]?.match && p3[1].match.in, 'batch');

  console.log('== no match, too big ==');
  const p4 = await planCompanions('acct', [{ name: 'Sintel_en.vtt' }, { name: 'Elephants_Dream_en.vtt', bytes: 40 * 1024 * 1024 }], lib);
  eq('no video named like it', [p4[0]?.match, !!p4[0]?.why], [null, true]);
  eq('too big is never attached', [p4[1]?.tooBig, p4[1]?.match], [true, null]);

  console.log('== language from lower case names ==');
  eq('zh_tw', nameHints('Elephants_Dream_zh_tw.vtt').language, 'zh-TW');
  eq('zh-hant', nameHints('Elephants_Dream_zh-hant.vtt').language, 'zh-Hant');
  eq('zh_Hans', nameHints('Elephants_Dream_zh_Hans.vtt').language, 'zh-Hans');
  eq('zh_cn', nameHints('Elephants_Dream_zh_cn.vtt').language, 'zh-CN');
  eq('plain zh', nameHints('Elephants_Dream_zh.vtt').language, 'zh');
  eq('en_cc is a flag, not a region', nameHints('show_en_cc.srt'), { language: 'en', forced: false, sdh: true });
  eq('en_full is not a script', nameHints('show_en_full.srt').language, 'en');
  eq('Taiwan label', languageName('zh-TW'), 'Chinese (Taiwan)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
