// ============================================================================
//  SKIP MARKERS (services/vodMarkers.ts, services/introDetect.ts).
//
//    1. Detection on REAL audio: three episodes built with ffmpeg that share a
//       40 s theme at different points (one copy re-encoded louder as MP3), with
//       different programme audio around it. Each episode's intro must come out
//       within 0.5 s of where the theme really is, and two unrelated
//       programmes must share nothing.
//    2. The playlists a player gets: HLS DATERANGE + the PDT it needs, DASH
//       EventStream, idempotent, suggestions left out, masters untouched.
//    3. Which episodes count as one series.
//
//  Usage: npx tsx test/vod-markers.check.ts   (ffmpeg on PATH; no database)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, detectAcross, fingerprint } from '../src/services/introDetect';
import { annotateHls, annotateMpd, anchorFor, assetIdFromClipsPath, seriesTitle, VOD_EPOCH_MS, type VodMarker } from '../src/services/vodMarkers';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const near = (m: string, got: number | undefined, want: number, tol = 0.5) =>
  got != null && Math.abs(got - want) <= tol ? ok(`${m} (${got.toFixed(2)})`) : bad(m, `expected ${want} ± ${tol}, got ${got}`);

async function main() {
  console.log('== 1. detection on real audio ==');
  const d = mkdtempSync(join(tmpdir(), 'vodmk-'));
  const ff = (...a: string[]) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...a]);
  try {
    ff('-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*(220+110*floor(mod(t*2\\,8)))*t)+0.2*sin(2*PI*(330+55*floor(mod(t*1.5\\,6)))*t)+0.15*sin(2*PI*82*t)*lt(mod(t\\,0.5)\\,0.08)':s=22050:d=40", '-ac', '1', join(d, 'theme.wav'));
    const bed = (name: string, f: number, rate: number, dur: number, seed: number) => ff(
      '-f', 'lavfi', '-i', `aevalsrc='0.25*sin(2*PI*(${f}+70*floor(mod(t*${rate}\\,9)))*t)':s=22050:d=${dur}`,
      '-f', 'lavfi', '-i', `anoisesrc=color=brown:amplitude=0.05:sample_rate=22050:d=${dur}:seed=${seed}`,
      '-filter_complex', 'amix=inputs=2', '-ac', '1', join(d, name));
    bed('a1.wav', 300, 3.1, 20, 1); bed('a2.wav', 180, 2.3, 90, 2);
    bed('b1.wav', 410, 1.7, 55, 3); bed('b2.wav', 260, 2.9, 90, 4);
    bed('c1.wav', 150, 4.2, 8, 5); bed('c2.wav', 500, 1.3, 90, 6);
    bed('x.wav', 333, 2.2, 150, 7); bed('y.wav', 222, 3.3, 150, 8);
    ff('-i', join(d, 'theme.wav'), '-af', 'volume=1.6,aresample=44100', '-c:a', 'libmp3lame', '-b:a', '96k', join(d, 'theme_c.mp3'));
    const ep = (out: string, parts: string[]) => {
      const inputs = parts.flatMap((p) => ['-i', join(d, p)]);
      ff(...inputs, '-filter_complex', `${parts.map((_, i) => `[${i}:a]aresample=22050,aformat=channel_layouts=mono[a${i}]`).join(';')};${parts.map((_, i) => `[a${i}]`).join('')}concat=n=${parts.length}:v=0:a=1`, '-c:a', 'aac', '-b:a', '128k', join(d, out));
    };
    ep('A.m4a', ['a1.wav', 'theme.wav', 'a2.wav']);      // theme 20-60
    ep('B.m4a', ['b1.wav', 'theme.wav', 'b2.wav']);      // theme 55-95
    ep('C.m4a', ['c1.wav', 'theme_c.mp3', 'c2.wav']);    // theme 8-48, louder, via MP3
    ep('X.m4a', ['x.wav']); ep('Y.m4a', ['y.wav']);       // unrelated programmes

    const fp = Object.fromEntries(await Promise.all(['A', 'B', 'C', 'X', 'Y'].map(async (k) => [k, await fingerprint(join(d, `${k}.m4a`), 0, 600)] as const)));
    const res = detectAcross(['A', 'B', 'C'].map((id) => ({ id, fp: fp[id] })), { minSec: 10, maxSec: 150 });
    const by = Object.fromEntries(res.map((r) => [r.id, r]));
    near('A intro starts at 20 s', by.A.interval?.start, 20); near('A intro ends at 60 s', by.A.interval?.end, 60);
    near('B intro starts at 55 s', by.B.interval?.start, 55); near('B intro ends at 95 s', by.B.interval?.end, 95);
    near('C (a louder MP3 copy) starts at 8 s', by.C.interval?.start, 8); near('C ends at 48 s', by.C.interval?.end, 48);
    check('every episode agrees with every other', res.map((r) => r.confidence), [1, 1, 1]);
    check('two unrelated programmes share nothing', compare(fp.X, fp.Y, { minSec: 10, maxSec: 150 }), null);
    check('an episode and an unrelated programme share nothing', compare(fp.A, fp.X, { minSec: 10, maxSec: 150 }), null);
    // the credits window: the same comparison on an offset window places it in the asset's own time
    const tail = detectAcross([{ id: 'A', fp: await fingerprint(join(d, 'A.m4a'), 10, 80), offsetSec: 10 }, { id: 'B', fp: fp.B }], { minSec: 10, maxSec: 150 });
    near('a window starting later reports asset time, not window time', tail[0].interval?.start, 20);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }

  console.log('\n== 2. the playlists ==');
  const id = '33f9735e-7663-4cc9-801f-434767863959';
  const mk = (kind: VodMarker['kind'], s: number, e: number, status: VodMarker['status'] = 'active'): VodMarker =>
    ({ kind, startMs: s, endMs: e, source: 'auto', status, confidence: 1, detail: {}, updatedAt: '' });
  const media = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000000,\nseg_00000.m4s\n#EXTINF:4.000000,\nseg_00001.m4s\n#EXT-X-ENDLIST\n';
  const anchor = Date.UTC(2026, 9, 20, 8, 0, 0);
  const out = annotateHls(media, [mk('intro', 55066, 94942), mk('credits', 200000, 215000, 'suggested')], anchor, id);
  const lines = out.split('\n');
  const dr = lines.filter((l) => l.startsWith('#EXT-X-DATERANGE:'));
  check('one DATERANGE: the suggestion is not in the output', dr.length, 1);
  check('its class', /CLASS="com\.boomlabs\.volt\.skip"/.test(dr[0]), true);
  check('it starts 55.066 s after the anchor', /START-DATE="2026-10-20T08:00:55\.066Z"/.test(dr[0]), true);
  check('and lasts 39.876 s', /DURATION=39\.876/.test(dr[0]), true);
  check('the player is told what it is and where to go', [/X-GRAPHIC="skip-intro"/.test(dr[0]), /X-TO="94\.942"/.test(dr[0])], [true, true]);
  check('a PROGRAM-DATE-TIME at the anchor, right before the first segment', lines[lines.indexOf('#EXTINF:4.000000,') - 1], '#EXT-X-PROGRAM-DATE-TIME:2026-10-20T08:00:00.000Z');
  check('the DATERANGE is in the header, before it', lines.indexOf(dr[0]) < lines.indexOf('#EXTINF:4.000000,'), true);
  check('every segment is still there', lines.filter((l) => l.endsWith('.m4s')).length, 2);
  check('annotating twice changes nothing (the old lines go first)', annotateHls(out, [mk('intro', 55066, 94942), mk('credits', 200000, 215000, 'suggested')], anchor, id), out);
  const moved = annotateHls(out, [mk('intro', 62000, 94942)], anchor, id);
  check('a moved marker replaces the old one', moved.split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE:')).length, 1);
  check('at its new start', /START-DATE="2026-10-20T08:01:02\.000Z"/.test(moved), true);
  check('no markers: the playlist as built (no PDT added)', annotateHls(media, [], anchor, id), media);
  const withPdt = media.replace('#EXTINF:4.000000,\nseg_00000', '#EXT-X-PROGRAM-DATE-TIME:2026-10-20T08:00:00.000Z\n#EXTINF:4.000000,\nseg_00000');
  check('a playlist that has PDT keeps its own', annotateHls(withPdt, [mk('intro', 1000, 5000)], anchor, id).split('#EXT-X-PROGRAM-DATE-TIME').length - 1, 1);
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nstream_0.m3u8\n';
  check('a master is untouched', annotateHls(master, [mk('intro', 1000, 5000)], anchor, id), master);
  check('an asset with a recording time is anchored there', anchorFor({ start_epoch_ms: 1792400000000 }), 1792400000000);
  check('one without is anchored at the fixed epoch', anchorFor({ start_epoch_ms: 0 }), VOD_EPOCH_MS);

  const mpd = '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT215S"><Period id="0" start="PT0S"><AdaptationSet/></Period></MPD>';
  const m1 = annotateMpd(mpd, [mk('intro', 55066, 94942), mk('recap', 1000, 9000, 'suggested')], id);
  check('DASH: one EventStream in the Period', (m1.match(/<EventStream /g) ?? []).length, 1);
  check('with the intro at 55066 ms for 39876 ms', /presentationTime="55066" duration="39876"/.test(m1), true);
  check('the payload names the graphic (escaped JSON)', /messageData="\{&quot;graphic&quot;:&quot;skip-intro&quot;/.test(m1), true);
  check('DASH: annotating again replaces it', (annotateMpd(m1, [mk('intro', 1000, 5000)], id).match(/<EventStream /g) ?? []).length, 1);
  const two = '<MPD><Period id="0" start="PT0S"></Period><Period id="1" start="PT100S"></Period></MPD>';
  const m2 = annotateMpd(two, [mk('credits', 150000, 170000)], id);
  check('a marker in the second Period is timed from that Period', /<Period id="1" start="PT100S"><EventStream[^>]*><Event id="3" presentationTime="50000" duration="20000"/.test(m2), true);

  check('/clips/<id>/hls/index.m3u8 belongs to <id>', assetIdFromClipsPath(`/${id}/hls/index.m3u8`), id);
  check('/clips/vod/<id>/stream_0.m3u8 too', assetIdFromClipsPath(`/vod/${id}/stream_0.m3u8`), id);
  check('anything else belongs to nobody', assetIdFromClipsPath('/filler/x.m3u8'), null);

  console.log('\n== 3. which episodes are one series ==');
  check('S01E05', seriesTitle('Sorotan S01E05'), 'sorotan');
  check('Episode 12', seriesTitle('The Interview - Episode 12'), 'the interview');
  check('a date', seriesTitle('Berita Utama 20 Oct 2026'), 'berita utama');
  check('Edisi 04:55', seriesTitle('Hiburan Edisi 04:55'), 'hiburan');
  check('a trailing number', seriesTitle('Sports Tonight 3'), 'sports tonight');
  check('accents and case', seriesTitle('Café Société S2E1'), 'cafe societe');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
