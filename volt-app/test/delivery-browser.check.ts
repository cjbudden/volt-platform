// ============================================================================
//  SERVER-GUIDED QUALITY AND STEERING IN A REAL PLAYER (build queue 2.10).
//
//  Shaka 4.16 (the engine of the Volt SDK, with the SDK's streaming settings)
//  in Chromium plays a live HLS channel from the real control plane
//  (createServer(): the /origin route with its CMSD hook, the /live route,
//  the steering service), on a page from another site. The live stream is
//  three VP9 rungs (400, 1200, 3000 kb/s, two-second segments) whose media
//  playlists this suite advances every second, as the packager would.
//
//  1. CMSD, the same lab twice. Four viewers start on the top rung (2.9 Mb/s
//     each, 11.6 Mb/s together) behind one 10 Mb/s uplink (a proxy that
//     shares 10 Mb/s between the responses in flight); the origin's allowance
//     is that uplink. Run A follows CMSD (Shaka's default): the origin's
//     meter sees the uplink nearly full, the playlists say du and a fair
//     share. Run B ignores CMSD. Recorded per run: stalls (count and time),
//     seconds the uplink was full, each viewer's least buffer ahead, rungs at
//     the end. The bar: A follows the ceiling and stays on it (no cycle back
//     to the top), fills the link no more often and stalls no more than B,
//     every viewer still playing. Whether A stalls LESS is recorded, not
//     asserted: Shaka on its own adapted without a stall in every version of
//     this lab tried (see VOLT_BUILD_STATUS.md, 2.10).
//  2. Steering. Two delivery paths (127.0.0.1 and localhost, the same
//     origin), TTL 2 s. The viewer (in AU) starts on path a; at 12 s the
//     players' reports for AU say path a stalls 10 % of the time; within a
//     few seconds the player fetches its segments from path b, with no stall
//     and without the picture stopping.
//
//  Needs: DATABASE_URL, ffmpeg with libvpx-vp9, volt-player node_modules
//  (shaka-player), playwright-core with a Chromium. Skips (and says so)
//  without them. Usage: DATABASE_URL=... npx tsx test/delivery-browser.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ORIGIN = mkdtempSync(join(tmpdir(), 'volt-delivery-browser-'));
process.env.ORIGIN_DIR = ORIGIN;
process.env.DELIVERY_METER_WINDOW_SEC = '4';
process.env.DELIVERY_DURESS_HOLD_SEC = '30';
process.env.STEERING_MIN_PLAYING_MS = '60000';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d !== undefined ? ' -- ' + JSON.stringify(d).slice(0, 600) : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUNGS = [{ n: 1, w: 960, h: 540, k: 3000 }, { n: 2, w: 640, h: 360, k: 1200 }, { n: 3, w: 320, h: 180, k: 400 }];
const SEG = 2, SECONDS = 120;

