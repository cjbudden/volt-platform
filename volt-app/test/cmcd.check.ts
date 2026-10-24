// ============================================================================
//  CMCD v2 IN THE VOLT SDK AND ITS COLLECTOR (build queue 1.14d).
//
//  1. The SDK's play attempt (volt-player/src/sdk/cmcd.ts): request-mode data
//     for each kind of request and event-mode reports through a whole view,
//     each checked with the SVTA Common Media Library's own CMCD v2 validator
//     (the spec's key types, inner lists and required keys), plus what is
//     ours: sn in sequence, the startup spans adding up, a refusal or a
//     failure before the first frame still a view with its step and code.
//  2. The event-mode transport: batching, and the collector rules (429 slows
//     down, 410 stops, 5xx retried with back-off, nothing lost offline).
//  3. The collector's parser against the library's decoder on the same lines.
//  4. The collector, POST /api/cmcd, on Postgres with real HTTP: accepted
//     reports kept raw for their account, every refusal code.
//  5. The play gate puts the attempt's sid in the playback token.
//  6. Terraform: CMCD never in a delivery cache key; x-amz-cf-id exposed.
//
//  Needs DATABASE_URL and volt-player's node_modules (npm install in
//  volt-player: @svta/cml-cmcd). Usage: DATABASE_URL=... npx tsx test/cmcd.check.ts
// ============================================================================
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROOT = resolve(__dirname, '..');
const PLAYER = resolve(ROOT, '../volt-player');
process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'qoe-raw-'));

