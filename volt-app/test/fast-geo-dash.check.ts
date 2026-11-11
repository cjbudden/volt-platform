// ============================================================================
//  FAST GEO REPLACEMENT, DASH (services/variantManifest.ts renderVariantMpd
//  on a FAST playout MPD: one Period per part, a SegmentTemplate with a
//  SegmentTimeline per Representation, the titles' own absolute addresses).
//
//  The window covers the restricted programme (the first Period and the last
//  minute of it): its Period is cut at the window start, the replacement's
//  passes fill the window as Periods of their own, and the next programme's
//  Period is untouched. Stable across reloads (Period ids from the window).
//    npx tsx test/fast-geo-dash.check.ts      (no database needed)
// ============================================================================
let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected ${w} got ${g}`); fail++ }
};

/** Segments listed for the first (video) Representation of a Period's XML. */
const videoSegs = (periodXml: string) => {
  const tl = periodXml.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/)?.[1] ?? '';
  return [...tl.matchAll(/<S\b[^>]*>/g)].reduce((n, m) => n + 1 + Number(m[0].match(/\br="(\d+)"/)?.[1] ?? 0), 0);
};

(async () => {
  const vm = await import('../src/services/variantManifest');
  const AST = Date.UTC(2027, 0, 1, 0, 0, 0) / 1000;
  const iso = (s: number) => new Date(s * 1000).toISOString();
  // fast_playout.py's shape: Period start relative to the AST, pto = the part's first media time
  const tpl = (asset: string, rend: string, ts: number, pto: number, start: number, n: number, d: number) =>
    `<SegmentTemplate timescale="${ts}" presentationTimeOffset="${pto}" initialization="/clips/vod/${asset}/${rend}/init.mp4" media="/clips/vod/${asset}/${rend}/seg_$Number$.m4s" startNumber="${start}">` +
    `<SegmentTimeline><S t="${pto}" d="${d}" r="${n - 1}"/></SegmentTimeline></SegmentTemplate>`;
  const period = (id: string, startSec: number, asset: string, firstNum: number, n: number) =>
    `<Period id="${id}" start="PT${startSec.toFixed(3)}S">` +
    `<AdaptationSet id="0" contentType="video" segmentAlignment="true" startWithSAP="1"><Representation id="v720" bandwidth="3000000" codecs="avc1.64001f" mimeType="video/mp4" width="1280" height="720">${tpl(asset, '720p', 90000, (firstNum - 1) * 540000, firstNum, n, 540000)}</Representation></AdaptationSet>` +
    `<AdaptationSet id="1" contentType="audio" segmentAlignment="true" startWithSAP="1"><Representation id="audio" bandwidth="128000" codecs="mp4a.40.2" mimeType="audio/mp4" audioSamplingRate="48000">${tpl(asset, 'audio', 48000, (firstNum - 1) * 288000, firstNum, n, 288000)}</Representation></AdaptationSet>` +
    `</Period>`;
  // Programme A (restricted) from AST+0 for 10 x 6 s = 60 s, its segments 591..600 (the end of the film);
  // programme B (open) from AST+60 for 10 x 6 s.
  const T1 = AST, T2 = AST + 60;
  const mpd = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="dynamic" availabilityStartTime="${iso(AST)}" publishTime="${iso(AST + 120)}" minimumUpdatePeriod="PT6S" timeShiftBufferDepth="PT300S" minBufferTime="PT6S">` +
    period('A:0', 0, 'A', 591, 10) + period('B:0', 60, 'B', 1, 10) + `</MPD>\n`;
  const loopTrack = (rend: string) => ({ kind: rend === 'audio' ? 'audio' : 'video', init: `/clips/vod/G/ladders/g/6s-loud/${rend}/init.mp4`, segments: Array.from({ length: 4 }, (_, k) => ({ uri: `/clips/vod/G/ladders/g/6s-loud/${rend}/seg_${k + 1}.m4s`, dur: 6 })) });
  const loop = { segmentSeconds: 6, base: '', tracks: { '720p': loopTrack('720p'), audio: loopTrack('audio') } };
  const TL: any = [[T1, T2, 'G']];
  const out = vm.renderVariantMpd(mpd, { timeline: TL, loop, base: '/origin/F/fast/', key: 'vabc12345' });
  const periods = [...out.matchAll(/<Period\b[^>]*>/g)].map((m) => [m[0].match(/id="([^"]+)"/)![1], m[0].match(/start="([^"]+)"/)![1]]);
  check('the restricted programme\'s Period is gone, three passes of the 24 s replacement fill its 60 s, programme B follows',
    periods.map((p) => p[0].startsWith('vabc12345') ? 'loop' : p[0]), ['loop', 'loop', 'loop', 'B:0']);
  check('...the passes start at 0, 24 and 48 s', periods.slice(0, 3).map((p) => p[1]), ['PT0.000S', 'PT24.000S', 'PT48.000S']);
  check('...each pass plays the replacement\'s own init and segments', [out.includes('initialization="/clips/vod/G/ladders/g/6s-loud/720p/init.mp4"'), out.includes('/clips/vod/G/ladders/g/6s-loud/audio/init.mp4'), out.includes('/clips/vod/A/')], [true, true, false]);
  const lastPass = out.split('<Period').filter((x) => x.includes('vabc12345'))[2];
  check('...the last pass is cut at the window end (2 of its 4 segments)', videoSegs(lastPass), 2);
  check('...programme B is as delivered', out.includes(period('B:0', 60, 'B', 1, 10).slice(0, 60)), true);
  const again = vm.renderVariantMpd(mpd, { timeline: TL, loop, base: '/origin/F/fast/', key: 'vabc12345' });
  check('the same answer on every reload (stable Period ids)', again, out);
  const none = vm.renderVariantMpd(mpd, { timeline: [], loop: null, base: '/origin/F/fast/', key: 'v00000000' });
  check('no window: the programmes as delivered', [...none.matchAll(/<Period\b[^>]*id="([^"]+)"/g)].map((m) => m[1]), ['A:0', 'B:0']);
  // the window starting part way into a programme (a rights window ending mid-programme)
  const mid = vm.renderVariantMpd(mpd, { timeline: [[T1 + 30, T2, 'G']] as any, loop, base: '/origin/F/fast/', key: 'vabc12345' });
  const midP = [...mid.matchAll(/<Period\b[^>]*>/g)].map((m) => m[0]);
  check('a window from 30 s: A keeps its first 30 s (5 segments), the replacement from 30 s, then B',
    [midP.length, videoSegs(mid.split('<Period')[1]), /start="PT30.000S"/.test(midP[1])], [4, 5, true]);
  check('...A\'s cut keeps its own numbering and media time', [/startNumber="591"/.test(mid.split('<Period')[1]), /presentationTimeOffset="318600000"/.test(mid.split('<Period')[1])], [true, true]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
