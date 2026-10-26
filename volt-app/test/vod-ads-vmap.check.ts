// ============================================================================
//  ON-DEMAND ADS: VMAP FROM THE AD SERVER (SSAI.md 5.1, build queue 1.14k-4).
//
//  A rule can let the ad server decide where the breaks go: Volt asks it for a
//  VMAP schedule (one request per playback, with the viewer's macros), maps
//  each break's offset onto the nearest segment start, and fills each break
//  from the ad server's own source (a VAST tag, or the VAST inline).
//
//  Pure first: offsets, the parser (namespaced or not, inline VAST, tag URIs,
//  break trackers, what it leaves out), the plan (snapping, merging, the
//  title's own say), break trackers on the pod's first and last ad, the
//  policy fields. Then the real API with a local VMAP and VAST server and HLS
//  on disk: pre, mid at an offset and post land where VMAP says in the
//  stitched playlist and the guided one, each break's pod from its source,
//  breakStart and breakEnd sent, the viewer's own schedule filling the shared
//  guided playlist, an empty schedule, and an ad server that is slow or down
//  (the rule's own breaks, house spots, the ad server not asked again).
//
//  Usage: DATABASE_URL=... npx tsx test/vod-ads-vmap.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An HLS asset on disk: two video renditions and audio, 4 s segments. */
function writeAsset(dir: string, totalSec: number) {
  const seg = 4;
  mkdirSync(dir, { recursive: true });
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  const media = (folder: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${folder}/init.mp4"`, ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${folder}/seg_${i + 1}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('360p'));
  writeFileSync(join(dir, 'stream_1.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="audio"', 'stream_0.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="audio"', 'stream_1.m3u8', ''].join('\n'));
}

const vastDoc = (base: string, id: string, uai: string, dur: string) => `<VAST version="4.1"><Ad id="${id}" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>${id}</AdTitle>
  <Impression><![CDATA[${base}/px/imp-${id}]]></Impression><Creatives><Creative id="c-${id}"><UniversalAdId idRegistry="ad-id.org">${uai}</UniversalAdId><Linear><Duration>${dur}</Duration>
  <TrackingEvents><Tracking event="complete"><![CDATA[${base}/px/complete-${id}]]></Tracking></TrackingEvents>
  <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${base}/${id}.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`;

(async () => {
  // ---------------------------------------------------------------- the ad server: VMAP and VAST
  const hits: { path: string; at: number }[] = [];
  let schedule: 'full' | 'variant' = 'full';
  const vmapRequests: URL[] = [];
  const vastRequests: string[] = [];
  const stub = httpServer(async (req, res) => {
    const base = `http://127.0.0.1:${(stub.address() as any).port}`;
    const u = new URL(req.url!, base);
    if (u.pathname.startsWith('/px/')) { hits.push({ path: u.pathname, at: Date.now() }); res.writeHead(200); return res.end(); }
    if (u.pathname.startsWith('/vast/')) {
      vastRequests.push(u.pathname);
      res.writeHead(200, { 'content-type': 'application/xml' });
      if (u.pathname === '/vast/pre') return res.end(vastDoc(base, 'pre', 'UAI-1', '00:00:15'));
      if (u.pathname === '/vast/post') return res.end(vastDoc(base, 'post', 'UAI-1', '00:00:15'));
      return res.end('<VAST version="4.1"></VAST>');
    }
    if (u.pathname === '/vmap-slow') { await sleep(2500); res.writeHead(200); return res.end('<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"/>'); }
    if (u.pathname === '/vmap-down') { res.writeHead(503); return res.end('down'); }
    if (u.pathname === '/vmap-empty') { vmapRequests.push(u); res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"></vmap:VMAP>'); }
    if (u.pathname === '/vmap') {
      vmapRequests.push(u);
      res.writeHead(200, { 'content-type': 'application/xml' });
      const half = schedule === 'full' ? `
        <vmap:AdBreak timeOffset="50%" breakType="linear" breakId="half">
          <vmap:AdSource id="half" allowMultipleAds="true" followRedirects="true"><vmap:AdTagURI templateType="vast3"><![CDATA[${base}/vast/none]]></vmap:AdTagURI></vmap:AdSource>
        </vmap:AdBreak>` : '';
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
      <vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">
        <vmap:AdBreak timeOffset="start" breakType="linear" breakId="preroll">
          <vmap:AdSource id="pre" allowMultipleAds="false" followRedirects="true"><vmap:AdTagURI templateType="vast3"><![CDATA[${base}/vast/pre?sid=${u.searchParams.get('sid')}]]></vmap:AdTagURI></vmap:AdSource>
          <vmap:TrackingEvents>
            <vmap:Tracking event="breakStart"><![CDATA[${base}/px/break-start]]></vmap:Tracking>
            <vmap:Tracking event="breakEnd"><![CDATA[${base}/px/break-end]]></vmap:Tracking>
          </vmap:TrackingEvents>
        </vmap:AdBreak>
        <vmap:AdBreak timeOffset="00:10:01.500" breakType="linear" breakId="mid1a">
          <vmap:AdSource id="mid1a"><vmap:VASTAdData>${vastDoc(base, 'inline', 'UAI-2', '00:00:10')}</vmap:VASTAdData></vmap:AdSource>
        </vmap:AdBreak>
        <vmap:AdBreak timeOffset="00:10:02" breakType="linear" breakId="mid1b">
          <vmap:AdSource id="mid1b"><vmap:AdTagURI templateType="vast3"><![CDATA[${base}/vast/pre?second=1]]></vmap:AdTagURI></vmap:AdSource>
        </vmap:AdBreak>${half}
        <vmap:AdBreak timeOffset="#1" breakType="linear" breakId="cue1">
          <vmap:AdSource id="cue1"><vmap:AdTagURI templateType="vast3"><![CDATA[${base}/vast/none]]></vmap:AdTagURI></vmap:AdSource>
        </vmap:AdBreak>
        <vmap:AdBreak timeOffset="00:20:00" breakType="nonlinear" breakId="overlay">
          <vmap:AdSource id="ov"><vmap:AdTagURI><![CDATA[${base}/vast/none]]></vmap:AdTagURI></vmap:AdSource>
        </vmap:AdBreak>
        <vmap:AdBreak timeOffset="later" breakType="linear" breakId="odd"></vmap:AdBreak>
        <vmap:AdBreak timeOffset="end" breakType="linear" breakId="postroll">
          <vmap:AdSource id="post"><vmap:AdTagURI templateType="vast3"><![CDATA[${base}/vast/post]]></vmap:AdTagURI></vmap:AdSource>
        </vmap:AdBreak>
      </vmap:VMAP>`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  const VBASE = `http://127.0.0.1:${(stub.address() as any).port}`;

  const work = mkdtempSync(join(tmpdir(), 'vod-ads-vmap-'));
  Object.assign(process.env, { CLIPS_DIR: join(work, 'clips'), AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example' });

  const P = await import('../src/services/vodAds/plan');
  const M = await import('../src/services/vodAds/vmap');

  console.log('== offsets ==');
  check('start, end, a time, a percentage, a cue position',
    ['start', 'end', '00:10:01.500', '01:00:00', '25%', '#2'].map(M.parseOffset),
    [{ kind: 'start' }, { kind: 'end' }, { kind: 'time', sec: 601.5 }, { kind: 'time', sec: 3600 }, { kind: 'percent', pct: 25 }, { kind: 'position', n: 2 }]);
  check('what cannot be read is null', ['later', '10:00', '120%', '#0', ''].map(M.parseOffset), [null, null, null, null, null]);
  check('where an offset lands in a 1800 s title with cue points at 1200 and 300 s',
    [M.offsetSec({ kind: 'percent', pct: 50 }, 1800), M.offsetSec({ kind: 'position', n: 1 }, 1800, [1200, 300]), M.offsetSec({ kind: 'position', n: 3 }, 1800, [1200, 300]), M.offsetSec({ kind: 'time', sec: 2000 }, 1800)],
    [900, 300, null, null]);

  console.log('\n== the parser ==');
  const doc = M.parseVmap(`<?xml version="1.0"?><!-- a comment with <vmap:AdBreak> in it -->
    <vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">
      <vmap:AdBreak timeOffset="start" breakType="linear,nonlinear" breakId="pre">
        <vmap:AdSource id="a"><vmap:AdTagURI templateType="vast3"><![CDATA[https://ads.example/vast?a=1&b=2]]></vmap:AdTagURI></vmap:AdSource>
        <vmap:TrackingEvents><vmap:Tracking event="breakStart"><![CDATA[https://ads.example/bs]]></vmap:Tracking><vmap:Tracking event="error">https://ads.example/err?c=[ERRORCODE]&amp;x=1</vmap:Tracking></vmap:TrackingEvents>
      </vmap:AdBreak>
      <vmap:AdBreak timeOffset="00:05:00.000" breakType="linear">
        <vmap:AdSource><vmap:VASTAdData><VAST version="3.0"><Ad id="i"><InLine><AdSystem>X</AdSystem></InLine></Ad></VAST></vmap:VASTAdData></vmap:AdSource>
      </vmap:AdBreak>
      <vmap:AdBreak timeOffset="00:06:00" breakType="linear"><vmap:AdSource><vmap:CustomAdData templateType="x">opaque</vmap:CustomAdData></vmap:AdSource></vmap:AdBreak>
      <vmap:AdBreak timeOffset="00:07:00" breakType="display"/>
      <vmap:AdBreak timeOffset="soon" breakType="linear"/>
    </vmap:VMAP>`);
  check('three linear breaks kept, in order', [doc.version, doc.breaks.map((b) => b.timeOffset)], ['1.0', ['start', '00:05:00.000', '00:06:00']]);
  check('a tag source (CDATA kept as is) with its break trackers (entities decoded)',
    [doc.breaks[0].breakId, doc.breaks[0].source, doc.breaks[0].tracking],
    ['pre', { kind: 'tag', url: 'https://ads.example/vast?a=1&b=2' }, { breakStart: ['https://ads.example/bs'], breakEnd: [], error: ['https://ads.example/err?c=[ERRORCODE]&x=1'] }]);
  check('an inline VAST source keeps the VAST document', [doc.breaks[1].source?.kind, (doc.breaks[1].source as any)?.xml.startsWith('<VAST version="3.0">')], ['vast', true]);
  check('custom ad data: the break is kept with no source', doc.breaks[2].source, null);
  check('a display break and an unreadable offset are left out and said', doc.problems.length, 3);
  check('no namespace prefix reads the same', M.parseVmap('<VMAP version="1.0"><AdBreak timeOffset="end" breakType="linear"><AdSource><AdTagURI>https://a.example/t</AdTagURI></AdSource></AdBreak></VMAP>').breaks.map((b) => [b.offset, b.source]),
    [[{ kind: 'end' }, { kind: 'tag', url: 'https://a.example/t' }]]);
  let threw = false;
  try { M.parseVmap('<VAST version="4.0"></VAST>'); } catch { threw = true; }
  truthy('a VAST answer where a VMAP was expected is an error', threw);
  const sf = M.sourceFetcher({ kind: 'vast', xml: '<VAST/>' }, async () => ({ status: 200, body: 'net' }));
  check('an inline source answers itself; a wrapper inside it goes to the network',
    [sf.url, (await sf.fetcher(sf.url, 10)).body, (await sf.fetcher('https://w.example', 10)).body], [M.INLINE_URL, '<VAST/>', 'net']);

  console.log('\n== the plan ==');
  const pol = P.resolveVodAdPolicy({ schedule: 'vmap' });
  const bounds = Array.from({ length: 450 }, (_, i) => i * 4);
  const vb = (timeOffset: string, id: string) => ({ timeOffset, offset: M.parseOffset(timeOffset)!, breakId: id, source: { kind: 'tag' as const, url: `https://a.example/${id}` }, tracking: { breakStart: [], breakEnd: [], error: [] } });
  let plan = P.planVmapBreaks(1800, [vb('start', 'p'), vb('00:10:01.500', 'm1'), vb('00:10:02', 'm2'), vb('50%', 'h'), vb('#1', 'c'), vb('00:40:00', 'late'), vb('end', 'e')], pol, { boundaries: bounds, cuesSec: [1200] });
  check('pre at 0, mids snapped to segment starts (601.5 and 602 to 600), 50% at 900, #1 at the cue, post at the end; past the end dropped',
    plan.map((b) => [b.index, b.position, b.atSec, b.source]), [[0, 'pre', 0, 'vmap'], [1, 'mid', 600, 'vmap'], [2, 'mid', 900, 'vmap'], [3, 'mid', 1200, 'vmap'], [4, 'post', 1800, 'vmap']]);
  check('two AdBreaks on one moment are one pod, their sources in order', [plan[1].vmap?.breakIds, plan[1].vmap?.sources.map((s: any) => s.url)], [['m1', 'm2'], ['https://a.example/m1', 'https://a.example/m2']]);
  check('a break\'s planned length is the rule\'s for its position (only used when the ad server sends nothing)', plan.map((b) => b.durationSec), [15, 60, 60, 60, 15]);
  check('a mid that snaps to the very start is the pre-roll', P.planVmapBreaks(1800, [vb('00:00:01', 'x')], pol, { boundaries: bounds }).map((b) => [b.position, b.atSec]), [['pre', 0]]);
  check('no_mid: the ad server\'s pre and post only', P.planVmapBreaks(1800, [vb('start', 'p'), vb('00:10:00', 'm'), vb('end', 'e')], pol, { titleRule: 'no_mid' }).map((b) => b.position), ['pre', 'post']);
  check('an ad-free title gets nothing, whatever the ad server says', P.planVmapBreaks(1800, [vb('start', 'p')], pol, { titleRule: 'none' }), []);
  check('the policy: schedule and VMAP address kept; anything else falls back to Volt\'s rules',
    [P.resolveVodAdPolicy({ schedule: 'vmap', vmapUrl: ' https://ads.example/vmap?x=[CONTENT_ID] ' }).vmapUrl, P.resolveVodAdPolicy({ schedule: 'other', vmapUrl: 'javascript:x' }).schedule, P.resolveVodAdPolicy({ vmapUrl: 'javascript:x' }).vmapUrl, P.resolveVodAdPolicy({}).schedule],
    ['https://ads.example/vmap?x=[CONTENT_ID]', 'rules', '', 'rules']);

  console.log('\n== break trackers on the pod ==');
  const VA = await import('../src/services/vodAds');
  const entry: any = { kind: 'ad', durationSec: 15, impressions: ['i'], tracking: { breakStart: ['bs'], breakEnd: ['be'], complete: ['c'] } };
  check('the first segment of the first ad: breakStart before the impression', VA.eventsDueAt(entry, 0, false).map((e) => e.event), ['breakStart', 'impression', 'creativeView', 'start']);
  check('the last segment of the last ad: complete, then breakEnd', VA.eventsDueAt(entry, 12, true).slice(-2).map((e) => e.event), ['complete', 'breakEnd']);
  check('an ad with no break trackers sends none (no empty rows)', VA.eventsDueAt({ ...entry, tracking: {} }, 12, true).some((e) => e.event.startsWith('break')), false);

  // ---------------------------------------------------------------- the real thing
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vmap-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vmap-${tag}@volt.test`]))!.id;
  const mk = async (title: string, sec: number, extra: { cues?: number[]; metadata?: any } = {}) => {
    const id = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status, break_cues_ms, metadata)
      VALUES ($1,'upload','clip',$2,0,$3,$3,'ready',$4,$5::jsonb) RETURNING id`, [acct, title, sec * 1000, extra.cues ?? [], JSON.stringify(extra.metadata ?? {})]))!.id;
    writeAsset(join(process.env.CLIPS_DIR!, 'vod', id), sec);
    await query(`UPDATE vod_assets SET master_key = $2, published = true WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    return id;
  };
  const film = await mk('A film', 1800, { cues: [1200000] });
  const ad15 = await mk('Spring sale', 15);
  const ad10 = await mk('Autumn sale', 10);
  const house = await mk('House promo', 10);
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-1',$2,'ready',15000), ($1,'ad-id.org:UAI-2',$3,'ready',10000)`, [acct, ad15, ad10]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, vendor, tag_template, timeout_ms) VALUES ($1,'GAM stub','gam',$2,1000) RETURNING id`, [acct, `${VBASE}/vast/pre?sid=[SESSION_ID]`]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${signAccess({ sub: owner, account_id: acct, role: 'owner' } as any)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const gate = async (assetId: string, extra: any = {}) => {
    const r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestPlayer/1.0' }, body: JSON.stringify({ appKey: k.raw, assetId, ...extra }) });
    return { s: r.status, j: await r.json() as any };
  };
  const text = async (path: string) => { const r = await fetch(base + path, { redirect: 'manual' }); return { s: r.status, t: await r.text(), loc: r.headers.get('location') }; };
  const uris = (t: string) => t.split('\n').filter((l) => l && !l.startsWith('#'));
  const VMAP_URL = `${VBASE}/vmap?sid=[SESSION_ID]&dur=[CONTENT_DURATION]&cues=[CUE_POINTS]&ua=[CLIENTUA]&cid=[CONTENT_ID]`;
  const rule = (policy: any, adServerId: string | null = server) => api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy, adServerId, houseAds: [{ assetId: house }] });

  console.log('\n== the rule ==');
  let r = await rule({ schedule: 'vmap', vmapUrl: VMAP_URL }, null);
  check('VMAP needs an ad server to ask', [r.s, /ad server/.test(r.j?.error?.message ?? r.j?.message ?? JSON.stringify(r.j))], [400, true]);
  r = await rule({ schedule: 'vmap', vmapUrl: 'ftp://ads.example/vmap' });
  check('the VMAP address must be a web address', r.s, 400);
  r = await rule({ schedule: 'vmap', vmapUrl: VMAP_URL });
  check('the owner lets the ad server decide the breaks', [r.s, r.j.policy.schedule, r.j.policy.vmapUrl], [200, 'vmap', VMAP_URL]);

  console.log('\n== the plan in the console ==');
  r = await api('GET', `/api/vod/ads/assets/${film}/plan`);
  check('pre, mids at 600 (10:01.5 and 10:02 together), 900 (50%) and 1200 (#1, the cue point), post at the end',
    [r.s, r.j.schedule, r.j.vmap?.state, r.j.breaks.map((b: any) => [b.position, b.atSec, b.source])],
    [200, 'vmap', 'ok', [['pre', 0, 'vmap'], ['mid', 600, 'vmap'], ['mid', 900, 'vmap'], ['mid', 1200, 'vmap'], ['post', 1800, 'vmap']]]);
  check('the plan names the ad server\'s breaks and offsets', r.j.breaks[1], { index: 1, position: 'mid', atSec: 600, durationSec: 60, source: 'vmap', vmapBreakIds: ['mid1a', 'mid1b'], vmapOffsets: ['00:10:01.500', '00:10:02'] });
  check('what the ad server sent that cannot play is said (the overlay break, the unreadable offset)', r.j.vmap.problems.length, 2);
  const titleAsk = vmapRequests[vmapRequests.length - 1];
  check('the title\'s schedule is asked without a viewer, with its length and cue points',
    [titleAsk.searchParams.get('sid'), titleAsk.searchParams.get('dur'), titleAsk.searchParams.get('cues'), titleAsk.searchParams.get('cid')], ['', '1800', '1200', film]);

  console.log('\n== stitched: the breaks where VMAP says ==');
  const before = vmapRequests.length;
  const g1 = await gate(film, { sid: 'vmap-play-0001' });
  const sid = g1.j.ads?.sessionId;
  check('the gate opens a stitched session', [g1.s, g1.j.ads?.delivery, !!sid], [200, 'stitched', true]);
  const ask = vmapRequests.slice(before);
  check('one VMAP request for this viewer, with the session and the viewer\'s player', [ask.length, ask[0]?.searchParams.get('sid'), ask[0]?.searchParams.get('ua')], [1, sid, 'TestPlayer/1.0']);
  const v = await text(`/vod-ads/s/${sid}/v720.m3u8`);
  const vl = uris(v.t);
  const content = vl.filter((l) => l.includes(`/clips/vod/${film}/`)).map((l) => Number(l.match(/seg_(\d+)\.m4s$/)![1]));
  check('the content is whole and in order: 450 segments', [content.length, content.every((n, i) => n === i + 1)], [450, true]);
  const at = (n: number) => vl.indexOf(`/clips/vod/${film}/720p/seg_${n}.m4s`);
  truthy('the pre-roll opens the playlist', vl[0].includes(`/vod-ads/s/${sid}/seg/0/`));
  const between = (a: number, b: number) => vl.slice(at(a) + 1, at(b));
  truthy('the 10:01.5 break sits between segment 150 (ends 10:00) and 151', between(150, 151).length > 0 && between(150, 151).every((l) => l.includes(`/seg/1/`)), between(150, 151).join(' '));
  truthy('the 50% break between 225 and 226 (15:00)', between(225, 226).length > 0 && between(225, 226).every((l) => l.includes(`/seg/2/`)));
  truthy('the #1 break at the title\'s cue point, between 300 and 301 (20:00)', between(300, 301).length > 0 && between(300, 301).every((l) => l.includes(`/seg/3/`)));
  truthy('the post-roll closes the playlist', vl[vl.length - 1].includes(`/seg/4/`));
  const dec = await query<any>(`SELECT position, content_ms, break_ms, ad_ms, house_ms, fallback FROM vod_ad_breaks WHERE session_id=$1 ORDER BY break_index`, [sid]);
  check('each break filled from its own source: the tag (15 s), the inline VAST then the second tag (10 + 15 s), nothing back so a house spot, the post tag',
    dec.map((d) => [d.position, d.content_ms, d.break_ms, d.ad_ms, d.house_ms > 0]),
    [['pre', 0, 15000, 15000, false], ['mid', 600000, 25000, 25000, false], ['mid', 900000, 60000, 0, true], ['mid', 1200000, 60000, 0, true], ['post', 1800000, 15000, 15000, false]]);
  const row = await one<any>(`SELECT plan FROM vod_ad_sessions WHERE id=$1`, [sid]);
  check('the 600 s pod plays the ads in the order the ad server listed them', row.plan.breaks[1].pod.map((p: any) => p.creativeKey), ['ad-id.org:UAI-2', 'ad-id.org:UAI-1']);
  const tl = (await (await fetch(`${base}/vod-ads/s/${sid}/timeline.json`)).json()) as any;
  check('the timeline: schedule vmap, the breaks at content 0, 600, 900, 1200 and 1800',
    [tl.schedule, tl.vmap?.state, tl.breaks.map((b: any) => b.contentSec)], ['vmap', 'ok', [0, 600, 900, 1200, 1800]]);

  console.log('\n== beacons: VMAP\'s break trackers with the ad\'s own ==');
  hits.length = 0;
  const s0 = await text(`/vod-ads/s/${sid}/seg/0/0/v720/0`);
  await sleep(300);
  check('the pre-roll\'s first segment: breakStart, then the impression', [s0.s, hits.map((h) => h.path)], [302, ['/px/break-start', '/px/imp-pre']]);
  hits.length = 0;
  await text(`/vod-ads/s/${sid}/seg/0/0/v720/3`);
  await sleep(300);
  check('its last segment: complete, then breakEnd', hits.map((h) => h.path), ['/px/complete-pre', '/px/break-end']);
  hits.length = 0;
  await text(`/vod-ads/s/${sid}/seg/0/0/v720/3`);
  await sleep(200);
  check('each sent once', hits.length, 0);

  console.log('\n== guided: the shared playlist from the title\'s schedule, filled from the viewer\'s ==');
  const g2 = await gate(film, { caps: ['hls-interstitials'] });
  check('a player with interstitials gets the guided playlist', g2.j.ads?.delivery, 'guided');
  const gpath = g2.j.delivery.hls.replace(/master\.m3u8$/, 'v720.m3u8');
  const gv = await text(gpath);
  const starts = [...gv.t.matchAll(/com\.apple\.hls\.interstitial",START-DATE="([^"]+)"/g)].map((m) => m[1].slice(11, 19));
  check('interstitials at 0, 10:00, 15:00, 20:00 and the end', starts, ['00:00:00', '00:10:00', '00:15:00', '00:20:00', '00:30:00']);
  schedule = 'variant';   // this viewer's schedule has no 50% break
  const n0 = vmapRequests.length;
  const list = async (b: number) => (await (await fetch(`${base}${gpath.replace(/v720\.m3u8$/, `list/${b}.json`)}?_HLS_primary_id=guided-viewer-1`)).json()) as any;
  const l1 = await list(1);
  check('the 10:00 break: this viewer\'s schedule asked once, its two ads', [vmapRequests.length - n0, l1.ASSETS.map((a: any) => a.DURATION)], [1, [10, 15]]);
  const l2 = await list(2);
  check('the 15:00 break, which this viewer\'s schedule does not have, plays nothing', [l2.ASSETS.length, vmapRequests.length - n0], [0, 1]);
  schedule = 'full';
  const g3 = await gate(film, { caps: ['hls-interstitials'] });
  check('the guided version follows the title\'s schedule (cached for five minutes, so the same now)', g3.j.delivery.hls, g2.j.delivery.hls);

  console.log('\n== what the ad server says no to, and when it is down ==');
  r = await rule({ schedule: 'vmap', vmapUrl: `${VBASE}/vmap-empty` });
  const ge = await gate(film, { sid: 'vmap-play-0002' });
  check('an empty schedule: the title plays as it is', [ge.s, ge.j.ads, ge.j.delivery.hls], [200, undefined, `/clips/vod/${film}/master.m3u8`]);
  const nomid = await mk('No mid', 1800, { metadata: { adRule: 'no_mid' } });
  r = await rule({ schedule: 'vmap', vmapUrl: VMAP_URL });
  r = await api('GET', `/api/vod/ads/assets/${nomid}/plan`);
  check('a title marked no_mid takes the ad server\'s pre and post only', r.j.breaks.map((b: any) => b.position), ['pre', 'post']);

  r = await rule({ schedule: 'vmap', vmapUrl: `${VBASE}/vmap-slow` });
  const vastBefore = vastRequests.length;
  const t0 = Date.now();
  const gs = await gate(film, { sid: 'vmap-play-0003' });
  const took = Date.now() - t0;
  const ssid = gs.j.ads?.sessionId;
  truthy('a slow ad server: the viewer waits no longer than its budget (1 s)', took < 1900, `${took} ms`);
  await text(`/vod-ads/s/${ssid}/v720.m3u8`);
  const sd = await query<any>(`SELECT position, content_ms, ad_ms, house_ms > 0 AS house, fallback FROM vod_ad_breaks WHERE session_id=$1 ORDER BY break_index`, [ssid]);
  check('the rule\'s own breaks (pre, the cue point at 20:00), house spots, marked vmap-timeout',
    sd.map((d) => [d.position, d.content_ms, d.ad_ms, d.house, d.fallback]), [['pre', 0, 0, true, 'vmap-timeout'], ['mid', 1200000, 0, true, 'vmap-timeout']]);
  check('the ad server is not asked again for each break', vastRequests.length, vastBefore);
  const stl = (await (await fetch(`${base}/vod-ads/s/${ssid}/timeline.json`)).json()) as any;
  check('the timeline says why', [stl.schedule, stl.vmap?.state], ['vmap', 'timeout']);

  r = await rule({ schedule: 'vmap', vmapUrl: `${VBASE}/vmap-down` });
  const gd = await gate(film, { sid: 'vmap-play-0004' });
  await text(`/vod-ads/s/${gd.j.ads?.sessionId}/v720.m3u8`);
  const dd = await query<any>(`SELECT DISTINCT fallback FROM vod_ad_breaks WHERE session_id=$1`, [gd.j.ads?.sessionId]);
  check('an ad server that answers 503: the same, marked vmap-error', dd.map((d) => d.fallback), ['vmap-error']);
  r = await api('GET', `/api/vod/ads/assets/${film}/plan`);
  check('the console plan shows the rule\'s breaks and that the schedule could not be had', [r.j.vmap?.state, r.j.breaks.map((b: any) => b.vmapFailed)], ['error', ['error', 'error']]);

  r = await rule({ schedule: 'rules' });
  r = await api('GET', `/api/vod/ads/assets/${film}/plan`);
  check('back to Volt\'s rules: the cue point mid-roll and the pre-roll, no VMAP', [r.j.schedule, r.j.vmap, r.j.breaks.map((b: any) => b.source)], ['rules', null, ['pre', 'cue']]);

  srv.close(); stub.close(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
