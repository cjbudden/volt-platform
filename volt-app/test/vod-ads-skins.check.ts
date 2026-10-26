// ============================================================================
//  ON-DEMAND ADS IN THE BUILT-IN SKINS (build queue 1.14k-5).
//
//  Pure first (no database): the overlay's words in the player's string table,
//  the SDK reporting each ad in its break (as, ae inside abs, abe) as valid
//  CMCD v2 the collector accepts, and those reports giving a view its ad count
//  and the ads watched to the end, or none ended for a viewer who left.
//
//  Then the real API with a local VAST server: repeated player events (each
//  pause, resume, mute and unmute sent, a resent one not, old players counted
//  once, a cap), the SDK's ads controller on a stand-in media element (a
//  resume needs a pause first, a volume drag is not a mute, the breaks for a
//  scrubber as they are watched, the overlay's words translated), and the
//  Playback reports' ad count from a player's own reports through POST
//  /api/cmcd (overview and sessions).
//
//  Then a browser (Chromium, VP9 and Opus made by ffmpeg, the SDK bundled
//  from volt-player/src): the video skin playing a stitched session with the
//  overlay in French, the breaks marked on the scrubber (watched and not),
//  pauses and mutes during the ad reaching the session, and the player's own
//  CMCD reports carrying each ad. A screenshot goes to SHOT_DIR when set.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-ads-skins.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0, skipped = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected [${JSON.stringify(want)}] got [${JSON.stringify(got)}]`);
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || `got [${JSON.stringify(v)}]`));
const skip = (m: string) => { console.log('SKIP ' + m); skipped++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, timeoutMs: number, every = 150): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await fn()) return Date.now() - t0; } catch { /* not yet */ } await sleep(every); }
  return -1;
}

