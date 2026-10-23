// ============================================================================
//  THE VARIANT MANIFEST SERVICE (EDGE_RIGHTS_VARIANTS.md, build queue 1.14b).
//
//  1. HLS: a 5 minute loop over a 20 minute window plays four times and is
//     cut exactly at the window end; PROGRAM-DATE-TIME and the media
//     sequence are the source's; the discontinuity count holds as the
//     playlist slides; subtitles go quiet; it refuses rather than leaks.
//  2. DASH: the window as Periods (live cut at the edges, one per pass of
//     the loop), only what is available listed, valid XML.
//  3. On the Mac with Postgres and real HTTP: AU and NZ get two different
//     variants from one source at the same time, MY the normal stream;
//     blocks stay blocks; the origin's files are byte-identical afterwards;
//     origin reads grow with variants, not viewers (a CDN in front).
//  4. The edge function sends a variant to the "variants" origin.
//    DATABASE_URL=... npx tsx test/edge-variant-manifests.check.ts
// ============================================================================
process.env.TRUST_EDGE_GEO = '1';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ORIGIN = mkdtempSync(join(tmpdir(), 'volt-variants-'));
process.env.ORIGIN_DIR = ORIGIN;

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};
/** Segments in a SegmentTimeline, repeats counted. */
const countS = (xml: string) => [...xml.matchAll(/<S\b[^>]*\/>/g)].reduce((n, m) => n + 1 + Number(/ r="(\d+)"/.exec(m[0])?.[1] ?? 0), 0);
const iso = (s: number) => new Date(s * 1000).toISOString();
const xmlOk = (xml: string) => {
  try { execFileSync('python3', ['-c', 'import sys,xml.dom.minidom as m; m.parseString(sys.stdin.read())'], { input: xml }); return true; } catch { return false; }
};

/** A delivered media playlist the way playout.py writes it. */
function mediaPlaylist(o: { t0: number; first: number; count: number; dur?: number; init?: string; dir: string; discSeq?: number; srcDiscAt?: number[]; ext?: string }) {
  const dur = o.dur ?? 4;
  const L = ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${Math.ceil(dur)}`, `#EXT-X-MEDIA-SEQUENCE:${o.first}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${o.discSeq ?? 0}`];
  if (o.init) L.push(`#EXT-X-MAP:URI="${o.init}"`);
  for (let i = 0; i < o.count; i++) {
    const n = o.first + i;
    if (i > 0 && o.srcDiscAt?.includes(n)) L.push('#EXT-X-DISCONTINUITY');
    L.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(o.t0 + n * dur)}`, `#EXTINF:${dur.toFixed(3)},`, `${o.dir}/seg_${n + 1}.${o.ext ?? 'm4s'}`);
  }
  return L.join('\n') + '\n';
}
/** Segments of a rendered playlist: what a player would read. */
function segsOf(text: string) {
  const out: { uri: string; pdt: number; dur: number; disc: number; map: string | null; mseq: number }[] = [];
  let disc = 0, map: string | null = null, pdt = NaN, dur = 0, mseq = 0, ds = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mseq = Number(l.slice(22));
    else if (l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) ds = Number(l.slice(30));
    else if (l === '#EXT-X-DISCONTINUITY') disc++;
    else if (l.startsWith('#EXT-X-MAP:')) map = l.match(/URI="([^"]*)"/)![1];
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25)) / 1000;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) { out.push({ uri: l, pdt, dur, disc: ds + disc, map, mseq: mseq + out.length }); }
  }
  return { segs: out, discSeq: ds, discTags: text.split('\n').filter((l) => l === '#EXT-X-DISCONTINUITY').length };
}

