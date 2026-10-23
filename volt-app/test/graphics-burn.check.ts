// ============================================================================
//  GRAPHICS BURNED INTO THE VIDEO, end to end (build queue 1.10).
//
//  The control plane's side through the real API and Postgres: the burn feed
//  the encoder's renderer follows (ingest token, published versions only, burn
//  and both but not player-only, values only while on air, an ad break takes
//  them off), the plan worked out at start, the job config and the load
//  estimate. Then the whole path for real: the renderer
//  (volt-encoder/gfx/burn_renderer.js) in headless Chromium following the feed
//  from the running API, and the encoder's own composite graph and rung
//  settings (gfx_burn.py, ladder_args.py) encoding a live source while an
//  operator takes the graphic on, changes it and takes it off through the API.
//  The PIXELS of the encoded output are read back: nothing in the box before
//  it is taken, the graphic exactly where the player would draw it after, its
//  new colour after the change, nothing after it is taken off, and the time
//  from each API call to the first encoded frame that shows it.
//
//  The encoder's own pieces (graph, seed, dead-man, start_transcode) are
//  volt-encoder/bin/test_gfx_burn.py.
//
//  Needs DATABASE_URL (a migrated, disposable database). The renderer part
//  needs ffmpeg with libx264, python3, playwright-core installed next to the
//  renderer (npm ci in volt-encoder/gfx) and a Chromium or Chrome
//  (GFX_CHROMIUM_PATH or CHROMIUM_PATH, else the usual places); it SKIPS and
//  says what is missing otherwise.
//  Usage: DATABASE_URL=... npx tsx test/graphics-burn.check.ts
// ============================================================================
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown> | unknown, timeoutMs: number, every = 50): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await fn()) return Date.now() - t0; } catch { /* not yet */ } await sleep(every); }
  return -1;
}

// A solid box exactly where its manifest says it draws, coloured by a field.
const TEMPLATE = `<script type="application/json" id="volt-manifest">{"name":"Burn box","canvas":[1920,1080],"bbox":[200,120,500,140],"fields":[{"id":"label","type":"text"},{"id":"colour","type":"text"}]}</script>
<style>html,body{margin:0;background:transparent}#box{position:absolute;left:200px;top:120px;width:500px;height:140px;background:#e01414;display:none;color:#e01414;font:20px sans-serif}</style>
<div id="box"><span id="label"></span></div>
<script>
function update(d){ if(typeof d==='string') d=JSON.parse(d); if(d.label!=null) document.getElementById('label').textContent=d.label; if(d.colour) { var b=document.getElementById('box'); b.style.background=d.colour; b.style.color=d.colour; } }
function play(){ document.getElementById('box').style.display='block' }
function stop(){ document.getElementById('box').style.display='none' }
</script>`;

