/**
 * FAST ads: SCTE-35 bytes, VAST parsing and wrapper chains, break fill with
 * fallback to house ads, and per-session HLS stitching played through a
 * sliding live window. Pure, no database.
 * Run: npx tsx test/fast-ads.check.ts
 */
import { spliceInsert, toBase64, toHex, decode, crc32mpeg, eventIdFor } from '../src/services/fast/scte35';
import { parseVast, resolve, expandTag, parseDuration, errorUrl, bestSource, type Fetcher } from '../src/services/fast/vast';
import { fillBreak, houseFill } from '../src/services/fast/pod';
import { stitchHls, parsePlaylist, CLASS_AD_BREAK, type SessionState, type PodRendition } from '../src/services/fast/stitch';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => (c ? (pass++, console.log('PASS ' + m)) : (fail++, console.log('FAIL ' + m)));

(async () => {
// ---- SCTE-35 ----------------------------------------------------------------
// Vectors checked against an independent decoder (threefive 3.1.3, 20 Oct 2026):
// out = splice_insert event 1234, pts 10.0s, break 120s auto-return, upid 7, avail 1/1;
// in  = splice_insert event 1234, pts 130.0s, back to network.
const out = spliceInsert({ eventId: 1234, out: true, pts: 900000, durationSec: 120, uniqueProgramId: 7, availNum: 1, availsExpected: 1 });
const inn = spliceInsert({ eventId: 1234, out: false, pts: 900000 + 120 * 90000 });
ok(toBase64(out) === '/DAlAAAAAAAAAP/wFAUAAATSf+/+AA27oP4ApMuAAAcBAQAAF6HMEA==', 'cue out bytes match the reference vector');
ok(toBase64(inn) === '/DAgAAAAAAAAAP/wDwUAAATSf0/+ALKHIAAAAAAAADailU0=', 'cue in bytes match the reference vector');
ok(crc32mpeg(out) === 0 && crc32mpeg(inn) === 0, 'CRC-32/MPEG over section + CRC is zero');
const d = decode(toHex(out));
ok(d.command === 'splice_insert' && d.out === true && d.durationSec === 120 && d.pts === 900000 && d.eventId === 1234 && d.crcOk, 'decodes back (hex)');
const di = decode(toBase64(inn));
ok(di.out === false && di.pts === 900000 + 120 * 90000 && di.durationSec == null, 'cue in decodes back (base64)');
ok(spliceInsert({ eventId: 1, out: true, pts: 2 ** 33 + 5, durationSec: 30 }).length > 0 && decode(spliceInsert({ eventId: 1, out: true, pts: 2 ** 33 + 5, durationSec: 30 })).pts === 5, 'PTS wraps at 2^33');
ok(eventIdFor('brk-1') === eventIdFor('brk-1') && eventIdFor('brk-1') !== eventIdFor('brk-2'), 'stable event ids per break');
let threw = false; try { decode('0x00'); } catch { threw = true; }
ok(threw, 'non-SCTE bytes are refused');

// ---- VAST -------------------------------------------------------------------
const inline = (id: string, seq: number | null, dur: string, uai: string, extra = '') => `
  <Ad id="${id}"${seq != null ? ` sequence="${seq}"` : ''}><InLine><AdSystem>GAM</AdSystem><AdTitle>${id} &amp; co</AdTitle>
    <Impression><![CDATA[https://ads.example/imp?id=${id}]]></Impression>
    <Error>https://ads.example/err?c=[ERRORCODE]</Error>
    <Creatives><Creative id="c-${id}" adId="AD-${id}"><UniversalAdId idRegistry="ad-id.org">${uai}</UniversalAdId><Linear>
      <Duration>${dur}</Duration>
      <TrackingEvents>
        <Tracking event="start">https://ads.example/start?id=${id}</Tracking>
        <Tracking event="firstQuartile">https://ads.example/q1?id=${id}</Tracking>
        <Tracking event="complete">https://ads.example/done?id=${id}</Tracking>
      </TrackingEvents>
      <VideoClicks><ClickThrough>https://brand.example</ClickThrough></VideoClicks>
      <MediaFiles>
        <MediaFile delivery="progressive" type="video/mp4" width="640" height="360" bitrate="800">https://cdn.example/${id}-360.mp4</MediaFile>
        <MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080" bitrate="6000">https://cdn.example/${id}-1080.mp4</MediaFile>
        ${extra}
      </MediaFiles>
    </Linear></Creative></Creatives></InLine></Ad>`;
const vast = (body: string, v = '4.2') => `<?xml version="1.0"?><VAST version="${v}">${body}</VAST>`;

const doc = parseVast(vast(inline('a1', 1, '00:00:15', 'UAI-1') + inline('a2', 2, '00:00:30.000', 'UAI-2') + inline('b1', null, '15', 'UAI-3')));
ok(doc.version === '4.2' && doc.ads.length === 3, 'three ads parsed');
ok(doc.ads[0].durationSec === 15 && doc.ads[1].durationSec === 30 && doc.ads[2].sequence === null, 'durations and buffet ad');
ok(doc.ads[0].creativeKey === 'ad-id.org:UAI-1', 'creative key from UniversalAdId');
ok(doc.ads[0].impressions[0] === 'https://ads.example/imp?id=a1' && doc.ads[0].tracking.firstQuartile.length === 1, 'impressions (CDATA) and trackers');
ok(doc.ads[0].title === 'a1 & co', 'entities decoded');
ok(bestSource(doc.ads[0]) === 'https://cdn.example/a1-1080.mp4', 'conditioning source: the largest MP4');
ok(bestSource(parseVast(vast(inline('m', 1, '10', 'U', '<Mezzanine delivery="progressive" type="video/mp4">https://cdn.example/mezz.mov</Mezzanine>'))).ads[0]) === 'https://cdn.example/mezz.mov', 'conditioning source: the Mezzanine when present');
ok(parseDuration('00:01:02.5') === 62.5 && parseDuration('') === 0 && parseDuration('bad') === 0, 'durations');
ok(errorUrl('https://x/e?c=[ERRORCODE]', 301) === 'https://x/e?c=301', 'error pixel code');

const tag = expandTag('https://pubads.example/gampad/ads?iu=/1/fast&ciu_szs=&pod=[POD_INDEX]&pmxd=[BREAK_DURATION_MS]&ip=[IP]&ua={user_agent}&vid=[CONTENT_ID]&x=[UNKNOWN_VENDOR]&c=[CACHEBUSTING]', {
  sessionId: 's1', breakId: 'b1', breakIndex: 3, durationSec: 120, channelId: 'ch', contentId: 'film 1', ip: '1.2.3.4', userAgent: 'Mozilla/5.0 (X)', cacheBuster: '42',
});
ok(tag.includes('pod=3') && tag.includes('pmxd=120000') && tag.includes('ip=1.2.3.4') && tag.includes('ua=Mozilla%2F5.0%20(X)') && tag.includes('vid=film%201'), 'macros filled and encoded');
ok(tag.includes('x=[UNKNOWN_VENDOR]') && tag.includes('c=42'), 'unknown vendor macros survive; cache buster');

// wrappers: tag -> wrapper -> wrapper -> inline, trackers merged
const responses: Record<string, string> = {
  'https://ads/tag': vast(`<Ad id="w1" sequence="1"><Wrapper><AdSystem>SSP</AdSystem><VASTAdTagURI>https://ads/w2</VASTAdTagURI><Impression>https://ssp/imp</Impression><Creatives><Creative><Linear><TrackingEvents><Tracking event="complete">https://ssp/done</Tracking></TrackingEvents></Linear></Creative></Creatives></Wrapper></Ad>` + inline('direct', 2, '00:00:30', 'UAI-D')),
  'https://ads/w2': vast(`<Ad id="w2"><Wrapper><VASTAdTagURI>https://ads/final</VASTAdTagURI><Impression>https://dsp/imp</Impression></Wrapper></Ad>`),
  'https://ads/final': vast(inline('final', null, '00:00:15', 'UAI-F')),
  'https://ads/empty': vast('', '4.0'),
  'https://ads/loop': vast(`<Ad id="l"><Wrapper><VASTAdTagURI>https://ads/loop</VASTAdTagURI></Wrapper></Ad>`),
};
let clock = 0;
const fetcher = (delay: Record<string, number> = {}): Fetcher => async (url, timeoutMs) => {
  const dl = delay[url] ?? 50;
  if (dl > timeoutMs) { clock += timeoutMs; throw new Error('timeout'); }
  clock += dl;
  if (!(url in responses)) return { status: 404, body: '' };
  return { status: 200, body: responses[url] };
};
const now = () => clock;
const r1 = await resolve('https://ads/tag', fetcher(), { now });
ok(r1.ads.length === 2 && r1.ads[0].id === 'final' && r1.ads[1].id === 'direct', 'wrapper chain followed to the inline, pod order kept');
ok(r1.ads[0].sequence === 1, 'the outer pod position wins');
ok(r1.ads[0].impressions.join() === 'https://ssp/imp,https://dsp/imp,https://ads.example/imp?id=final', 'impressions merged down the chain');
ok(r1.ads[0].tracking.complete.join() === 'https://ssp/done,https://ads.example/done?id=final', 'trackers merged down the chain');
ok(r1.requests === 3 && r1.problems.length === 0, 'three requests, no problems');
const r2 = await resolve('https://ads/empty', fetcher(), { now });
ok(r2.ads.length === 0, 'empty VAST = no ads');
clock = 0;
const r3 = await resolve('https://ads/tag', fetcher({ 'https://ads/tag': 2000 }), { now, budgetMs: 1500 });
ok(r3.ads.length === 0 && r3.problems.some((p) => p.code === 301), 'a slow ad server is a 301 timeout inside the budget');
clock = 0;
const r4 = await resolve('https://ads/tag', fetcher({ 'https://ads/final': 1450 }), { now, budgetMs: 1500 });
ok(r4.ads.map((a) => a.id).join() === 'direct' && r4.problems.some((p) => p.code === 301), 'one slow wrapper loses only its own ad');
const r5 = await resolve('https://ads/loop', fetcher(), { now, maxDepth: 3 });
ok(r5.ads.length === 0 && r5.problems.some((p) => p.code === 302), 'wrapper loops stop at the depth limit (302)');
const r6 = await resolve('https://ads/nothing-here', fetcher(), { now });
ok(r6.ads.length === 0 && r6.problems.length === 1, 'HTTP error is a problem, not a crash');

// ---- filling a break -------------------------------------------------------
const cond = (map: Record<string, number>) => (k: string) => (k in map ? { assetId: `cond-${k}`, durationSec: map[k] } : null);
const house = [{ assetId: 'h15', title: 'Promo 15', durationSec: 15 }, { assetId: 'h30', title: 'Promo 30', durationSec: 30 }, { assetId: 'h10', title: 'Sponsor 10', durationSec: 10 }];
const ads = doc.ads; // a1 15s, a2 30s, b1 15s
const full = fillBreak({ breakSec: 60, segmentSec: 2, ads, conditioned: cond({ 'ad-id.org:UAI-1': 15, 'ad-id.org:UAI-2': 30, 'ad-id.org:UAI-3': 15 }), house, breakIndex: 0 });
ok(full.items.map((i) => i.kind).join() === 'ad,ad,ad' && full.adSec === 60 && full.fillRate === 1 && full.fallback === null, 'all conditioned: 60s of paid ads');
const part = fillBreak({ breakSec: 90, segmentSec: 2, ads, conditioned: cond({ 'ad-id.org:UAI-1': 15, 'ad-id.org:UAI-3': 15 }), house, breakIndex: 0 });
ok(part.adSec === 30 && part.toCondition.map((x) => x.creativeKey).join() === 'ad-id.org:UAI-2', 'unconditioned creative skipped and queued for packaging');
ok(part.items.some((i) => i.kind === 'house') && Math.abs(part.adSec + part.houseSec + part.slateSec - 90) <= 1, 'the rest is house ads (+slate), break still 90s');
ok(part.fallback === 'partial', 'marked partial');
const timeout = fillBreak({ breakSec: 120, segmentSec: 2, ads: [], conditioned: () => null, house, breakIndex: 1, serverProblem: 'timeout' });
ok(timeout.fallback === 'ad-server-timeout' && timeout.houseSec === 55 && timeout.slateSec === 64, `ad server down: all house ads then slate (house ${timeout.houseSec}s, slate ${timeout.slateSec}s)`);
const noHouse = fillBreak({ breakSec: 47, segmentSec: 2, ads: [], conditioned: () => null, house: [], breakIndex: 0 });
ok(noHouse.items.length === 1 && noHouse.items[0].kind === 'slate' && Math.abs(noHouse.slateSec - 47) <= 1, 'no house ads: slate in whole segments, within a segment of the break');
const rotA = houseFill(60, 2, house, 0).items[0], rotB = houseFill(60, 2, house, 1).items[0];
ok(rotA.kind === 'house' && rotB.kind === 'house' && (rotA as any).assetId !== (rotB as any).assetId, 'consecutive breaks open with different house spots');
const dup = fillBreak({ breakSec: 60, segmentSec: 2, ads: [ads[0], { ...ads[0], id: 'again' }], conditioned: cond({ 'ad-id.org:UAI-1': 15 }), house: [], breakIndex: 0 });
ok(dup.adSec === 15 && dup.skipped.some((s) => s.reason === 'repeat'), 'same creative twice in a pod: played once');
const long = fillBreak({ breakSec: 20, segmentSec: 2, ads: [ads[1]], conditioned: cond({ 'ad-id.org:UAI-2': 30 }), house: [], breakIndex: 0 });
ok(long.adSec === 0 && long.skipped[0].reason === 'too-long', 'an ad longer than the break is not played');

// ---- per-session stitching through a live window ---------------------------
// Channel: 2s content segments; a 60s break at 40s of house fill (30s promo + 30s slate).
const T0 = Date.parse('2026-10-20T10:00:00.000Z');
type Seg = { uri: string; dur: number; init: string; t: number; brk?: boolean };
const timeline: Seg[] = [];
let tt = T0;
for (let i = 0; i < 20; i++) { timeline.push({ uri: `content/seg_${i + 1}.m4s`, dur: 2, init: 'content/init.mp4', t: tt }); tt += 2000; }
const BREAK_START = tt;
for (let i = 0; i < 15; i++) { timeline.push({ uri: `house/promo30_${i + 1}.m4s`, dur: 2, init: 'house/init.mp4', t: tt, brk: true }); tt += 2000; }
for (let i = 0; i < 15; i++) { timeline.push({ uri: `slate/s_${i + 1}.m4s`, dur: 2, init: 'slate/init.mp4', t: tt, brk: true }); tt += 2000; }
for (let i = 20; i < 60; i++) { timeline.push({ uri: `content/seg_${i + 1}.m4s`, dur: 2, init: 'content/init.mp4', t: tt }); tt += 2000; }
const W = 8;
const channelAt = (edge: number) => {
  const end = Math.min(edge, timeline.length);
  const start = Math.max(0, end - W);
  const win = timeline.slice(start, end);
  let dsn = 0;
  for (let i = 1; i <= start; i++) if (timeline[i] && timeline[i].init !== timeline[i - 1].init) dsn++;
  // a disc on the first listed segment is counted in the header (not written)
  if (start > 0 && timeline[start].init !== timeline[start - 1].init) { /* counted above */ }
  const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${start}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${dsn}`];
  let map = '';
  win.forEach((s, k) => {
    const gi = start + k;
    if (k > 0 && s.init !== timeline[gi - 1].init) L.push('#EXT-X-DISCONTINUITY');
    if (s.init !== map) { L.push(`#EXT-X-MAP:URI="${s.init}"`); map = s.init; }
    if (s.t === BREAK_START) {
      L.push(`#EXT-X-DATERANGE:ID="brk-1",CLASS="${CLASS_AD_BREAK}",START-DATE="${new Date(BREAK_START).toISOString()}",DURATION=60.000,SCTE35-OUT=${toHex(out)}`);
      L.push('#EXT-X-CUE-OUT:DURATION=60.000');
    } else if (s.brk) L.push(`#EXT-X-CUE-OUT-CONT:ElapsedTime=${((s.t - BREAK_START) / 1000).toFixed(3)},Duration=60.000`);
    else if (gi > 0 && timeline[gi - 1].brk) L.push('#EXT-X-CUE-IN');
    L.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.t).toISOString()}`);
    L.push(`#EXTINF:${s.dur.toFixed(3)},`, s.uri);
  });
  return L.join('\n') + '\n';
};
// the viewer's pod: 15s ad (7 x 2s + 1s), 30s ad (15 x 2s), 15s house (7 x 2s + 1s) = 31 segments, 3 items
const pod: PodRendition = [];
const addItem = (name: string, secs: number) => { let left = secs, n = 0; while (left > 0) { const dd = Math.min(2, left); pod.push({ uri: `${name}/seg_${++n}.m4s`, dur: dd, init: `${name}/init.mp4` }); left -= dd; } };
addItem('ads/a1', 15); addItem('ads/a2', 30); addItem('house/h15', 15);