(async () => {
  const cml: any = await import(join(PLAYER, 'node_modules/@svta/cml-cmcd/dist/index.js'));
  const sdk = await import('../../volt-player/src/sdk/cmcd');
  const { parseCmcdLine, checkEventReport } = await import('../src/services/qoe/cmcdParse');
  const { PlayAttempt, CmcdSender, cmcdRequestUrl, withoutCmcd, VOLT_KEY } = sdk;

  /** A sender stand-in that keeps the lines. */
  const capture = () => { const lines: string[] = []; return { lines, s: { push: (l: string) => lines.push(l), flush: async () => {} } as any }; };
  const decode = (l: string) => cml.decodeCmcd(l);
  const reqValid = (d: Record<string, unknown>) => cml.validateCmcd(d, { reportingMode: 'request' });
  const fromUrl = (u: string) => cml.decodeCmcd(decodeURIComponent(new URL(u).searchParams.get('CMCD') ?? ''));

  // A clock the test moves.
  let clock = 1000;
  const now = () => clock;
  const probe = {
    bufferMs: () => 12_340, throughputKbps: () => 25_432, playingKbps: () => 2_800, topKbps: () => 6_000,
    topPlayableKbps: () => 4_500, droppedFrames: () => 3, latencyMs: () => 6_200, keySystem: () => null,
  };

  console.log('== request mode: every kind of request, valid CMCD v2 ==');
  {
    const c = capture();
    const a = new PlayAttempt({ cid: 'chan-1', live: true, sender: c.s, requestMode: true, autoplay: true, probe, now, sid: 'sid-0001-test' });
    a.sf = 'h';
    const m = fromUrl(a.requestUrl({ kind: 'manifest', url: 'https://cdn.example/live/master.m3u8?as=AU' }));
    ok(reqValid(m).valid, 'manifest request: the library validator accepts it as CMCD v2 request mode', reqValid(m));
    ok(m.v === 2 && m.sid === 'sid-0001-test' && m.cid === 'chan-1' && m.ot === 'm' && m.su === true && m.sf === 'h' && m.st === 'l', 'manifest: v=2, sid, cid, ot=m, su (startup), sf=h, st=l', m);
    const u = a.requestUrl({ kind: 'manifest', url: 'https://cdn.example/live/master.m3u8?as=AU' });
    ok(new URL(u).searchParams.get('as') === 'AU', 'the URL keeps its own query (a rights stand-in, a claim)', u);
    const seg = fromUrl(a.requestUrl({ kind: 'segment', url: 'https://cdn.example/live/v1/seg9.m4s', media: 'video', bitrateKbps: 2800, durationMs: 4000 }));
    ok(reqValid(seg).valid, 'video segment request: valid', reqValid(seg));
    const brOf = (v: any) => (Array.isArray(v) ? (typeof v[0] === 'object' ? v[0].value ?? v[0] : v[0]) : v);
    ok(seg.ot === 'v' && brOf(seg.br) === 2800 && seg.d === 4000 && brOf(seg.bl) === 12300 && brOf(seg.mtp) === 25400 && brOf(seg.tb) === 6000,
      'video segment: ot=v, br 2800, d 4000, bl 12300 (rounded to 100 ms), mtp 25400 (rounded to 100 kbps), tb 6000', seg);
    const aud = fromUrl(a.requestUrl({ kind: 'segment', url: 'https://cdn.example/a/seg9.m4s', media: 'audio', bitrateKbps: 128, durationMs: 4000 }));
    const txt = fromUrl(a.requestUrl({ kind: 'segment', url: 'https://cdn.example/t/seg9.vtt', media: 'text', durationMs: 4000 }));
    const ini = fromUrl(a.requestUrl({ kind: 'init', url: 'https://cdn.example/v1/init.mp4', media: 'video', bitrateKbps: 2800 }));
    ok(aud.ot === 'a' && txt.ot === 'c' && ini.ot === 'i' && reqValid(aud).valid && reqValid(txt).valid && reqValid(ini).valid, 'audio ot=a, subtitles ot=c, init ot=i, all valid', [aud.ot, txt.ot, ini.ot]);
    ok(a.requestUrl({ kind: 'licence', url: 'https://drm.example/lic' }) === 'https://drm.example/lic', 'a licence request gets no CMCD (licence servers are often strict, and someone else\'s)');
    const twice = a.requestUrl({ kind: 'manifest', url: u });
    ok((twice.match(/CMCD=/g) ?? []).length === 1, 'a URL that already carries CMCD (a retry) gets one CMCD, not two', twice);
    ok(withoutCmcd('https://x/a.m3u8?CMCD=v%3D2') === 'https://x/a.m3u8' && withoutCmcd('https://x/a?b=1&CMCD=x&c=2') === 'https://x/a?b=1&c=2', 'withoutCmcd strips only the CMCD argument');
    a.firstFrame();
    a.waiting();
    const after = fromUrl(a.requestUrl({ kind: 'segment', url: 'https://cdn.example/v1/seg10.m4s', media: 'video', bitrateKbps: 2800, durationMs: 4000 }));
    const next = fromUrl(a.requestUrl({ kind: 'segment', url: 'https://cdn.example/v1/seg11.m4s', media: 'video', bitrateKbps: 2800, durationMs: 4000 }));
    ok(after.bs === true && !after.su && !next.bs, 'after the first frame no su; a stall marks bs on the next request only', [after.bs, after.su, next.bs]);
    const off = new PlayAttempt({ cid: 'x', live: false, sender: null, requestMode: false, autoplay: true, now });
    ok(off.requestUrl({ kind: 'manifest', url: 'https://x/a.m3u8' }) === 'https://x/a.m3u8', 'request mode off: the URL is untouched');
  }

  console.log('== event mode: a whole view, every report valid ==');
  {
    const c = capture();
    clock = 1000;
    const a = new PlayAttempt({ cid: 'chan-1', live: true, sender: c.s, requestMode: true, autoplay: true, probe, now, sid: 'sid-0002-test', heartbeatMs: 60_000,
      identity: { [VOLT_KEY + 'app']: 'Demo app', [VOLT_KEY + 'appv']: '2.3.1', [VOLT_KEY + 'sdkv']: '1.0.0', [VOLT_KEY + 'dm']: 'Linux x86_64' } });
    a.sf = 'h';
    clock = 1010; a.spanStart('entitlement'); clock = 1130; a.spanEnd('entitlement');
    clock = 1140; a.spanStart('manifest'); clock = 1200; a.spanEnd('manifest');
    a.response({ kind: 'manifest', url: 'https://cdn.example/m.m3u8?CMCD=v%3D2', status: 200, ttfbMs: 40, ttlbMs: 60, edgeId: 'Abc123_cf-id==' });
    clock = 1210; a.spanStart('drm'); clock = 1290; a.spanEnd('drm');
    clock = 1300; a.spanStart('segment'); clock = 1450; a.spanEnd('segment');
    clock = 1520; a.firstFrame();
    clock = 5000; a.seekingStarted(); a.waiting(); a.playing();
    clock = 6000; a.waiting(); a.playing();
    a.bitrate(4500); a.bitrate(4500);
    a.paused(); a.playing();
    a.rate(1.5); a.muted(true); a.backgrounded(true); a.backgrounded(false);
    a.heartbeat();
    for (let i = 0; i < 120; i++) a.response({ kind: 'segment', url: `https://cdn.example/v1/s${i}.m4s`, status: 200, media: 'video', ttfbMs: 20, ttlbMs: 80 });
    a.response({ kind: 'segment', url: 'https://cdn.example/v1/slow.m4s', status: 200, media: 'video', ttfbMs: 900, ttlbMs: 2500 });
    a.response({ kind: 'segment', url: 'https://cdn.example/v1/gone.m4s', status: 404, media: 'video', failed: true });
    a.error('shaka-3016', 'decode', false);
    a.close();
    a.close();
    const body = c.lines.join('\n');
    const v = cml.validateCmcdEvents(body);
    ok(v.valid, `every one of the ${c.lines.length} reports is valid CMCD v2 event mode (library validator)`, v.issues?.slice(0, 3));
    const rows = c.lines.map(decode);
    ok(rows.every((r: any) => r.v === 2 && typeof r.ts === 'number' && typeof r.e === 'string' && r.sid === 'sid-0002-test'), 'every report carries v=2, ts, e and sid');
    ok(rows.every((r: any, i: number) => r.sn === i + 1), 'sn runs 1, 2, 3 ... with no gap (event loss is visible as a gap)', rows.map((r: any) => r.sn));
    const ps = rows.filter((r: any) => r.e === 'ps').map((r: any) => r.sta).join(' ');
    ok(ps === 's p k p r p a p q', 'play states: starting, playing, seeking (not a stall), playing, rebuffering, playing, paused, playing, quit', ps);
    const first = rows.find((r: any) => r.e === 'ps' && r.sta === 'p');
    // Custom key values are strings (CTA-5004-B), read back as numbers.
    const spans = ['tent', 'tman', 'tdrm', 'tseg', 'tdec', 'toth'].map((k) => Number(first[VOLT_KEY + k]));
    ok(first.msd === 520 && spans.join(',') === '120,60,80,150,70,40', 'first frame: msd 520 ms, spans entitlement 120, manifest 60, licence 80, first segment 150, decode 70, other 40', { msd: first.msd, spans });
    ok(spans.reduce((s: number, x: number) => s + x, 0) === first.msd, 'the startup spans add up to msd exactly');
    ok(rows[0][VOLT_KEY + 'app'] === 'Demo app' && rows[0][VOLT_KEY + 'appv'] === '2.3.1' && rows[0][VOLT_KEY + 'sdkv'] === '1.0.0' && rows[0][VOLT_KEY + 'dm'] === 'Linux x86_64'
      && rows.slice(1).every((r: any) => r[VOLT_KEY + 'app'] == null), 'app, app version, SDK version and device model on the first report only');
    const bc = rows.filter((r: any) => r.e === 'bc');
    ok(bc.length === 1 && JSON.stringify(bc[0].br).includes('4500'), 'a bitrate change is one e=bc with br; the same bitrate again is not news', bc);
    const kinds = new Set(rows.map((r: any) => r.e));
    ok(['pr', 'm', 'b', 't', 'e', 'rr'].every((k) => kinds.has(k)), 'playback rate, mute, backgrounded, heartbeat, error and response received reports', [...kinds]);
    const bg = rows.filter((r: any) => r.e === 'b');
    ok(bg.length === 2 && bg[0].bg === true && !bg[1].bg, 'backgrounded: bg on going hidden, off coming back');
    const t = rows.find((r: any) => r.e === 't');
    ok(t && JSON.stringify(t.bl).includes('12300') && JSON.stringify(t.pb).includes('2800') && t.dfa === 3 && t.ltc === 6200 && JSON.stringify(t.tpb).includes('4500'), 'heartbeat: buffer, playhead bitrate, dropped frames, live latency, top playable bitrate', t);
    const rr = rows.filter((r: any) => r.e === 'rr');
    ok(rr[0].url === 'https://cdn.example/m.m3u8' && rr[0].rc === 200 && rr[0].ttfb === 40 && rr[0].ttlb === 60 && rr[0][VOLT_KEY + 'cfid'] === 'Abc123_cf-id==' && rr[0].su === true,
      'the startup manifest response: url without its CMCD, status, ttfb, ttlb, the CDN request id (x-amz-cf-id), su', rr[0]);
    const sampled = rr.filter((r: any) => /\/s\d+\.m4s$/.test(r.url)).length;
    ok(sampled === 2, `1 in 50 ordinary segment responses is reported (120 gave ${sampled})`);
    ok(rr.some((r: any) => r.url.endsWith('slow.m4s') && r.ttlb === 2500) && rr.some((r: any) => r.url.endsWith('gone.m4s') && r.rc === 404), 'every slow (2 s and over) and every failed response is reported');
    const err = rows.find((r: any) => r.e === 'e');
    ok(JSON.stringify(err.ec) === '["shaka-3016"]' && err[VOLT_KEY + 'step'] === 'decode' && rows.filter((r: any) => r.e === 'ps' && r.sta === 'f').length === 0, 'a recoverable error: e=e with ec and its step, no fatal state');
    ok(rows.filter((r: any) => r.sta === 'q').length === 1, 'closing twice quits once');
  }

  console.log('== refused or failed before the first frame: still a view, with its step and code ==');
  {
    const c = capture();
    const a = new PlayAttempt({ cid: 'chan-9', live: null, sender: c.s, requestMode: true, autoplay: true, now, sid: 'sid-0003-test' });
    a.spanStart('entitlement'); a.spanEnd('entitlement');
    a.error('gate-403', 'entitlement', true);
    a.error('shaka-1001', 'manifest', true);
    a.close();
    const rows = c.lines.map(decode);
    ok(cml.validateCmcdEvents(c.lines.join('\n')).valid, 'valid event reports');
    ok(rows.map((r: any) => r.e + (r.sta ? ':' + r.sta : '')).join(' ') === 'ps:s e ps:f', 'starting, the error, fatal; nothing after (no second error, no quit)', rows.map((r: any) => [r.e, r.sta]));
    ok(JSON.stringify(rows[1].ec) === '["gate-403"]' && rows[1][VOLT_KEY + 'step'] === 'entitlement' && rows[1].su === true, 'the refusal: ec gate-403, step entitlement, su (before the first frame)', rows[1]);
    const c2 = capture();
    const b = new PlayAttempt({ cid: 'vod-1', live: false, sender: c2.s, requestMode: true, autoplay: true, now, sid: 'sid-0004-test' });
    b.spanStart('manifest'); b.spanEnd('manifest'); b.spanStart('drm');
    b.response({ kind: 'licence', url: 'https://drm.example/lic', status: 500, failed: true });
    b.error('shaka-6007', 'drm', true);
    const r2 = c2.lines.map(decode);
    ok(cml.validateCmcdEvents(c2.lines.join('\n')).valid, 'valid event reports');
    const lic = r2.find((r: any) => r.e === 'rr');
    ok(lic && lic.rc === 500 && lic[VOLT_KEY + 'req'] === 'licence' && lic.ot == null, 'the licence response: rc 500, named a licence request (no media object type)', lic);
    const e2 = r2.find((r: any) => r.e === 'e');
    ok(JSON.stringify(e2.ec) === '["shaka-6007"]' && e2[VOLT_KEY + 'step'] === 'drm' && r2[r2.length - 1].sta === 'f', 'a failed licence: ec shaka-6007, step drm, then fatal', r2.map((r: any) => [r.e, r.sta, r.ec]));
    const c3 = capture();
    clock = 0;
    const p = new PlayAttempt({ cid: 'vod-2', live: false, sender: c3.s, requestMode: true, autoplay: false, now, sid: 'sid-0005-test' });
    p.spanStart('entitlement'); clock = 100; p.spanEnd('entitlement');
    clock = 60_000; p.playRequested(); clock = 60_300; p.firstFrame();
    const r3 = c3.lines.map(decode);
    ok(r3.map((r: any) => r.sta).join(' ') === 'd s p' && r3[2].msd === 300, 'not autoplay: preloading, then starting when play is pressed; startup timed from the press (300 ms, not 60 s)', r3.map((r: any) => [r.sta, r.msd]));
    const c4 = capture();
    const w = new PlayAttempt({ cid: 'vod-3', live: false, sender: c4.s, requestMode: true, autoplay: true, now });
    w.waitForViewer();
    ok(c4.lines.map(decode).map((r: any) => r.sta).join(' ') === 's d', 'autoplay refused by the browser: back to preloading until the viewer presses play');
    ok(/^[0-9a-f-]{36}$/.test(w.sid), 'a new attempt gets a UUID sid', w.sid);
  }

  console.log('== the transport: batches, 429, 410, 5xx, offline ==');
  {
    const calls: { body: string; keepalive: boolean; type: string }[] = [];
    let answer = 204; let retryAfter: string | null = null;
    const fetchImpl: any = async (_u: string, init: any) => {
      calls.push({ body: init.body, keepalive: !!init.keepalive, type: init.headers['content-type'] });
      return { status: answer, headers: { get: (n: string) => (n === 'retry-after' ? retryAfter : null) } };
    };
    const s = new CmcdSender({ url: 'https://api.example/api/cmcd?appKey=pk', fetchImpl, flushMs: 50 });
    for (let i = 0; i < 25; i++) s.push(`e=t,sid="a",sn=${i},ts=1,v=2`);
    await sleep(120);
    ok(calls.length === 3 && calls[0].body.split('\n').length === 10 && calls[2].body.split('\n').length === 5 && calls[0].type === 'application/cmcd',
      '25 reports go as 10, 10 and 5 (the last after flushMs), one per line, application/cmcd', calls.map((c) => c.body.split('\n').length));
    ok(s.sent === 25 && s.pending === 0, 'all 25 delivered');
    calls.length = 0; answer = 429; retryAfter = '1';
    for (let i = 0; i < 10; i++) s.push('e=t,sid="a",sn=1,ts=1,v=2');
    await sleep(50);
    ok(calls.length === 1 && s.pending === 10 && s.batchSize === 20, '429: nothing lost, batches doubled to 20', [calls.length, s.pending, s.batchSize]);
    for (let i = 0; i < 5; i++) s.push('e=t,sid="a",sn=1,ts=1,v=2');
    await sleep(300);
    ok(calls.length === 1, '429 with Retry-After 1: nothing sent before the second is up', calls.length);
    answer = 204;
    await sleep(900);
    ok(calls.length === 2 && calls[1].body.split('\n').length === 15 && s.pending === 0, 'after Retry-After: the 15 waiting go in one bigger batch', calls.map((c) => c.body.split('\n').length));
    calls.length = 0; answer = 503;
    s.push('e=e,sid="a",sn=1,ts=1,v=2', true);
    await sleep(50);
    ok(calls.length === 1 && s.pending === 1, '5xx: kept for a retry', [calls.length, s.pending]);
    answer = 204;
    await sleep(2300);
    ok(calls.length === 2 && s.pending === 0, 'retried after the back-off (2 s) and delivered', calls.length);
    calls.length = 0; answer = 410;
    s.push('e=e,sid="a",sn=1,ts=1,v=2', true);
    await sleep(50);
    s.push('e=e,sid="a",sn=2,ts=1,v=2', true);
    await sleep(50);
    ok(calls.length === 1 && s.stopped && s.pending === 0, '410: reporting stops for the session, nothing more is sent', [calls.length, s.stopped]);
    s.destroy();
    const s2 = new CmcdSender({ url: 'x', fetchImpl, flushMs: 10_000 });
    calls.length = 0; answer = 204;
    for (let i = 0; i < 3; i++) s2.push('e=t,sid="b",sn=1,ts=1,v=2');
    await s2.flush(true);
    ok(calls.length === 1 && calls[0].keepalive && calls[0].body.split('\n').length === 3, 'page going away: everything queued goes at once with keepalive', calls[0]);
    const s3 = new CmcdSender({ url: 'x', fetchImpl: async () => { throw new TypeError('offline'); }, flushMs: 10, maxQueue: 5 });
    for (let i = 0; i < 8; i++) s3.push('e=t,sid="c",sn=1,ts=1,v=2');
    await sleep(60);
    ok(s3.pending === 5 && s3.dropped === 3, 'unreachable: the newest reports are kept (up to maxQueue), the oldest dropped and counted', [s3.pending, s3.dropped]);
    s3.destroy(); s2.destroy();
  }

  console.log('== the collector reads what the library writes ==');
  {
    const c = capture();
    const a = new PlayAttempt({ cid: 'chan "quoted" \\ name', live: true, sender: c.s, requestMode: true, autoplay: true, probe, now, sid: 'sid-0006-test', identity: { [VOLT_KEY + 'hwdec']: true, [VOLT_KEY + 'app']: 'A, B = C' } });
    a.sf = 'd';
    a.firstFrame(); a.waiting(); a.playing(); a.heartbeat(); a.error('gate-451', 'entitlement', true);
    let same = 0;
    for (const l of c.lines) {
      const ours = parseCmcdLine(l);
      const theirs = cml.decodeCmcd(l);
      const norm = (o: any) => JSON.stringify(Object.keys(o).sort().map((k) => [k, Array.isArray(o[k]) ? o[k].map((x: any) => (x && typeof x === 'object' && 'value' in x ? x.value : x)) : o[k]]));
      if (norm(ours) === norm(theirs)) same++; else console.log('  differs:', l, norm(ours), norm(theirs));
    }
    ok(same === c.lines.length, `our parser and the library decode all ${c.lines.length} lines the same (quotes, backslashes, commas in strings, inner lists, booleans, tokens)`);
    ok(checkEventReport(c.lines[0]).ok, 'a real report passes the collector check');
    const bad = ['e=ps,sid="x",ts=1,v=2', `e=t,sid="x",ts=${Date.now()},v=1`, `sid="x",ts=${Date.now()},v=2`, `e=t,ts=${Date.now()},v=2`, `e=t,sid="x",ts=1,v=2`, `e=t,sid="x,ts=${Date.now()},v=2`, `e=t,sid="x",ts=${Date.now()},v=2,sn=-1`];
    const why = bad.map((l) => checkEventReport(l));
    ok(why.every((w) => !w.ok), 'refused: ps without sta, v=1, no e, no sid, ts a day out, an unterminated string, a negative sn', why.map((w) => w.why));
  }

  // ---- the collector over HTTP ----
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { generateKey } = await import('../src/services/apiKeys');
  const { readSession } = await import('../src/services/qoe/rawStore');
  const { resetCmcdLimits } = await import('../src/modules/cmcd');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cmcd-${tag}`]))!.id;
  const acct2 = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`cmcd2-${tag}`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,'Sport 1','live') RETURNING id`, [grp]))!.id;
  const mk = async (account: string, kind: 'publishable' | 'secret') => {
    const app = await one<any>(`INSERT INTO apps(account_id, name, type, restrictions) VALUES ($1,'Web','web','{}') RETURNING id`, [account]);
    const k = generateKey(kind);
    await query(`INSERT INTO api_keys(account_id, app_id, kind, key_prefix, key_hash, scopes) VALUES ($1,$2,$3,$4,$5,'{playback}')`, [account, app!.id, kind, k.prefix, k.hash]);
    return { raw: k.raw, app: app!.id };
  };
  const pk = await mk(acct, 'publishable');
  const pk2 = await mk(acct2, 'publishable');
  const sk = await mk(acct, 'secret');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = (body: string, key = pk.raw, type = 'application/cmcd', extra: Record<string, string> = {}) =>
    fetch(`${base}/api/cmcd?appKey=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': type, ...extra }, body });
  const lineFor = (sid: string, sn: number, e = 't', more = '') => `e=${e},${more}sid="${sid}",sn=${sn},ts=${Date.now()},v=2`;
  try {
    console.log('== POST /api/cmcd ==');
    const sid = `sid-${tag}-http`;
    let r = await post([lineFor(sid, 1, 'ps', 'sta=s,'), lineFor(sid, 2, 'ps', 'msd=640,sta=p,'), lineFor(sid, 3)].join('\n'));
    ok(r.status === 204, 'three valid reports: 204', r.status);
    let kept = await readSession(acct, sid);
    ok(kept.length === 3 && kept.every((k) => k.app === pk.app && k.sid === sid) && kept.map((k) => k.e).join(',') === 'ps,ps,t', 'kept raw first, for the key\'s account and app, in order, the line as sent', kept);
    ok(kept[1].line.includes('msd=640') && !JSON.stringify(kept).includes('127.0.0.1'), 'the line is kept exactly; no IP address is kept');
    ok((await readSession(acct2, sid)).length === 0, 'another account\'s store has none of it');
    r = await post(lineFor(sid, 4), pk.raw, 'text/cmcd');
    ok(r.status === 204 && (await readSession(acct, sid)).length === 4, 'text/cmcd (CTA-5004-A\'s type) accepted too');
    r = await fetch(`${base}/api/public/cmcd?appKey=${encodeURIComponent(pk.raw)}`, { method: 'POST', headers: { 'content-type': 'application/cmcd' }, body: lineFor(sid, 5) });
    ok(r.status === 204, 'also at /api/public/cmcd');
    r = await post(lineFor(sid, 6), pk.raw, 'text/plain');
    ok(r.status === 415, 'another content type: 415', r.status);
    r = await post(lineFor(sid, 6), 'pk_live_nothing');
    ok(r.status === 410, 'an unknown key: 410 (stop reporting), not something to retry', r.status);
    r = await post(lineFor(sid, 6), sk.raw);
    ok(r.status === 410, 'a secret key (never in a player): 410', r.status);
    r = await post('this is not cmcd\ne=ps,sid="x",v=2');
    ok(r.status === 400, 'nothing valid: 400', r.status);
    r = await post([lineFor(sid, 6), 'garbage', `e=t,sid="${sid}",ts=1,v=2`].join('\n'));
    ok(r.status === 204 && r.headers.get('x-cmcd-rejected') === '2' && (await readSession(acct, sid)).length === 6, 'mixed: the valid one kept, 2 rejected and counted', [r.status, r.headers.get('x-cmcd-rejected')]);
    r = await post(Array.from({ length: 201 }, (_, i) => lineFor(sid, i)).join('\n'));
    ok(r.status === 413, 'more than 200 reports in one POST: 413', r.status);
    resetCmcdLimits();
    const fast = `sid-${tag}-fast`;
    let st: number[] = [];
    for (let b = 0; b < 4; b++) st.push((await post(Array.from({ length: 200 }, (_, i) => lineFor(fast, b * 200 + i)).join('\n'))).status);
    r = await post(lineFor(fast, 900));
    ok(st.join(',') === '204,204,204,429' && r.status === 429 && r.headers.get('retry-after') === '30', 'over 600 reports a minute from one session: 429 with Retry-After', [...st, r.status]);
    ok((await post(lineFor(`sid-${tag}-other`, 1))).status === 204, 'another session is not slowed by it');
    const pre = await fetch(`${base}/api/cmcd?appKey=x`, { method: 'OPTIONS', headers: { origin: 'https://some-site.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    ok(pre.status < 300 && /\*|some-site/.test(pre.headers.get('access-control-allow-origin') ?? '') && /content-type/i.test(pre.headers.get('access-control-allow-headers') ?? ''),
      'CORS preflight from a player on another site is allowed (application/cmcd needs one)', [pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers')]);

    console.log('== the play gate carries the attempt\'s sid ==');
    const jwt = require('jsonwebtoken');
    const gsid = '3f2a6c1e-0b7d-4f6e-9a51-2c8e1d0b9f44';
    r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: pk.raw, assetId: ch, sid: gsid }) });
    const j: any = await r.json();
    ok(r.status === 200 && jwt.decode(j.playbackToken)?.sid === gsid, 'POST /api/availability with sid: the playback token carries it', [r.status, jwt.decode(j.playbackToken ?? '')]);
    r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: pk.raw, assetId: ch }) });
    const j2: any = await r.json();
    ok(r.status === 200 && jwt.decode(j2.playbackToken)?.sid === undefined, 'without one: no sid claim, as before');
    r = await fetch(`${base}/api/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: pk.raw, assetId: ch, sid: 'no spaces <allowed>' }) });
    ok(r.status === 422, 'a sid that is not an id: refused (422, like any invalid field)', r.status);
  } catch (e) {
    fail++; console.log('FAIL unexpected: ' + ((e as Error).stack ?? e));
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }

  console.log('== terraform: CMCD never splits the cache; the CDN request id is exposed ==');
  {
    const tf = readFileSync(join(ROOT, '../deploy/terraform/s3_cloudfront.tf'), 'utf8');
    const policy = (name: string) => (new RegExp(`resource "aws_cloudfront_cache_policy" "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(tf) ?? [])[1] ?? '';
    ok(/query_string_behavior = "none"/.test(policy('segment')) && /query_string_behavior = "none"/.test(policy('manifest')),
      'segment and manifest cache policies: query strings none (CMCD is neither in the key nor sent to S3, so viewers share one object)');
    const all = ['s3_cloudfront.tf', 'edge_rights.tf', 'images.tf', 'scaling_edge.tf'].map((f) => readFileSync(join(ROOT, '../deploy/terraform', f), 'utf8')).join('\n');
    ok(!/query_strings\s*\{\s*items\s*=\s*\[[^\]]*"CMCD"/.test(all), 'no whitelist anywhere names CMCD');
    const rhp = (/resource "aws_cloudfront_response_headers_policy" "delivery" \{([\s\S]*?)\n\}/.exec(tf) ?? [])[1] ?? '';
    ok(/access_control_expose_headers \{ items = \[[^\]]*"x-amz-cf-id"/.test(rhp) && /Timing-Allow-Origin/.test(rhp) && /origin_override\s*= true/.test(rhp),
      'the delivery response headers policy exposes x-amz-cf-id (and Timing-Allow-Origin), overriding S3\'s CORS');
    const dist = (/resource "aws_cloudfront_distribution" "cdn" \{([\s\S]*?)\n\}/.exec(tf) ?? [])[1] ?? '';
    const behaviours = (dist.match(/(ordered_cache_behavior"? |default_cache_behavior )\{/g) ?? []).length;
    const attached = (dist.match(/response_headers_policy_id = aws_cloudfront_response_headers_policy\.delivery\.id/g) ?? []).length;
    ok(behaviours === 4 && attached === 4, `every delivery behaviour (${behaviours}) has it (${attached})`);
    const alb = readFileSync(join(ROOT, '../deploy/terraform/scaling_alb.tf'), 'utf8');
    ok(/"\/api\/cmcd", "\/api\/cmcd\/\*"/.test(alb), 'the load balancer sends /api/cmcd to the public API tier');
    const { scaleConfig } = await import('../src/scale/config');
    ok(scaleConfig.publicPrefixes.includes('/api/cmcd'), 'and the public API tier serves it');
  }

  try { rmSync(process.env.QOE_RAW_DIR!, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
