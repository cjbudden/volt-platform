// ============================================================================
//  HTML GRAPHICS IN THE VOLT PLAYER, in a real browser (build queue 1.9).
//
//  The whole viewer path, end to end: a sample template pasted and published
//  through the API, a setup and a player assignment on a live channel, the
//  real control plane (Postgres + HTTP), the real player SDK bundled from
//  volt-player/src, playing a live VP9 HLS stream with PROGRAM-DATE-TIME in
//  Chromium. Then, through the operator API: the graphic comes on (shows),
//  its value changes (updates), it is taken off (hides). And the layer keeps
//  its sandbox: the iframe has no allow-same-origin, runs at an opaque origin,
//  cannot read the host page or its cookies, and its CSP keeps it off the
//  network. A setup trying out an unpublished draft never reaches viewers.
//
//  The pure parts (snapshot choice, merging) are player-overlay.check.ts; the
//  feed's API rules are graphics.check.ts.
//
//  Needs: DATABASE_URL (a migrated, disposable database), ffmpeg with libvpx,
//  esbuild (volt-app's own) and shaka-player installed in volt-player, and
//  playwright-core with a Chromium. Not a dependency of the app, so it is
//  looked for and the browser part SKIPS (and says so) when it is missing:
//    npm i --no-save playwright-core          (in volt-app)
//    CHROMIUM_PATH=/path/to/chrome            (optional; else Playwright's own)
//  Usage: DATABASE_URL=... npx tsx test/player-overlay-browser.check.ts
// ============================================================================
import { createServer as httpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0, skipped = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until fn() is truthy; the time it took in ms, or -1. */
async function until(fn: () => Promise<unknown>, timeoutMs: number, every = 100): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return Date.now() - t0; } catch { /* not yet */ }
    await sleep(every);
  }
  return -1;
}

const SAMPLE = (name: string) => `<script type="application/json" id="volt-manifest">{"name":"${name}","canvas":[1920,1080],"fields":[{"id":"home","type":"text"},{"id":"away","type":"text"}]}</script>
<style>#bug{position:absolute;left:120px;top:80px;padding:12px 24px;background:#0d2a4a;color:#fff;font:48px sans-serif;display:none}</style>
<div id="bug"><span id="home"></span> - <span id="away"></span></div>
<script>
function update(d){ if(typeof d==='string') d=JSON.parse(d); if(d.home!=null) document.getElementById('home').textContent=d.home; if(d.away!=null) document.getElementById('away').textContent=d.away; document.body.dataset.updates=String((+document.body.dataset.updates||0)+1) }
function play(){ document.getElementById('bug').style.display='block'; document.body.dataset.state='playing' }
function stop(){ document.getElementById('bug').style.display='none'; document.body.dataset.state='stopped' }
</script>`;

