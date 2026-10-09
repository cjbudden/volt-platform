// ============================================================================
//  EXT-X-DATERANGE — VIDEO. Emitted, and emitted to spec.
//
//  This is the delivery-side metadata a PLAYER acts on: programme boundaries and
//  ad windows in the manifest. It is deliberately not the radio now-playing path,
//  which arrives as ICY on ingest and is handled elsewhere; the two were being
//  read as one requirement and that is how a video feature ends up with an audio
//  acceptance test.
//
//  WHAT GOES WRONG WITH A HAND-BUILT MANIFEST TAG, all of it silent:
//
//    A QUOTE IN A TITLE. The HLS attribute grammar has no escape sequence for a
//    double quote inside a quoted-string. A programme called `The "Real" Story`
//    emitted verbatim terminates the attribute early; strict players reject the
//    playlist and lenient ones mis-parse it into something else. It cannot be
//    escaped, so it has to be removed.
//
//    A TAG IN THE WRONG PLACE. DATERANGE is a Media Playlist tag and must sit in
//    the header. Written after an `#EXTINF` it lands inside a segment
//    declaration, which is a parse error rather than untidiness.
//
//    THE SAME TAG TWICE. A live player refetches the playlist every few seconds
//    and the control plane serves the same file each time. An injector that
//    appends rather than replaces produces two DATERANGEs sharing one ID, which
//    the spec forbids, and a renamed programme then appears under both names.
//
//    A WINDOW GUESSED FROM now(). A media playlist's only wall-clock anchor is
//    its PROGRAM-DATE-TIME. Without one, deriving the span from the current time
//    attaches tags to segments that are not in the playlist at all.
//
//  Usage: npx tsx test/timed-metadata.check.ts   (pure; no database, no ffmpeg)
// ============================================================================
import {
  quoted, dateRangeTag, playlistWindow, overlapping, injectDateRanges, annotatePlaylist,
  CLASS_PROGRAMME, CLASS_AD, type ProgrammeWindow,
} from '../src/services/timedMetadata';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);

const D = (s: string) => new Date(s);
const prog = (o: Partial<ProgrammeWindow> & { id: string; title: string; startsAt: Date }): ProgrammeWindow =>
  ({ endsAt: null, kind: 'content', ...o });

const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-PROGRAM-DATE-TIME:2026-09-05T14:00:00.000Z',
  '#EXTINF:4.000,',
  'seg_00100.m4s',
  '#EXTINF:4.000,',
  'seg_00101.m4s',
  '#EXTINF:4.000,',
  'seg_00102.m4s',
  '',
].join('\n');

// ---- quoting ---------------------------------------------------------------
console.log('== a value the grammar will accept, or nothing ==');
check('an ordinary title is quoted', quoted('Breakfast'), '"Breakfast"');
// THE ONE THAT BREAKS PLAYERS.
check('a double quote is removed, because the grammar cannot escape it',
  quoted('The "Real" Story'), '"The Real Story"');
check('and so are line breaks, which would end the tag',
  quoted('Two\nLines'), '"TwoLines"');
check('whitespace is trimmed', quoted('  padded  '), '"padded"');
check('an empty title is still a valid empty string', quoted(''), '""');

// ---- the tag ---------------------------------------------------------------
console.log('\n== the tag carries what the spec requires ==');
const t = dateRangeTag(prog({
  id: 'p-1', title: 'Newcastle Breakfast',
  startsAt: D('2026-09-05T14:00:00.000Z'), endsAt: D('2026-09-05T14:30:00.000Z'),
}));
check('it is a DATERANGE', t.startsWith('#EXT-X-DATERANGE:'), true);
check('ID is present and quoted', t.includes('ID="p-1"'), true);
check('START-DATE is ISO-8601 and quoted', t.includes('START-DATE="2026-09-05T14:00:00.000Z"'), true);
check('DURATION is a decimal-floating-point, unquoted', t.includes('DURATION=1800.000'), true);
check('CLASS uses reverse-DNS so it cannot collide', t.includes(`CLASS="${CLASS_PROGRAMME}"`), true);
// CLIENT ATTRIBUTES MUST BE X- PREFIXED. A bare TITLE= squats on a namespace the
// spec reserves for itself.
check('the title is an X- client attribute', t.includes('X-TITLE="Newcastle Breakfast"'), true);
check('and nothing unprefixed sneaks in', /,(?!ID=|CLASS=|START-DATE=|END-DATE=|DURATION=|PLANNED-DURATION=|X-)/.test(t), false);

console.log('\n== an ad is classed as an ad, not as programming ==');
const ad = dateRangeTag(prog({ id: 'a-9', title: 'Break', kind: 'ad', startsAt: D('2026-09-05T14:10:00.000Z'), endsAt: D('2026-09-05T14:12:00.000Z') }));
check('the CLASS differs', ad.includes(`CLASS="${CLASS_AD}"`), true);
check('which is what lets a player treat it differently', ad.includes('X-KIND="ad"'), true);