(async () => {
  const vm = await import('../src/services/variantManifest');
  const er = await import('../src/services/edgeRights');

  // ---- 1. HLS -----------------------------------------------------------------------------------
  const T0 = 1_800_000_000;
  const loopTrack = (label: string, n = 75) => ({ kind: label === 'audio' ? 'audio' : 'video', init: `${label}/init.mp4`, segments: Array.from({ length: n }, (_, k) => ({ uri: `${label}/seg_${k + 1}.m4s`, dur: 4 })) });
  const LOOP = { segmentSeconds: 4, base: '/origin/X/live/filler/', tracks: { '720p': loopTrack('720p'), '1080p': loopTrack('1080p'), audio: loopTrack('audio') } };
  const FROM = T0 + 40, TO = FROM + 1200;          // 20 minutes; the loop is 75 x 4 s = 5 minutes
  const TL: any = [[FROM, TO, 'loop:filler-1']];
  const src = mediaPlaylist({ t0: T0, first: 0, count: 450, init: '720p/init.mp4', dir: '720p', discSeq: 3 });
  const out = vm.renderVariantMedia(src, { timeline: TL, loop: LOOP, base: '/origin/X/live/', emptyVtt: 'empty.vtt' });
  const a = segsOf(src).segs, b = segsOf(out).segs;
  const rep = b.filter((s) => s.uri.includes('/filler/'));
  check('HLS: every slot kept, same media sequence', [b.length, b[0].mseq, b[b.length - 1].mseq], [a.length, a[0].mseq, a[a.length - 1].mseq]);
  check('...the 20 minute window is 300 slots of the loop', rep.length, 300);
  const idx = rep.map((s) => Number(s.uri.match(/seg_(\d+)\.m4s$/)![1]) - 1);
  check('...the 5 minute loop plays exactly four times, in order', JSON.stringify(idx), JSON.stringify([0, 1, 2, 3].flatMap(() => Array.from({ length: 75 }, (_, k) => k))));
  check('...it starts at the window start and stops exactly at the window end', [rep[0].pdt, rep[rep.length - 1].pdt + rep[rep.length - 1].dur, b.find((s) => s.pdt >= TO)!.uri.includes('/filler/')], [FROM, TO, false]);
  check('...PROGRAM-DATE-TIME and durations are the source\'s (continuous)', JSON.stringify(b.map((s) => [s.pdt, s.dur])), JSON.stringify(a.map((s) => [s.pdt, s.dur])));
  check('...continuous: each segment starts where the last ended', b.every((s, i) => i === 0 || Math.abs(s.pdt - (b[i - 1].pdt + b[i - 1].dur)) < 1e-6), true);
  check('...five discontinuities: in, three wraps, out', segsOf(out).discTags, 5);
  const discAt = b.filter((s, i) => i > 0 && s.disc !== b[i - 1].disc).map((s) => (s.pdt - FROM) / 4);
  check('...at the window start, every 75 slots, and the end', discAt, [0, 75, 150, 225, 300]);
  check('...the loop\'s own init in the window, the live one after', [rep[0].map, b.find((s) => s.pdt >= TO)!.map], ['/origin/X/live/filler/720p/init.mp4', '/origin/X/live/720p/init.mp4']);
  check('...live segments addressed on the origin', b[0].uri, '/origin/X/live/720p/seg_1.m4s');
  check('...the discontinuity sequence starts from the source\'s', segsOf(out).discSeq, 3);

  // Sliding: a player holding segment m must keep its discontinuity number
  // (sequence + tags before it) whatever later playlist it reads.
  const numberOf = new Map<number, number>();
  let stable = true, slides = 0;
  for (let first = 0; first + 30 <= 450; first += 7) {
    // the source slides the same way: a disc on its first segment is folded into its sequence
    const srcDisc = [200];
    const ds = 3 + srcDisc.filter((n) => n <= first).length;
    const s = mediaPlaylist({ t0: T0, first, count: 30, init: '720p/init.mp4', dir: '720p', discSeq: ds, srcDiscAt: srcDisc });
    const r = segsOf(vm.renderVariantMedia(s, { timeline: TL, loop: LOOP, base: '', emptyVtt: 'empty.vtt' }));
    for (const g of r.segs) {
      if (numberOf.has(g.mseq) && numberOf.get(g.mseq) !== g.disc) stable = false;
      numberOf.set(g.mseq, g.disc);
    }
    slides++;
  }
  check(`...the discontinuity number of every segment is the same in all ${slides} sliding playlists (30 segments, one source discontinuity too)`, stable, true);
  check('...and climbs by the six discontinuities over the run', [numberOf.get(0), numberOf.get(449)], [3, 9]);

  // jitter like real audio (3.598 / 3.621 s), segments not on the loop's grid
  const jitter = (() => {
    const L = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="audio/init.mp4"'];
    let t = T0 + 0.637;
    for (let i = 0; i < 450; i++) { const d = i % 3 ? 3.998 : 4.004; L.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(t)}`, `#EXTINF:${d.toFixed(3)},`, `audio/seg_${i + 1}.m4s`); t += d; }
    return L.join('\n') + '\n';
  })();
  const jr = segsOf(vm.renderVariantMedia(jitter, { timeline: TL, loop: LOOP, base: '', emptyVtt: 'empty.vtt' })).segs.filter((s) => s.uri.includes('filler'));
  const ji = jr.map((s) => Number(s.uri.match(/seg_(\d+)/)![1]));
  check('audio with jittered segments off the grid: the audio loop, never a segment twice in a row', [jr[0].uri.startsWith('filler/audio/') || jr[0].uri.startsWith('/origin/X/live/filler/audio/'), ji.every((n, i) => i === 0 || n !== ji[i - 1])], [true, true]);

  const plain = vm.renderVariantMedia(src, { timeline: [], loop: null, base: '/origin/X/live/', emptyVtt: 'empty.vtt' });
  check('an empty timeline (a viewer never replaced) is the source with absolute addresses', plain.replace(/\/origin\/X\/live\//g, ''), src);
  const subs = mediaPlaylist({ t0: T0, first: 0, count: 450, dir: 'sub', ext: 'vtt' });
  const so = segsOf(vm.renderVariantMedia(subs, { timeline: TL, loop: LOOP, base: '', emptyVtt: 'empty.vtt' }));
  check('subtitles go quiet inside the window (the programme\'s words are not shown), with the same discontinuities', [so.segs.filter((s) => s.uri === 'empty.vtt').length, so.discTags], [300, 5]);
  let err = '';
  try { vm.renderVariantMedia(src, { timeline: TL, loop: null, base: '', emptyVtt: 'e' }); } catch (e: any) { err = e instanceof vm.VariantError ? 'refused' : String(e); }
  check('no loop built: refused, never the normal stream', err, 'refused');
  err = '';
  try { vm.renderVariantMedia(src.replace(/720p\/init/, '480p/init'), { timeline: TL, loop: LOOP, base: '', emptyVtt: 'e' }); } catch (e: any) { err = e instanceof vm.VariantError ? 'refused' : String(e); }
  check('a rendition the loop does not have: refused', err, 'refused');
  err = '';
  try { vm.renderVariantMedia(mediaPlaylist({ t0: T0, first: 0, count: 450, dir: 'ts', ext: 'ts' }), { timeline: TL, loop: LOOP, base: '', emptyVtt: 'e' }); } catch (e: any) { err = e instanceof vm.VariantError ? 'refused' : String(e); }
  check('MPEG-TS segments (no CMAF init): refused', err, 'refused');
  const shifted = segsOf(vm.renderVariantMedia(src, { timeline: [[FROM + 600, TO + 600, 'x']], loop: LOOP, base: '/origin/X/live/', emptyVtt: 'e', shiftSec: 600 })).segs;
  check('a test time (&at=) moves the window over the same segments', JSON.stringify(shifted.map((s) => s.uri)), JSON.stringify(b.map((s) => s.uri)));
  const enc = src.replace('#EXT-X-MAP:URI="720p/init.mp4"', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k1"\n#EXT-X-MAP:URI="720p/init.mp4"');
  const encOut = vm.renderVariantMedia(enc, { timeline: TL, loop: LOOP, base: '', emptyVtt: 'e' });
  check('an encrypted stream: the clear loop is announced as clear, the key comes back after', [(encOut.match(/METHOD=NONE/g) ?? []).length, (encOut.match(/SAMPLE-AES/g) ?? []).length], [1, 2]);

  const master = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_0_cc.m3u8",GROUP-ID="audio",NAME="A"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="audio"\nstream_1_cc.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"\n';
  const mo = vm.renderVariantMaster(master, '?as=AU&at=x');
  check('the variant master keeps its playlists relative, passes the stand-ins on, drops I-frame playlists',
    [mo.includes('URI="stream_0_cc.m3u8?as=AU&at=x"'), mo.includes('\nstream_1_cc.m3u8?as=AU&at=x\n'), mo.includes('I-FRAME')], [true, true, false]);

  // ---- 2. DASH ----------------------------------------------------------------------------------
  const mpd = (count: number) => `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="${iso(T0)}" publishTime="${iso(T0 + count * 4)}" minimumUpdatePeriod="PT4S" timeShiftBufferDepth="PT3600S"><Location>https://x/manifest_cc.mpd</Location><Period id="p0" start="PT0S"><AdaptationSet id="0" contentType="video"><Representation id="0" bandwidth="1" codecs="avc1.4d401f" width="1280" height="720"><SegmentTemplate timescale="90000" presentationTimeOffset="0" initialization="720p/init.mp4" media="720p/seg_$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="360000" r="${count - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet><AdaptationSet id="1" contentType="audio"><Representation id="1" bandwidth="1" codecs="mp4a.40.2"><SegmentTemplate timescale="48000" presentationTimeOffset="0" initialization="audio/init.mp4" media="audio/seg_$Number$.m4s" startNumber="1"><SegmentTimeline><S t="0" d="192000" r="${count - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet><AdaptationSet id="2" contentType="text" mimeType="text/vtt"><Representation id="2" bandwidth="1"><SegmentTemplate timescale="1000" initialization="sub/init.mp4" media="sub/seg_$Number$.vtt" startNumber="1"><SegmentTimeline><S t="0" d="4000" r="${count - 1}"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
  const dm = vm.renderVariantMpd(mpd(450), { timeline: TL, loop: LOOP, base: '/origin/X/live/', key: 'vabc12345' });
  const periods = [...dm.matchAll(/<Period\b[^>]*>/g)].map((m) => m[0]);
  const pAttr = (p: string, n: string) => p.match(new RegExp(` ${n}="([^"]*)"`))?.[1] ?? null;
  check('DASH: live, four passes of the loop, live again', periods.map((p) => pAttr(p, 'id')), ['p0', ...[0, 1, 2, 3].map((j) => `vabc12345-${(FROM + j * 300) * 1000}`), `p0-${TO * 1000}`]);
  check('...Period starts at the window start, each pass, and the window end', periods.map((p) => vm.isoDur(pAttr(p, 'start'))), [0, 40, 340, 640, 940, 1240]);
  check('...each pass is 5 minutes, the last cut at the window end', periods.slice(1, 5).map((p) => vm.isoDur(pAttr(p, 'duration'))), [300, 300, 300, 300]);
  const loopP = dm.match(/<Period id="vabc12345-[^>]*>[\s\S]*?<\/Period>/)![0];
  check('...a pass plays the loop from its start: 75 segments, loop time 0, its own init', [countS(loopP) / 2, /initialization="\/origin\/X\/live\/filler\/720p\/init.mp4"/.test(loopP), /media="\/origin\/X\/live\/filler\/720p\/seg_\$Number\$.m4s" startNumber="1"/.test(loopP), /<S t="0" d="4000"( r="74")?\/>/.test(loopP)], [75, true, true, true]);
  check('...no text track and no event stream inside the window', /contentType="text"/.test(loopP), false);
  const after = dm.match(new RegExp(`<Period id="p0-${TO * 1000}"[\\s\\S]*?</Period>`))![0];
  check('...the live Period after starts at the segment at the window end, offset moved so nothing shifts', [/presentationTimeOffset="111600000"/.test(after), /startNumber="311"/.test(after)], [true, true]);
  const before = dm.match(/<Period id="p0"[\s\S]*?<\/Period>/)![0];
  check('...the live Period before keeps only the ten segments before the window', countS(before.match(/<SegmentTemplate[^>]*720p[\s\S]*?<\/SegmentTemplate>/)![0]), 10);
  check('...valid XML, the Location (the normal MPD) removed', [xmlOk(dm), dm.includes('<Location>')], [true, false]);
  const partial = vm.renderVariantMpd(mpd(100), { timeline: TL, loop: LOOP, base: '', key: 'vabc12345' });
  const pp = [...partial.matchAll(/<Period\b[^>]*>/g)].map((m) => m[0]);
  check('...live edge inside the window: passes only up to it, the last one open and listing only what is available',
    [pp.length, pAttr(pp[pp.length - 1], 'duration'), countS(partial.match(/<Period id="vabc12345-1800000340000"[\s\S]*?<\/Period>/)![0].match(/<SegmentTemplate[^>]*filler\/720p[\s\S]*?<\/SegmentTemplate>/)![0])], [3, null, 15]);
  check('...and valid', xmlOk(partial), true);
  err = '';
  try { vm.renderVariantMpd(mpd(450), { timeline: TL, loop: null, base: '', key: 'k' }); } catch (e: any) { err = e instanceof vm.VariantError ? 'refused' : String(e); }
  check('...no loop: refused', err, 'refused');
  check('...an empty timeline: only the addresses change', vm.renderVariantMpd(mpd(450), { timeline: [], loop: null, base: '', key: 'k' }).replace(/\s*<Location>[^<]*<\/Location>/, ''), mpd(450).replace(/\s*<Location>[^<]*<\/Location>/, ''));

  // ---- 4. the edge function picks the variants origin --------------------------------------------
  {
    const fsrc = readFileSync(join(__dirname, '../../deploy/edge/rights-viewer-request.js'), 'utf8');
    check('the function is still inside CloudFront Functions\' 10 KB', Buffer.byteLength(fsrc) < 10240, true);
    const CH = '11111111-2222-3333-4444-555555555555';
    const r = er.compileEdgeRules({ account: null, channel: null, programmes: [{ starts_at: new Date((T0 - 60) * 1000), ends_at: new Date((T0 + 3600) * 1000), geo_mode: 'block', geo_countries: ['AU'], replacement_kind: 'loop', replacement_ref: 'f' }], nowSec: T0, variantService: true })!;
    const picked: string[] = [];
    (globalThis as any).__cf = { kvs: () => ({ async get(k: string) { if (k === `s:${CH}`) return JSON.stringify(r); throw new Error('nf'); } }), selectRequestOriginById: (o: string) => picked.push(o) };
    (globalThis as any).__crypto = await import('node:crypto');
    const body = fsrc.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cf;').replace("import crypto from 'crypto';", 'const crypto = globalThis.__crypto;').replace('${kvs_id}', 'kvs-test');
    const edge = new Function(`${body}\nreturn { handler };`)();
    const realNow = Date.now; Date.now = () => T0 * 1000;
    const hit = async (uri: string, cc: string) => edge.handler({ request: { uri, headers: { 'cloudfront-viewer-country': { value: cc } }, querystring: {}, cookies: {} } });
    const x = await hit(`/channel/${CH}/stream_1_cc.m3u8`, 'AU');
    check('edge: a replaced viewer is rewritten to the variant and sent to the variants origin', [x.uri, picked], [`/channel/${CH}/v/${r.vm!.AU}/stream_1_cc.m3u8`, ['variants']]);
    picked.length = 0;
    const y = await hit(`/channel/${CH}/stream_1_cc.m3u8`, 'MY');
    check('...an allowed viewer stays on S3', [y.uri, picked.length], [`/channel/${CH}/stream_1_cc.m3u8`, 0]);
    Date.now = realNow;
  }

  // ---- 3. on the Mac: Postgres and real HTTP ---------------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('PASS skipped the database part: set DATABASE_URL');
  } else {
    const { pool, one, query } = await import('../src/db');
    const express = (await import('express')).default;
    const { publicLiveRouter } = await import('../src/modules/publicLive');
    const app = express(); app.use(publicLiveRouter);
    let appRequests = 0;
    const counted = express(); counted.use((_q, _r, n) => { appRequests++; n(); }, app);
    const srv = counted.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const tag = Date.now().toString(36);
    const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vm-${tag}`]))!.id;
    const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
    const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
    const ch = (await one<any>(`INSERT INTO channels(group_id, name, geo_mode, geo_countries) VALUES ($1,'VM Sport','block',ARRAY['CN']) RETURNING id`, [g]))!.id;
    const off = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'VM Off') RETURNING id`, [g]))!.id;
    await query(`UPDATE channels SET on_air = true, status = 'live' WHERE id = $1`, [ch]);
    const now = Math.floor(Date.now() / 1000);
    // AU replaced from a minute ago for ten minutes, NZ from 100 s ago for two minutes: two
    // different timelines over the same moment; FJ blacked out with no replacement.
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
                 VALUES ($1,'Match AU',to_timestamp($2),to_timestamp($3),'block',ARRAY['AU'],'loop','filler-1'),
                        ($1,'Match NZ',to_timestamp($4),to_timestamp($5),'block',ARRAY['NZ'],'loop','filler-1'),
                        ($1,'Match FJ',to_timestamp($2),to_timestamp($3),'block',ARRAY['FJ'],'none',NULL)`,
    [ch, now - 60, now + 600, now - 100, now + 20]);
    await query(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, geo_mode, geo_countries, replacement_kind, replacement_ref)
                 VALUES ($1,'Off AU',to_timestamp($2),to_timestamp($3),'block',ARRAY['AU'],'loop','f')`, [off, now - 60, now + 600]);
    // the delivered output of a run, as the encoder leaves it
    const run = join(ORIGIN, ch, 'runs', '20261023T000000Z');
    mkdirSync(join(run, 'filler'), { recursive: true });
    writeFileSync(join(ORIGIN, ch, 'current_run.txt'), '20261023T000000Z');
    const t0 = now - 160;
    const writeOutput = () => {
      writeFileSync(join(run, 'master_cc.m3u8'), master.replace('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"\n', ''));
      writeFileSync(join(run, 'stream_0_cc.m3u8'), mediaPlaylist({ t0, first: 0, count: 40, init: 'audio/init.mp4', dir: 'audio' }));
      writeFileSync(join(run, 'stream_1_cc.m3u8'), mediaPlaylist({ t0, first: 0, count: 40, init: '720p/init.mp4', dir: '720p' }));
      writeFileSync(join(run, 'manifest_cc.mpd'), mpd(40).replace(`availabilityStartTime="${iso(T0)}"`, `availabilityStartTime="${iso(t0)}"`));
    };
    writeOutput();
    writeFileSync(join(run, 'filler', 'filler.json'), JSON.stringify({ hash: 'h', segment_seconds: 4, loop_seconds: 20, tracks: { '720p': loopTrack('720p', 5), audio: loopTrack('audio', 5) } }));
    const snapshot = () => {
      const h = createHash('sha256');
      const walk = (d: string) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else h.update(p).update(readFileSync(p)); } };
      walk(ORIGIN); return h.digest('hex');
    };
    const before = snapshot();
    const get = async (path: string, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, { headers, redirect: 'manual' });
      const text = await res.text();
      let j: any = null; try { j = JSON.parse(text); } catch { /* a playlist */ }
      return { status: res.status, text, j, loc: res.headers.get('location'), variant: res.headers.get('x-volt-variant'), rights: res.headers.get('x-volt-rights'), cache: res.headers.get('cache-control') ?? '' };
    };
    const st = await er.loadEdgeState('channel', ch);
    const kAU = st.rules!.vm!.AU, kNZ = st.rules!.vm!.NZ;
    check('db: AU and NZ have two different variants', [!!kAU, !!kNZ, kAU !== kNZ, st.variants.length], [true, true, true, 2]);
    check('...the service is on outside production by default, and the store says so', st.rules!.vs, 1);

    let x = await get(`/live/${ch}/master.m3u8?as=AU`);
    check('Mac: AU in its window is sent to its variant, the test country with it', [x.status, x.loc], [302, `/live/${ch}/v/${kAU}/master.m3u8?as=AU`]);
    x = await get(x.loc!);
    check('...the variant master leads to the variant\'s own playlists', [x.status, x.text.includes('\nstream_1_cc.m3u8?as=AU\n'), x.variant], [200, true, kAU]);
    const [au, nz, my] = await Promise.all([
      get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=AU`), get(`/live/${ch}/v/${kNZ}/stream_1_cc.m3u8?as=NZ`), get(`/live/${ch}/master.m3u8?as=MY`)]);
    const auS = segsOf(au.text).segs, nzS = segsOf(nz.text).segs;
    const replacedFrom = (s: typeof auS) => s.filter((q) => q.uri.includes('/filler/')).map((q) => Math.round(q.pdt - now));
    check('...AU and NZ at the same moment from one source: two versions', [au.status, nz.status, au.variant, nz.variant], [200, 200, kAU, kNZ]);
    check('...AU sees the loop from its window start (60 s ago)', replacedFrom(auS)[0] >= -60 && replacedFrom(auS)[0] < -56, true);
    check('...NZ from its own (100 s ago)', replacedFrom(nzS)[0] >= -100 && replacedFrom(nzS)[0] < -96, true);
    check('...both list the same slots and clock as the source', JSON.stringify(auS.map((q) => q.pdt)), JSON.stringify(nzS.map((q) => q.pdt)));
    check('...MY gets the normal stream, not a variant', [my.status, my.loc], [302, `/origin/${ch}/live/master_cc.m3u8`]);
    x = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=MY`);
    check('...MY asking for AU\'s variant by name gets its own (the normal stream through the same path)', [x.status, x.variant, x.text.includes('/filler/')], [200, 'none', false]);
    x = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=CN`);
    check('...a country the channel blocks: 451 on the variant path too', [x.status, x.j?.reason], [451, 'geo']);
    x = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=FJ`);
    check('...a blackout with no replacement: 451, the variant is no way round it', [x.status, x.j?.reason, x.rights], [451, 'rights', 'block']);
    x = await get(`/live/${ch}/v/${kAU}/stream_0_cc.m3u8?as=AU`);
    check('...the audio playlist carries the audio loop', [x.status, x.text.includes(`/origin/${ch}/live/filler/audio/seg_1.m4s`)], [200, true]);
    x = await get(`/live/${ch}/v/${kAU}/manifest.mpd?as=AU`);
    check('...DASH: the window as a Period of the loop, valid', [x.status, x.text.includes(`<Period id="${kAU}-`), x.text.includes(`/origin/${ch}/live/filler/720p/init.mp4`), xmlOk(x.text)], [200, true, true, true]);
    x = await get(`/live/${ch}/v/${kNZ}/stream_1_cc.m3u8?as=NZ&at=${encodeURIComponent(new Date((now + 3600) * 1000).toISOString())}`);
    check('...&at= an hour on, NZ\'s window is over: normal content', [x.status, x.variant, x.text.includes('/filler/')], [200, 'none', false]);
    x = await get(`/live/${ch}/v/${kAU}/empty.vtt`);
    check('...the empty subtitle segment, long cached', [x.status, x.text, /s-maxage=86400/.test(x.cache)], [200, 'WEBVTT\n\n', true]);
    x = await get(`/live/${off}/v/${kAU}/stream_1_cc.m3u8?as=AU`);
    check('...a channel off air: nothing, as on the normal route', [x.status, x.j?.reason], [404, 'not_on_air']);
    x = await get(`/live/${ch}/v/${kAU}/../../x.m3u8?as=AU`);
    check('...a crafted path goes nowhere', x.status === 404 || x.status === 400, true);
    x = await get(`/channel/${ch}/v/${kAU}/stream_1_cc.m3u8`, { 'CloudFront-Viewer-Country': 'AU' });
    check('the CDN-shaped path (/channel/<id>/v/<key>/): AU from the CDN\'s country header, shareable for a segment', [x.status, x.variant, x.text.includes('/filler/'), /s-maxage=2/.test(x.cache)], [200, kAU, true, true]);
    x = await get(`/event/${ch}/v/${kAU}/stream_1_cc.m3u8`, { 'CloudFront-Viewer-Country': 'AU' });
    check('...the wrong kind in the path: 404', x.status, 404);
    renameSync(join(run, 'filler', 'filler.json'), join(run, 'filler', 'filler.json.off'));
    process.env.VARIANT_SOURCE_CACHE_MS = '0';
    x = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=AU`);
    check('no loop built: 503, never the normal stream', [x.status, x.j?.reason, x.text.includes('720p/seg_')], [503, 'variant_unavailable', false]);
    renameSync(join(run, 'filler', 'filler.json.off'), join(run, 'filler', 'filler.json'));
    process.env.EDGE_VARIANT_SERVICE = '0';
    x = await get(`/live/${ch}/v/${kAU}/stream_1_cc.m3u8?as=AU`);
    check('EDGE_VARIANT_SERVICE=0: the service is off', [x.status, x.j?.reason], [404, 'variant_service_off']);
    delete process.env.EDGE_VARIANT_SERVICE;
    delete process.env.VARIANT_SOURCE_CACHE_MS;

    // ---- load: a CDN in front (caches by URL for s-maxage and, like CloudFront,
    // collapses simultaneous misses for one URL into one origin request),
    // N viewers polling their three playlists once a second for 6 seconds
    const loadRun = async (viewers: number) => {
      const cdn = new Map<string, { until: number; p: Promise<void> }>();
      const { variantSourceStats } = await import('../src/services/variantManifest');
      const reads0 = variantSourceStats.reads, app0 = appRequests, t0 = Date.now();
      for (let round = 0; round < 6; round++) {
        const t = new Date(); for (const f of ['stream_0_cc.m3u8', 'stream_1_cc.m3u8', 'master_cc.m3u8']) utimesSync(join(run, f), t, t);
        const roundStart = Date.now();
        await Promise.all(Array.from({ length: viewers }, async (_, v) => {
          const cc = v % 2 ? 'AU' : 'NZ';
          const k = cc === 'AU' ? kAU : kNZ;
          for (const f of ['master.m3u8', 'stream_0_cc.m3u8', 'stream_1_cc.m3u8']) {
            const url = `/channel/${ch}/v/${k}/${f}`;
            const c = cdn.get(url);
            if (c && c.until > Date.now()) { await c.p; continue; }   // an edge hit (or joined a miss in flight)
            const entry = { until: Infinity, p: Promise.resolve() };
            entry.p = (async () => {
              const res = await fetch(base + url, { headers: { 'CloudFront-Viewer-Country': cc } });
              await res.text();
              const m = /s-maxage=(\d+)/.exec(res.headers.get('cache-control') ?? '');
              entry.until = m ? Date.now() + Number(m[1]) * 1000 : 0;
            })();
            cdn.set(url, entry);
            await entry.p;
          }
        }));
        await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - roundStart))));
      }
      return { origin: variantSourceStats.reads - reads0, app: appRequests - app0, sec: (Date.now() - t0) / 1000 };
    };
    const small = await loadRun(20), big = await loadRun(1000);
    console.log(`  load: 20 viewers -> ${small.app} requests to the service, ${small.origin} origin reads in ${small.sec.toFixed(1)} s; 1000 viewers -> ${big.app}, ${big.origin} in ${big.sec.toFixed(1)} s`);
    // the bound: 4 source files (3 playlists and the loop) read at most once a second;
    // 2 variants x 3 playlists asked at most once per 2 s cache period
    check('load: 50 times the viewers, the same origin reads (bounded by files x seconds, not viewers)', [big.origin <= 4 * Math.ceil(big.sec + 1), big.origin <= small.origin + 4], [true, true]);
    check('...and the service is asked per variant and playlist, not per viewer', [big.app <= 2 * 3 * Math.ceil(big.sec / 2 + 1), big.app <= small.app + 6], [true, true]);

    check('the origin\'s own files are byte for byte untouched by all of it', snapshot() === before, true);
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