(async () => {
  const ROOT = resolve(__dirname, '..');
  const PLAYER = resolve(ROOT, '../volt-player');

  // ---- what the browser part needs; any missing piece skips it, said plainly ----
  let pw: any = null;
  try { pw = require(require.resolve('playwright-core', { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* skip below */ }
  const chromium = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const haveFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libvpx-vp9');
  const haveShaka = existsSync(join(PLAYER, 'node_modules/shaka-player'));
  const missing = [!pw && 'playwright-core (npm i --no-save playwright-core)', !haveFfmpeg && 'ffmpeg with libvpx-vp9', !haveShaka && 'volt-player node_modules (npm install in volt-player)'].filter(Boolean);

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { generateKey } = await import('../src/services/apiKeys');

  // ---- seed: an account, a live transcode channel, a web app with a publishable key ----
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gfxp-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `gfxp-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Sport 1','live') RETURNING id`, [grp]))!.id;
  const appRow = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [acct]);
  const key = generateKey('publishable');
  await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,'publishable',$3,$4,'{playback}')`, [acct, appRow!.id, key.prefix, key.hash]);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const feed = async () => (await (await fetch(`${base}/api/player/graphics?appKey=${key.raw}&streamId=${ch}`)).json()) as any;

  let browser: any = null; let page: any = null; let site: any = null; let work = '';
  try {
    console.log('== a sample template, published, on the channel for players ==');
    let r = await api('POST', '/api/graphics/templates', { html: SAMPLE('Test score'), kind: 'scorebug' });
    const tpl = r.j;
    ok(r.s === 201 && tpl.draft?.publishable, 'sample template pasted, its checks pass', JSON.stringify(r.j).slice(0, 300));
    r = await api('POST', `/api/graphics/templates/${tpl.id}/draft/publish`, { note: 'v1' });
    const v1 = r.j;
    ok(r.s === 200 && v1.status === 'published', 'published as v1');
    r = await api('POST', '/api/graphics/setups', { name: 'Match score', versionId: v1.id, placement: { anchor: 'top_left', x: 0, y: 0, scale: 1, layer: 2 },
      fields: { home: { source: 'operator' }, away: { source: 'operator' } } });
    const setup = r.j;
    ok(r.s === 201, 'setup on v1', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: ch, targets: 'player', runMode: 'manual' });
    const asg = r.j;
    ok(r.s === 201, 'assigned to the channel, shown in the player, taken by hand', JSON.stringify(r.j).slice(0, 200));
    await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { home: 'BLUES 14', away: 'CHIEFS 10' } });

    console.log('== a setup trying out a draft never reaches viewers ==');
    r = await api('POST', '/api/graphics/templates', { html: SAMPLE('Draft bug'), kind: 'bug' });
    const draftTpl = r.j;
    r = await api('POST', '/api/graphics/setups', { name: 'Trying the draft', versionId: draftTpl.draft.id, fields: { home: { source: 'operator' }, away: { source: 'operator' } } });
    const draftSetup = r.j;
    ok(r.s === 201 && draftSetup.versionStatus === 'draft', 'a setup may try out a draft (console preview, live control)', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', '/api/graphics/assignments', { setupId: draftSetup.id, channelId: ch, targets: 'player', runMode: 'manual' });
    const asgDraft = r.j;
    await api('PATCH', `/api/graphics/assignments/${asgDraft.id}/state`, { values: { home: 'DRAFT', away: 'DRAFT' } });
    await api('POST', `/api/graphics/assignments/${asgDraft.id}/air`, { on: true });
    let f = await feed();
    ok(Array.isArray(f.graphics) && f.graphics.length === 1 && f.graphics[0].id === asg.id && f.graphics[0].url === `/gfx/${v1.id}/index.html`,
      'the player feed lists only the published one, at its published version', JSON.stringify(f.graphics?.map((g: any) => [g.name, g.url])));
    ok(f.snapshots.every((s: any) => !(asgDraft.id in s.state)), 'and no state for the draft one, even taken on air');

    if (missing.length) {
      skipped = 1;
      console.log(`SKIP the browser part: missing ${missing.join(', ')}`);
    } else {
      // ---- a live VP9 HLS stream with PROGRAM-DATE-TIME (Chromium here has no H.264) ----
      work = mkdtempSync(join(tmpdir(), 'gfx-player-'));
      const enc = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '120',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-g', '50', '-keyint_min', '50',
        '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', join(work, 'seg%d.m4s'), join(work, 'vod.m3u8')], { encoding: 'utf8' });
      ok(enc.status === 0 && existsSync(join(work, 'seg10.m4s')), '120 s of VP9 test picture in 2 s fMP4 segments', enc.stderr?.slice(0, 300));
      const t0 = Date.now() - 10_000;           // the live edge is "now": five segments out at the start
      const live = () => {
        const out = Math.min(59, Math.floor((Date.now() - t0) / 2000));
        const first = Math.max(0, out - 6);
        let s = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-MAP:URI="init.mp4"\n`;
        for (let i = first; i < out; i++) s += `#EXT-X-PROGRAM-DATE-TIME:${new Date(t0 + i * 2000).toISOString()}\n#EXTINF:2.000,\nseg${i}.m4s\n`;
        return s;
      };

      // ---- the embedding site: its own origin, the SDK bundled from source ----
      const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
      const bundle = esbuild.buildSync({ entryPoints: [join(PLAYER, 'src/index.ts')], bundle: true, format: 'iife', globalName: 'VoltPlayer',
        write: false, target: 'es2018', logLevel: 'silent', nodePaths: [join(PLAYER, 'node_modules')] }).outputFiles[0].text;
      const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000">
