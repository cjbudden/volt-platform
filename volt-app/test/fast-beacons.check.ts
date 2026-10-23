// ============================================================================
//  SERVER-SIDE AD BEACONS for stitched breaks (build queue 1.11).
//
//  1. The pure parts (beacons.ts): each paid ad of a pod laid on the break's
//     clock with its impression, quartile and progress beacons; where a live
//     player is on a playlist; which beacons a refresh makes due, in order,
//     and which it skips (first sight, a gap in refreshes); IAB macros; the
//     private address guard (beaconSender.ts).
//  2. End to end through the real API and Postgres: a stitched FAST channel
//     whose playlist is written live by a stand-in playout (2 s segments, a
//     16 s break), a local VAST stub (a wrapper and two inline ads, trackers
//     pointing back at the stub, one of them answering 500), and three
//     viewers refreshing their session playlists every second like a player:
//       S1 watches the whole break (video and audio playlists): every beacon
//          of both ads reaches the stub once, in order (impression, start,
//          quartiles, progress, complete), each about one hold back after its
//          moment, with the viewer's address and player in X-Device-IP and
//          X-Device-User-Agent, macros filled;
//       S2 leaves at the first ad's first quartile: no midpoint, no complete;
//       S3 joins mid-break: it is given the house fill, so it reports nothing.
//     Then the ad report and the per-break beacons route show exactly that,
//     and another account cannot read them.
//
//  Needs DATABASE_URL (a migrated, disposable database). About 50 s.
//  Usage: DATABASE_URL=... npx tsx test/fast-beacons.check.ts
// ============================================================================
import { createServer as httpServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORK = mkdtempSync(join(tmpdir(), 'fast-beacons-'));
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.FAST_OUTPUT = 'local';
process.env.FAST_SEGMENT_SEC = '2';
process.env.AD_BEACONS_ALLOW_PRIVATE = '1'; // the VAST stub is on 127.0.0.1
process.env.ORCH_LAUNCHER ??= 'mock';
process.env.ORCH_TICK_SECONDS ??= '3600';
process.env.JWT_ACCESS_SECRET ??= 'x';
process.env.JWT_REFRESH_SECRET ??= 'y';
process.env.INGEST_TOKEN ??= 'z';

(async () => {
  const { adSchedule, playheadOf, dueBeacons, fillBeaconUrl, progressOffsetSec } = await import('../src/services/fast/beacons');
  const { refuseUrl } = await import('../src/services/fast/beaconSender');
  type PodItem = import('../src/services/fast/pod').PodItem;

  // ---------------------------------------------------------------- pure
  console.log('== each ad on the break clock, with its beacons ==');
  const B0 = Date.parse('2026-10-23T10:00:00.000Z');
  const adA: PodItem = { kind: 'ad', adId: 'A', creativeKey: 'k:A', assetId: 'a', durationSec: 10, title: 'A',
    impressions: ['https://w/imp', 'https://i/imp'],
    tracking: { start: ['https://i/start'], creativeView: ['https://i/cv'], firstQuartile: ['https://i/q1'], midpoint: ['https://i/mid'], thirdQuartile: ['https://i/q3'], complete: ['https://i/done', 'https://w/done'],
      'progress@00:00:05': ['https://i/p5'], 'progress@50%': ['https://i/p50'], pause: ['https://i/pause'], mute: ['https://i/mute'] } };
  const house: PodItem = { kind: 'house', assetId: 'h', durationSec: 4, title: 'Promo' };
  const adB: PodItem = { ...adA, adId: 'B', creativeKey: 'k:B', durationSec: 6, impressions: ['https://b/imp'], tracking: { start: ['https://b/start'], complete: ['https://b/done'] } };
  const sched = adSchedule('brk:1', [adA, house, adB], B0, 20);
  ok(sched.length === 2 && sched[0].podIndex === 0 && sched[1].podIndex === 2, 'two paid ads; the house spot gets no beacons; positions count it', JSON.stringify(sched.map((s) => s.podIndex)));
  ok(sched[1].startMs === B0 + 14000, 'the second ad starts after the first and the house spot (14 s)');
  const evA = sched[0].events.map((e) => `${e.event}@${(e.atMs - B0) / 1000}`);
  ok(evA.join(' ') === 'impression@0 creativeView@0 start@0 firstQuartile@2.5 midpoint@5 progress@00:00:05@5 progress@50%@5 thirdQuartile@7.5 complete@10', 'VAST order at the same moment; quartiles at 25/50/75/100 %; progress offsets as time and as percent', evA.join(' '));
  ok(!sched[0].events.some((e) => e.event === 'pause' || e.event === 'mute'), 'player-only events (pause, mute) are not sent by the server');
  ok(sched[0].events[0].urls.length === 2 && sched[0].events.find((e) => e.event === 'complete')!.urls.length === 2, 'a wrapper\'s and the inline ad\'s URLs both go out');
  const cut = adSchedule('brk:2', [{ ...adA, durationSec: 30 }, adB], B0, 20);
  ok(cut.length === 1 && cut[0].events.find((e) => e.event === 'complete')!.atMs === B0 + 20000, 'an ad cut by the break end completes at the break end; one that would start after it gets nothing');
  ok(sched[1].events.map((e) => e.event).join(',') === 'impression,start,complete', 'only the events the ad server asked for');
  ok(progressOffsetSec('00:00:05.500', 10) === 5.5 && progressOffsetSec('25%', 8) === 2 && progressOffsetSec('00:01:00', 10) === null && progressOffsetSec('soon', 10) === null, 'progress offsets: time, percent, past the end and nonsense');

  console.log('== where the player is ==');
  const pl = (extra: string, n = 4) => ['#EXTM3U', '#EXT-X-TARGETDURATION:2', extra, '#EXT-X-MEDIA-SEQUENCE:10', ...Array.from({ length: n }, (_, k) => `#EXT-X-PROGRAM-DATE-TIME:${new Date(B0 + k * 2000).toISOString()}\n#EXTINF:2.000,\ns${k}.m4s`)].filter(Boolean).join('\n') + '\n';
  ok(playheadOf(pl('')) === B0 + 8000 - 6000, 'three target durations behind the newest segment\'s end', String((playheadOf(pl('')) ?? 0) - B0));
  ok(playheadOf(pl('#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12,HOLD-BACK=4.5')) === B0 + 8000 - 4500, 'HOLD-BACK when the playlist states it');
  ok(playheadOf('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n') === null && playheadOf('nonsense') === null, 'no PROGRAM-DATE-TIME (or no playlist): no playhead, nothing sent');

  console.log('== which beacons a refresh makes due ==');
  const st: any = { done: [] };
  let r = dueBeacons(st, sched, B0 - 3000, 1000);
  ok(r.due.length === 0 && r.skipped.length === 0, 'first refresh before the break: nothing, the clock starts');
  r = dueBeacons(st, sched, B0 + 100, 2000);
  ok(r.due.map((d) => d.event).join(',') === 'impression,creativeView,start', 'the playhead reaches the first ad: impression, creativeView, start, in that order', r.due.map((d) => d.event).join(','));
  r = dueBeacons(st, sched, B0 + 100, 3000);
  ok(r.due.length === 0, 'a second refresh at the same place sends nothing again');
  r = dueBeacons(st, sched, B0 + 6000, 4000);
  ok(r.due.map((d) => d.event).join(',') === 'firstQuartile,midpoint,progress@00:00:05,progress@50%', 'quartiles and progress as the playhead passes them', r.due.map((d) => d.event).join(','));
  r = dueBeacons(st, sched, B0 + 5000, 5000);
  ok(r.due.length === 0 && st.lastPlayheadMs === B0 + 6000, 'the playhead never moves back (audio and video playlists end a little apart)');
  r = dueBeacons(st, sched, B0 + 16000, 5000 + 31_000);
  ok(r.due.length === 0 && r.skipped.map((d) => d.event).join(',') === 'thirdQuartile,complete,impression,start', 'refreshes stopped for over 30 s: what fell due meanwhile is skipped, not sent late', r.skipped.map((d) => d.event).join(','));
  r = dueBeacons(st, sched, B0 + 30000, 5000 + 33_000);
  ok(r.due.map((d) => `${d.adId}:${d.event}`).join(',') === 'B:complete', 'after the gap the clock carries on', r.due.map((d) => `${d.adId}:${d.event}`).join(','));
  dueBeacons(st, [], B0 + 40000, 5000 + 34_000);
  ok(st.done.length === 0, 'breaks no longer in play are forgotten');
  const late: any = { done: [] };
  r = dueBeacons(late, sched, B0 + 8000, 1000);
  ok(r.due.length === 0 && r.skipped.some((d) => d.event === 'impression'), 'a session first seen mid-ad sends nothing for what it did not see start');

  console.log('== macros and addresses ==');
  const filled = fillBeaconUrl('https://t/x?ts=[TIMESTAMP]&cb=%5BCACHEBUSTING%5D&ph=[ADPLAYHEAD]&bp=[BREAKPOSITION]&v=[VENDOR_THING]', { nowMs: B0, adPlayheadSec: 2.5, cacheBuster: '12345678' });
  ok(filled === `https://t/x?ts=${encodeURIComponent('2026-10-23T10:00:00.000Z')}&cb=12345678&ph=${encodeURIComponent('00:00:02.500')}&bp=2&v=[VENDOR_THING]`, 'TIMESTAMP, encoded CACHEBUSTING, ADPLAYHEAD, BREAKPOSITION filled; unknown macros left', filled);
  ok(/^\d{8}$/.test(new URL(fillBeaconUrl('https://t/?c=[CACHEBUSTING]', { nowMs: 0, adPlayheadSec: 0 })).searchParams.get('c') ?? ''), 'a fresh 8 digit cache buster when none is given');
  ok((await refuseUrl('http://127.0.0.1/x', false)) !== null && (await refuseUrl('http://[::1]/x', false)) !== null && (await refuseUrl('http://10.1.2.3/x', false)) !== null && (await refuseUrl('http://169.254.169.254/latest', false)) !== null, 'loopback, private and metadata addresses are refused');
  ok((await refuseUrl('ftp://93.184.216.34/x', false)) !== null && (await refuseUrl('not a url', false)) !== null, 'only http and https');
  ok((await refuseUrl('https://93.184.216.34/x', false)) === null && (await refuseUrl('http://127.0.0.1/x', true)) === null, 'a public address passes; AD_BEACONS_ALLOW_PRIVATE=1 lets a local stub through');

  // ---------------------------------------------------------------- end to end
  if (!process.env.DATABASE_URL) { console.log('SKIP end to end: DATABASE_URL is not set'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  // ---- the VAST stub: a wrapper around ad A, ad B inline; every tracker comes back here
  type Hit = { t: number; path: string; q: URLSearchParams; h: IncomingMessage['headers'] };
  const hits: Hit[] = [];
  let vastAsks = 0;
  const stub = httpServer((q, s) => {
    const u = new URL(q.url ?? '/', 'http://x');
    if (u.pathname === '/vast' || u.pathname === '/inline') {
      if (u.pathname === '/vast') vastAsks++;
      const sid = u.searchParams.get('s') ?? '';
      const T = (ad: string, e: string, extra = '') => `${STUB}/t/${ad}/${e}?s=${sid}&ts=[TIMESTAMP]&cb=[CACHEBUSTING]&ph=[ADPLAYHEAD]${extra}`;
      const inlineAd = (id: string, seq: number, dur: string, uai: string, events: string[], impWrapper = false) => `<Ad id="${id}" sequence="${seq}"><InLine><AdSystem>Stub</AdSystem><AdTitle>Ad ${id}</AdTitle>
        <Impression><![CDATA[${T(id, 'impression', '&from=inline')}]]></Impression>${impWrapper ? '' : ''}
        <Creatives><Creative id="c${id}"><UniversalAdId idRegistry="ad-id.org">${uai}</UniversalAdId><Linear><Duration>${dur}</Duration><TrackingEvents>
        ${events.map((e) => e.startsWith('progress@') ? `<Tracking event="progress" offset="${e.slice(9)}"><![CDATA[${T(id, e)}]]></Tracking>` : `<Tracking event="${e}"><![CDATA[${T(id, e, e === 'complete' && id === 'B' ? '&fail=1' : '')}]]></Tracking>`).join('')}
        </TrackingEvents><MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="640" height="360">${STUB}/m/${id}.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad>`;
      s.writeHead(200, { 'content-type': 'application/xml' });
      if (u.pathname === '/inline') return s.end(`<VAST version="4.2">${inlineAd('A', 1, '00:00:08', 'UAI-A', ['creativeView', 'start', 'firstQuartile', 'midpoint', 'progress@00:00:05', 'thirdQuartile', 'complete'])}</VAST>`);
      return s.end(`<VAST version="4.2"><Ad id="WA" sequence="1"><Wrapper><AdSystem>SSP</AdSystem><VASTAdTagURI><![CDATA[${STUB}/inline?s=${sid}]]></VASTAdTagURI>
        <Impression><![CDATA[${T('A', 'impression', '&from=wrapper')}]]></Impression>
        <Creatives><Creative><Linear><TrackingEvents><Tracking event="start"><![CDATA[${T('A', 'start', '&from=wrapper')}]]></Tracking></TrackingEvents></Linear></Creative></Creatives></Wrapper></Ad>
        ${inlineAd('B', 2, '00:00:04', 'UAI-B', ['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete'])}</VAST>`);
    }
    if (u.pathname.startsWith('/t/')) {
      hits.push({ t: Date.now(), path: u.pathname, q: u.searchParams, h: q.headers });
      if (u.searchParams.get('fail')) { s.writeHead(500); return s.end('no'); }
      if (u.searchParams.get('hop') == null && u.pathname === '/t/A/firstQuartile' && u.searchParams.get('s') === 'viewer-one-0001') {
        // a tracker that redirects: followed by hand, and the next hop is checked too
        s.writeHead(302, { location: `${STUB}${u.pathname}?${u.searchParams.toString()}&hop=1` }); return s.end();
      }
      s.writeHead(200, { 'content-type': 'image/gif' }); return s.end('GIF89a');
    }
    s.writeHead(404); s.end();
  });
  await new Promise<void>((res) => stub.listen(0, '127.0.0.1', () => res()));
  const STUB = `http://127.0.0.1:${(stub.address() as any).port}`;

  // ---- seed: an account with a stitched FAST channel, two conditioned creatives and a house spot
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`beacons-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `beacons-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[{"height":360,"bitrate_kbps":800}]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, origin, recording_enabled) VALUES ($1,'Beacon FAST','playlist',false) RETURNING id`, [grp]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`beacons-other-${tag}`]))!.id;
  const otherUser = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [other, `beacons-other-${tag}@volt.test`]))!.id;

  const clips = process.env.CLIPS_DIR!;
  const asset = async (title: string, secs: number) => {
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata) VALUES ($1,'upload','clip',$2,0,$3,$3,$4::jsonb) RETURNING id`, [acct, title, secs * 1000, JSON.stringify({ title })]))!.id;
    const dir = join(clips, 'vod', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'master.m3u8'), `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"\nv360.m3u8\n`);
    const media = (p: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="${p}_init.mp4"\n` + Array.from({ length: secs / 2 }, (_, k) => `#EXTINF:2.000,\n${p}_${k + 1}.m4s`).join('\n') + '\n#EXT-X-ENDLIST\n';
    writeFileSync(join(dir, 'v360.m3u8'), media('v'));
    writeFileSync(join(dir, 'audio.m3u8'), media('a'));
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [id, `/clips/vod/${id}/master.m3u8`]);
    return String(id);
  };
  const aA = await asset('Ad A', 8), aB = await asset('Ad B', 4), promo = await asset('Promo', 4);
  await query(`INSERT INTO ad_creatives (account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-A',$2,'ready',8000), ($1,'ad-id.org:UAI-B',$3,'ready',4000)`, [acct, aA, aB]);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const otherTok = signAccess({ sub: otherUser, account_id: other, role: 'owner' });
  const api = async (method: string, path: string, body?: any, t = tok) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const tx = await res.text(); let j: any = null; try { j = JSON.parse(tx); } catch { j = tx; }
    return { s: res.status, j };
  };

  let writer: NodeJS.Timeout | null = null;
  try {
    console.log('== a stitched channel with a 16 s break ==');
    let x = await api('POST', '/api/fast/ad-servers', { name: 'Stub', tagTemplate: `${STUB}/vast?s=[SESSION_ID]&d=[BREAK_DURATION]`, timeoutMs: 1500 });
    ok(x.s === 201 || x.s === 200, 'ad server added through the API', JSON.stringify(x.j).slice(0, 200));
    x = await api('PUT', `/api/fast/channels/${ch}/ads`, { mode: 'stitched', adServerId: x.j.id, houseAds: [{ assetId: promo }], scope: 'session' });
    ok(x.s === 200 && x.j.mode === 'stitched', 'channel set to stitched ads, decided per viewer', JSON.stringify(x.j).slice(0, 200));

    // the stand-in playout: 2 s segments from T0, the break at T0 + 20 s for 16 s, a 6 segment window
    const BREAK_S = 16;
    const T0 = Math.ceil((Date.now() + 3000) / 1000) * 1000;
    const BS = T0 + 20000, BE = BS + BREAK_S * 1000;
    const brk = (await one<any>(`INSERT INTO stream_breaks (channel_id, source, starts_at, duration_ms, position) VALUES ($1,'fast',$2,$3,'mid') RETURNING id`, [ch, new Date(BS).toISOString(), BREAK_S * 1000]))!.id;
    const out = join(process.env.ORIGIN_DIR!, ch, 'fast');
    mkdirSync(out, { recursive: true });
    const inBreak = (t: number) => t >= BS && t < BE;
    const write = () => {
      const now = Date.now();
      const n = Math.floor((now - T0) / 2000); // segments published
      if (n < 1) return;
      for (const tr of ['v360', 'audio']) {
        const first = Math.max(0, n - 6);
        let dsn = 0;
        for (let k = 1; k <= first; k++) if (inBreak(T0 + k * 2000) !== inBreak(T0 + (k - 1) * 2000)) dsn++;
        const L = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${dsn}`];
        for (let k = first; k < n; k++) {
          const t = T0 + k * 2000, b = inBreak(t);
          if (k > first && b !== inBreak(t - 2000)) L.push('#EXT-X-DISCONTINUITY');
          if (k === first || b !== inBreak(t - 2000)) L.push(`#EXT-X-MAP:URI="/clips/${b ? 'house' : 'content'}/${tr}_init.mp4"`);
          if (t === BS) { L.push(`#EXT-X-DATERANGE:ID="brk:${brk}",CLASS="com.boomlabs.volt.ad",START-DATE="${new Date(BS).toISOString()}",PLANNED-DURATION=${BREAK_S}.000,DURATION=${BREAK_S}.000`); L.push(`#EXT-X-CUE-OUT:DURATION=${BREAK_S}.000`); }
          else if (b) L.push(`#EXT-X-CUE-OUT-CONT:ElapsedTime=${((t - BS) / 1000).toFixed(3)},Duration=${BREAK_S}.000`);
          else if (inBreak(t - 2000)) L.push('#EXT-X-CUE-IN');
          L.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t).toISOString()}`, '#EXTINF:2.000,', `/clips/${b ? 'house' : 'content'}/${tr}_${k}.m4s`);
        }
        writeFileSync(join(out, `${tr}.m3u8.tmp`), L.join('\n') + '\n');
        renameSync(join(out, `${tr}.m3u8.tmp`), join(out, `${tr}.m3u8`));
      }
      writeFileSync(join(out, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nv360.m3u8\n');
    };
    writer = setInterval(write, 200);
    while (Date.now() < T0 + 2300) await sleep(100);

    // ---- three viewers, refreshing like players
    type Viewer = { sid: string; ua: string; from: number; until: number; tracks: string[]; got: string[] };
    const S1: Viewer = { sid: 'viewer-one-0001', ua: 'TestPlayer/1.0 (S1)', from: 0, until: BE + 7000, tracks: ['v360', 'audio'], got: [] };
    const S2: Viewer = { sid: 'viewer-two-0002', ua: 'TestPlayer/1.0 (S2)', from: 0, until: T0 + 29300, tracks: ['v360'], got: [] };
    const S3: Viewer = { sid: 'viewer-three-0003', ua: 'TestPlayer/1.0 (S3)', from: BS + 14000, until: BE + 7000, tracks: ['v360'], got: [] };
    const run = async (v: Viewer) => {
      while (Date.now() < v.from) await sleep(100);
      while (Date.now() < v.until) {
        await Promise.all(v.tracks.map(async (tr) => {
          const res = await fetch(`${base}/fast/${ch}/s/${v.sid}/${tr}.m3u8`, { headers: { 'user-agent': v.ua } }).catch(() => null);
          if (res?.ok) v.got.push(await res.text());
        }));
        await sleep(1000);
      }
    };
    await Promise.all([run(S1), run(S2), run(S3)]);
    await sleep(1500); // the last sends finish
    clearInterval(writer); writer = null;

    const stitchedSeen = (v: Viewer) => v.got.some((t) => t.includes(`/clips/vod/${aA}/`));
    ok(stitchedSeen(S1) && stitchedSeen(S2), 'S1 and S2 were given the stitched pod (ad A segments in their playlists)');
    ok(!stitchedSeen(S3) && S3.got.some((t) => t.includes('/clips/house/')), 'S3, joining mid-break, was given the house fill');
    ok(vastAsks >= 2, `the ad server was asked per viewer (${vastAsks})`);

    console.log('== what reached the ad server ==');
    const of = (sid: string) => hits.filter((h) => h.q.get('s') === sid && h.q.get('hop') == null);
    const name = (h: Hit) => h.path.replace('/t/', '').replace('/', ':');
    const s1 = of(S1.sid);
    const expect = ['A:impression', 'A:impression', 'A:creativeView', 'A:start', 'A:start', 'A:firstQuartile', 'A:midpoint', 'A:progress@00:00:05', 'A:thirdQuartile', 'A:complete',
      'B:impression', 'B:start', 'B:firstQuartile', 'B:midpoint', 'B:thirdQuartile', 'B:complete'];
    const order = (n: string) => expect.indexOf(n);
    ok(s1.map(name).sort().join(',') === [...expect].sort().join(','), 'S1: every beacon of both ads, each once (video and audio playlists both refreshing)', s1.map(name).join(','));
    ok(s1.every((h, i) => i === 0 || order(name(h)) >= order(name(s1[i - 1]))), 'S1: in order: impression, creativeView, start, quartiles, progress, complete; ad A before ad B', s1.map(name).join(','));
    const imp = s1.filter((h) => name(h) === 'A:impression').map((h) => h.q.get('from')).sort().join(',');
    ok(imp === 'inline,wrapper', 'the wrapper\'s impression and the inline ad\'s both sent');
    const firstQ = hits.filter((h) => h.path === '/t/A/firstQuartile' && h.q.get('s') === S1.sid);
    ok(firstQ.length === 2 && firstQ[1].q.get('hop') === '1', 'a redirecting tracker is followed to its next hop');
    // timing: each is sent once the player (3 x 2 s behind the newest segment) reaches its moment
    const due: Record<string, number> = { 'A:impression': BS, 'A:start': BS, 'A:firstQuartile': BS + 2000, 'A:midpoint': BS + 4000, 'A:thirdQuartile': BS + 6000, 'A:complete': BS + 8000, 'B:impression': BS + 8000, 'B:complete': BS + 12000 };
    const lags = s1.filter((h) => due[name(h)] != null).map((h) => h.t - due[name(h)]);
    ok(lags.every((l) => l >= 5800 && l <= 9500), `each beacon about one hold back (6 s) after its moment in the stream: ${Math.min(...lags)} to ${Math.max(...lags)} ms`, lags.join(','));
    const h1 = s1[0];
    ok(h1.h['x-device-user-agent'] === S1.ua && !!h1.h['x-device-ip'] && h1.h['user-agent'] === 'Volt-SSAI/1.0', 'the viewer\'s player and address in X-Device-User-Agent and X-Device-IP; Volt\'s own User-Agent', JSON.stringify({ ua: h1.h['user-agent'], d: h1.h['x-device-user-agent'], ip: h1.h['x-device-ip'] }));
    const q1 = s1.find((h) => name(h) === 'A:firstQuartile')!;
    ok(!Number.isNaN(Date.parse(q1.q.get('ts') ?? '')) && /^\d{8}$/.test(q1.q.get('cb') ?? '') && q1.q.get('ph') === '00:00:02.000', 'macros filled: TIMESTAMP, CACHEBUSTING, ADPLAYHEAD (2 s into an 8 s ad)', q1.q.toString());
    const s2 = of(S2.sid).map(name);
    ok(s2.includes('A:impression') && s2.includes('A:start') && s2.includes('A:firstQuartile'), 'S2 (left at the first quartile): impression, start, first quartile', s2.join(','));
    ok(!s2.includes('A:midpoint') && !s2.includes('A:complete') && !s2.some((n) => n.startsWith('B:')), 'S2: no midpoint, no complete, nothing for ad B');
    ok(of(S3.sid).length === 0, 'S3 (house fill): nothing reported');

    console.log('== what Volt recorded ==');
    const rows = await query<any>(`SELECT session_id, pod_index, event, status, ok, error FROM ad_beacons WHERE break_id = $1`, [brk]);
    ok(rows.filter((x) => x.session_id === S1.sid).length === 16 && rows.filter((x) => x.session_id === S2.sid).length === s2.length, `one row per URL sent (${rows.length})`);
    const bad = rows.filter((x) => x.ok === false);
    ok(bad.length === 1 && bad[0].event === 'complete' && bad[0].pod_index === 1 && bad[0].status === 500 && /500/.test(bad[0].error ?? ''), 'the tracker answering 500 is recorded as failed, with its status', JSON.stringify(bad));
    ok(rows.every((x) => x.ok !== null), 'nothing left half sent');

    x = await api('GET', `/api/fast/channels/${ch}/ad-report`);
    const b = x.j.beacons;
    ok(x.s === 200 && b && b.impressions === 3 && b.completes === 2, 'ad report: 3 impressions (A and B for S1, A for S2), 2 completes', JSON.stringify(b));
    ok(b.completionRate === 0.667 && b.failed === 1 && b.events.firstQuartile.ads === 3 && b.events.midpoint.ads === 2, 'completion 67 %, 1 failed pixel, quartiles per ad', JSON.stringify(b?.events));
    ok(b.events.start.sent === 5 && b.events.impression.sent === 5, 'impression and start: the wrapper\'s and the inline URLs counted (2 each for ad A for S1 and S2, 1 for ad B)', JSON.stringify(b?.events));
    x = await api('GET', `/api/fast/channels/${ch}/breaks/${brk}/beacons`);
    const ads = x.j.ads ?? [];
    ok(x.s === 200 && ads.length === 2 && ads[0].podIndex === 0 && ads[1].podIndex === 1, 'per break: both ads of the pod', JSON.stringify(x.j).slice(0, 300));
    ok(ads[0]?.events.impression.sessions === 2 && ads[0]?.events.complete.sessions === 1 && ads[1]?.events.complete.failed === 1, 'per break: ad A seen by 2 viewers, completed by 1; ad B\'s complete failed', JSON.stringify(ads));
    ok(Array.isArray(x.j.recent) && x.j.recent.length === rows.length && x.j.recent.every((r: any) => r.host === STUB.replace('http://', '') && !('url' in r)), 'latest beacons with the tracker host, not the full URL');
    x = await api('GET', `/api/fast/channels/${ch}/breaks/${brk}/beacons`, undefined, otherTok);
    ok(x.s === 404, 'another account: 404', String(x.s));
    x = await api('GET', `/api/fast/channels/${ch}/breaks/00000000-0000-0000-0000-000000000000/beacons`);
    ok(x.s === 404, 'an unknown break: 404');
  } catch (e: any) {
    ok(false, 'end to end ran', e?.stack ?? String(e));
  } finally {
    if (writer) clearInterval(writer);
    srv.close(); stub.close();
    await pool.end().catch(() => null);
    rmSync(WORK, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
