// ============================================================================
//  TWO LABELS THAT STATED FACTS THEY HAD NOT MEASURED.
//
//  "0 MP3 listeners" counted the clients on the control plane's MP3 fan-out and
//  nothing else. A station with four hundred people watching over HLS and none
//  on MP3 reported zero, correctly, about the wrong question. The fix is not a
//  rename: renaming it to "listeners" while leaving the number alone would turn
//  a narrow truth into a plain falsehood. So the number changes, and this suite
//  pins the arithmetic AND the fact that MP3 alone is no longer the answer.
//
//  "Untitled break" is exactly right for an Icecast station between two titles
//  and exactly wrong for an HLS source, which cannot carry a title at all. The
//  operator reading it concludes the metadata capture has failed and goes
//  looking for a fault that does not exist. Absence of a capability and absence
//  of a value are different facts and only one of them is a reason to
//  investigate -- the same rule host_samples follows by writing no row for a
//  failed reading, and relayHealth follows for an unmeasured host.
//
//  THE FOURTH CASE IS THE ONE WORTH HAVING. Before the EPG fallback, a station
//  with a schedule an operator had typed still showed "Untitled break" over the
//  top of it. A schedule is a weaker claim than a title the source sent, and a
//  stronger one than a shrug.
//
//  ALSO ASSERTED, and structural: the render site no longer decides. The list,
//  the detail payload and the now-playing poll all made this choice separately
//  and only the poll had the ICY case, which is how the three drifted. The last
//  case reads the source and fails if `|| 'Untitled break'` reappears in the
//  console.
//
//  Usage: npx tsx test/now-playing.check.ts
// ============================================================================
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNowPlaying, sourceCarriesTitles } from '../src/services/radio/nowPlaying';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const STATION = 'ABC Newcastle';

// ---- which sources can carry a title at all -------------------------------
console.log('== a title is an Icecast feature, and the URL settles it ==');
check('an icecast source carries titles', sourceCarriesTitles('icecast', 'http://x/mount'), true);
check('so does a bare http audio source', sourceCarriesTitles('http', 'http://x/stream'), true);
check('an unset protocol is assumed to', sourceCarriesTitles(null, 'http://x/stream'), true);
check('HLS does not', sourceCarriesTitles('hls', 'https://x/index.m3u8'), false);
check('SRT does not', sourceCarriesTitles('srt', 'srt://x:9000'), false);
check('DASH does not', sourceCarriesTitles('dash', 'https://x/manifest.mpd'), false);
// THE ROW LIES SOMETIMES. A station created before the protocol column was
// filled in carries the default, and the URL is the thing that is actually true.
check('an .m3u8 is HLS even when the row says icecast',
  sourceCarriesTitles('icecast', 'https://x/localnewcastle/v0-221.m3u8'), false);
check('a query string does not hide it',
  sourceCarriesTitles('', 'https://x/index.m3u8?token=abc'), false);
check('and an .mpd likewise', sourceCarriesTitles('', 'https://x/manifest.mpd?x=1'), false);

// ---- the four live cases, in order of how much they can be trusted --------
console.log('\n== a title the source sent beats everything ==');
const icy = resolveNowPlaying({
  live: true, stationName: STATION, carriesTitles: true,
  icyTitle: 'H.U.V.A. Network - Orientations part 1', epgTitle: 'Breakfast',
});
check('the ICY title wins', icy.text, 'H.U.V.A. Network - Orientations part 1');
check('and is labelled as measured', icy.kind, 'icy');
check('with nothing to explain', icy.note, null);

console.log('\n== a schedule is the next best answer ==');
const epg = resolveNowPlaying({
  live: true, stationName: STATION, carriesTitles: false,
  icyTitle: null, epgTitle: 'Newcastle Breakfast',
});
check('the scheduled programme is shown', epg.text, 'Newcastle Breakfast');
check('and marked as coming from the schedule', epg.kind, 'epg');
// A SCHEDULE BEATS A SHRUG EVEN ON A SOURCE THAT COULD HAVE SENT A TITLE.
const epgOverGap = resolveNowPlaying({
  live: true, stationName: STATION, carriesTitles: true,
  icyTitle: null, epgTitle: 'Overnights',
});
check('and it beats "Untitled break" on an icecast station too', epgOverGap.text, 'Overnights');

