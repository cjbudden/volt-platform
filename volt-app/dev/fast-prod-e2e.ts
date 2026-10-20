/**
 * FAST in its production shape, on one box (run by dev/fast-prod-e2e.sh):
 *
 *   S3          moto server (AWS_ENDPOINT_URL), the origin bucket
 *   CloudFront  the same bucket read path-style (CDN_BASE_URL)
 *   Valkey      redis-server (REDIS_URL)
 *   API         two processes: A (ROLE=all: scheduler, worker, console) and
 *               B (ROLE=api-public), the way api_public scales out
 *   playout     fast_playout.py launched by A, configured exactly as an ECS
 *               task is (FAST_CONFIG_JSON), writing to the bucket
 *
 * Checks: library media in the bucket (vodStore), the slate prepared to 1 s on
 * activation, playlists written to the bucket with the right headers and CDN
 * segment URLs, the public URL gated on on-air and the heartbeat, a stitched
 * session refreshed alternately on A and B staying consistent (the shared
 * session store), the playout killed and replaced carrying its media sequence
 * on, and Chromium playing the channel and a session from the "CDN".
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, one, pool } from '../src/db';
import { uploadVodDir } from '../src/services/fast/vodStore';

const A_BASE = process.env.BASE_A!, B_BASE = process.env.BASE_B!;
const LAB = process.env.FAST_LAB!;          // packaged assets: <lab>/clips/vod/<name>/
const SLATE_SRC = process.env.SLATE_SRC ?? join(LAB, 'src', 'slate.mp4'); // a source file the slate is re-encoded from
const CDN = process.env.CDN_BASE_URL!.replace(/\/$/, '');
const BUCKET = process.env.S3_BUCKET!;
const SECS = Number(process.env.PLAY_SECONDS ?? 60);
const ACCT = '0000000a-0000-0000-0000-0000000000e2';
const GROUP = '0000000d-0000-0000-0000-0000000000e2';
let A = '';
let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const api = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(A_BASE + p, { method: m, headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await what().catch(() => false)) return true; await sleep(500); } return false; };

(async () => {
  await query(`INSERT INTO accounts(id,name,max_channels) VALUES ($1,'E2E prod',20) ON CONFLICT (id) DO UPDATE SET max_channels = 20`, [ACCT]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES ('0000000b-0000-0000-0000-0000000000e2',$1,'prod@fast.example','x','owner','active','E2E') ON CONFLICT (id) DO NOTHING`, [ACCT]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000000e2',$1,'HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING`, [ACCT]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($2,$1,'G','0000000c-0000-0000-0000-0000000000e2',20) ON CONFLICT (id) DO NOTHING`, [ACCT, GROUP]);
  const { hashPassword } = await import('../src/auth/password');
  await query(`UPDATE users SET password_hash = $1 WHERE email = 'prod@fast.example'`, [await hashPassword('volt1234')]);
  A = (await (await fetch(A_BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'prod@fast.example', password: 'volt1234' }) })).json()).access;
  await query(`DELETE FROM channels WHERE group_id = $1`, [GROUP]);
  await query(`DELETE FROM vod_assets WHERE account_id = $1`, [ACCT]);
  await query(`DELETE FROM ad_creatives WHERE account_id = $1`, [ACCT]);
  // a default ladder, as every account that uploads has (prepare re-encodes with it)
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(ACCT, '0000000c-0000-0000-0000-0000000000e2', 'HD', { makeDefault: true });

  // LIBRARY IN THE BUCKET, as an encode with VOD_STORE=s3 leaves it
  const er = { zeroStart: true, segmentSeconds: 2, loudnorm: false };
  const mk = async (name: string, secs: number, md: any, media: string, extra: any = {}) => {
    const r = await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, encode_result)
      VALUES ($1,'upload','clip',$2,0,$3,$3,$4::jsonb,$5::jsonb) RETURNING id`, [ACCT, name, secs * 1000, JSON.stringify(md), JSON.stringify({ ...er, ...extra })]);
    const up = await uploadVodDir(join(LAB, 'clips', 'vod', media), r.id);
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [r.id, up.master]);
    return String(r.id);
  };
  const filmA = await mk('Film A', 60, { title: 'Film A' }, 'filmA');
  const filmB = await mk('Film B', 46, { title: 'Film B' }, 'filmB');
  for (let i = 1; i <= 3; i++) await mk(`Ep ${i}`, 30, { title: `Ep ${i}`, series: 'Show', season: 1, episodeNumber: i }, 'ep1');
  const promo = await mk('Promo', 10, { title: 'Promo' }, 'promo', { loudnorm: true });
  // THE SLATE needs preparing: packaged at 2 s, its source still here
  const slate = await mk('Slate', 6, { title: 'Slate' }, 'slate');
  await query(`UPDATE vod_assets SET source_key = $2 WHERE id = $1`, [slate, SLATE_SRC]);
  const adX = await mk('Ad X', 15, { title: 'Ad X', kind: 'ad' }, 'adX');
  await query(`INSERT INTO ad_creatives (account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-P',$2,'ready',15000)`, [ACCT, adX]);
  const head = await fetch(`${CDN}/vod/${filmA}/master.m3u8`);
  ok(head.ok && /mpegurl/.test(head.headers.get('content-type') ?? ''), `library media is in the bucket and served by the "CDN" (${head.status} ${head.headers.get('content-type')})`);

  const vast = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'application/xml' }); s.end(`<VAST version="4.2"><Ad id="x" sequence="1"><InLine><AdSystem>Fake</AdSystem><AdTitle>Ad X</AdTitle><Impression>http://127.0.0.1:1/i</Impression><Creatives><Creative><UniversalAdId idRegistry="ad-id.org">UAI-P</UniversalAdId><Linear><Duration>00:00:15</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4">http://127.0.0.1:1/x.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`); });
  await new Promise<void>((r) => vast.listen(8499, '127.0.0.1', () => r()));

  const ch = await api('POST', '/api/fast/channels', { name: 'Prod FAST', groupId: GROUP, zone: 'Australia/Brisbane' });
  const CH = ch.channel.id, L = ch.lineup.id;
  await api('PUT', `/api/fast/lineups/${L}`, { slots: [
    { id: 'm', kind: 'title', pool: [{ assetId: filmA }, { assetId: filmB }] },
    { id: 's', kind: 'series', series: 'Show', count: 1, order: 'sequential' },
  ] });
  const srv = await api('POST', '/api/fast/ad-servers', { name: 'Fake', tagTemplate: 'http://127.0.0.1:8499/vast?d=[BREAK_DURATION]&s=[SESSION_ID]', timeoutMs: 800 });
  await api('PUT', `/api/fast/channels/${CH}/ads`, { mode: 'stitched', adServerId: srv.id, policy: { betweenSec: 15, breakSec: 15, loadMinPerHour: 0, slateAssetId: slate }, houseAds: [{ assetId: promo }] });
  const before = await api('GET', `/api/fast/channels/${CH}/readiness`);
  ok(before.items?.find((r: any) => r.assetId === slate)?.state === 'needs-prepare', 'readiness: the slate needs preparing (not 1 s segments)');

  const act = await api('POST', `/api/fast/lineups/${L}/activate`, {});
  ok(act.prepared?.queued?.includes(slate), 'activate queued the slate for preparing');
  ok(String(act.urls?.hls ?? '').startsWith(`${CDN}/channel/${CH}/fast/`), `the channel's URL is on the CDN (${act.urls?.hls})`);

  // the playout writes to the bucket
  const fresh = await until(async () => (await api('GET', `/api/fast/channels/${CH}`)).playout?.fresh === true, 30_000);
  ok(fresh, 'the playout is heartbeating');
  const m = await fetch(`${CDN}/channel/${CH}/fast/master.m3u8`);
  ok(m.ok && /mpegurl/.test(m.headers.get('content-type') ?? '') && /no-store/.test(m.headers.get('cache-control') ?? ''), `master.m3u8 in the bucket (${m.headers.get('content-type')}; ${m.headers.get('cache-control')})`);
  const variant = await (await fetch(`${CDN}/channel/${CH}/fast/v720.m3u8`)).text();
  const segs = variant.split('\n').filter((l) => l && !l.startsWith('#'));
  ok(segs.length > 0 && segs.every((u) => u.startsWith(`${CDN}/vod/`)), `segment URLs point at the CDN (${segs[0]})`);
  const mpd = await fetch(`${CDN}/channel/${CH}/fast/manifest.mpd`);
  ok(mpd.ok && /dash\+xml/.test(mpd.headers.get('content-type') ?? ''), 'manifest.mpd in the bucket');

  // the slate's encode finishes and lands in the bucket at 1 s
  const prepared = await until(async () => (await one<any>(`SELECT encode_result FROM vod_assets WHERE id = $1`, [slate]))?.encode_result?.segmentSeconds === 1, 180_000);
  const sl = await one<any>(`SELECT master_key, encode_result FROM vod_assets WHERE id = $1`, [slate]);
  ok(prepared && sl.master_key === `vod/${slate}/master.m3u8` && sl.encode_result.zeroStart === true, `the slate was re-encoded at 1 s, zero-start, into the bucket (${sl.master_key})`);
  ok((await fetch(`${CDN}/vod/${slate}/master.m3u8`)).ok, 'and the "CDN" serves it');
  // The re-encode is H.264 (the account's ladder). Playwright's Chromium has no
  // H.264 decoder, so for the playback checks below the slate goes back to the
  // lab's (VP9) one. A real browser plays either.
  if (process.env.KEEP_PREPARED_SLATE !== '1') {
    const vp9 = await mk('Slate (lab)', 6, { title: 'Slate (lab)' }, 'slate', { segmentSeconds: 1 });
    await api('PUT', `/api/fast/channels/${CH}/ads`, { policy: { betweenSec: 15, breakSec: 15, loadMinPerHour: 0, slateAssetId: vp9 } });
  }

  // PUBLIC URL: private until on air, then the stitcher on B (the public tier)
  const priv = await fetch(`${B_BASE}/live/${CH}/master.m3u8`, { redirect: 'manual' });
  ok(priv.status !== 302, `private: the public URL gives nothing (${priv.status})`);
  await api('POST', `/api/fast/channels/${CH}/on-air`, { on: true });
  await sleep(5500); // the play gate's channel cache
  const pub = await fetch(`${B_BASE}/live/${CH}/master.m3u8`, { redirect: 'manual' });
  const loc = pub.headers.get('location') ?? '';
  ok(pub.status === 302 && /\/fast\/[^/]+\/s\/[^/]+\/master\.m3u8$/.test(loc) && /no-store/.test(pub.headers.get('cache-control') ?? ''), `public: a per-viewer session URL, not cached (${loc})`);
  const pub2 = (await fetch(`${B_BASE}/live/${CH}/master.m3u8`, { redirect: 'manual' })).headers.get('location');
  ok(pub2 !== loc, 'each viewer gets their own session');
  const dash = await fetch(`${B_BASE}/live/${CH}/manifest.mpd`, { redirect: 'manual' });
  ok(dash.status === 302 && dash.headers.get('location') === `${CDN}/channel/${CH}/fast/manifest.mpd`, 'DASH viewers get the channel MPD on the CDN');

  // ONE SESSION, TWO API TASKS: refreshes alternate between A and B
  const probe = 'probe' + Math.random().toString(36).slice(2, 10);
  const seen = new Map<number, { uri: string; d: number }>();
  let bad = 0, gaps = 0, refreshes = 0, turn = 0;
  const probeTimer = setInterval(async () => {
    const base = (turn++ % 2) ? B_BASE : A_BASE;
    const t = await fetch(`${base}/fast/${CH}/s/${probe}/v720.m3u8`).then((r) => r.text()).catch(() => '');
    if (!t.startsWith('#EXTM3U')) return;
    refreshes++;
    let msn = 0, d = 0, n = 0, disc = false, prev = -1;
    for (const l of t.split('\n')) {
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) msn = Number(l.split(':')[1]);
      else if (l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) d = Number(l.split(':')[1]);
      else if (l === '#EXT-X-DISCONTINUITY') disc = true;
      else if (l && !l.startsWith('#')) {
        if (disc && n > 0) d++;
        const k = msn + n; n++; disc = false;
        const was = seen.get(k);
        if (was && (was.uri !== l || was.d !== d)) bad++;
        if (!was) seen.set(k, { uri: l, d });
        if (prev >= 0 && k !== prev + 1) gaps++;
        prev = k;
      }
    }
  }, 1000);

  // BROWSER: the channel from the CDN, and a session
  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright-core');
  const b = await chromium.launch({ executablePath: process.env.CHROME, args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'] });
  const shaka = readFileSync(process.env.SHAKA ?? '../volt-player/node_modules/shaka-player/dist/shaka-player.compiled.js', 'utf8');
  const play = async (name: string, url: string, secs: number) => {
    const p = await b.newPage();
    const fetched: string[] = [];
    p.on('request', (r: any) => { const u = r.url(); if (u.endsWith('.m4s')) fetched.push(u); });
    await p.setContent(`<video id=v muted autoplay width=480></video><script>${shaka}</script>`);
    await p.evaluate(async (u: string) => {
      const w: any = window; w.stats = { stalls: 0, errors: [] as string[] };
      w.shaka.polyfill.installAll();
      const v: any = document.getElementById('v'); const pl = new w.shaka.Player(); await pl.attach(v);
      pl.addEventListener('error', (e: any) => w.stats.errors.push(String(e.detail?.code)));
      try { await pl.load(u); } catch (e: any) { w.stats.errors.push(`load ${e?.code ?? ''} ${JSON.stringify(e?.data ?? String(e)).slice(0, 300)}`); }
      let last = v.currentTime, lastT = performance.now(), stalled = false;
      setInterval(() => { const n = performance.now(); if (v.currentTime > last + 0.01) { last = v.currentTime; lastT = n; stalled = false; } else if (!stalled && n - lastT > 700) { stalled = true; w.stats.stalls++; } }, 200);
    }, url).catch((e: any) => console.log(name, 'load failed', String(e).slice(0, 600)));
    await p.waitForTimeout(secs * 1000);
    const st = await p.evaluate(() => ({ ...(window as any).stats, ct: (document.getElementById('v') as any).currentTime }));
    const which = (id: string) => fetched.filter((u) => u.includes(`/vod/${id}/`)).length;
    await p.close();
    return { name, ...st, fromCdn: fetched.filter((u) => u.startsWith(CDN)).length, segments: fetched.length, ad: which(adX), house: which(promo) + which(slate) };
  };
  const res = await Promise.all([
    play('channel HLS from the CDN', `${CDN}/channel/${CH}/fast/master.m3u8`, SECS),
    play('channel DASH from the CDN', `${CDN}/channel/${CH}/fast/manifest.mpd`, SECS),
    play('public URL (stitched session on B)', `${B_BASE}/live/${CH}/master.m3u8`, SECS),
  ]);
  for (const r of res) {
    console.log(JSON.stringify(r));
    ok(r.errors.length === 0 && r.ct > SECS * 0.7 && r.stalls <= 1 && r.fromCdn === r.segments && r.segments > 0,
      `${r.name}: played ${Math.round(r.ct)} s, ${r.stalls} stall(s), ${r.segments} segments all from the CDN`);
  }
  clearInterval(probeTimer);
  const ks = [...seen.keys()].sort((x, y) => x - y);
  const holes = ks.filter((k, i) => i > 0 && k !== ks[i - 1] + 1).length;
  ok(refreshes > SECS * 0.7 && bad === 0 && gaps === 0 && holes === 0,
    `one session refreshed ${refreshes} times across two API processes: ${bad} inconsistent, ${gaps} gaps, ${holes} holes`);
  const adInSession = [...seen.values()].filter((v) => v.uri.includes(`/vod/${adX}/`)).length;
  ok(adInSession > 0, `the session carries the ad server's ad (${adInSession} segments)`);

  if (process.env.KEEP_ON_AIR === '1') { console.log(`kept on air: ${CH} (login prod@fast.example / volt1234)`); await b.close(); vast.close(); await pool.end(); process.exit(fail ? 1 : 0); }

  // SPOT INTERRUPTION: the playout dies, the next reconcile replaces it, the media sequence carries on
  const p0 = await one<any>(`SELECT task_ref, media_sequence, restarts FROM fast_playouts WHERE channel_id = $1`, [CH]);
  try { process.kill(Number(p0.task_ref), 'SIGKILL'); } catch { /* */ }
  const msBefore = Number(p0.media_sequence);
  const back = await until(async () => {
    const r = await one<any>(`SELECT restarts, media_sequence, task_ref FROM fast_playouts WHERE channel_id = $1 AND last_seen_at > now() - interval '6 seconds'`, [CH]);
    return !!r && r.task_ref !== p0.task_ref && Number(r.restarts) > Number(p0.restarts);
  }, 75_000);
  const p1 = await one<any>(`SELECT task_ref, media_sequence, restarts FROM fast_playouts WHERE channel_id = $1`, [CH]);
  ok(back && Number(p1.media_sequence) >= msBefore, `killed playout replaced (restarts ${p0.restarts} -> ${p1.restarts}); media sequence ${msBefore} -> ${p1.media_sequence}, never back`);
  const v2 = await (await fetch(`${CDN}/channel/${CH}/fast/v720.m3u8`)).text();
  const msn2 = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(v2)?.[1] ?? -1);
  ok(msn2 >= msBefore - 60, `the playlist in the bucket carries on (media sequence ${msn2})`);

  // OFF AIR: deactivating stops the playout; the public URL stops answering
  await query(`UPDATE fast_lineups SET status = 'archived' WHERE channel_id = $1`, [CH]);
  const stopped = await until(async () => (await one<any>(`SELECT status FROM fast_playouts WHERE channel_id = $1`, [CH]))?.status === 'stopped', 45_000);
  ok(stopped, 'no active lineup: the playout is stopped');
  await sleep(2500);
  const gone = await fetch(`${B_BASE}/live/${CH}/master.m3u8`, { redirect: 'manual' });
  ok(gone.status === 503, `and the public URL says no content (${gone.status})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close(); vast.close(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
