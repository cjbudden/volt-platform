/// <reference lib="dom" />
// ============================================================================
//  EVERY CODE SAMPLE IN THE DEVELOPER GUIDES, RUN AGAINST A REAL API
//  (build queue 1.14-G6).
//
//  The developer guides do not paste code: each code block names a file in
//  docs-site/samples/ and the docs build fills it in (docs-site/src/remark/
//  include-samples.mjs). This suite runs those same files, as a customer
//  would, against this API on a seeded database, and checks what they print.
//  So a sample that stops working fails here, and the page can never show
//  code that was not run.
//
//  How a sample is run: its placeholders (https://your-volt-host, pk_live_...,
//  sk_live_..., <channel id> and the rest) are replaced with real values, the
//  suite fails if any placeholder is left over, and then:
//    .sh    bash -e -o pipefail, in a scratch folder (curl and jq, as the
//           guides say), with the sample files it reads (guide.xml) beside it
//    .mjs   node
//    .html  in Chromium, on a site of its own, with the player script served
//           from the API's address the way a deployment serves it
//  Every sample file must be named by a guide and checked here: a sample
//  nobody runs, or a guide naming a sample that is not there, fails.
//
//  The browser part SKIPS (and says so) when playwright or Chromium is not
//  available; everything else always runs.
//
//    DATABASE_URL=... npx tsx test/docs-samples.check.ts
//    SHOW_OUTPUT=1 also prints what each sample printed (for writing the guides)
// ============================================================================
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, extname } from 'node:path';

process.env.QOE_RAW_DIR = mkdtempSync(join(tmpdir(), 'docs-samples-qoe-'));
delete process.env.QOE_RAW_BUCKET;