(async () => {
  const ROOT = resolve(__dirname, '..');
  const SHAKA = resolve(ROOT, '../volt-player/node_modules/shaka-player/dist/shaka-player.compiled.js');
  let pw: any = null;
  try { pw = require(require.resolve('playwright-core', { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* skip */ }
  const chromium = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const haveVp9 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libvpx-vp9');
  const missing = [!pw && 'playwright-core', !haveVp9 && 'ffmpeg with libvpx-vp9', !existsSync(SHAKA) && 'volt-player node_modules', !process.env.DATABASE_URL && 'DATABASE_URL'].filter(Boolean);
  if (missing.length) { console.log(`SKIP: missing ${missing.join(', ')}`); console.log('\n0 passed, 0 failed (skipped)'); process.exit(0); }

  // ---- the ladder, encoded once ----
  const media = mkdtempSync(join(tmpdir(), 'volt-delivery-media-'));
  for (const r of RUNGS) {
    mkdirSync(join(media, `v${r.n}`));
    const e = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${r.w}x${r.h}:rate=25`, '-t', String(SECONDS),
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', `${r.k}k`, '-minrate', `${r.k}k`, '-maxrate', `${r.k}k`,
      '-g', '50', '-keyint_min', '50', '-f', 'hls', '-hls_time', String(SEG), '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod',
      '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(media, `v${r.n}`, 'seg_%d.m4s'), join(media, `v${r.n}`, 'index.m3u8')], { encoding: 'utf8' });
    if (e.status !== 0) { console.log('FAIL encoding the ladder -- ' + e.stderr); process.exit(1); }
  }
  const nSeg = readdirSync(join(media, 'v1')).filter((f) => f.startsWith('seg_')).length;
  const MASTER = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
    ...RUNGS.flatMap((r) => [`#EXT-X-STREAM-INF:BANDWIDTH=${r.k * 1000},CODECS="vp09.00.30.08",RESOLUTION=${r.w}x${r.h}`, `stream_${r.n}_cc.m3u8`]), ''].join('\n');

  // ---- the control plane ----
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { aquery, closeAnalytics } = await import('../src/services/qoe/analyticsDb');
  const cm = await import('../src/services/delivery/cmsd');
  const st = await import('../src/services/delivery/steering');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`db-${tag}`]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'Lab') RETURNING id`, [acct]))!.id;
  const srv = createServer().listen(0);
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as any).port;

  /** A live channel: the ladder's segments, a five-segment window advancing in real time. */
  const timers: NodeJS.Timeout[] = [];
  async function liveChannel(name: string): Promise<string> {
    const id = (await one<any>(`INSERT INTO channels(group_id, name, status, on_air) VALUES ($1,$2,'live',true) RETURNING id`, [grp, name]))!.id;
    const run = join(ORIGIN, id, 'runs', 'r1');
    mkdirSync(run, { recursive: true });
    spawnSync('cp', ['-r', ...RUNGS.map((r) => join(media, `v${r.n}`)), run]);
    writeFileSync(join(ORIGIN, id, 'current_run.txt'), 'r1');
    writeFileSync(join(run, 'master_cc.m3u8'), MASTER);
    const t0 = Date.now();
    const tick = () => {
      const k = Math.min(nSeg - 1, 5 + Math.floor((Date.now() - t0) / (SEG * 1000)));
      for (const r of RUNGS) {
        const L = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${SEG}`, `#EXT-X-MEDIA-SEQUENCE:${k - 5}`, `#EXT-X-MAP:URI="v${r.n}/init.mp4"`];
        for (let i = k - 5; i < k; i++) L.push(`#EXTINF:${SEG}.000,`, `v${r.n}/seg_${i}.m4s`);
        const p = join(run, `stream_${r.n}_cc.m3u8`);
        writeFileSync(p + '.tmp', L.join('\n') + '\n'); renameSync(p + '.tmp', p);
      }
      writeFileSync(join(run, 'master_cc.m3u8'), MASTER);
    };
    tick(); timers.push(setInterval(tick, 1000));
    return id;
  }

  // ---- the viewer's site ----
  const page0 = `<!doctype html><video id="v" muted autoplay playsinline style="width:480px"></video><script src="/shaka.js"></script>
<script>
window.lab = { stalls: [], variants: [], segHosts: [], playing: false, err: null };
window.start = async (url, cmsd) => {
  shaka.polyfill.installAll();
  const v = document.getElementById('v'), p = new shaka.Player(); await p.attach(v); window.p = p;
  // the Volt SDK's own streaming settings (sdk/engine.ts), CMCD as the SDK sends it (the sid tells viewers apart), a start on the top rung
  p.configure({ streaming: { rebufferingGoal: 2, bufferingGoal: 20 }, manifest: { hls: { liveSegmentsDelay: 2 } }, abr: { enabled: true, defaultBandwidthEstimate: 6e6 }, cmsd: { enabled: cmsd }, cmcd: { enabled: true } });
  let since = null;
  p.addEventListener('buffering', (e) => {
    if (!window.lab.playing) return;
    if (e.buffering) since = performance.now();
    else if (since != null) { window.lab.stalls.push({ at: since, ms: performance.now() - since }); since = null; }
  });
  window.lab.openStall = () => since == null ? null : performance.now() - since;
  v.addEventListener('playing', () => { window.lab.playing = true; });
  p.addEventListener('variantchanged', () => window.lab.variants.push({ at: performance.now(), bw: p.getVariantTracks().find((t) => t.active)?.bandwidth }));
  p.addEventListener('adaptation', () => window.lab.variants.push({ at: performance.now(), bw: p.getVariantTracks().find((t) => t.active)?.bandwidth }));
  p.getNetworkingEngine().registerResponseFilter((type, res) => { if (type === 1) window.lab.segHosts.push({ at: performance.now(), host: new URL(res.uri).host }); });
  p.addEventListener('error', (e) => { window.lab.err = e.detail && e.detail.code; });
  window.lab.t0 = performance.now();
  await p.load(url);
};
window.now = () => ({ t: performance.now() - window.lab.t0, ct: document.getElementById('v').currentTime, bw: window.p.getVariantTracks().find((t) => t.active)?.bandwidth });
</script>`;
  const site = httpServer((q, res) => {
    if (q.url === '/shaka.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync(SHAKA)); }
    res.setHeader('content-type', 'text/html'); res.end(page0);
  }).listen(0);
  await new Promise((r) => site.once('listening', r));
  const siteUrl = `http://127.0.0.1:${(site.address() as any).port}/`;

  const browser = await pw.chromium.launch({ executablePath: chromium, args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---- 1. CMSD, twice: four viewers sharing the origin's uplink ----
  // THE SHARED LINK: a proxy in front of the origin that sends at most LINK
  // bits per second in total, shared out evenly between the responses in
  // flight, as one uplink is shared by everyone it serves.
  const LINK = 10e6;
  const active = new Set<{ q: Buffer[]; res: any; done: boolean }>();
  const linkSec = new Map<number, number>();   // bytes sent per second, for the utilisation
  const pump = setInterval(() => {
    const live = [...active].filter((w) => w.q.length);
    if (!live.length) return;
    const sec = Math.floor(Date.now() / 1000);
    linkSec.set(sec, (linkSec.get(sec) ?? 0) + Math.min(LINK / 8 / 100, live.reduce((n, w) => n + w.q.reduce((m, c) => m + c.length, 0), 0)));
    let share = Math.floor(LINK / 8 / 100 / live.length); // per 10 ms
    for (const w of live) {
      let left = share;
      while (left > 0 && w.q.length) {
        const c = w.q[0];
        if (c.length <= left) { w.res.write(c); w.q.shift(); left -= c.length; }
        else { w.res.write(c.subarray(0, left)); w.q[0] = c.subarray(left); left = 0; }
      }
      if (!w.q.length && w.done) { w.res.end(); active.delete(w); }
    }
  }, 10);
  const proxy = httpServer(async (q, res) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${q.url}`);
      const keep = ['content-type', 'cmsd-static', 'cmsd-dynamic', 'access-control-allow-origin', 'access-control-expose-headers', 'cache-control'];
      for (const h of keep) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
      res.statusCode = r.status;
      const buf = Buffer.from(await r.arrayBuffer());
      const w = { q: [] as Buffer[], res, done: true };
      for (let i = 0; i < buf.length; i += 16384) w.q.push(buf.subarray(i, i + 16384));
      if (!w.q.length) { res.end(); return; }
      active.add(w);
    } catch { res.statusCode = 502; res.end(); }
  }).listen(0);
  await new Promise((r) => proxy.once('listening', r));
  const pport = (proxy.address() as any).port;

  async function cmsdRun(follow: boolean) {
    process.env.DELIVERY_ALLOWANCE_MBPS = String(LINK / 1e6);   // the origin knows its own uplink
    cm.resetOriginGuidance();
    const id = await liveChannel(`Lab ${follow ? 'A' : 'B'}`);
    const pages: any[] = [];
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const page = await browser.newPage();
      page.on('response', (r: any) => { const h = r.headers()['cmsd-dynamic']; if (h && h.includes('mb=')) seen.push(h); });
      await page.goto(siteUrl);
      await page.evaluate(([u, c]: any) => (window as any).start(u, c), [`http://127.0.0.1:${pport}/origin/${id}/live/master_cc.m3u8`, follow]);
      pages.push(page);
      await sleep(1000);
    }
    const t0 = Date.now(), from = Math.floor(t0 / 1000) + 10;
    const minBuf = pages.map(() => Infinity);
    while (Date.now() - t0 < 40_000) {
      await sleep(500);
      if (Date.now() - t0 < 10_000) continue;
      for (let i = 0; i < pages.length; i++) {
        const b = await pages[i].evaluate(() => { const v = document.getElementById('v') as HTMLVideoElement; const r = v.buffered; return r.length ? r.end(r.length - 1) - v.currentTime : 0; });
        minBuf[i] = Math.min(minBuf[i], b);
      }
    }
    const secs = [...linkSec.entries()].filter(([k]) => k >= from && k < Math.floor(Date.now() / 1000)).map(([, v]) => v * 8 / LINK);
    const saturated = secs.filter((u) => u > 0.97).length;
    const out = [];
    for (const page of pages) out.push(await page.evaluate(() => ({ ...(window as any).now(), lab: (window as any).lab, open: (window as any).lab.openStall() })));
    await sleep(2000);
    const ct2 = [];
    for (const page of pages) { ct2.push((await page.evaluate(() => (window as any).now())).ct); await page.close(); }
    const stalls = out.reduce((n, o) => n + o.lab.stalls.length + (o.open != null ? 1 : 0), 0);
    const stallMs = Math.round(out.reduce((n, o) => n + o.lab.stalls.reduce((m: number, x: any) => m + x.ms, 0) + (o.open ?? 0), 0));
    return { saturated, secs: secs.length, minBuf: minBuf.map((b) => Math.round(b * 10) / 10), stalls, stallMs, perViewer: out.map((o) => o.lab.stalls.length), rungsNow: out.map((o) => o.bw), err: out.map((o) => o.lab.err).filter(Boolean),
      stillPlaying: out.every((o, i) => ct2[i] > o.ct + 1), mb: seen[seen.length - 1] ?? null };
  }
  const A = await cmsdRun(true);
  const B = await cmsdRun(false);
  clearInterval(pump); proxy.close();
  console.log(`  run A (follow CMSD): ${A.stalls} stalls (${A.stallMs} ms) over 4 viewers, uplink full ${A.saturated} of ${A.secs} s, least buffer ${JSON.stringify(A.minBuf)} s, rungs at the end ${A.rungsNow}, guidance ${A.mb}`);
  console.log(`  run B (ignore CMSD): ${B.stalls} stalls (${B.stallMs} ms) over 4 viewers, uplink full ${B.saturated} of ${B.secs} s, least buffer ${JSON.stringify(B.minBuf)} s, rungs at the end ${B.rungsNow}`);
  ok(A.mb && /mb=\d+/.test(A.mb), 'the origin, its uplink nearly full, sent mb on the playlists', A.mb);
  ok(A.rungsNow.every((b: number) => b <= 1.2e6), 'the viewers following CMSD are at or under the ceiling at the end (the guidance held, no cycle back up)', A.rungsNow);
  ok(A.saturated <= B.saturated, `the uplink was full no more often with CMSD (${A.saturated} s) than without (${B.saturated} s)`, { A: A.saturated, B: B.saturated });
  ok(A.stalls <= B.stalls, `viewers following CMSD stalled no more: ${A.stalls} (${A.stallMs} ms) against ${B.stalls} (${B.stallMs} ms)`, { A, B });
  ok(A.stillPlaying && B.stillPlaying && !A.err.length && !B.err.length, 'every viewer is still playing at the end, no error (players that ignore CMSD keep playing)', { A: [A.stillPlaying, A.err], B: [B.stillPlaying, B.err] });

  // ---- 2. steering ----
  process.env.DELIVERY_ALLOWANCE_MBPS = '0';
  cm.resetOriginGuidance();
  process.env.DELIVERY_PATHWAYS = JSON.stringify({ pathways: [{ id: 'a', base: `http://127.0.0.1:${port}` }, { id: 'b', base: `http://localhost:${port}` }], ttlSec: 2 });
  await aquery(`DELETE FROM qoe_minutes WHERE cdn IN ('127.0.0.1', 'localhost')`);
  st.clearQualityCache();
  const sid = await liveChannel('Lab steering');
  const page = await browser.newPage();
  await page.goto(siteUrl);
  const steerReqs: string[] = [];
  page.on('request', (r: any) => { if (r.url().includes('/steering')) steerReqs.push(r.url()); });
  await page.evaluate(([u]: any) => (window as any).start(u, true), [`http://127.0.0.1:${port}/live/${sid}/master.m3u8?as=AU`]);
  await sleep(12_000);
  const before = await page.evaluate(() => ({ ...(window as any).now(), hosts: (window as any).lab.segHosts.map((h: any) => h.host), stalls: (window as any).lab.stalls.length }));
  ok(before.hosts.length >= 3 && before.hosts.every((h: string) => h.startsWith('127.0.0.1')), 'steering: the player starts on path a (127.0.0.1)', before.hosts);
  ok(steerReqs.length >= 3 && steerReqs.every((u) => /as=AU/.test(u)) && steerReqs.slice(1).every((u) => (u.match(/_HLS_pathway=a/g) ?? []).length === 1),
    `steering: the player asks the service every TTL (${steerReqs.length} times in 12 s), saying its pathway once`, steerReqs.slice(0, 3));
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  await aquery(`INSERT INTO qoe_minutes(account_id, minute, content_id, stream_type, country, device_class, cdn, def_version, attempts, starts, stalls, playing_ms, rebuffer_ms)
                VALUES ($1,$2,$3,'live','AU','desktop','127.0.0.1',1,20,20,40,540000,60000), ($1,$2,$3,'live','AU','desktop','localhost',1,20,20,1,580000,1000)`, [acct, minute, sid]);
  st.clearQualityCache();
  const tMove = before.t;
  await sleep(12_000);
  const afterS = await page.evaluate(() => ({ ...(window as any).now(), lab: (window as any).lab, open: (window as any).lab.openStall() }));
  const moved = afterS.lab.segHosts.filter((h: any) => h.at - afterS.lab.t0 > tMove);
  const firstB = moved.findIndex((h: any) => h.host.startsWith('localhost'));
  ok(firstB >= 0 && moved.slice(firstB).every((h: any) => h.host.startsWith('localhost')) && moved.slice(firstB).length >= 3,
    `steering: after the reports, segments come from path b (moved within ${firstB >= 0 ? Math.round((moved[firstB].at - afterS.lab.t0 - tMove) / 100) / 10 : '?'} s)`, moved.map((h: any) => h.host));
  // from the moment the reports change (a stall while the player first fills its buffer is not the move's)
  const moveStalls = afterS.lab.stalls.filter((x: any) => x.at - afterS.lab.t0 > tMove);
  ok(moveStalls.length === 0 && afterS.open == null && !afterS.lab.err, 'steering: no stall and no error through the move', { stalls: afterS.lab.stalls, tMove, err: afterS.lab.err });
  ok(afterS.ct > before.ct + 10, `steering: the picture kept going (${Math.round(before.ct)} s to ${Math.round(afterS.ct)} s in 12 s)`, [before.ct, afterS.ct]);
  await page.close();
  delete process.env.DELIVERY_PATHWAYS;

  for (const t of timers) clearInterval(t);
  await browser.close(); site.close(); srv.close(); await closeAnalytics(); await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