<div id="p" style="width:960px;height:540px"></div>
<script src="/volt-player.js"></script>
<script>document.cookie='site_session=secret-of-the-host; path=/';
VoltPlayer.create({ el: '#p', appKey: ${JSON.stringify(key.raw)}, apiBase: ${JSON.stringify(base)}, autoplay: true, muted: true, beacons: false,
  item: { id: ${JSON.stringify(ch)}, assetId: ${JSON.stringify(ch)}, live: true, source: { hls: location.origin + '/live/index.m3u8' } } })
  .then(function (p) { window.vp = p; });</script></body></html>`;
      site = httpServer((q, res) => {
        const u = String(q.url).split('?')[0];
        if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end(html); }
        if (u === '/volt-player.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle); }
        if (u === '/live/index.m3u8') { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.setHeader('cache-control', 'no-store'); return res.end(live()); }
        const m = /^\/live\/(init\.mp4|seg\d+\.m4s)$/.exec(u);
        if (m && existsSync(join(work, m[1]))) { res.setHeader('content-type', 'video/mp4'); return res.end(readFileSync(join(work, m[1]))); }
        if (u === '/secret.json') { res.setHeader('access-control-allow-origin', '*'); res.setHeader('content-type', 'application/json'); return res.end('{"secret":1}'); }
        res.statusCode = 404; res.end();
      }).listen(0);
      const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`;

      browser = await pw.chromium.launch({ executablePath: chromium, args: ['--autoplay-policy=no-user-gesture-required'] });
      page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
      const pageErrors: string[] = [];
      page.on('pageerror', (e: any) => pageErrors.push(String(e?.message ?? e)));
      const gfxResponses: { url: string; csp: string }[] = [];
      page.on('response', (resp: any) => { if (/\/gfx\//.test(resp.url())) gfxResponses.push({ url: resp.url(), csp: resp.headers()['content-security-policy'] ?? '' }); });
      await page.goto(siteUrl + '/');

      const playing = await until(() => page.evaluate(() => { const v = document.querySelector('video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.5 && (window as any).vp?.getState().wallClock > 0; }), 30_000, 250);
      const skinAttr = await page.evaluate(`document.querySelector('#p > .vp').dataset.skin + ' ' + document.querySelector('.vp-stage').clientHeight`);
      ok(skinAttr === 'video 540', 'created with no skin named: the video skin, styled (16:9 stage, 540 px high in a 960 px box)', skinAttr);
      ok(playing >= 0, `the live stream plays, the playhead has a wall clock from PROGRAM-DATE-TIME (${playing} ms)`);

      // The layer: one iframe per player graphic, at the published version.
      const frameEl = await until(() => page.evaluate(() => document.querySelectorAll('.vp-gfx iframe').length === 1), 10_000);
      ok(frameEl >= 0, 'the overlay layer has one graphic, the draft one is not drawn');
      const attrs = await page.evaluate(() => { const i = document.querySelector('.vp-gfx iframe') as HTMLIFrameElement; return { sandbox: i.getAttribute('sandbox'), src: i.src }; });
      ok(attrs.sandbox === 'allow-scripts', 'iframe sandbox is allow-scripts only (no allow-same-origin)', String(attrs.sandbox));
      ok(attrs.src === `${base}/gfx/${v1.id}/index.html`, 'loaded from /gfx/<published version>/ on the control plane', attrs.src);
      const gfxFrame = () => page.frames().find((fr: any) => fr.url().includes(`/gfx/${v1.id}/`));
      const inFrame = (fn: any, arg?: any) => gfxFrame()!.evaluate(fn, arg);
      await until(async () => !!gfxFrame() && (await inFrame(() => document.readyState)) === 'complete', 10_000);

      console.log('== shows, updates, hides ==');
      const bugShown = () => inFrame(() => ({ state: document.body.dataset.state ?? '', display: getComputedStyle(document.getElementById('bug')!).display, home: document.getElementById('home')!.textContent, away: document.getElementById('away')!.textContent }));
      let st = await bugShown();
      ok(st.display === 'none' && st.state !== 'playing', 'before it is taken: loaded, nothing drawn', JSON.stringify(st));
      ok((await page.evaluate(() => (window as any).vp.getState().overlays.length)) === 0, 'player state: no overlays on screen');

      const tOn = Date.now();
      await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: true });
      const shown = await until(async () => { const s = await bugShown(); return s.state === 'playing' && s.display === 'block' && s.home === 'BLUES 14'; }, 15_000);
      const behind = Math.round(await page.evaluate(`window.vp.getState().behindLive`));
      ok(shown >= 0, `taken on through the API: shown in the player with its values (${shown >= 0 ? Date.now() - tOn : -1} ms; the playhead is ${behind} s behind live and the change is applied when the picture reaches it)`, JSON.stringify(await bugShown()));
      const ov = await page.evaluate(() => (window as any).vp.getState().overlays);
      ok(ov.length === 1 && ov[0].id === asg.id && ov[0].name === 'Match score', 'player state names the overlay on screen', JSON.stringify(ov));
      const box = await page.evaluate(`(() => { const b = document.querySelector('.vp-gfx').getBoundingClientRect(); const v = document.querySelector('.vp-stage').getBoundingClientRect();
        return { b: [Math.round(b.width), Math.round(b.height)], v: [Math.round(v.width), Math.round(v.height)] }; })()`);
      ok(Math.abs(box.b[0] / box.b[1] - 16 / 9) < 0.02 && box.b[0] <= box.v[0] + 1 && box.b[1] <= box.v[1] + 1 && box.b[0] > 0, 'the layer is fitted to the picture: the 1920x1080 canvas scaled into the stage', JSON.stringify(box));
      await page.screenshot({ path: join(work, 'shown.png') });

      const tUp = Date.now();
      await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { home: 'BLUES 21' } });
      const updated = await until(async () => (await bugShown()).home === 'BLUES 21', 15_000);
      st = await bugShown();
      ok(updated >= 0 && st.away === 'CHIEFS 10' && st.state === 'playing', `a value changed through the API: updated in place, still on (${updated >= 0 ? Date.now() - tUp : -1} ms)`, JSON.stringify(st));

      const tOff = Date.now();
      await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: false });
      const hidden = await until(async () => { const s = await bugShown(); return s.state === 'stopped' && s.display === 'none'; }, 15_000);
      ok(hidden >= 0, `taken off through the API: hidden (${hidden >= 0 ? Date.now() - tOff : -1} ms)`, JSON.stringify(await bugShown()));
      ok((await page.evaluate(() => (window as any).vp.getState().overlays.length)) === 0, 'player state: no overlays on screen again');

      console.log('== the sandbox is kept ==');
      const csp = gfxResponses.find((g) => g.url.includes(`/gfx/${v1.id}/index.html`))?.csp ?? '';
      ok(/(^|;\s*)sandbox allow-scripts(;|$)/.test(csp) && !/allow-same-origin/.test(csp), 'served with CSP sandbox allow-scripts, no allow-same-origin', csp);
      ok(csp.includes(`connect-src ${base}/gfx/${v1.id}/;`), 'connect-src is the template’s own package only', csp);
      const probe = await inFrame(async (o: { site: string; api: string }) => {
        const out: Record<string, unknown> = { origin: self.origin };
        try { out.cookie = document.cookie; } catch (e) { out.cookie = 'threw:' + (e as Error).name; }
        try { out.parent = String((parent as any).document.cookie); } catch (e) { out.parent = 'threw:' + (e as Error).name; }
        try { await fetch(o.site + '/secret.json'); out.siteFetch = 'reached'; } catch { out.siteFetch = 'blocked'; }
        try { await fetch(o.api + '/api/health'); out.apiFetch = 'reached'; } catch { out.apiFetch = 'blocked'; }
        try { await fetch(location.href); out.ownFetch = 'reached'; } catch { out.ownFetch = 'blocked'; }
        return out;
      }, { site: siteUrl, api: base });
      ok(probe.origin === 'null', 'the template runs at an opaque origin', String(probe.origin));
      ok(String(probe.cookie).startsWith('threw:'), 'it cannot read cookies', String(probe.cookie));
      ok(String(probe.parent).startsWith('threw:'), 'it cannot reach into the host page', String(probe.parent));
      ok(probe.siteFetch === 'blocked' && probe.apiFetch === 'blocked', 'it cannot fetch the host site or the Volt API (CSP)', JSON.stringify(probe));
      ok(probe.ownFetch === 'reached', 'it can still read its own package', JSON.stringify(probe));
      const hostCookie = await page.evaluate(() => document.cookie);
      ok(hostCookie.includes('secret-of-the-host'), 'the host page’s cookie is untouched (and was there to steal)');

      f = await feed();
      ok(f.graphics.length === 1, 'the draft one is still not in the feed after all that');
      const errs = pageErrors.filter((e) => !/codec|decode/i.test(e));
      ok(errs.length === 0, 'no page errors', errs.join(' | '));
    }
  } catch (e) {
    fail++; console.log('FAIL unexpected: ' + ((e as Error).stack ?? e));
  } finally {
    try { await browser?.close(); } catch { /* */ }
    try { site?.close(); } catch { /* */ }
    srv.close();
    await pool.end().catch(() => {});
    if (work && !process.env.KEEP_WORK) try { rmSync(work, { recursive: true, force: true }); } catch { /* */ }
  }
  console.log(`\n${pass} passed, ${fail} failed${skipped ? ' (browser part skipped)' : ''}`);
  process.exit(fail ? 1 : 0);
})();