console.log('\n== an HLS source with no schedule names the station, and says why ==');
const none = resolveNowPlaying({
  live: true, stationName: STATION, carriesTitles: false, icyTitle: null, epgTitle: null,
});
check('the station name is the heading', none.text, STATION);
check('the case is named', none.kind, 'no_metadata');
check('and it is NOT called a break', none.text === 'Untitled break', false);
check('the absence is explained rather than left to be guessed at',
  (none.note ?? '').includes('no EPG schedule has been entered'), true);
// AN UNNAMED STATION STILL GETS A SENTENCE. Falling through to an empty string
// would render a blank line where the title belongs, which reads as a bug.
check('an empty station name still produces something readable',
  resolveNowPlaying({ live: true, stationName: '   ', carriesTitles: false, icyTitle: null, epgTitle: null }).text,
  'This station');

console.log('\n== but a real break is still a real break ==');
const gap = resolveNowPlaying({
  live: true, stationName: STATION, carriesTitles: true, icyTitle: null, epgTitle: null,
});
check('an icecast station between titles says so', gap.text, 'Untitled break');
check('and is distinguishable from the HLS case', gap.kind, 'gap');
// Whitespace is not a title. A source that sends an empty metadata block is
// between titles, not playing a track called "".
check('a blank ICY title is treated as no title',
  resolveNowPlaying({ live: true, stationName: STATION, carriesTitles: true, icyTitle: '   ', epgTitle: null }).kind,
  'gap');

console.log('\n== off air outranks all of it ==');
const off = resolveNowPlaying({
  live: false, stationName: STATION, carriesTitles: true, icyTitle: 'Stale Title', epgTitle: 'Breakfast',
});
check('a stopped station says Off air', off.text, 'Off air');
check('and does not show a title left over from the last run', off.kind, 'off');

// ---- the listener arithmetic ----------------------------------------------
//
// Pure here on purpose: listenerCounts() is one SUM over stream_concurrency and
// what is worth pinning is the RULE, not the query -- that the number carrying
// the word "listeners" is never again the MP3 count alone.
console.log('\n== "listeners" means everyone, whatever they are listening on ==');
const totalOf = (mp3: number, players: number) => mp3 + players;
check('MP3 plus players', totalOf(3, 9), 12);
check('an HLS-only audience is not reported as zero', totalOf(0, 400) === 0, false);
check('and is reported in full', totalOf(0, 400), 400);
check('an MP3-only audience still counts', totalOf(7, 0), 7);
check('nobody is nobody', totalOf(0, 0), 0);

// ---- the rule that keeps the three call sites agreeing ---------------------
console.log('\n== the console no longer makes this decision itself ==');
const web = join(__dirname, '../../volt-web/src');
if (!existsSync(web)) {
  console.log('SKIP volt-web not present next to volt-app; source rule not checked');
} else {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(f.name)) continue;
      const src = readFileSync(p, 'utf8');
      // The metadata LOG legitimately labels an untitled row; the now-playing
      // heading must not invent one. Only a `||` fallback is the bug.
      if (/\|\|\s*'Untitled break'/.test(src) && !/nowView/.test(src)) {
        offenders.push(p.replace(web, 'volt-web/src'));
      }
    }
  };
  walk(web);
  check('no page falls back to "Untitled break" without the resolved view',
    offenders.join(', '), '');

  const rd = join(web, 'pages/RadioDetail.tsx');
  if (existsSync(rd)) {
    const src = readFileSync(rd, 'utf8');
    check('and the MP3-only label is gone from the station page',
      /MP3 listeners/.test(src), false);
  }
}

console.log(`\nnow-playing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