function writeHls(dir: string, totalSec: number, seg: number) {
  mkdirSync(dir, { recursive: true });
  const segs: number[] = [];
  for (let t = 0; t < totalSec - 1e-9; t += seg) segs.push(Math.min(seg, totalSec - t));
  const media = (folder: string) => ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${seg}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${folder}/init.mp4"`, ...segs.flatMap((d, i) => [`#EXTINF:${d.toFixed(3)},`, `${folder}/seg_${i + 1}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n');
  writeFileSync(join(dir, 'stream_0.m3u8'), media('720p'));
  writeFileSync(join(dir, 'stream_2.m3u8'), media('audio'));
  writeFileSync(join(dir, 'master.m3u8'), ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_2.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"', 'stream_0.m3u8', ''].join('\n'));
}

function ffmpegHls(dir: string, color: string, tone: number, sec: number) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=25`, '-f', 'lavfi', '-i', `sine=f=${tone}:sample_rate=48000`,
    '-t', String(sec), '-c:v', 'libvpx-vp9', '-g', '50', '-keyint_min', '50', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '64k',
    '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-hls_playlist', '1',
    '-init_seg_name', 'init-$RepresentationID$.mp4', '-media_seg_name', 'seg-$RepresentationID$-$Number%05d$.m4s', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    join(dir, 'manifest.mpd')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

(async () => {
  const ROOT = resolve(__dirname, '..');
  const PLAYER = resolve(ROOT, '../volt-player');
  const work = mkdtempSync(join(tmpdir(), 'vod-ads-skins-'));
  Object.assign(process.env, { CLIPS_DIR: join(work, 'clips'), AD_BEACONS_ALLOW_PRIVATE: '1', PUBLIC_BASE_URL: 'https://volt.example', QOE_RAW_DIR: join(work, 'qoe-raw') });
  delete process.env.QOE_RAW_BUCKET;

  // ---------------------------------------------------------------- pure
  console.log('== the overlay\'s words are the player\'s strings ==');
  const { STRINGS, format } = await import('../../volt-player/src/sdk/strings');
  check('ad, ad n of m, Learn more and the scrubber\'s break labels are in the string table', [STRINGS.ad, STRINGS.adOf, STRINGS.learnMore, STRINGS.adBreak, STRINGS.adBreakWatched],
    ['Ad', 'Ad {number} of {of}', 'Learn more', 'Ad break', 'Ad break, watched']);
  check('the count fills in', format(STRINGS.adOf, { number: 2, of: 3 }), 'Ad 2 of 3');

  console.log('\n== the SDK reports each ad inside its break (sdk/cmcd.ts) ==');
  const sdk = await import('../../volt-player/src/sdk/cmcd');
  const { checkEventReport, parseCmcdLine } = await import('../src/services/qoe/cmcdParse');
  const V = await import('../src/services/qoe/views');
  let cml: any = null;
  try { cml = await import(join(PLAYER, 'node_modules/@svta/cml-cmcd/dist/index.js')); } catch { /* checked below */ }
  const attemptLines = (script: (a: any) => void) => {
    const lines: string[] = [];
    const a = new sdk.PlayAttempt({ cid: 'skins-film', live: false, sender: { push: (l: string) => lines.push(l), flush: () => {} } as any, requestMode: false, autoplay: true });
    a.firstFrame();
    script(a);
    return { a, lines };
  };
  const watched = attemptLines((a) => {
    a.adStart();                                // outside a break: not reported
    a.adBreak('vod-0'); a.adStart(); a.adStart(); a.adEnd(); a.adStart(); a.adEnd(); a.adEnd(); a.adBreak(null);
    a.adBreak('vod-1'); a.adStart(); a.adBreak(null);   // the break ends with its ad still on: the ad ends with it
    a.close();
  });
  const es = watched.lines.map((l) => String(parseCmcdLine(l).e));
  check('two ads in the first break, one in the second, each reported once, ends before the break ends',
    es, ['ps', 'ps', 'abs', 'as', 'ae', 'as', 'ae', 'abe', 'abs', 'as', 'ae', 'abe', 'ps']);
  if (cml) truthy('every line a valid CMCD v2 event report (SVTA validator)', watched.lines.every((l) => cml.validateCmcdEvents(l).valid), JSON.stringify(watched.lines.filter((l) => !cml.validateCmcdEvents(l).valid)));
  else skip('SVTA validator (volt-player node_modules not installed)');
  truthy('and accepted by the collector', watched.lines.every((l) => checkEventReport(l).ok));
  const left = attemptLines((a) => { a.adBreak('vod-0'); a.adStart(); a.close(); a.adEnd(); a.adBreak(null); });
  check('a viewer who leaves during the ad: started, never ended, nothing after the close', left.lines.map((l) => String(parseCmcdLine(l).e)), ['ps', 'ps', 'abs', 'as', 'ps']);
  const view = (lines: string[], sid: string) => V.deriveAll(lines.map((line, i) => ({ acct: 'a1', sid, rt: Date.now() + i, app: null, line }))).views[0];
  const vw = view(watched.lines, watched.a.sid), vl = view(left.lines, left.a.sid);
  check('the view row: 3 ads played and 3 watched to the end in 2 breaks', [vw?.ads_started, vw?.ads_ended, vw?.ad_breaks, vw?.left_in_ad], [3, 3, 2, false]);
  check('the viewer who left: 1 ad played, none ended, left during an ad', [vl?.ads_started, vl?.ads_ended, vl?.left_in_ad], [1, 0, true]);

  // ---------------------------------------------------------------- the real API
  const hits: { path: string; ua: string | null }[] = [];
  const EVENTS = ['start', 'complete', 'pause', 'resume', 'mute', 'unmute'];
  const vast = httpServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/px/')) { hits.push({ path: u.pathname, ua: (req.headers['x-device-user-agent'] as string) ?? null }); res.writeHead(200); return res.end(); }
    const base = `http://127.0.0.1:${(vast.address() as any).port}`;
    const short = u.pathname === '/vast4';
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<VAST version="4.1"><Ad id="${short ? 'b4' : 'a1'}" sequence="1"><InLine><AdSystem>Stub</AdSystem><AdTitle>${short ? 'Red sale' : 'Spring sale'}</AdTitle>
      <Impression><![CDATA[${base}/px/imp]]></Impression><Creatives><Creative id="c1"><UniversalAdId idRegistry="ad-id.org">${short ? 'UAI-4' : 'UAI-1'}</UniversalAdId><Linear><Duration>00:00:${short ? '04' : '15'}</Duration>
      <TrackingEvents>${EVENTS.map((e) => `<Tracking event="${e}"><![CDATA[${base}/px/${e}]]></Tracking>`).join('')}</TrackingEvents>
      <VideoClicks><ClickThrough><![CDATA[https://advertiser.example/landing]]></ClickThrough></VideoClicks>
      <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1280" height="720"><![CDATA[${base}/ad.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`);
  });
  await new Promise<void>((r) => vast.listen(0, '127.0.0.1', () => r()));
  const VBASE = `http://127.0.0.1:${(vast.address() as any).port}`;

  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');
  const adb = await import('../src/services/qoe/analyticsDb');
  const coll = await import('../src/services/qoe/collector');
  const { config } = await import('../src/config');
  const aname = new URL(adb.analyticsUrl()).pathname.slice(1);
  const dropAnalytics = async () => {
    const { Client } = await import('pg'); const u = new URL(config.databaseUrl); u.pathname = '/postgres';
    const c = new Client({ connectionString: u.toString() }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${aname}" WITH (FORCE)`); await c.end();
  };
  await dropAnalytics();

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vak-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vak-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'VAK Ch','ended') RETURNING id`, [g]))!.id;
  const shortType = (await one<any>(`INSERT INTO metadata_schemas(account_id, name) VALUES ($1,'Short films') RETURNING id`, [acct]))!.id;
  const mkAsset = async (title: string, sec: number, write: (dir: string) => void, o: { schema?: string | null; cues?: number[] } = {}) => {
    const id = (await one<any>(`INSERT INTO vod_assets(channel_id, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, thumb_status, schema_id, formats, break_cues_ms)
      VALUES ($1,'clip',$2,0,$3,$3,'{}'::jsonb,'ready',$4,'{"hls":true}'::jsonb,$5) RETURNING id`, [ch, title, sec * 1000, o.schema ?? null, o.cues ?? []]))!.id;
    write(join(process.env.CLIPS_DIR!, 'vod', id));
    const master = existsSync(join(process.env.CLIPS_DIR!, 'vod', id, 'master.m3u8')) ? 'master.m3u8' : 'manifest.m3u8';
    await query(`UPDATE vod_assets SET master_key = $2, published = true WHERE id = $1`, [id, `/clips/vod/${id}/${master}`]);
    return id;
  };
  const film = await mkAsset('The long film', 1800, (d) => writeHls(d, 1800, 4));
  const adAsset = await mkAsset('Spring sale (conditioned)', 15, (d) => writeHls(d, 15, 4));
  await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-1',$2,'ready',15000)`, [acct, adAsset]);
  const server = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub',$2,1500) RETURNING id`, [acct, `${VBASE}/vast?sid=[SESSION_ID]`]))!.id;
  const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const k = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, app!.id, k.prefix, k.hash]);

  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const gate = async (assetId: string, extra: any = {}) => {
    const r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestPlayer/3.0' }, body: JSON.stringify({ appKey: k.raw, assetId, ...extra }) });
    return { s: r.status, j: await r.json() as any };
  };
  const events = (sid: string, list: any[]) => fetch(`${base}/vod-ads/s/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: list }) });
  const counted = async (sid: string, b: number) => Object.fromEntries((await query<any>(
    `SELECT event, count(*)::int AS n FROM vod_ad_events WHERE session_id=$1 AND break_index=$2 AND pod_index=0 AND event = ANY($3) GROUP BY event ORDER BY event`, [sid, b, ['pause', 'resume', 'mute', 'unmute']])).map((r) => [r.event, r.n]));
  let browser: any = null;

  try {
    let r = await api('PUT', '/api/vod/ads/rules/default', { mode: 'on', policy: {}, adServerId: server, houseAds: [] });
    check('ads on for the account', r.s, 200);

    console.log('\n== repeated player events ==');
    const g1 = await gate(film, { sid: 'skins-attempt-01' });
    const sid = g1.j.ads?.sessionId;
    check('a stitched session', [g1.s, g1.j.ads?.delivery, !!sid], [200, 'stitched', true]);
    // The breaks are decided in the background: wait until they are.
    await until(async () => ((await (await fetch(`${base}/vod-ads/s/${sid}/timeline.json`)).json()) as any).ready === true, 5000);
    hits.length = 0;
    let pe = await events(sid, [{ b: 0, p: 0, event: 'pause', n: 0 }, { b: 0, p: 0, event: 'resume', n: 0 }, { b: 0, p: 0, event: 'pause', n: 1 }]);
    check('pause, resume, pause: all three accepted', [pe.status, (await pe.json() as any).accepted], [200, 3]);
    await sleep(400);
    check('the ad server got both pauses and the resume', hits.map((h) => h.path).sort(), ['/px/pause', '/px/pause', '/px/resume']);
    hits.length = 0;
    await events(sid, [{ b: 0, p: 0, event: 'pause', n: 1 }]);
    await sleep(300);
    check('the second pause sent again (a retry): not sent twice', hits.length, 0);
    await events(sid, [{ b: 0, p: 0, event: 'mute' }]);
    await events(sid, [{ b: 0, p: 0, event: 'mute' }]);
    await sleep(300);
    check('a player that sends no number (before this change): its event counted once, as before', hits.map((h) => h.path), ['/px/mute']);
    check('recorded per repeat', await counted(sid, 0), { mute: 1, pause: 2, resume: 1 });
    pe = await events(sid, [{ b: 0, p: 0, event: 'pause', n: 20 }]);
    check('more than 20 of one event for one ad is refused', pe.status, 422);
    const seqs = await query<any>(`SELECT event, seq FROM vod_ad_events WHERE session_id=$1 AND event IN ('impression','pause') ORDER BY event, seq`, [sid]);
    check('server-side events stay at seq 0 (once), the pauses are 0 and 1', seqs.map((x) => `${x.event}:${x.seq}`), ['pause:0', 'pause:1']);

    console.log('\n== the SDK on a stand-in media element (sdk/ads.ts) ==');
    {
      const SDK = await import('../../volt-player/src/sdk/ads');
      const g2 = await gate(film, { sid: 'skins-attempt-02' });
      const sid2 = g2.j.ads.sessionId;
      class FakeMedia extends EventTarget { currentTime = 0; paused = false; muted = true; volume = 1; pause() { this.paused = true; this.dispatchEvent(new Event('pause')); } }
      const media = new FakeMedia() as any;
      const marks: any[] = [];
      const fr: Record<string, string> = { ad: 'Annonce', adOf: 'Annonce {number} sur {of}', learnMore: 'En savoir plus' };
      const ctl = new SDK.VodAds(media, base, { delivery: 'stitched', sessionId: sid2, timelineUrl: g2.j.ads.timelineUrl }, () => {}, undefined,
        { t: (key, v) => format(fr[key] ?? STRINGS[key] ?? key, v), onMarkers: (m) => marks.push(m) });
      await sleep(400);
      const fire = async (ev: string) => { media.dispatchEvent(new Event(ev)); await sleep(20); };
      const at = async (t: number) => { media.currentTime = t; await fire('timeupdate'); };
      await at(3);
      const tl2 = (await (await fetch(`${base}/vod-ads/s/${sid2}/timeline.json`)).json()) as any;
      check('the breaks for the scrubber as soon as the timeline is read: where the timeline puts them in the stream, none watched',
        marks[0]?.map((m: any) => [m.startSec, m.durationSec, m.watched]), tl2.breaks.map((b: any) => [b.stitchedStartSec, b.durationSec, false]));
      truthy('a pre-roll and mid-rolls (stitched time, after the ads before them)', marks[0]?.length >= 3 && marks[0][0].startSec === 0 && marks[0][1].startSec === 600 + marks[0][0].durationSec, JSON.stringify(marks[0]));
      await fire('play');
      await fire('pause'); await fire('play'); await fire('pause'); await fire('play');
      media.volume = 0.6; await fire('volumechange'); media.volume = 0.4; await fire('volumechange');
      media.muted = false; await fire('volumechange'); media.volume = 0.5; await fire('volumechange');
      media.muted = true; await fire('volumechange'); media.muted = false; await fire('volumechange');
      await sleep(500);
      check('a play at the ad\'s start is no resume; two pauses and two resumes; a volume drag is nothing; two unmutes and a mute',
        await counted(sid2, 0), { mute: 1, pause: 2, resume: 2, unmute: 2 });
      await at(16);
      check('past the pre-roll: the first break marked watched, the rest not', marks.at(-1)?.map((m: any) => m.watched), marks[0].map((_m: any, i: number) => i === 0));
      check('the scrubber was told twice (when read, when the pre-roll was watched)', marks.length, 2);
      await fire('pause');
      await sleep(200);
      check('a pause in the programme is not the ad\'s', (await counted(sid2, 0)).pause, 2);
      const word = (key: string, v?: any) => (ctl as any).word(key, v);
      check('the overlay\'s words through the player\'s strings (a client\'s French)', [word('ad'), word('adOf', { number: 1, of: 2 }), word('learnMore')], ['Annonce', 'Annonce 1 sur 2', 'En savoir plus']);
      const plain = new SDK.VodAds(new FakeMedia() as any, base, { delivery: 'stitched', sessionId: null, timelineUrl: null }, () => {});
      check('without the player\'s strings: the English defaults', [(plain as any).word('adOf', { number: 2, of: 3 }), (plain as any).word('learnMore')], ['Ad 2 of 3', 'Learn more']);
      ctl.dispose(); plain.dispose();
    }

    console.log('\n== the ad count in Playback reports ==');
    {
      const post = (lines: string[]) => fetch(`${base}/api/cmcd?appKey=${encodeURIComponent(k.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' }, body: lines.join('\n') });
      const p1 = await post(watched.lines), p2 = await post(left.lines);
      check('both viewers\' reports accepted', [p1.status, p2.status], [204, 204]);
      await coll.flushQoe(Date.now() + 61_000);
      const W = `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`;
      const ov = await api('GET', `/api/analytics/qoe/overview?${W}`);
      const ads = ov.j?.ads;
      check('Advertising: 4 ads played, 3 watched to the end (75%), in 3 breaks', [ov.s, ads?.adsStarted, ads?.adsEnded, ads?.adCompletion, ads?.breaks], [200, 4, 3, 0.75, 3]);
      const ss = await api('GET', `/api/analytics/qoe/sessions?${W}`);
      const bySid = Object.fromEntries((ss.j?.items ?? []).map((x: any) => [x.sid, x]));
      check('Sessions: each view says how many ads it played', [bySid[watched.a.sid]?.adsStarted, bySid[left.a.sid]?.adsStarted, bySid[left.a.sid]?.leftInAd], [3, 1, true]);
    }

    // ---------------------------------------------------------------- a real browser
    console.log('\n== in a browser: the video skin with a stitched session ==');
    let pw: any = null;
    for (const name of ['playwright-core', 'playwright']) {
      if (pw) break;
      try { pw = require(require.resolve(name, { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { try { pw = require(name); } catch { /* skip below */ } }
    }
    const chromiumPath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
    const haveFfmpeg = encoders.includes('libvpx-vp9') && encoders.includes('libopus');
    let esbuild: any = null;
    try { esbuild = require(require.resolve('esbuild', { paths: [ROOT, PLAYER] })); } catch { /* skip below */ }
    const missing = [!pw && 'playwright-core', !haveFfmpeg && 'ffmpeg with libvpx-vp9 and libopus',
      !existsSync(join(PLAYER, 'node_modules/shaka-player')) && 'volt-player node_modules', !esbuild && 'esbuild'].filter(Boolean);
    if (missing.length) skip(`the browser part: missing ${missing.join(', ')}`);
    else {
      const real = await mkAsset('Short blue film', 24, (d) => ffmpegHls(d, 'blue', 440, 24), { schema: shortType, cues: [8000] });
      const red = await mkAsset('Red sale (conditioned)', 4, (d) => ffmpegHls(d, 'red', 880, 4));
      await query(`INSERT INTO ad_creatives(account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-4',$2,'ready',4000)`, [acct, red]);
      const server4 = (await one<any>(`INSERT INTO ad_servers(account_id, name, tag_template, timeout_ms) VALUES ($1,'Stub 4',$2,1500) RETURNING id`, [acct, `${VBASE}/vast4?sid=[SESSION_ID]`]))!.id;
      r = await api('PUT', `/api/vod/ads/rules/content-type/${shortType}`, { mode: 'on', adServerId: server4, houseAds: [],
        policy: { delivery: 'stitched', preroll: { on: true, sec: 4, minContentSec: 0 }, midroll: { on: true, sec: 4, everyMin: 120, firstAfterMin: 0, endGuardMin: 0, minGapMin: 1, useCues: true, maxBreaks: 1 }, postroll: { on: false } } });
      check('the short film: stitched, a pre-roll and a mid-roll at its cue', r.s, 200);

      const bundle = esbuild.buildSync({ entryPoints: [join(PLAYER, 'src/index.ts')], bundle: true, format: 'iife', globalName: 'VoltPlayer',
        write: false, target: 'es2018', logLevel: 'silent', nodePaths: [join(PLAYER, 'node_modules')] }).outputFiles[0].text;
      const COLOR = `window.colorOf = function () { var v = document.querySelector('video'); if (!v || v.readyState < 2) return 'none';
        var c = document.createElement('canvas'); c.width = 32; c.height = 18; var x = c.getContext('2d'); x.drawImage(v, 0, 0, 32, 18);
        var d = x.getImageData(16, 9, 1, 1).data; return d[0] > 150 && d[2] < 110 ? 'red' : d[2] > 150 && d[0] < 110 ? 'blue' : 'other:' + d[0] + ',' + d[1] + ',' + d[2]; };`;
      const pages: Record<string, { type: string; body: string | Buffer }> = {
        '/__t/volt-player.js': { type: 'text/javascript', body: bundle },
        '/__t/skin.html': { type: 'text/html', body: `<!doctype html><html><body style="margin:0;background:#000"><div id="p" style="width:640px;height:360px"></div>
<script src="/__t/volt-player.js"></script><script>${COLOR}
VoltPlayer.create({ el: '#p', appKey: ${JSON.stringify(k.raw)}, apiBase: location.origin, autoplay: true, muted: true, beacons: false, skin: 'video',
  strings: { ad: 'Annonce', adOf: 'Annonce {number} sur {of}', learnMore: 'En savoir plus', adBreak: 'Coupure pub', adBreakWatched: 'Coupure pub, vue' },
  item: { id: ${JSON.stringify(real)}, assetId: ${JSON.stringify(real)} } }).then(function (p) { window.vp = p; });</script></body></html>` },
      };
      browser = await pw.chromium.launch({ executablePath: chromiumPath, args: ['--autoplay-policy=no-user-gesture-required'] });
      const ctx = await browser.newContext({ viewport: { width: 700, height: 420 } });
      await ctx.route(`${base}/__t/**`, (route: any) => {
        const f = pages[new URL(route.request().url()).pathname];
        return f ? route.fulfill({ status: 200, contentType: f.type, body: f.body }) : route.fulfill({ status: 404, body: '' });
      });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e: any) => errors.push(String(e?.message ?? e)));
      let gateAns: any = null;
      page.on('response', async (q: any) => { if (q.url().includes('/api/availability')) { try { gateAns = await q.json(); } catch { /* */ } } });
      await page.goto(`${base}/__t/skin.html`);
      const colour = () => page.evaluate('window.colorOf()') as Promise<string>;
      const overlay = () => page.evaluate(`(function () { var e = document.querySelector('.vp-ad'); return e && !e.hidden ? e.textContent : null; })()`) as Promise<string | null>;
      const markState = () => page.evaluate(`Array.prototype.map.call(document.querySelectorAll('.vpv-sl .vp-sl-mark'), function (m) { return [m.classList.contains('watched'), m.style.left, m.getAttribute('title')]; })`) as Promise<any[]>;
      const tRed = await until(async () => (await colour()) === 'red', 20000);
      truthy('the pre-roll plays (red) through the stitched session', tRed >= 0 && gateAns?.ads?.delivery === 'stitched', `colour ${await colour()} delivery ${gateAns?.ads?.delivery}`);
      const tOv = await until(async () => /^Annonce · 0:0\d\s*En savoir plus$/.test((await overlay()) ?? ''), 4000);
      truthy('the overlay in the client\'s words: "Annonce · 0:0x" and "En savoir plus"', tOv >= 0, String(await overlay()));
      const shot = async (name: string) => {
        if (!process.env.SHOT_DIR) return;
        mkdirSync(process.env.SHOT_DIR, { recursive: true });
        await page.mouse.move(300 + Math.random() * 40, 280); await sleep(450);
        await page.screenshot({ path: join(process.env.SHOT_DIR, name) });
      };
      await shot('skin-ad-overlay.png');
      check('the skin\'s title steps aside for the ad (the overlay sits where it would)', await page.evaluate(`(function () { var t = document.querySelector('.vpv-title'); return !!t && (t.hidden || getComputedStyle(t).display === 'none'); })()`), true);
      const ps = gateAns?.ads?.sessionId;
      // Pause and resume twice, unmute and mute, while the ad is on screen.
      await page.evaluate(`(async function () { var v = document.querySelector('video'); v.pause(); await new Promise(function (r) { setTimeout(r, 150); });
        await v.play(); v.pause(); await new Promise(function (r) { setTimeout(r, 150); }); await v.play();
        var tick = function () { return new Promise(function (r) { setTimeout(r, 60); }); };
        v.muted = false; await tick(); v.volume = 0.5; await tick(); v.volume = 0.4; await tick(); v.muted = true; await tick(); })()`);
      const m0 = await markState();
      check('two breaks on the scrubber, both ahead (yellow), labelled in the client\'s words', [m0.length, m0.map((m) => m[0]), m0[1]?.[2]], [2, [false, false], 'Coupure pub']);
      const tBlue = await until(async () => (await colour()) === 'blue' && (await overlay()) == null, 15000);
      truthy('then the programme (blue), the overlay gone', tBlue >= 0, `colour ${await colour()} overlay ${await overlay()}`);
      check('and the title is back', await until(async () => page.evaluate(`(function () { var t = document.querySelector('.vpv-title'); return !!t && !t.hidden && getComputedStyle(t).display !== 'none'; })()`), 2000) >= 0, true);
      await until(async () => (await markState())[0]?.[0] === true, 3000);
      const m1 = await markState();
      check('the pre-roll\'s mark is now watched (grey), the mid-roll\'s still ahead', [m1.map((m) => m[0]), m1[0]?.[2]], [[true, false], 'Coupure pub, vue']);
      await shot('skin-ad-markers.png');
      await sleep(400);
      check('the ad\'s pauses, resumes, unmute and mute reached the session', await counted(ps, 0), { mute: 1, pause: 2, resume: 2, unmute: 1 });
      const tMid = await until(async () => (await colour()) === 'red', 20000);
      truthy('the mid-roll at 8 s plays', tMid >= 0, `colour ${await colour()}`);
      await until(async () => (await colour()) === 'blue', 15000);
      const adLogNow = async () => ((await page.evaluate(`(window.vp.attempt || (window.vp.player && window.vp.player.attempt) || {}).log || []`)) as any[])
        .filter((d) => ['abs', 'abe', 'as', 'ae'].includes(String(d.e))).map((d) => `${d.e}${d['com.volt-brk'] ? ':' + d['com.volt-brk'] : ''}`);
      // The picture can turn blue a frame before the player's clock leaves the break.
      await until(async () => (await adLogNow()).length >= 8, 3000);
      const adLog = await adLogNow();
      check('the player\'s own reports: each break with its ad started and ended inside it', adLog, ['abs:vod-0', 'as', 'ae', 'abe:vod-0', 'abs:vod-1', 'as', 'ae', 'abe:vod-1']);
      check('no page errors', errors, []);
      await page.close();
    }
  } catch (e: any) {
    bad('ran to the end', String(e?.stack ?? e));
  } finally {
    if (browser) await browser.close().catch(() => null);
    srv.close(); vast.close();
    await adb.closeAnalytics().catch(() => null);
    await pool.end().catch(() => null);
    try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
