#!/usr/bin/env node
/* ============================================================================
 *  RUN THE CHECKS.
 *
 *  Every suite in test/, each against ITS OWN database, one at a time, with a
 *  single summary at the end.
 *
 *  WHY A DATABASE PER SUITE. Each suite seeds fixtures with hardcoded uuids and
 *  most of them never clean up, because each was written to be run by hand
 *  against a throwaway Postgres. Run them together against one database and
 *  they trample each other: three suites had drifted onto the same account id
 *  (…0000a1), several shell suites re-apply 0001_init.sql mid-run and reseed
 *  the world underneath whatever is already there, and the resulting
 *  foreign-key and primary-key errors read exactly like product faults. They
 *  are not. They are the suite failing to be a suite.
 *
 *  Isolating them is a better fix than renumbering forty sets of fixtures,
 *  because it removes the whole class of problem rather than the instances of
 *  it that happen to have collided so far. A suite cannot leak into another
 *  suite's database, so a suite can be as careless with cleanup as it likes.
 *
 *  HOW. One template database is built once with the real migration runner —
 *  the same one the service uses on boot — and each suite gets a copy made
 *  with CREATE DATABASE ... TEMPLATE, which Postgres does by file copy. The
 *  copy is dropped afterwards unless the run is asked to keep it.
 *
 *  Exit code is the number of failing suites, so CI needs no wrapper.
 *
 *    node scripts/check.js               every suite
 *    node scripts/check.js clip vod      only suites whose name matches
 *    KEEP_DB=1 node scripts/check.js x   leave the database behind to inspect
 *    SHARED_DB=1 node scripts/check.js   old behaviour: one shared database
 * ========================================================================= */
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { Client } = require('pg');
const net = require('node:net');

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'test');
const filters = process.argv.slice(2);
const KEEP = process.env.KEEP_DB === '1';
const SHARED = process.env.SHARED_DB === '1';
const TEMPLATE = 'volt_check_template';

const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) { console.error('set DATABASE_URL'); process.exit(1); }

// ONE TEST SIGNING SECRET for the suites and the control planes they talk to.
// Several suites sign their tokens with `devsecret` unless JWT_ACCESS_SECRET is
// set, while the control plane falls back to its own development value, so a
// plain run with nothing set failed six suites with 401s that were not product
// faults. Every suite and every control plane started here inherits this
// environment, so setting it once makes both sides agree. A value already set
// by whoever runs the checks is kept.
if (!process.env.JWT_ACCESS_SECRET) process.env.JWT_ACCESS_SECRET = 'devsecret';
if (!process.env.JWT_REFRESH_SECRET) process.env.JWT_REFRESH_SECRET = 'devrefresh';

/** Swap the database name in a connection string, keeping everything else. */
function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
function adminUrl() { return withDb(BASE_URL, 'postgres'); }

async function admin(sql) {
  const c = new Client({ connectionString: adminUrl() });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

/** A database name Postgres will accept, derived from the suite file name. */
function dbNameFor(file, i) {
  const slug = file.replace(/\.check\.(ts|sh)$/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return `volt_chk_${String(i).padStart(2, '0')}_${slug}`.slice(0, 60);
}

async function buildTemplate() {
  // Rebuilt every run. A stale template is worse than a slow one: it would
  // silently test yesterday's schema and pass.
  await admin(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  await admin(`CREATE DATABASE ${TEMPLATE}`);
  const r = spawnSync(
    join(ROOT, 'node_modules/.bin/tsx'),
    ['-e', `
      import { migrate } from './src/services/migrate';
      import { pool } from './src/db';
      migrate().then(async (m) => {
        console.log('[template] ' + m.applied.length + ' migrations');
        await pool.end();
      }).catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
    `],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: withDb(BASE_URL, TEMPLATE) } }
  );
  if (r.status !== 0) {
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    throw new Error('could not build the template database');
  }
  console.log((r.stdout || '').trim());

  // Seed the template too. Several suites assume a channel exists rather than
  // creating one — "FATAL: no channel to test against" — because they were
  // only ever run against a developer's database, which always had one. That
  // dependency is real whether or not it is admitted, so it is met here
  // explicitly instead of being satisfied by accident.
  const s = spawnSync(
    join(ROOT, 'node_modules/.bin/tsx'),
    [join(ROOT, 'scripts/seed-demo.ts')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: withDb(BASE_URL, TEMPLATE) } }
  );
  if (s.status !== 0) {
    console.error(`${s.stdout ?? ''}${s.stderr ?? ''}`);
    throw new Error('could not seed the template database');
  }
  console.log('[template] demo seed applied');

  // And the fixture six suites assume exists but none of them creates.
  const c = spawnSync(
    join(ROOT, 'node_modules/.bin/tsx'),
    [join(ROOT, 'scripts/seed-check.ts')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: withDb(BASE_URL, TEMPLATE) } }
  );
  if (c.status !== 0) {
    console.error(`${c.stdout ?? ''}${c.stderr ?? ''}`);
    throw new Error('could not apply the check fixture');
  }
  console.log((c.stdout || '').trim());
}