console.log('\n== an open-ended strand is not given an invented end ==');
const open = dateRangeTag(prog({ id: 'p-2', title: 'Overnights', startsAt: D('2026-09-05T02:00:00.000Z') }));
check('no DURATION', open.includes('DURATION='), false);
check('no END-DATE either', open.includes('END-DATE='), false);
check('but it still has a start', open.includes('START-DATE='), true);
// A zero or negative span is upstream data corruption; encoding it would put a
// nonsense duration in front of every player rather than leaving it out.
const zero = dateRangeTag(prog({ id: 'p-3', title: 'Glitch', startsAt: D('2026-09-05T03:00:00.000Z'), endsAt: D('2026-09-05T03:00:00.000Z') }));
check('a zero-length window emits no DURATION rather than DURATION=0', zero.includes('DURATION='), false);

// ---- the window ------------------------------------------------------------
console.log('\n== the window comes from the playlist, never from the clock ==');
const w = playlistWindow(PLAYLIST)!;
check('it starts at the PROGRAM-DATE-TIME', w.from.toISOString(), '2026-09-05T14:00:00.000Z');
check('and runs for the sum of the EXTINFs', w.to.toISOString(), '2026-09-05T14:00:12.000Z');
check('a playlist with no PDT has no window, so nothing is emitted',
  playlistWindow('#EXTM3U\n#EXTINF:4.000,\nseg.m4s\n'), null);

console.log('\n== only what the window covers ==');
const sched: ProgrammeWindow[] = [
  prog({ id: 'before', title: 'Earlier', startsAt: D('2026-09-05T13:00:00Z'), endsAt: D('2026-09-05T14:00:00Z') }),
  prog({ id: 'spans', title: 'Spanning', startsAt: D('2026-09-05T13:59:00Z'), endsAt: D('2026-09-05T14:05:00Z') }),
  prog({ id: 'inside', title: 'Inside', startsAt: D('2026-09-05T14:00:04Z'), endsAt: D('2026-09-05T14:00:08Z') }),
  prog({ id: 'after', title: 'Later', startsAt: D('2026-09-05T14:00:12Z'), endsAt: D('2026-09-05T15:00:00Z') }),
];
const hit = overlapping(sched, w.from, w.to).map((p) => p.id);
check('a programme ending exactly as the window opens is out', hit.includes('before'), false);
check('one starting exactly as it closes is out too', hit.includes('after'), false);
check('one spanning the edge is in', hit.includes('spans'), true);
check('one wholly inside is in', hit.includes('inside'), true);
check('and they come out in start order', hit.join(','), 'spans,inside');

// ---- injection -------------------------------------------------------------
console.log('\n== tags land in the header, never inside a segment ==');
const out = annotatePlaylist(PLAYLIST, sched);
const lines = out.split('\n');
const firstExtinf = lines.findIndex((l) => l.startsWith('#EXTINF:'));
const tagIdx = lines.map((l, i) => l.startsWith('#EXT-X-DATERANGE:') ? i : -1).filter((i) => i >= 0);
check('two tags were added', tagIdx.length, 2);
check('all of them before the first segment', tagIdx.every((i) => i < firstExtinf), true);
// A PDT immediately before the first EXTINF belongs to THAT segment; splitting
// them would attach the wrong wall-clock to the first segment.
const pdtIdx = lines.findIndex((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
check('and above the PROGRAM-DATE-TIME that belongs to the first segment',
  tagIdx.every((i) => i < pdtIdx), true);
check('the header is otherwise untouched', lines[0], '#EXTM3U');
check('and the segments are untouched', out.includes('seg_00101.m4s'), true);

console.log('\n== serving the same playlist twice does not double the tags ==');
const twice = annotatePlaylist(out, sched);
check('still two', (twice.match(/#EXT-X-DATERANGE:/g) ?? []).length, 2);
// A renamed programme has to CORRECT itself, not appear under both names.
const renamed = sched.map((p) => p.id === 'inside' ? { ...p, title: 'Renamed' } : p);
const after = annotatePlaylist(out, renamed);
check('a rename replaces rather than duplicates', (after.match(/#EXT-X-DATERANGE:/g) ?? []).length, 2);
check('the new title is there', after.includes('X-TITLE="Renamed"'), true);
check('and the old one is gone', after.includes('X-TITLE="Inside"'), false);

console.log('\n== nothing to say means nothing is added ==');
check('an empty schedule leaves the playlist alone',
  annotatePlaylist(PLAYLIST, []).replace(/\n$/, ''), PLAYLIST.replace(/\n$/, ''));
check('and a playlist with no PDT is returned untouched',
  annotatePlaylist('#EXTM3U\n#EXTINF:4.000,\nseg.m4s', sched), '#EXTM3U\n#EXTINF:4.000,\nseg.m4s');

console.log(`\ntimed-metadata: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