const ROOT = resolve(__dirname, '..');
const SITE_DIR = resolve(ROOT, '../docs-site');
const SAMPLES = join(SITE_DIR, 'samples');
const PLAYER = resolve(ROOT, '../volt-player');

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); }
  else { fail++; console.log(`FAIL ${m}${d !== undefined ? ' -- ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 900) : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, timeoutMs: number, every = 150): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(every); }
  return null;
}
/** Every JSON value a sample printed (one per line, or a pretty-printed one). */
function jsonOut(text: string): any[] {
  const out: any[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    buf += line + '\n';
    try { out.push(JSON.parse(buf)); buf = ''; } catch { if (!buf.trim().startsWith('{') && !buf.trim().startsWith('[') && !buf.trim().startsWith('"')) buf = ''; }
  }
  return out;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What a guide shows in place of a real value. Anything still matching after
// substitution means the sample would run with a placeholder: a failure.
const LEFTOVER = /your-volt-host|\b(pk|sk)_live_\.\.\.|whsec_\.\.\.|<[a-z][^<>="]* id>|<the [^<>]+>|hooks\.example\.com/;

(async () => {
  const { createServer } = await import('../src/server');
  const { query, one } = await import('../src/db');
  const coll = await import('../src/services/qoe/collector');
  const jn = await import('../src/services/qoe/journeys');
  const app: any = createServer();

  // ---- the player bundle, served from the API's address as a deployment does ----
  let bundle: string | null = null;
  try {
    const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
    bundle = esbuild.buildSync({ entryPoints: [join(PLAYER, 'src/index.ts')], bundle: true, format: 'iife', globalName: 'VoltPlayer',
      write: false, target: 'es2018', logLevel: 'silent', nodePaths: [join(PLAYER, 'node_modules')] }).outputFiles[0].text;
  } catch (e) { console.log(`(player bundle not built: ${String(e).slice(0, 200)})`); }
  const apiLog: { method: string; path: string; origin: string | null; body: string }[] = [];
  const api = httpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = String(req.url).split('?')[0];
    if (path === '/player/volt-player.js' && bundle) {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(bundle);
    }
    if (/^\/api\/(public\/)?(cmcd|availability|journey)/.test(path)) {
      // Keep what the player sent, for the browser checks, without consuming the body.
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => apiLog.push({ method: String(req.method), path, origin: (req.headers.origin as string) ?? null, body: Buffer.concat(chunks).toString() }));
    }
    app(req, res);
  }).listen(0);
  const base = `http://127.0.0.1:${(api.address() as any).port}`;
  const j = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };

  // ---- the browser's site: its own origin ----
  const pages: Record<string, string> = {};
  const site = httpServer((q, res) => {
    const u = String(q.url).split('?')[0];
    if (pages[u]) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(pages[u]); }
    res.statusCode = 404; res.end();
  }).listen(0);
  const siteHost = `127.0.0.1:${(site.address() as any).port}`;

  // ---- the account, as a customer has it: an admin, two apps, a secret key ----
  const ADMIN = { email: process.env.DOCS_TEST_EMAIL ?? 'admin@volt.test', password: process.env.DOCS_TEST_PASSWORD ?? 'VoltTest!2026' };
  const login = await j('POST', '/api/auth/login', ADMIN);
  const T = login.data?.access;
  if (!T) { console.log(`FAIL sign-in for the setup (${login.status} ${JSON.stringify(login.data).slice(0, 200)})`); process.exit(1); }
  const auth = { authorization: `Bearer ${T}` };
  const acct = (await one<any>(`SELECT account_id FROM users WHERE email = $1`, [ADMIN.email])).account_id;
  const CH = (await one<any>(`SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND COALESCE(c.kind,'tv') = 'tv' ORDER BY c.created_at LIMIT 1`, [acct])).id;
  const ST = (await one<any>(`SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1 AND c.kind = 'radio' ORDER BY c.created_at LIMIT 1`, [acct])).id;
  const chName = (await one<any>(`SELECT name FROM channels WHERE id = $1`, [CH])).name;
  const webApp = (await j('POST', '/api/apps', { name: 'Docs samples site', type: 'web', restrictions: { referrers: ['https://www.example.com'] } }, auth)).data;
  const PK = webApp.publishableKey.key;
  const browserApp = (await j('POST', '/api/apps', { name: 'Docs samples browser', type: 'web', restrictions: { referrers: [siteHost] } }, auth)).data;
  const PK_BROWSER = browserApp.publishableKey.key;
  const SK = (await j('POST', '/api/apps/secret-keys', undefined, auth)).data.key;
  const skAuth = { authorization: `Bearer ${SK}` };
  ok(/^pk_live_/.test(PK) && /^pk_live_/.test(PK_BROWSER) && /^sk_live_/.test(SK), 'setup: two web apps and a secret key');
  // Three published on-demand assets of this account, for the list samples.
  for (const [i, t] of ['Season opener', 'Coach interview', 'Highlights'].entries()) {
    await query(`INSERT INTO vod_assets(channel_id,kind,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms,output_kind,formats,thumb_status,published,portal_visible,updated_at)
                 VALUES ($1,'clip',$2,$3,0,60000,60000,'manifest','{"hls":true}','ready',true,true, now() - make_interval(mins => $4::int))`,
      [CH, `Docs ${t}`, `channel/${CH}/docs-${i}`, 10 - i]);
  }
  const viewer = (await j('POST', '/api/public/auth/register', { appKey: PK, email: 'docs-viewer@example.com', password: 'Docs-Viewer-2026' }, { origin: 'https://www.example.com' })).data;
  ok(!!viewer?.access, 'setup: a viewer session for the signed-in samples', viewer);
  // A programme on now, for the guide samples.
  const nowStart = new Date(Date.now() - 10 * 60_000).toISOString(), nowEnd = new Date(Date.now() + 50 * 60_000).toISOString();
  ok((await j('POST', '/api/epg', { channelId: CH, title: 'Docs on now', startsAt: nowStart, endsAt: nowEnd }, skAuth)).status === 201, 'setup: a programme on now');

  // Placeholders every sample may use. A sample can add or override its own.
  const common: Record<string, string> = {
    'https://your-volt-host': base,
    'pk_live_...': PK,
    'sk_live_...': SK,
    'admin@example.com': ADMIN.email,
    'your-password': ADMIN.password,
    '<channel, event or VOD id>': CH,
    '<channel id>': CH,
    '<asset id>': CH,
    "<the viewer's access token>": viewer.access,
  };

  // ---- running a sample ----
  const checked = new Set<string>();
  async function run(rel: string, extra: Record<string, string> = {}, opts: { files?: string[]; stdin?: string; env?: Record<string, string>; quiet?: boolean } = {}) {
    checked.add(rel);
    const src = readFileSync(join(SAMPLES, rel), 'utf8');
    let code = src;
    for (const [from, to] of Object.entries({ ...common, ...extra })) code = code.split(from).join(to);
    const left = LEFTOVER.exec(code);
    if (left) { ok(false, `${rel}: every placeholder is filled`, left[0]); return { code: -1, stdout: '', stderr: '', out: [] as any[] }; }
    const dir = mkdtempSync(join(tmpdir(), 'docs-sample-'));
    for (const f of opts.files ?? []) copyFileSync(join(SAMPLES, f), join(dir, f.split('/').pop()!));
    const file = join(dir, rel.split('/').pop()!);
    writeFileSync(file, code);
    const cmd = extname(rel) === '.mjs' ? ['node', [file]] : ['bash', ['-e', '-o', 'pipefail', file]];
    return await new Promise<{ code: number; stdout: string; stderr: string; out: any[] }>((done) => {
      const p = spawn(cmd[0] as string, cmd[1] as string[], { cwd: dir, env: { ...process.env, ...(opts.env ?? {}) } });
      let stdout = '', stderr = '';
      p.stdout.on('data', (c) => { stdout += c; });
      p.stderr.on('data', (c) => { stderr += c; });
      const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
      p.on('close', (c) => {
        clearTimeout(timer);
        if (!opts.quiet) console.log(`  ${rel}: exit ${c}${stderr.trim() ? ', stderr: ' + stderr.trim().slice(0, 300) : ''}`);
        if (process.env.SHOW_OUTPUT === '1') console.log(stdout.replace(/^/gm, '    | '));
        done({ code: c ?? -1, stdout, stderr, out: jsonOut(stdout) });
      });
    });
  }
  const ran = (rel: string, r: { code: number; stdout: string }) => ok(r.code === 0, `${rel} runs`, r.stdout.slice(0, 400));
  const gate = (key: string, asset = CH, origin = 'https://www.example.com') =>
    fetch(`${base}/api/public/availability?appKey=${encodeURIComponent(key)}&assetId=${asset}`, { headers: { origin } }).then((r) => r.status);

  // ========================================================================
  console.log('== apps and keys ==');
  let r = await run('apps-and-keys/register-app.sh');
  ran('apps-and-keys/register-app.sh', r);
  const reg = r.out[0] ?? {};
  ok(UUID.test(reg.appId ?? '') && /^pk_live_/.test(reg.publishableKey ?? '') && UUID.test(reg.keyId ?? ''), 'register-app prints the app id, its key and the key id', reg);
  ok(reg.publishableKey && await gate(reg.publishableKey) === 200, 'the new key opens the play gate from the allowed site');
  ok(reg.publishableKey && await gate(reg.publishableKey, CH, 'https://elsewhere.example.net') === 403, 'and is refused from any other site');

  r = await run('apps-and-keys/secret-key.sh');
  ran('apps-and-keys/secret-key.sh', r);
  const sk2 = r.out[0]?.secretKey;
  ok(/^sk_live_/.test(sk2 ?? '') && r.out[0]?.prefix && sk2.startsWith(r.out[0].prefix), 'secret-key prints a secret key and its prefix', r.out[0]);
  ok(sk2 && (await fetch(`${base}/api/channels?limit=1`, { headers: { authorization: `Bearer ${sk2}` } })).status === 200, 'the new secret key reads the admin API');

  r = await run('apps-and-keys/first-call.sh');
  ran('apps-and-keys/first-call.sh', r);
  ok(Array.isArray(r.out[0]) && r.out[0].some((c: any) => c.id === CH && c.name === chName), `first-call lists the account's channels (${chName})`, r.out[0]);

  // Rotation on an app of its own, so the other samples keep their key.
  const rot = (await j('POST', '/api/apps', { name: 'Docs rotation', type: 'web', restrictions: {} }, auth)).data;
  r = await run('apps-and-keys/rotate-key.sh', { '<app id>': rot.id, '<old key id>': rot.publishableKey.id });
  ran('apps-and-keys/rotate-key.sh', r);
  const newKey = r.out[0]?.newKey;
  ok(/^pk_live_/.test(newKey ?? '') && /^204$/m.test(r.stdout), 'rotate-key issues a new key and revokes the old one (204)', r.stdout);
  ok(newKey && await gate(newKey) === 200 && await gate(rot.publishableKey.key) === 401, 'afterwards the new key plays and the old one is refused (401)');

  // ========================================================================
  console.log('== authentication ==');
  r = await run('authentication/admin-sign-in.sh');
  ran('authentication/admin-sign-in.sh', r);
  ok(Array.isArray(r.out[0]) && r.out[0].includes(chName), 'admin-sign-in lists channels with the session', r.out[0]);
  ok(r.out[1]?.newSession === true && r.out[1]?.expiresIn > 0, 'and the refresh token returns a new session', r.out[1]);

  r = await run('authentication/viewer-sign-in.sh');
  ran('authentication/viewer-sign-in.sh', r);
  ok(r.out[0]?.available === true && r.out[0]?.mode === 'play' && r.out[0]?.expiresIn > 0, 'viewer-sign-in: a new viewer, and the gate says play', r.out[0]);

  r = await run('authentication/token-exchange.sh');
  ran('authentication/token-exchange.sh', r);
  ok(UUID.test(r.out[0]?.viewer ?? '') && JSON.stringify(r.out[0]?.groups) === '["members"]' && r.out[0]?.access && r.out[0]?.refresh, 'token-exchange: a viewer in the members group, with a session pair', r.out[0]);

  // ========================================================================
  console.log('== lists ==');
  r = await run('lists/filter-sort-page.sh');
  ran('lists/filter-sort-page.sh', r);
  const [p1, p2] = r.out;
  const published = Number((await one<any>(`SELECT count(*)::int AS n FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups g ON g.id = c.group_id
                                            WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.published`, [acct])).n);
  ok(Array.isArray(p1) && p1.length === 2 && new RegExp(`x-total-count: ${published}`, 'i').test(r.stdout) && /x-next-cursor: \S+/i.test(r.stdout), `filter-sort-page: page 1 has 2 of ${published}, with the total and a cursor`, r.stdout.slice(0, 600));
  ok(Array.isArray(p2) && p2.length === Math.min(2, published - 2) && !p2.some((a: any) => p1.some((b: any) => b.id === a.id)), 'the cursor gives the next page, with nothing repeated', p2);
  ok(p1 && p1[0].updated_at >= p1[1].updated_at && p2?.[0] && p1[1].updated_at >= p2[0].updated_at, 'newest change first, across the pages');

  r = await run('lists/all-pages.mjs');
  ran('lists/all-pages.mjs', r);
  const allVod = (await j('GET', '/api/vod?limit=200&count=true', undefined, skAuth));
  ok(r.out[0]?.assets === allVod.data.length, `all-pages follows the Link header to every asset (${r.out[0]?.assets})`, r.out[0]);

  r = await run('lists/invalid-query.sh');
  ran('lists/invalid-query.sh', r);
  ok(r.out[0]?.code === 'invalid_list_query' && r.out[0]?.parameter === 'colour' && r.out[0]?.canFilterOn > 10 && /Unknown filter/.test(r.out[0]?.error), 'invalid-query: the error names the parameter and what can be filtered', r.out[0]);

  r = await run('lists/follow-links.sh');
  ran('lists/follow-links.sh', r);
  ok(r.out[0]?.id === `${base}/api/channels/${r.out[0]?.id?.split('/').pop()}` && UUID.test(r.out[0]?.id?.split('/').pop() ?? '') && r.out[0]?.type === 'volt:Channel' && r.out[0]?.name
    && r.out[0]?.status === `${base}/api/status?channelId=${r.out[0]?.id?.split('/').pop()}`, 'follow-links: entry point, collection, then a channel and its status link', r.out[0]);

  // ========================================================================
  console.log('== the play gate ==');
  r = await run('play-gate/anonymous.sh');
  ran('play-gate/anonymous.sh', r);
  ok(r.out[0]?.available === true && r.out[0]?.mode === 'play' && r.out[0]?.title === chName && r.out[0]?.live === true && r.out[0]?.expiresIn > 0 && 'delivery' in (r.out[0] ?? {}),
    'anonymous: play, with the title, live and the token lifetime', r.out[0]);
  r = await run('play-gate/signed-in.sh');
  ran('play-gate/signed-in.sh', r);
  ok(r.out[0]?.available === true && r.out[0]?.token === true, 'signed-in: play, with a playback token', r.out[0]);
  r = await run('play-gate/catalogue-check.sh');
  ran('play-gate/catalogue-check.sh', r);
  ok(r.out[0]?.allowed === true && r.out[0]?.mode === 'play' && Array.isArray(r.out[0]?.reasons), 'catalogue-check: allowed, no token', r.out[0]);
  r = await run('play-gate/wrong-site.sh');
  ran('play-gate/wrong-site.sh', r);
  ok(/HTTP 403/.test(r.stdout) && /not in allow-list/.test(r.stdout), 'wrong-site: 403 and why', r.stdout);

  // ========================================================================
  console.log('== playback reporting ==');
  // The analytics database can outlive a run: count from what is there now.
  const attemptsBefore = Number((await j('GET', '/api/analytics/qoe/overview?days=1', undefined, skAuth)).data?.success?.attempts ?? 0);
  r = await run('playback-reporting/send-reports.sh');
  ran('playback-reporting/send-reports.sh', r);
  ok(/HTTP 204/.test(r.stdout), 'send-reports: the collector takes the three reports (204)', r.stdout);
  // The view closes after 60 s of quiet: move the collector's clock on until it has.
  await until(async () => { await coll.flushQoe(Date.now() + 61_000); return (await j('GET', '/api/analytics/qoe/overview?days=1', undefined, skAuth)).data?.success?.attempts > attemptsBefore; }, 15_000, 300);
  r = await run('playback-reporting/overview.sh');
  ran('playback-reporting/overview.sh', r);
  ok(r.out[0]?.attempts === attemptsBefore + 1 && r.out[0]?.startupFailureRate === 0 && 'startupP95ms' in r.out[0] && 'rebufferRatio' in r.out[0], 'overview: the reported view is counted, and started', r.out[0]);
  r = await run('playback-reporting/breakdown.sh');
  ran('playback-reporting/breakdown.sh', r);
  ok(r.out[0]?.by === 'app_version' && r.out[0]?.rows?.some((x: any) => x.value === '2.1.0' && x.views >= 1 && x.measure === 0), 'breakdown: the app version the reports named, with no failures', r.out[0]);
  r = await run('playback-reporting/session.sh');
  ran('playback-reporting/session.sh', r);
  ok(r.out[0]?.reports >= 2 && r.out[0]?.events?.[0] === 'Play pressed' && r.out[0]?.events?.some((l: string) => l.startsWith('First frame')) && Array.isArray(r.out[0]?.missingSequence)
    && r.out[0]?.spans?.some((x: any) => x.state === 'playing'), 'session: the newest view\'s timeline, from play pressed to the first frame', r.out[0]);
  // Journey to play (build queue 1.14g)
  const sessionsBefore = Number((await j('GET', '/api/analytics/qoe/journeys?days=1', undefined, skAuth)).data?.sessions ?? 0);
  r = await run('playback-reporting/send-journey.sh');
  ran('playback-reporting/send-journey.sh', r);
  ok(/HTTP 204/.test(r.stdout), 'send-journey: the collector takes the app\'s five events (204)', r.stdout);
  await jn.flushJourneys();
  r = await run('playback-reporting/journeys.sh');
  ran('playback-reporting/journeys.sh', r);
  const jst = Object.fromEntries((r.out[0]?.steps ?? []).map((x: any) => [x.step, x.sessions]));
  ok(r.out[0]?.sessions === sessionsBefore + 1 && jst.open === r.out[0]?.sessions && jst.play >= 1 && jst.detail >= 1, 'journeys: the app session is counted, up to play pressed', r.out[0]);
  ok(r.out[1]?.rows?.some((x: any) => x.entry === 'row' && x.detail === 'Trending' && x.journeys >= 1 && x.plays >= 1), 'journeys: the play is credited to the Trending row', r.out[1]);

  // ========================================================================
  console.log('== webhooks, then an upload that fires one ==');
  const recvPort = 20000 + Math.floor(Math.random() * 20000);
  r = await run('webhooks/register-webhook.sh', { 'https://hooks.example.com/volt': `http://127.0.0.1:${recvPort}/volt` });
  ran('webhooks/register-webhook.sh', r);
  const hook = r.out[0] ?? {};
  ok(UUID.test(hook.id ?? '') && /^whsec_/.test(hook.secret ?? '') && JSON.stringify(hook.events) === '["ingested","quarantined"]', 'register-webhook: the webhook and its signing secret, shown once', hook);
  ok(!JSON.stringify((await j('GET', '/api/ingest/webhooks', undefined, skAuth)).data).includes(hook.secret), 'the secret is not in the list afterwards');

  // The customer's receiver, as written, with the secret it was given.
  checked.add('webhooks/receiver.mjs');
  const recvSrc = readFileSync(join(SAMPLES, 'webhooks/receiver.mjs'), 'utf8').split('whsec_...').join(hook.secret);
  ok(!LEFTOVER.test(recvSrc), 'webhooks/receiver.mjs: every placeholder is filled');
  const recvDir = mkdtempSync(join(tmpdir(), 'docs-receiver-'));
  writeFileSync(join(recvDir, 'receiver.mjs'), recvSrc);
  const recv = spawn('node', [join(recvDir, 'receiver.mjs')], { cwd: recvDir, env: { ...process.env, PORT: String(recvPort) } });
  let recvOut = '';
  recv.stdout.on('data', (c) => { recvOut += c; });
  recv.stderr.on('data', (c) => { recvOut += c; });
  const up = await until(() => fetch(`http://127.0.0.1:${recvPort}/`, { method: 'POST', body: '{}' }).then((x) => x.status), 10_000);
  ok(up === 401, 'receiver.mjs refuses a call with no signature (401)', up);
  const forged = await fetch(`http://127.0.0.1:${recvPort}/`, { method: 'POST', body: '{"event":"ingested"}', headers: { 'x-volt-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` } }).then((x) => x.status);
  ok(forged === 401, 'and one with a wrong signature (401)', forged);

  // A file of two chunks, so the loop in the sample really loops.
  const updir = mkdtempSync(join(tmpdir(), 'docs-upload-'));
  const fileBytes = randomBytes(8 * 1024 * 1024 + 300_000);
  writeFileSync(join(updir, 'evening-news.mp4'), fileBytes);
  checked.add('uploads/upload.sh');
  {
    let code = readFileSync(join(SAMPLES, 'uploads/upload.sh'), 'utf8');
    for (const [from, to] of Object.entries(common)) code = code.split(from).join(to);
    writeFileSync(join(updir, 'upload.sh'), code);
    r = await new Promise((done) => {
      const p = spawn('bash', ['-e', '-o', 'pipefail', join(updir, 'upload.sh')], { cwd: updir, env: process.env });
      let stdout = '', stderr = '';
      p.stdout.on('data', (c) => { stdout += c; }); p.stderr.on('data', (c) => { stderr += c; });
      p.on('close', (c) => { console.log(`  uploads/upload.sh: exit ${c}${stderr.trim() ? ', stderr: ' + stderr.trim().slice(0, 300) : ''}`); done({ code: c ?? -1, stdout, stderr, out: jsonOut(stdout) }); });
    });
  }
  ran('uploads/upload.sh', r);
  const chunks = r.out.filter((o: any) => 'index' in o);
  const fin = r.out.find((o: any) => 'assetId' in o) ?? {};
  ok(chunks.length === 2 && chunks[1].complete === true && chunks[0].chunkCount === 2, 'upload: two chunks sent, the second completes it', chunks);
  ok(UUID.test(fin.assetId ?? '') && fin.bytes === fileBytes.length && fin.sha256 === createHash('sha256').update(fileBytes).digest('hex') && fin.ingest === 'ingested' && fin.title === 'evening-news.mp4',
    'finish: the asset, every byte, the right SHA-256, ingested, named after the file', fin);
  const titled = r.out.find((o: any) => 'title' in o && 'id' in o && !('assetId' in o));
  ok(titled?.id === fin.assetId && titled?.title === 'Evening news, 24 October', 'and the title is set afterwards', titled);
  const delivered = await until(() => recvOut.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.assetId === fin.assetId), 15_000);
  ok(delivered?.event === 'ingested' && delivered?.file === 'evening-news.mp4' && delivered?.sha256 === fin.sha256,
    'the webhook reached receiver.mjs, its signature checked, for this upload', delivered ?? recvOut.slice(0, 400));
  const hookRow = await one<any>(`SELECT last_status, last_error FROM ingest_webhooks WHERE id = $1`, [hook.id]);
  ok(hookRow?.last_status === 204, `Volt recorded the receiver's answer (${hookRow?.last_status})`, hookRow);
  recv.kill();

  const open = (await j('POST', '/api/uploads', { purpose: 'vod', name: 'Docs resume', filename: 'resume.mp4', totalBytes: 9_000_000 }, skAuth)).data;
  r = await run('uploads/resume.sh', { '<upload id>': open.id, "<the upload's token>": open.token });
  ran('uploads/resume.sh', r);
  ok(r.out[0]?.state === 'open' && r.out[0]?.chunkCount === 2 && JSON.stringify(r.out[0]?.missing) === '[0,1]', 'resume: the chunks still to send', r.out[0]);

  r = await run('webhooks/send-notification.sh');
  ran('webhooks/send-notification.sh', r);
  const [tpl, sent] = r.out;
  ok(tpl?.key === 'rights-closing', 'send-notification: the template is made', tpl);
  ok(sent?.subject === 'Rights close tonight: The match replay' && sent?.deliveries?.some((d: any) => d.channel === 'in_app' && d.recipient === ADMIN.email && d.status === 'sent')
    && sent?.deliveries?.some((d: any) => d.channel === 'email'), 'the message is filled from the payload; the inbox copy is sent, the email copy accounted for', sent);

  // ========================================================================
  console.log('== the guide (EPG) ==');
  r = await run('epg/push-programmes.sh');
  ran('epg/push-programmes.sh', r);
  const [a1, a2, day] = r.out;
  ok(UUID.test(a1?.id ?? '') && a1?.id === a2?.id && a2?.title === 'Morning News (extended)' && a2?.ends_at === '2027-03-01T08:30:00.000Z', 'push-programmes: the same sourceRef updates the programme', [a1, a2]);
  ok(Array.isArray(day) && day.length === 1 && day[0].title === 'Morning News (extended)', 'and the day has one programme, not two', day);

  r = await run('epg/now-next.sh');
  ran('epg/now-next.sh', r);
  ok(r.out[0]?.now === 'Docs on now', 'now-next: what is on now', r.out[0]);

  r = await run('epg/import-xmltv.sh', {}, { files: ['epg/guide.xml'] });
  ran('epg/import-xmltv.sh', r);
  const [xid, imp, maps] = r.out;
  ok(xid?.xmltvId === 'news.example.com', 'import-xmltv: the channel takes the XMLTV id', xid);
  ok(imp?.status === 'warnings' && imp?.programmes === 3 && imp?.inserted === 2 && imp?.unmapped === 1, 'the file imports with a warning: 3 in it, 2 for the mapped channel, 1 channel to map', imp);
  ok(Array.isArray(maps) && maps.some((m: any) => m.externalId === 'news.example.com' && m.state === 'used' && m.mappedBy === 'auto:xmltv_id' && m.channelName === chName)
    && maps.some((m: any) => m.externalId === 'radio.example.com' && m.state !== 'used'), 'mapped by its XMLTV id; the other waits', maps);
  const source = ((await j('GET', '/api/epg/import/sources', undefined, skAuth)).data as any[]).find?.((s: any) => s.name === 'Partner guide')
    ?? (await j('GET', '/api/epg/import/sources', undefined, skAuth)).data?.sources?.find?.((s: any) => s.name === 'Partner guide');
  r = await run('epg/map-channel.sh', { '<import source id>': source?.id ?? 'missing', '<channel id>': ST }, { files: ['epg/guide.xml'] });
  ran('epg/map-channel.sh', r);
  ok(r.out[0]?.state === 'used' && r.out[0]?.channelId === ST && r.out[1]?.status === 'ok' && r.out[1]?.inserted === 1 && r.out[1]?.unmapped === 0, 'map-channel: mapped by hand, then its programme comes in', r.out);

  r = await run('epg/export-xmltv.sh');
  ran('epg/export-xmltv.sh', r);
  ok(r.stdout.trim() === '3', `export-xmltv: the channel's three programmes in the window (${r.stdout.trim()})`, r.stdout);

  // ========================================================================
  console.log('== recipes ==');
  r = await run('recipes/whats-on.sh');
  ran('recipes/whats-on.sh', r);
  ok(r.out[0]?.channelId === CH && r.out[0]?.programmes?.some((p: any) => p.title === 'Docs on now' && p.startsAt <= Date.now() && p.endsAt > Date.now()), 'whats-on: the programme on now, with only the publishable key', r.out[0]);
  r = await run('recipes/members-from-your-site.sh');
  ran('recipes/members-from-your-site.sh', r);
  ok(r.out[0]?.available === true && r.out[0]?.mode === 'play', 'members-from-your-site: the member plays', r.out[0]);
  r = await run('recipes/sync-catalogue.sh');
  ran('recipes/sync-catalogue.sh', r);
  const since = Number((await one<any>(`SELECT count(*)::int AS n FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN groups g ON g.id = c.group_id
                                        WHERE COALESCE(g.account_id, v.account_id) = $1 AND v.updated_at >= '2026-01-01'`, [acct])).n);
  ok(r.out.length === since && r.out.every((x: any) => UUID.test(x.id)) && r.out.every((x: any, i: number) => i === 0 || r.out[i - 1].updated_at <= x.updated_at),
    `sync-catalogue: every asset changed since the date, oldest change first (${r.out.length} of ${since})`, r.out.length);

  // ========================================================================
  console.log('== the player, in a browser ==');
  let pw: any = null;
  for (const name of ['playwright-core', 'playwright']) {
    if (pw) break;
    try { pw = require(require.resolve(name, { paths: [ROOT, process.cwd(), ...(process.env.PLAYWRIGHT_CORE_DIR ? [process.env.PLAYWRIGHT_CORE_DIR] : [])] })); } catch { /* next */ }
  }
  const htmlSamples = ['player/create-player.html', 'player/custom-skin.html', 'player/drm-and-reporting.html', 'player/tag.html', 'player/scan.html', 'player/journey.html'];
  const chromium = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  if (!pw || !bundle) {
    console.log(`SKIP the browser samples: ${!pw ? 'playwright is not installed' : 'the player bundle did not build'}`);
    for (const h of htmlSamples) checked.add(h);
  } else {
    const browser = await pw.chromium.launch({ executablePath: chromium, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = async (rel: string) => {
      checked.add(rel);
      let html = readFileSync(join(SAMPLES, rel), 'utf8');
      for (const [from, to] of Object.entries({ ...common, 'pk_live_...': PK_BROWSER })) html = html.split(from).join(to);
      ok(!LEFTOVER.test(html), `${rel}: every placeholder is filled`, LEFTOVER.exec(html)?.[0]);
      const path = '/' + rel.replace(/\//g, '-');
      pages[path] = `<!doctype html><html><head><meta charset="utf-8"></head><body>\n${html}\n</body></html>`;
      const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
      // Nothing leaves the machine: the sample's example.com addresses are not real.
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route: any) => route.abort());
      const pg = await ctx.newPage();
      const errors: string[] = [], logs: string[] = [];
      pg.on('pageerror', (e: any) => errors.push(String(e?.message ?? e)));
      pg.on('console', (m: any) => logs.push(m.text()));
      const before = apiLog.length;
      await pg.goto(`http://${siteHost}${path}`);
      const asked = () => apiLog.slice(before).filter((x) => /availability/.test(x.path) && x.origin === `http://${siteHost}`);
      return { ctx, pg, errors, logs, asked, sent: () => apiLog.slice(before) };
    };
    try {
      // create-player.html
      let P = await page('player/create-player.html');
      ok(await until(() => P.asked().length >= 1, 15_000), 'create-player: the player asks the play gate, from the page\'s own site', P.sent().map((x) => x.path));
      ok(await until(() => P.pg.evaluate(() => document.querySelector('#player')!.children.length > 0), 10_000), 'the player is drawn in #player');
      await P.pg.click('#next');
      ok(await until(() => P.logs.some((l) => l === 'now playing item 1'), 10_000), 'Next moves to the second item (itemchange 1)', P.logs.slice(-8));
      ok(!P.errors.length, 'no page errors', P.errors);
      await P.ctx.close();

      // custom-skin.html
      P = await page('player/custom-skin.html');
      ok(await until(() => P.pg.evaluate(() => (document.querySelector('#p h2')?.textContent ?? '').length > 0), 15_000), 'custom-skin: the skin mounts and update() fills the title',
        await P.pg.evaluate(() => document.querySelector('#p')?.innerHTML.slice(0, 300)));
      ok(await P.pg.evaluate(() => !!document.querySelector('#p button')), 'with its own button');
      await P.pg.click('#p button');
      await sleep(300);
      ok(!P.errors.length, 'no page errors, the button included', P.errors);
      await P.ctx.close();

      // drm-and-reporting.html
      P = await page('player/drm-and-reporting.html');
      ok(await until(() => P.asked().length >= 1, 15_000), 'drm-and-reporting: the player starts with the drm and cmcd options');
      const cmcdPosts = await until(() => { const c = P.sent().filter((x) => /cmcd/.test(x.path)); return c.length ? c : null; }, 15_000);
      ok(cmcdPosts?.some((x) => x.body.includes('"Example website"') && x.body.includes('"4.2.0"')), 'its reports name the app and version', cmcdPosts?.map((x) => x.body.slice(0, 200)));
      ok(!P.errors.length, 'no page errors', P.errors);
      await P.ctx.close();

      // journey.html (build queue 1.14g)
      P = await page('player/journey.html');
      const jPosts = await until(() => { const c = P.sent().filter((x) => /\/journey/.test(x.path)); const b = c.map((x) => x.body).join('\n'); return /content_select/.test(b) ? c : null; }, 15_000);
      const jBody = (jPosts ?? []).map((x) => x.body).join('\n');
      ok(/"app_open"/.test(jBody) && /"screen"/.test(jBody) && /"entry":"row"/.test(jBody) && /"ed":"Trending"/.test(jBody), 'journey: after consent, the app session, its screen and the select from the Trending row reach the collector', jBody.slice(0, 400));
      const jCmcd = await until(() => { const c = P.sent().filter((x) => /cmcd/.test(x.path) && /com\.volt-jid/.test(x.body)); return c.length ? c : null; }, 15_000);
      ok(!!jCmcd && /com\.volt-entry="row"/.test(jCmcd[0].body), 'and the play attempt\'s reports carry the journey (play_intent itself is sent when the viewer presses play: test/journey.check.ts)', P.sent().filter((x) => /cmcd/.test(x.path)).map((x) => x.body.slice(0, 200)));
      ok(!P.errors.length, 'no page errors', P.errors);
      await P.ctx.close();

      // tag.html
      P = await page('player/tag.html');
      ok(await until(() => P.pg.evaluate(() => !!(document.querySelector('[data-volt-player]') as any)?.voltPlayer), 15_000), 'tag: the tag mounts a player with no code');
      ok(P.asked().length >= 1, 'and asks the play gate');
      ok(!P.errors.length, 'no page errors', P.errors);
      await P.ctx.close();

      // scan.html
      P = await page('player/scan.html');
      await until(() => P.pg.evaluate(() => !!(window as any).VoltPlayer), 10_000);
      await P.pg.click('#show');
      ok(await until(() => P.pg.evaluate(() => !!(document.querySelector('#tab-2 [data-volt-player]') as any)?.voltPlayer), 15_000), 'scan: a player added later mounts on scan()');
      ok(!P.errors.length, 'no page errors', P.errors);
      await P.ctx.close();
    } finally { await browser.close(); }
  }

  // ========================================================================
  console.log('== every sample is in a guide and checked here ==');
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(relative(SAMPLES, p)); } };
  walk(SAMPLES);
  const named = new Set<string>();
  const walkDocs = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walkDocs(p); else if (/\.mdx?$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/^```\S*\s+file=(\S+)/gm)) named.add(m[1]); } };
  walkDocs(join(SITE_DIR, 'docs'));
  const dataFiles = new Set(['epg/guide.xml']); // read by a sample, shown in a guide too
  const notRun = files.filter((f) => !checked.has(f) && !dataFiles.has(f));
  const notShown = files.filter((f) => !named.has(f));
  const missing = [...named].filter((f) => !files.includes(f));
  ok(!notRun.length, `every sample is run by this suite (${files.length} files)`, notRun);
  ok(!notShown.length, 'every sample is shown in a guide', notShown);
  ok(!missing.length, 'every sample a guide names exists', missing);

  api.close(); site.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