/**
 * Suites that need a control plane started FOR them.
 *
 * Three kinds exist in test/ and only the third needs help: suites that touch
 * the database alone; shell suites that spawn their own `src/index.ts` on
 * their own port; and suites that just assume something is already listening
 * on :8080. That last kind passed only on a developer's machine with a service
 * running — against a different database from the one under test, which is
 * worse than failing.
 */
function needsApi(file) {
  const src = readFileSync(join(DIR, file), 'utf8');
  if (/src\/index\.ts/.test(src)) return false;   // it starts its own
  return /process\.env\.API|\bAPI=|localhost:8080/.test(src);
}

/**
 * A port nothing is listening on, starting at `from`.
 *
 * The runner used to start a suite's control plane on 8300 + its position, but
 * several shell suites start their own on fixed ports in the same range
 * (edit-audit on 8478, radio on 8490, ...) and leave it running with their own
 * signing secret. The new control plane then could not bind, the health check
 * was answered by the old one, and the suite failed with 401s against a
 * database that was not its own (station-clear and timeline-grid in a full
 * run, build queue 1.14-G7a). Probing first means /health is ours.
 */
function freePort(from) {
  const tryPort = (p) => new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen({ port: p }, () => srv.close(() => res(true)));
  });
  return (async () => {
    for (let p = from; p < from + 500; p++) if (await tryPort(p)) return p;
    throw new Error(`no free port from ${from}`);
  })();
}

/** Start a control plane against `url` on `port`, and wait for it to answer. */
async function startApi(url, port) {
  const proc = spawn(
    join(ROOT, 'node_modules/.bin/tsx'),
    [join(ROOT, 'src/index.ts')],
    {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, DATABASE_URL: url, PORT: String(port), ORCH_LAUNCHER: 'mock' },
    }
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return proc;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* ignore */ }
  throw new Error(`the control plane never came up on :${port}`);
}

(async () => {
  const files = readdirSync(DIR)
    .filter((f) => /\.check\.(ts|sh)$/.test(f))
    .filter((f) => !filters.length || filters.some((q) => f.includes(q)))
    .sort();

  if (!files.length) {
    console.error(filters.length ? `no suites match ${filters.join(', ')}` : 'no suites found');
    process.exit(1);
  }

  if (!SHARED) await buildTemplate();

  const PASS_RE = /(\d+)\s+passed,\s+(\d+)\s+failed/;
  const results = [];
  let assertions = 0, failedAssertions = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const db = dbNameFor(f, i);
    let url = BASE_URL;

    if (!SHARED) {
      await admin(`DROP DATABASE IF EXISTS ${db}`);
      await admin(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE}`);
      url = withDb(BASE_URL, db);
    }

    const started = Date.now();
    const isSh = f.endsWith('.sh');

    // A suite that hits the API needs one pointed at ITS database, not at
    // whatever happens to be running on :8080 — which is a developer's own
    // service, against a different database, and would make the suite pass or
    // fail on the state of somebody's afternoon.
    let api = null;
    let apiErr = '';
    let port = 8300 + i;
    if (!SHARED && needsApi(f)) {
      // eslint-disable-next-line no-empty
      try { port = await freePort(port); api = await startApi(url, port); }
      catch (e) { apiErr = String(e.message); }
    }

    const r = apiErr ? { status: 1, stdout: '', stderr: apiErr } : spawnSync(
      isSh ? 'bash' : join(ROOT, 'node_modules/.bin/tsx'),
      [join(DIR, f)],
      {
        cwd: ROOT, encoding: 'utf8', timeout: 300_000,
        env: {
          ...process.env,
          DATABASE_URL: url,
          ...(api ? { API: `http://localhost:${port}` } : {}),
        },
      }
    );
    if (api) { try { process.kill(-api.pid, 'SIGKILL'); } catch { /* ignore */ } }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const m = out.match(PASS_RE);
    if (m) { assertions += Number(m[1]); failedAssertions += Number(m[2]); }

    // A suite that prints no tally is judged on its exit code alone; several
    // shell suites just exit non-zero. A crash (null status, from a timeout or
    // a signal) is a failure however the output reads.
    const okRun = r.status === 0 && !r.error;
    const ok = m ? Number(m[2]) === 0 && okRun : okRun;
    const ms = Date.now() - started;
    results.push({ f, ok, out, db });

    const tally = m ? `${m[1]} passed, ${m[2]} failed` : okRun ? 'ok' : 'FAILED';
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${f.padEnd(38)} ${tally}  (${ms}ms)`);

    if (!SHARED && !(KEEP && !ok)) {
      // Terminate anything the suite left connected, or the drop blocks.
      await admin(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`
      ).catch(() => {});
      await admin(`DROP DATABASE IF EXISTS ${db}`).catch(() => {});
    } else if (KEEP && !ok) {
      console.log(`      kept database ${db} for inspection`);
    }
  }

  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.log('\n' + '='.repeat(72));
    for (const b of bad) {
      console.log(`\n--- ${b.f} ---`);
      // The tail carries the failures and the summary; the head is setup noise.
      console.log(b.out.split('\n').slice(-40).join('\n'));
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log(
    `${results.length - bad.length}/${results.length} suites passed` +
    (assertions ? `, ${assertions} assertions (${failedAssertions} failed)` : '')
  );
  process.exit(bad.length);
})().catch((e) => { console.error(e); process.exit(1); });
