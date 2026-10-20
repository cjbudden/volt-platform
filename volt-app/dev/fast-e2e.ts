/**
 * FAST end to end, for real: the control plane, the playout, a fake ad server,
 * and a browser playing the channel and a stitched session.
 *
 *   1. seeds a library from FAST_LAB (packaged assets, see DESIGN_fast_channels.md
 *      "Checking it"), creates a FAST channel, a lineup, house ads and a slate,
 *      an ad server (a fake VAST server here) and activates the lineup;
 *   2. starts fast_playout.py against this API;
 *   3. plays, in Chromium with Shaka, for PLAY_SECONDS:
 *        - the shared channel  /origin/<id>/fast/master.m3u8 and manifest.mpd
 *        - a viewer session    /fast/<id>/s/<sid>/master.m3u8 (ads stitched)
 *      and reports stalls, errors, and which ad media each one fetched.
 *
 * Run from volt-app/ with the API running (BASE), DATABASE_URL, CLIPS_DIR and
 * ORIGIN_DIR set the same as the API's, FAST_LAB pointing at packaged assets
 * and CHROME at a Chromium binary:
 *   BASE=http://localhost:8486 FAST_LAB=... CHROME=... npx tsx dev/fast-e2e.ts
 */
import { createServer } from 'node:http';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { query, one, pool } from '../src/db';

const BASE = process.env.BASE ?? 'http://localhost:8486';
const LAB = process.env.FAST_LAB!;
const CLIPS = process.env.CLIPS_DIR!;
const ORIGIN = process.env.ORIGIN_DIR!;
const SECS = Number(process.env.PLAY_SECONDS ?? 150);
const ACCT = '0000000a-0000-0000-0000-0000000000e1';
const GROUP = '0000000d-0000-0000-0000-0000000000e1';
let A = '';
const api = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};