const play = (joinEdge: number, withPod = true) => {
  const st: SessionState = { startedMs: T0, breaks: {} };
  const seen = new Map<number, { uri: string; d: number }>();
  let consistent = true, contiguous = true, msnMonotonic = true, lastFirst = -1;
  for (let edge = joinEdge; edge <= timeline.length; edge++) {
    const txt = stitchHls(channelAt(edge), st, () => (withPod ? pod : null));
    const pp = parsePlaylist(txt)!;
    if (pp.msn < lastFirst) msnMonotonic = false;
    lastFirst = pp.msn;
    let d = pp.dsn;
    pp.entries.forEach((e, k) => {
      if (k > 0 && e.disc) d++;
      if (k > 0 && e.msn !== pp.entries[k - 1].msn + 1) contiguous = false;
      const prev = seen.get(e.msn);
      if (prev && (prev.uri !== e.uri || prev.d !== d)) consistent = false;
      if (!prev) seen.set(e.msn, { uri: e.uri, d });
    });
  }
  const order = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.uri);
  return { order, consistent, contiguous, msnMonotonic, seen };
};

const s1 = play(W);
ok(s1.consistent, 'every refresh agrees on each media sequence number: same segment, same discontinuity number');
ok(s1.contiguous && s1.msnMonotonic, 'media sequence contiguous within a playlist and never goes backwards');
const contentIn = s1.order.filter((u) => u.startsWith('content/'));
ok(contentIn.length === 60 && new Set(contentIn).size === 60, 'every content segment appears exactly once');
ok(s1.order.filter((u) => u.startsWith('ads/') || u.startsWith('house/h15')).length === 31 && !s1.order.some((u) => u.startsWith('house/promo30') || u.startsWith('slate/')), 'the break is the viewer pod, not the house fill');
const i20 = s1.order.indexOf('content/seg_20.m4s'), i21 = s1.order.indexOf('content/seg_21.m4s');
ok(i21 - i20 === 32, `content resumes straight after the 31 pod segments (gap ${i21 - i20 - 1})`);
const dOf = (uri: string) => [...s1.seen.values()].find((v) => v.uri === uri)!.d;
ok(dOf('ads/a1/seg_1.m4s') === dOf('content/seg_20.m4s') + 1 && dOf('ads/a2/seg_1.m4s') === dOf('ads/a1/seg_1.m4s') + 1 && dOf('content/seg_21.m4s') === dOf('house/h15/seg_1.m4s') + 1, 'a discontinuity at each item change, numbered consistently');

// joined mid-break: house fill for that break
const s2 = play(30);
ok(s2.order.some((u) => u.startsWith('house/promo30') || u.startsWith('slate/')) && !s2.order.some((u) => u.startsWith('ads/')), 'joined mid-break: sees the house fill for that break');
ok(s2.consistent && s2.contiguous, 'and the numbering is still consistent');
// no decision: channel playlist unchanged
const s3 = play(W, false);
ok(s3.order.filter((u) => u.startsWith('house/promo30') || u.startsWith('slate/')).length === 30 && s3.consistent, 'no ad decision ready: the house fill plays, numbering unchanged');
// a garbled playlist is returned as is
ok(stitchHls('not a playlist', { startedMs: 0, breaks: {} }, () => pod) === 'not a playlist', 'unreadable playlist: passed through unchanged');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