(async () => {
  const ROOT = resolve(__dirname, '..');
  const ENC = resolve(ROOT, '../volt-encoder');
  const GFX = join(ENC, 'gfx');
  const BIN = join(ENC, 'bin');

  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const { burnPlan, burnRegion, placedBox } = await import('../src/services/graphics/burnFeed');
  const { buildEncoderJobConfig } = await import('../src/services/jobConfig');
  const { estimateEncoderLoad, encoderSignature } = await import('../src/services/fleet/streamLoad');

  // ---- the placement maths, without a database ----
  console.log('== where a graphic lands (the player\'s layout) ==');
  const canvas: [number, number] = [1920, 1080];
  const bbox: [number, number, number, number] = [200, 120, 500, 140];
  ok(JSON.stringify(placedBox({ canvas, bbox })) === JSON.stringify([200, 120, 500, 140]), 'top left, no offset, scale 1: its own box');
  const placed = placedBox({ canvas, bbox, placement: { anchor: 'bottom_right', x: -40, y: -30, scale: 0.8 } });
  ok(placed.map((n) => Math.round(n)).join(',') === '504,282,400,112', 'bottom right, offset -40,-30, scale 0.8: scaled about the anchor', placed.join(','));
  const half = placedBox({ canvas: [3840, 2160], bbox: [400, 240, 1000, 280] });
  ok(half.join(',') === '200,120,500,140', 'a 4K template canvas is fitted to 1920x1080', half.join(','));
  ok(JSON.stringify(burnRegion([{ canvas, bbox }])) === JSON.stringify([192, 112, 516, 156]), 'the region: the box padded by 8 px, on even pixels', JSON.stringify(burnRegion([{ canvas, bbox }])));
  ok(JSON.stringify(burnRegion([{ canvas, bbox: [1800, 1000, 400, 300] }])) === JSON.stringify([1792, 992, 128, 88]), 'kept inside the canvas');
  ok(JSON.stringify(burnRegion([{ canvas, bbox: [100, 100, 100, 100] }, { canvas, bbox: [1500, 900, 100, 100] }])) === JSON.stringify([92, 92, 1516, 916]), 'two graphics: the union of their boxes');
  ok(JSON.stringify(burnRegion([{ canvas }])) === JSON.stringify([0, 0, 1920, 1080]), 'no declared bbox: the whole canvas (it still works, it just costs more)');
  ok(burnRegion([]) === null, 'nothing to burn: no region');

  // ---- seed: two accounts, transcode and package-only channels ----
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`gfxb-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `gfxb-${tag}@volt.test`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[{"height":720,"bitrate_kbps":1500,"fps":25},{"height":360,"bitrate_kbps":500,"fps":25}]','transcode') RETURNING id`, [acct]))!.id;
  const pkgProf = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'P','[]','package_only') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const pkgGrp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'GP',$2) RETURNING id`, [acct, pkgProf]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Sport 1','live') RETURNING id`, [grp]))!.id;
  const quiet = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Quiet','live') RETURNING id`, [grp]))!.id;
  const pkgCh = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Pass through','live') RETURNING id`, [pkgGrp]))!.id;

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const api = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j };
  };
  const feedUrl = (id: string, kind = 'channel') => `${base}/api/streams/${id}/burn-graphics?kind=${kind}`;
  const feed = async (id = ch) => (await (await fetch(feedUrl(id), { headers: { 'X-Volt-Ingest-Token': config.ingestToken } })).json()) as any;

  let renderer: ChildProcess | null = null; let work = '';
  try {
    console.log('== a template, published, burned on a transcode channel ==');
    let r = await api('POST', '/api/graphics/templates', { html: TEMPLATE, kind: 'bug' });
    const tpl = r.j;
    ok(r.s === 201 && tpl.draft?.publishable, 'template pasted, its checks pass', JSON.stringify(r.j).slice(0, 300));
    r = await api('POST', `/api/graphics/templates/${tpl.id}/draft/publish`, { note: 'v1' });
    const v1 = r.j;
    ok(r.s === 200 && v1.status === 'published', 'published as v1');
    const placement = { anchor: 'bottom_right', x: -40, y: -30, scale: 0.8, layer: 2 };
    r = await api('POST', '/api/graphics/setups', { name: 'Burn box', versionId: v1.id, placement, fields: { label: { source: 'operator' }, colour: { source: 'operator' } } });
    const setup = r.j;
    ok(r.s === 201, 'setup on v1, bottom right', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: ch, targets: 'burn', runMode: 'manual' });
    const asg = r.j;
    ok(r.s === 201 && asg.targets === 'burn', 'assigned to the channel: burned into the video, taken by hand', JSON.stringify(r.j).slice(0, 200));
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: pkgCh, targets: 'burn', runMode: 'manual' });
    ok(r.s === 400, 'burned on a package-only channel is refused (its picture is the source encoder\'s)', `${r.s}`);
    // Player-only and a draft: neither is burned.
    r = await api('POST', '/api/graphics/assignments', { setupId: setup.id, channelId: ch, targets: 'player', runMode: 'manual' });
    const asgPlayer = r.j;
    r = await api('POST', '/api/graphics/templates', { html: TEMPLATE.replace('Burn box', 'Draft box'), kind: 'bug' });
    const draftTpl = r.j;
    r = await api('POST', '/api/graphics/setups', { name: 'Draft', versionId: draftTpl.draft.id, fields: { label: { source: 'operator' } } });
    r = await api('POST', '/api/graphics/assignments', { setupId: r.j.id, channelId: ch, targets: 'burn', runMode: 'manual' });
    const asgDraft = r.j;
    await api('POST', `/api/graphics/assignments/${asgDraft.id}/air`, { on: true });
    await api('POST', `/api/graphics/assignments/${asgPlayer.id}/air`, { on: true });

    console.log('== the burn feed ==');
    let raw = await fetch(feedUrl(ch));
    ok(raw.status === 401, 'no ingest token: 401', `${raw.status}`);
    raw = await fetch(feedUrl(ch), { headers: { 'X-Volt-Ingest-Token': 'wrong' } });
    ok(raw.status === 401, 'a wrong token: 401', `${raw.status}`);
    raw = await fetch(feedUrl('00000000-0000-4000-8000-00000000dead'), { headers: { 'X-Volt-Ingest-Token': config.ingestToken } });
    ok(raw.status === 404, 'a stream that does not exist: 404', `${raw.status}`);
    let f = await feed();
    ok(Array.isArray(f.graphics) && f.graphics.length === 1 && f.graphics[0].id === asg.id, 'only the burned graphic at a published version (not player-only, not a draft)', JSON.stringify(f.graphics?.map((g: any) => g.name)));
    const pl = f.graphics[0].placement ?? {};
    ok(f.graphics[0].url === `/gfx/${v1.id}/index.html` && pl.anchor === 'bottom_right' && pl.x === -40 && pl.y === -30 && pl.scale === 0.8
      && JSON.stringify(f.graphics[0].bbox) === JSON.stringify(bbox), 'with its package, placement and declared box', JSON.stringify(f.graphics[0]));
    ok(JSON.stringify(f.region) === JSON.stringify([496, 274, 416, 128]), 'the region: its placed box, padded', JSON.stringify(f.region));
    ok(f.state[asg.id]?.on === false && JSON.stringify(f.state[asg.id]?.v) === '{}', 'not taken yet: off, and no values');
    ok(!(asgPlayer.id in f.state) && !(asgDraft.id in f.state), 'no state for the player-only or the draft one');
    ok((await feed(quiet)).graphics.length === 0, 'another channel burns nothing');
    await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { label: 'LIVE', colour: '#e01414' } });
    await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: true });
    f = await feed();
    ok(f.state[asg.id]?.on === true && f.state[asg.id]?.v?.label === 'LIVE', 'taken on: on, with its values', JSON.stringify(f.state));
    r = await api('POST', `/api/fast/streams/channel/${ch}/breaks`, { durationSec: 30, hideGraphics: true });
    ok(r.s === 201, 'Go to break', JSON.stringify(r.j).slice(0, 200));
    f = await feed();
    ok(f.inBreak === true && f.state[asg.id]?.on === false && JSON.stringify(f.state[asg.id]?.v) === '{}', 'in an ad break that hides graphics: off (as in the player)', JSON.stringify(f));
    await api('DELETE', `/api/fast/streams/channel/${ch}/breaks/${r.j.id}`);
    f = await feed();
    ok(f.inBreak === false && f.state[asg.id]?.on === true, 'break cancelled: back on');
    await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: false });

    console.log('== at start: the plan, the job, the load ==');
    const plan = await burnPlan('channel', ch);
    ok(!!plan && JSON.stringify(plan.region) === JSON.stringify([496, 274, 416, 128]) && plan.count === 1, 'burnPlan: one graphic, the same region as the feed', JSON.stringify(plan));
    ok((await burnPlan('channel', quiet)) === null, 'a channel with nothing burned: no plan');
    ok((await burnPlan('channel', pkgCh)) === null, 'a package-only channel: no plan');
    const ctx: any = {
      kind: 'channel', owner: { id: ch }, inputs: [{ role: 'primary', rendition_label: null, rendition_bitrate_kbps: null, protocol: 'srt', ingest_url: 'srt://x', stream_key: null }],
      profile: { rungs: [{ height: 720, bitrate_kbps: 1500 }], packaging: 'both', workflow_type: 'transcode', codec_backend: 'x264', segment_dur: 4, dvr_window_sec: 60 },
    };
    const before = buildEncoderJobConfig(ctx);
    const job = buildEncoderJobConfig({ ...ctx, burn: plan });
    ok(!('graphics_burn' in before), 'no plan: no graphics_burn in the job');
    const { graphics_burn: gbJob, ...rest } = job as any;
    ok(JSON.stringify(rest) === JSON.stringify(before), 'and with one, the rest of the job is byte-identical');
    ok(gbJob?.feed_url === `${config.internalApiBaseUrl}/api/streams/${ch}/burn-graphics?kind=channel` && gbJob.token === config.ingestToken
      && JSON.stringify(gbJob.region) === JSON.stringify(plan!.region) && gbJob.api_base === config.internalApiBaseUrl && gbJob.fps === 25,
    'graphics_burn: the feed, the token, the region, the API base and the frame rate', JSON.stringify(gbJob));
    ok(!('graphics_burn' in buildEncoderJobConfig({ ...ctx, burn: plan, profile: { ...ctx.profile, workflow_type: 'package_only' } })), 'never on a package-only profile');
    ok(!('graphics_burn' in buildEncoderJobConfig({ ...ctx, burn: plan, profile: { ...ctx.profile, encode_engine: 'aws_medialive' } })), 'never for a vendor engine (it has no renderer of ours)');
    const load = estimateEncoderLoad(job), load0 = estimateEncoderLoad(before);
    ok(load.lines.some((l: any) => /graphics burned/.test(l.what)) && load.load.memoryMib > load0.load.memoryMib && load.load.cpuUnits > load0.load.cpuUnits,
      'the load estimate reserves the renderer', `${load0.load.cpuUnits} -> ${load.load.cpuUnits} cpu, ${load0.load.memoryMib} -> ${load.load.memoryMib} MiB`);
    ok(encoderSignature(job) === encoderSignature(before) + '|gfx', 'its own cost signature; every signature without it unchanged', encoderSignature(job));

    // ---- the real path: renderer + the encoder's graph ----
    let pw = false;
    try { require.resolve('playwright-core', { paths: [GFX] }); pw = true; } catch { /* missing */ }
    const chrome = [process.env.GFX_CHROMIUM_PATH, process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
    const haveX264 = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264');
    const havePy = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
    const missing = [!pw && `playwright-core next to the renderer (npm ci in ${GFX})`, !chrome && 'a Chromium or Chrome (GFX_CHROMIUM_PATH)', !haveX264 && 'ffmpeg with libx264', !havePy && 'python3'].filter(Boolean);
    if (missing.length) {
      console.log(`SKIP the renderer and encode part: missing ${missing.join(', ')}`);
    } else {
      console.log('== the renderer follows the feed ==');
      work = mkdtempSync(join(tmpdir(), 'gfx-burn-'));
      const png = join(work, 'burn.png');
      const region = plan!.region;
      const py = (code: string) => spawnSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(BIN)}); ${code}`], { encoding: 'utf8' });
      const seed = py(`import gfx_burn; gfx_burn.seed(${JSON.stringify(png)}, ${JSON.stringify(region)})`);
      ok(seed.status === 0 && existsSync(png), 'the encoder seeds the PNG first', seed.stderr);
      const logs: any[] = [];
      const startRenderer = () => {
        const p = spawn(process.execPath, [join(GFX, 'burn_renderer.js'), '--feed', feedUrl(ch), '--api', base, '--out', png,
          '--region', region.join(','), '--fps', '25', '--poll-ms', '250', '--stream', ch, '--chrome', chrome!],
        { env: { ...process.env, VOLT_INGEST_TOKEN: config.ingestToken }, stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        p.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { logs.push(JSON.parse(line)); } catch { logs.push({ raw: line }); } } });
        p.stderr!.on('data', (d) => logs.push({ stderr: String(d) }));
        return p;
      };
      // The PNG's pixels, decoded by ffmpeg: rgba, region-sized.
      const [RW, RH] = [region[2], region[3]];
      const pixels = () => {
        const o = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
        return o.status === 0 && o.stdout.length === RW * RH * 4 ? o.stdout : null;
      };
      const opaqueBox = (b: Buffer) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) if (b[(y * RW + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        return x1 < 0 ? null : [x0 + region[0], y0 + region[1], x1 - x0 + 1, y1 - y0 + 1];
      };
      const colourAt = (b: Buffer, cx: number, cy: number) => { const i = ((cy - region[1]) * RW + (cx - region[0])) * 4; return [b[i], b[i + 1], b[i + 2], b[i + 3]]; };

      renderer = startRenderer();
      const ready = await until(() => logs.some((l) => l.ev === 'ready'), 30_000);
      ok(ready >= 0, `the renderer starts in Chromium (${ready} ms)`, JSON.stringify(logs.slice(-3)));
      const blank = await until(() => { const b = pixels(); return b && !opaqueBox(b); }, 5000);
      ok(blank >= 0, 'off air: the PNG is the region\'s size and fully transparent');
      const m0 = statSync(png).mtimeMs;
      await sleep(2600);
      ok(statSync(png).mtimeMs > m0, 'the frame is re-written every 2 s (the heartbeat the dead-man watches)');

      let tCall = Date.now();
      await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: true });
      const onMs = await until(() => { const b = pixels(); return b && opaqueBox(b); }, 8000);
      ok(onMs >= 0, `taken on through the API: drawn into the PNG ${onMs} ms after the call`);
      await sleep(400);
      let b = pixels()!;
      const drawn = opaqueBox(b);
      ok(!!drawn && drawn.every((v, i) => Math.abs(v - [504, 282, 400, 112][i]) <= 1),
        'exactly where the player draws it: bottom right, offset and scaled (canvas 504,282 400x112)', JSON.stringify(drawn));
      let c = colourAt(b, 520, 380);
      ok(c[0] > 200 && c[1] < 50 && c[2] < 50 && c[3] === 255, 'in its colour, opaque', String(c));

      tCall = Date.now();
      await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { colour: '#14c828' } });
      const changeMs = await until(() => { const bb = pixels(); if (!bb) return false; const k = colourAt(bb, 520, 380); return k[1] > 150 && k[0] < 60; }, 8000);
      ok(changeMs >= 0, `a value change through the API redrawn in ${changeMs} ms`);

      console.log('== a renderer that dies ==');
      renderer.kill('SIGKILL'); renderer = null;
      await sleep(500);
      b = pixels()!;
      ok(!!b && !!opaqueBox(b), 'killed: the file stays a whole, valid PNG with the last frame (the encoder\'s dead-man clears it after 10 s)');
      renderer = startRenderer();
      const back = await until(() => logs.filter((l) => l.ev === 'ready').length >= 2, 30_000);
      ok(back >= 0, `restarted (as the encoder's supervisor does): ready again in ${back} ms`);
      const redraw = await until(() => { const bb = pixels(); if (!bb) return false; const k = colourAt(bb, 520, 380); return k[1] > 150 && k[3] === 255; }, 8000);
      ok(redraw >= 0, `and draws the current state again (${redraw} ms)`);

      console.log('== the encoder\'s composite on a live source, read back from the encoded frames ==');
      // Back to red and off air for a clean timeline.
      await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { colour: '#e01414' } });
      await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: false });
      await until(() => { const bb = pixels(); return bb && !opaqueBox(bb); }, 8000);
      const g = py(`import gfx_burn, ladder_args as la
lad = [{"height": 720, "bitrate_kbps": 1500}, {"height": 360, "bitrate_kbps": 500}]
gin, graph, labels = gfx_burn.composite_graph(lad, ${JSON.stringify(region)}, ${JSON.stringify(png)}, fps=25)
print(json.dumps({"gin": gin, "graph": graph, "rungs": [la.video_rung_args(r, seg=1, fps=25, vmap=labels[i]) for i, r in enumerate(lad)]}))`);
      ok(g.status === 0, 'the graph and rung arguments come from the encoder\'s own modules', g.stderr);
      const G = JSON.parse(g.stdout);
      const outs = [join(work, 'r0.ts'), join(work, 'r1.ts')];
      const DUR = 14;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-re', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25', ...G.gin, '-filter_complex', G.graph];
      G.rungs.forEach((ra: string[], i: number) => args.push(...ra, '-t', String(DUR), '-f', 'mpegts', outs[i]));
      const t0 = Date.now();
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let ffErr = ''; ff.stderr!.on('data', (d) => { ffErr += d; });
      const at = async (sec: number) => { const w = t0 + sec * 1000 - Date.now(); if (w > 0) await sleep(w); return (Date.now() - t0) / 1000; };
      const tOn = await at(3); await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: true });
      const tChange = await at(7); await api('PATCH', `/api/graphics/assignments/${asg.id}/state`, { values: { colour: '#14c828' } });
      const tOff = await at(10.5); await api('POST', `/api/graphics/assignments/${asg.id}/air`, { on: false });
      const code = await new Promise<number>((res) => ff.on('exit', (c) => res(c ?? -1)));
      ok(code === 0, 'the encode ran to the end', ffErr.slice(-300));
      // The output timeline starts when ffmpeg delivered its first frame; ffmpeg's
      // own start-up (well under a second here) only makes the latencies below
      // look LONGER, never shorter.
      const sample = (path: string, t: number, x: number, y: number) => {
        const o = spawnSync('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', path, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
        return o.stdout.length >= 3 ? [o.stdout[0], o.stdout[1], o.stdout[2]] : null;
      };
      const red = (k: number[] | null) => !!k && k[0] > 170 && k[1] < 80 && k[2] < 80;
      const green = (k: number[] | null) => !!k && k[1] > 140 && k[0] < 90;
      const black = (k: number[] | null) => !!k && Math.max(...k) < 40;
      // Canvas 504,282 400x112 at 720p (x 2/3): 336,188 267x75. Centre 469,225.
      const series: { t: number; k: number[] | null }[] = [];
      for (let t = 0.2; t < DUR - 0.3; t += 0.2) series.push({ t, k: sample(outs[0], t, 469, 225) });
      const first = (pred: (k: number[] | null) => boolean, from: number) => series.find((s) => s.t >= from && pred(s.k))?.t ?? null;
      ok(series.filter((s) => s.t < tOn).every((s) => black(s.k)), `before it is taken on (${tOn.toFixed(1)} s) the box shows the picture`);
      const sOn = first(red, tOn);
      ok(sOn !== null && sOn - tOn < 1.5, `taken on at ${tOn.toFixed(1)} s: in the encoded frames from ${sOn?.toFixed(1)} s (${sOn !== null ? Math.round((sOn - tOn) * 1000) : '?'} ms, sampled every 200 ms)`);
      const sGreen = first(green, tChange);
      ok(sGreen !== null && sGreen - tChange < 1.5, `its colour changed at ${tChange.toFixed(1)} s: green from ${sGreen?.toFixed(1)} s (${sGreen !== null ? Math.round((sGreen - tChange) * 1000) : '?'} ms)`);
      ok(series.filter((s) => s.t > (sOn ?? 99) + 0.2 && s.t < tChange).every((s) => red(s.k)), 'red, steadily, between the two');
      const sOff = first(black, tOff);
      ok(sOff !== null && sOff - tOff < 1.5, `taken off at ${tOff.toFixed(1)} s: gone from ${sOff?.toFixed(1)} s (${sOff !== null ? Math.round((sOff - tOff) * 1000) : '?'} ms)`);
      const mid = (sOn ?? 4) + 1;
      ok(red(sample(outs[0], mid, 340, 192)) && black(sample(outs[0], mid, 330, 182)) && red(sample(outs[0], mid, 598, 258)) && black(sample(outs[0], mid, 608, 268)),
        'its edges in the 720p frame are where the canvas box scales to (336,188 to 603,263)');
      ok(black(sample(outs[0], mid, 900, 500)) && black(sample(outs[0], mid, 100, 100)), 'nothing drawn anywhere else');
      ok(red(sample(outs[1], mid, 234, 112)) && black(sample(outs[1], mid, 164, 90)), 'the 360p rung carries it too, in the same place at its scale');
      const nfr = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', outs[0]], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
      ok(nfr === String(DUR * 25), `no frame lost: ${nfr} of ${DUR * 25}`);
      ok(!logs.some((l) => l.ev === 'page_error' || l.ev === 'template_error' || l.ev === 'render_error'), 'no page, template or render errors in the renderer', JSON.stringify(logs.filter((l) => /error/.test(String(l.ev)))).slice(0, 300));
    }
  } finally {
    try { renderer?.kill('SIGTERM'); } catch { /* gone */ }
    srv.close();
    if (work) rmSync(work, { recursive: true, force: true });
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
