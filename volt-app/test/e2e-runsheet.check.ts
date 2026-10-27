// ============================================================================
//  THE MAC END-TO-END RUN SHEET STAYS RUNNABLE (build queue 1.15).
//
//  scripts/e2e-mac.sh drives a running Volt through its public API, so it
//  breaks quietly whenever a route it calls moves. This suite holds it to the
//  product:
//    1. --plan lists every step, and TESTING_WORKFLOWS.md section 8 names each
//       one (the run sheet and its document cannot drift apart);
//    2. every API call in the script is a route the API has (method and path,
//       from docs/api-routes.json, which the docs suite keeps current);
//    3. with Postgres: a real API, a fresh account, and the steps that need no
//       live video encoder run for real (its own group and profile, the two
//       synthetic sources, the channel, the radio station end to end with
//       now playing), then --cleanup removes what it made.
//  The steps that need the encoder (start to FAST) are Christian's on the Mac.
//    DATABASE_URL=... npx tsx test/e2e-runsheet.check.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'e2e-mac.mjs');
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, extra = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra ? '\n' + extra.split('\n').map((l) => '     | ' + l).join('\n') : '')); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((r) => { const s = netServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

(async () => {
  // ---- 1. the plan and its document
  const plan = spawnSync(process.execPath, [SCRIPT, '--plan'], { encoding: 'utf8' });
  ok(plan.status === 0, '--plan runs and changes nothing', plan.stderr);
  const steps = [...plan.stdout.matchAll(/^ {2}([a-z]+) +/gm)].map((m) => m[1]);
  const want = ['preflight', 'setup', 'sources', 'channel', 'start', 'air', 'captions', 'rights', 'failover', 'stop', 'record', 'clip', 'vod', 'publish', 'radio', 'event', 'fast'];
  ok(JSON.stringify(steps) === JSON.stringify(want), `the plan lists the product path in order (${steps.length} steps)`, steps.join(','));
  const doc = readFileSync(join(ROOT, 'TESTING_WORKFLOWS.md'), 'utf8');
  const s8 = doc.slice(doc.indexOf('## 8.'), doc.indexOf('## 9.'));
  const undocumented = want.filter((s) => !new RegExp('\\|\\s*`' + s + '`\\s*\\|').test(s8));
  ok(s8.includes('scripts/e2e-mac.sh') && undocumented.length === 0, 'TESTING_WORKFLOWS.md section 8 runs the script and has a row per step', undocumented.join(','));

  // ---- 2. every API call names a real route
  const src = readFileSync(SCRIPT, 'utf8');
  const routes: Array<{ method: string; path: string }> = JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'api-routes.json'), 'utf8'));
  const toRe = (p: string) => new RegExp('^' + p
    .replace(/\/:[A-Za-z]+\(([^)]+)\)/g, '/($1)')
    .replace(/\/:[A-Za-z]+\?/g, '(/[^/]+)?')
    .replace(/\/:[A-Za-z]+/g, '/[^/]+') + '$');
  const known = routes.map((r) => ({ m: r.method, re: toRe(r.path) }));
  const calls = [...src.matchAll(/api\('(GET|POST|PUT|PATCH|DELETE)', [`'"]([^`'"]+)[`'"]/g)].map((m) => ({ m: m[1], p: m[2] }));
  const deletes = [...src.matchAll(/(\w[\w-]*|'[\w-]+'): `(\/api\/[^`]+)`/g)].map((m) => ({ m: 'DELETE', p: m[2] }));
  const all = [...calls, ...deletes].map((c) => ({ ...c, path: c.p.replace(/\$\{[^}]+\}/g, 'X').split('?')[0] }));
  const unknown = all.filter((c) => !known.some((k) => k.m === c.m && k.re.test(c.path)));
  ok(calls.length >= 30, `the script's API calls are found (${calls.length}, plus ${deletes.length} cleanup routes)`);
  ok(unknown.length === 0, 'every one is a route the API has', unknown.map((c) => `${c.m} ${c.p}`).join('; '));

  // ---- 3. against a real API
  if (!process.env.DATABASE_URL) { console.log('SKIP the live part: set DATABASE_URL'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) { console.log('SKIP the live part: ffmpeg is not installed'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
  const { pool, one } = await import('../src/db');
  const { hashPassword } = await import('../src/auth/password');
  const tag = Date.now().toString(36);
  const email = `e2e-${tag}@volt.test`;
  const acct = (await one<any>(`INSERT INTO accounts(name, max_channels) VALUES ($1, 20) RETURNING id`, [`E2E run sheet ${tag}`]))!.id;
  await one(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,$3,'owner','active') RETURNING id`, [acct, email, await hashPassword('e2e-run-sheet-1')]);
  // Every account has a default group already, and a default group cannot be
  // removed: without one, the run's own group would become the default.
  await one(`INSERT INTO groups(account_id, name, max_channels, is_default) VALUES ($1,'Main',2,true) RETURNING id`, [acct]);
  const port = await freePort(), srcPort = await freePort();
  const work = mkdtempSync(join(tmpdir(), 'e2e-runsheet-'));
  const api = spawn(process.execPath, [join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ORCH_LAUNCHER: 'local', ORIGIN_DIR: join(work, 'origin'), IMAGE_STORE_DIR: join(work, 'images'),
      FILLER_DIR: join(work, 'filler'), ENCODER_BIN: join(ROOT, 'volt-encoder', 'bin'), THUMBS_ENABLED: '0', CORS_ORIGIN: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiLog = ''; api.stdout!.on('data', (d) => { apiLog += d; }); api.stderr!.on('data', (d) => { apiLog += d; });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await sleep(500); up = await fetch(`http://localhost:${port}/health`).then((r) => r.ok).catch(() => false); }
    ok(up, 'the API is up', apiLog.slice(-800));
    const r = spawnSync(process.execPath, [SCRIPT, '--only', 'setup,sources,channel,radio', '--cleanup'], {
      encoding: 'utf8', timeout: 240000,
      // A packager that cannot run: the encoder steps must say so and skip, never pass.
      env: { ...process.env, VOLT_API: `http://localhost:${port}`, VOLT_EMAIL: email, VOLT_PASSWORD: 'e2e-run-sheet-1', E2E_SOURCE_PORT: String(srcPort), PACKAGER_BIN: '/nonexistent/packager' },
    });
    const out = r.stdout ?? '';
    const res = out.match(/RESULT: (\d+) passed, (\d+) failed, (\d+) skipped/);
    ok(!!res && res[1] === '5' && res[2] === '0', `preflight, setup, sources, channel and radio pass, none fails (${res ? `${res[1]} of 5 ok, ${res[3]} skipped` : 'no result line'})`, out.slice(-2500));
    ok(r.status === 0, 'the run exits 0');
    ok(/own profile [0-9a-f-]{36}/.test(out), 'it ran in a group and profile of its own');
    ok(/now playing: "[^"]+"/.test(out), 'a title from the ICY source reached now playing');
    ok(/on air: \/live\/[0-9a-f-]{36}\/master\.m3u8 answers 200/.test(out), 'the station played on its public address');
    ok(/SKIP {2}start +the encoder cannot run here/.test(out) || !/PASS {2}start/.test(out), 'start was not run without the encoder (and not counted)');
    const removed = [...out.matchAll(/removed (\S+) \S+: (\d+)/g)];
    ok(removed.length >= 4 && removed.every((m) => m[2] === '204' || m[2] === '200'), `--cleanup removed what it made (${removed.map((m) => `${m[1]} ${m[2]}`).join(', ')})`);
    const left = await one<any>(`SELECT count(*)::int AS n FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1`, [acct]);
    const groupsLeft = await one<any>(`SELECT count(*)::int AS n FROM groups WHERE account_id = $1 AND name LIKE 'E2E %'`, [acct]);
    ok(left!.n === 0 && groupsLeft!.n === 0, `nothing of the run is left in the account (${left!.n} streams, ${groupsLeft!.n} groups)`);
  } finally {
    api.kill('SIGTERM');
    await sleep(500);
    await pool.end().catch(() => null);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