(async () => {
  // seed an account (idempotent)
  await query(`INSERT INTO accounts(id,name,max_channels) VALUES ($1,'E2E',20) ON CONFLICT (id) DO UPDATE SET max_channels = 20`, [ACCT]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES ('0000000b-0000-0000-0000-0000000000e1',$1,'e2e@fast.example','x','owner','active','E2E') ON CONFLICT (id) DO NOTHING`, [ACCT]);
  await query(`INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000000e1',$1,'HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING`, [ACCT]);
  await query(`INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ($2,$1,'G','0000000c-0000-0000-0000-0000000000e1',20) ON CONFLICT (id) DO NOTHING`, [ACCT, GROUP]);
  const { hashPassword } = await import('../src/auth/password');
  await query(`UPDATE users SET password_hash = $1 WHERE email = 'e2e@fast.example'`, [await hashPassword('volt1234')]);
  A = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e@fast.example', password: 'volt1234' }) })).json()).access;

  await query(`DELETE FROM channels WHERE id IN (SELECT c.id FROM channels c WHERE c.group_id = $1)`, [GROUP]);
  await query(`DELETE FROM vod_assets WHERE account_id = $1`, [ACCT]);
  await query(`DELETE FROM ad_creatives WHERE account_id = $1`, [ACCT]);
  const mk = async (name: string, secs: number, md: any, media: string) => {
    const r = await one<any>(`INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata) VALUES ($1,'upload','clip',$2,0,$3,$3,$4::jsonb) RETURNING id`, [ACCT, name, secs * 1000, JSON.stringify(md)]);
    mkdirSync(join(CLIPS, 'vod'), { recursive: true });
    cpSync(join(LAB, 'vod', media), join(CLIPS, 'vod', r.id), { recursive: true });
    await query(`UPDATE vod_assets SET master_key = $2 WHERE id = $1`, [r.id, `/clips/vod/${r.id}/master.m3u8`]);
    return String(r.id);
  };
  const filmA = await mk('Film A', 60, { title: 'Film A' }, 'filmA');
  const filmB = await mk('Film B', 46, { title: 'Film B' }, 'filmB');
  for (let i = 1; i <= 3; i++) await mk(`Ep ${i}`, 30, { title: `Ep ${i}`, series: 'Show', season: 1, episodeNumber: i }, 'ep1');
  const promo = await mk('Promo', 10, { title: 'Promo' }, 'promo');
  const slate = await mk('Slate', 6, { title: 'Slate' }, 'slate');
  const adX = await mk('Ad X', 15, { title: 'Ad X', kind: 'ad' }, 'adX');
  await query(`INSERT INTO ad_creatives (account_id, creative_key, vod_asset_id, status, duration_ms) VALUES ($1,'ad-id.org:UAI-X',$2,'ready',15000)`, [ACCT, adX]);

  const vast = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'application/xml' }); s.end(`<VAST version="4.2"><Ad id="x" sequence="1"><InLine><AdSystem>Fake</AdSystem><AdTitle>Ad X</AdTitle><Impression>http://127.0.0.1:1/i</Impression><Creatives><Creative><UniversalAdId idRegistry="ad-id.org">UAI-X</UniversalAdId><Linear><Duration>00:00:15</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4">http://127.0.0.1:1/x.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`); });
  await new Promise<void>((r) => vast.listen(8498, '127.0.0.1', () => r()));

  const ch = await api('POST', '/api/fast/channels', { name: 'E2E FAST', groupId: GROUP, zone: 'Australia/Brisbane' });
  const CH = ch.channel.id, L = ch.lineup.id;
  await api('PUT', `/api/fast/lineups/${L}`, { slots: [
    { id: 'm', kind: 'title', pool: [{ assetId: filmA }, { assetId: filmB }] },
    { id: 's', kind: 'series', series: 'Show', count: 1, order: 'sequential' },
  ] });
  const srv = await api('POST', '/api/fast/ad-servers', { name: 'Fake', tagTemplate: 'http://127.0.0.1:8498/vast?d=[BREAK_DURATION]&s=[SESSION_ID]', timeoutMs: 800 });
  await api('PUT', `/api/fast/channels/${CH}/ads`, { mode: 'stitched', adServerId: srv.id, policy: { betweenSec: 15, breakSec: 15, loadMinPerHour: 0, slateAssetId: slate }, houseAds: [{ assetId: promo }] });
  const act = await api('POST', `/api/fast/lineups/${L}/activate`, {});
  console.log(`channel ${CH}: ${act.applied.inserted} programmes, ${act.applied.breaks} breaks`);

  const out = join(ORIGIN, CH, 'fast');
  mkdirSync(out, { recursive: true });
  const po = spawn('python3', ['../volt-encoder/bin/fast_playout.py', '--channel', CH, '--api', BASE, '--token', process.env.INGEST_TOKEN ?? 'z', '--out', out, '--clips-dir', CLIPS, '--dvr', '60'], { stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((r) => setTimeout(r, 6000));

  const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright-core');
  const b = await chromium.launch({ executablePath: process.env.CHROME, args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'] });
  const shaka = readFileSync(process.env.SHAKA ?? '../volt-player/node_modules/shaka-player/dist/shaka-player.compiled.js', 'utf8');
  const play = async (name: string, url: string) => {
    const p = await b.newPage();
    const fetched: string[] = [];
    p.on('request', (r: any) => { const u = r.url(); if (u.endsWith('.m4s')) fetched.push(u); });
    await p.setContent(`<video id=v muted autoplay width=480></video><script>${shaka}</script>`);
    await p.evaluate(async (u: string) => {
      const w: any = window; w.stats = { stalls: 0, errors: [] as string[], breaks: 0 };
      w.shaka.polyfill.installAll();
      const v: any = document.getElementById('v'); const pl = new w.shaka.Player(); await pl.attach(v);
      pl.addEventListener('error', (e: any) => w.stats.errors.push(String(e.detail?.code)));
      pl.addEventListener('metadata', (e: any) => { if (e.metadataType === 'com.boomlabs.volt.ad' && e.payload?.key === 'X-BREAK') w.stats.breaks++; });
      pl.addEventListener('timelineregionadded', (e: any) => { if (String(e.detail.schemeIdUri).includes('scte35')) w.stats.breaks++; });
      await pl.load(u);
      let last = v.currentTime, lastT = performance.now(), stalled = false;
      setInterval(() => { const n = performance.now(); if (v.currentTime > last + 0.01) { last = v.currentTime; lastT = n; stalled = false; } else if (!stalled && n - lastT > 700) { stalled = true; w.stats.stalls++; } }, 200);
    }, url);
    await p.waitForTimeout(SECS * 1000);
    const st = await p.evaluate(() => ({ ...(window as any).stats, ct: (document.getElementById('v') as any).currentTime }));
    const which = (id: string) => fetched.filter((u) => u.includes(`/vod/${id}/`)).length;
    return { name, ...st, adSegments: which(adX), promoSegments: which(promo), slateSegments: which(slate), filmSegments: which(filmA) + which(filmB) };
  };
  const sid = 'viewer' + Math.random().toString(36).slice(2, 10);
  // A PROBE SESSION refreshed every second like a player, every playlist kept,
  // then checked: one media sequence number = one segment and one
  // discontinuity number on every refresh, no gaps, the pod in each break.
  const probe = 'probe' + Math.random().toString(36).slice(2, 10);
  const seen: Record<string, Map<number, { uri: string; d: number }>> = { v720: new Map(), v360: new Map(), audio: new Map() };
  let probeBad = 0, probeGaps = 0, probeRefreshes = 0;
  const probeTimer = setInterval(async () => {
    for (const tr of Object.keys(seen)) {
      const t = await fetch(`${BASE}/fast/${CH}/s/${probe}/${tr}.m3u8`).then((r) => r.text()).catch(() => '');
      if (!t.startsWith('#EXTM3U')) continue;
      probeRefreshes++;
      let msn = 0, d = 0, n = 0, disc = false, prev = -1;
      for (const l of t.split('\n')) {
        if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) msn = Number(l.split(':')[1]);
        else if (l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) d = Number(l.split(':')[1]);
        else if (l === '#EXT-X-DISCONTINUITY') disc = true;
        else if (l && !l.startsWith('#')) {
          if (disc && n > 0) d++;
          const m = msn + n; n++; disc = false;
          const was = seen[tr].get(m);
          if (was && (was.uri !== l || was.d !== d)) probeBad++;
          if (!was) seen[tr].set(m, { uri: l, d });
          if (prev >= 0 && m !== prev + 1) probeGaps++;
          prev = m;
        }
      }
    }
  }, 1000);
  const res = await Promise.all([
    play('channel HLS', `${BASE}/origin/${CH}/fast/master.m3u8`),
    play('channel DASH', `${BASE}/origin/${CH}/fast/manifest.mpd`),
    play('session HLS (stitched)', `${BASE}/fast/${CH}/s/${sid}/master.m3u8`),
  ]);
  for (const r of res) console.log(JSON.stringify(r));
  clearInterval(probeTimer);
  const ms = [...seen.v720.keys()].sort((a, b) => a - b);
  const holes = ms.filter((m, i) => i > 0 && m !== ms[i - 1] + 1).length;
  const order = ms.map((m) => seen.v720.get(m)!.uri);
  console.log('probe', JSON.stringify({ refreshes: probeRefreshes, inconsistent: probeBad, gapsInPlaylists: probeGaps, holesAcrossRefreshes: holes,
    adSegs: order.filter((u) => u.includes(`/vod/${adX}/`)).length, houseSegs: order.filter((u) => u.includes(`/vod/${promo}/`) || u.includes(`/vod/${slate}/`)).length,
    filmSegs: order.filter((u) => u.includes(`/vod/${filmA}/`) || u.includes(`/vod/${filmB}/`)).length }));
  const dec = await one<any>(`SELECT count(*)::int n, sum(ad_ms)::int ad FROM ad_decisions WHERE channel_id = $1`, [CH]);
  console.log('decisions', JSON.stringify(dec));
  await b.close(); po.kill(); vast.close(); await pool.end();
})().catch(async (e) => { console.error(e); process.exit(1); });
