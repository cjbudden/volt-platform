// ============================================================================
//  THE STALE CONSOLE.
//
//  This suite exists because of a failure with no symptom.
//
//  `config.webDistDir` was `${process.cwd()}/web`. That is right inside the
//  Docker image, where the Dockerfile copies the built console to exactly that
//  path and it is the only copy there is. In a source checkout it is a trap:
//  somebody copies volt-web/dist to volt-app/web once to make a local run
//  work, and from that moment the control plane serves a FROZEN SNAPSHOT.
//
//  Every later `npm run build` in volt-web updates volt-web/dist and changes
//  nothing about what is served. And there is no error. The console loads.
//  Every page routes. Every API call succeeds. It is simply an old version of
//  the application, and the only evidence is that the work you just did is not
//  there — which reads as "the build is broken" or "the change did not land",
//  and sends you looking in entirely the wrong place. It happened more than
//  once before anyone worked out what it was.
//
//  Two defences, and this suite tests both as pure functions so neither needs
//  a server to verify:
//
//    resolveWebDist       prefers the live build in a source checkout, so the
//                         trap cannot be set by accident any more.
//    staleConsoleWarning  detects a copy that the real build has moved past
//                         and says so at boot, for anyone who recreates one
//                         deliberately.
//
//  Usage: DATABASE_URL=... npx tsx test/console-freshness.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(m) : bad(m, `expected [${String(want)}] got [${String(got)}]`);
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));
const falsy = (m: string, v: unknown) => (!v ? ok(m) : bad(m, `expected falsy, got [${String(v)}]`));

/**
 * A fake checkout: <root>/volt-app and <root>/volt-web/dist, with the control
 * plane's cwd inside volt-app. The real layout, because the resolver walks up
 * one directory and a flatter fixture would not exercise that.
 */
function makeTree(opts: { withCopy: boolean; copyOlder?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'console-fresh-'));
  const app = join(root, 'volt-app');
  const dist = join(root, 'volt-web', 'dist');
  mkdirSync(app, { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/index-NEW.js"></script>');
  if (opts.withCopy) {
    const copy = join(app, 'web');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'index.html'), '<script src="/assets/index-OLD.js"></script>');
    if (opts.copyOlder) {
      // An hour behind. Set explicitly rather than relying on write order:
      // two writes in the same millisecond is exactly the flake that would
      // make this suite pass for the wrong reason.
      const hourAgo = Date.now() / 1000 - 3600;
      utimesSync(join(copy, 'index.html'), hourAgo, hourAgo);
    } else {
      const ahead = Date.now() / 1000 + 3600;
      utimesSync(join(copy, 'index.html'), ahead, ahead);
    }
  }
  return { root, app, dist };
}

/**
 * Load config.ts fresh with a given cwd and environment.
 *
 * The module resolves the path at IMPORT time, which is the behaviour under
 * test, so the cache has to be cleared between cases or every case after the
 * first would assert against the first one's answer.
 */
function loadConfig(cwd: string, env: Record<string, string | undefined>) {
  const prevCwd = process.cwd();
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; }
  try {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/src/config.')) delete require.cache[k];
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../src/config') as typeof import('../src/config');
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const BASE_ENV = {
  DATABASE_URL: 'postgres://volt:volt@localhost:5432/volt',
  JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y', INGEST_TOKEN: 'z',
};

const trees: string[] = [];
try {
  // ========================================================================
  console.log('\n== a source checkout serves the LIVE build, not a copy ==');
  //
  // The fix. With no copy present there is nothing to go stale, and the
  // control plane reads volt-web/dist directly, so a rebuild is served the
  // moment it finishes.
  // ========================================================================
  {
    const t = makeTree({ withCopy: false }); trees.push(t.root);
    const { config } = loadConfig(t.app, { ...BASE_ENV, WEB_DIST_DIR: undefined });
    check('the built console is found next door', config.webDistDir, t.dist);
  }

  // ========================================================================
  console.log('\n== the image layout still wins where it is the only copy ==');
  //
  // Inside the Docker image there is no ../volt-web/dist at all; ./web is the
  // console. That path must not regress, or the shipped image serves nothing.
  // ========================================================================
  {
    const root = mkdtempSync(join(tmpdir(), 'console-image-')); trees.push(root);
    const app = join(root, 'app');
    mkdirSync(join(app, 'web'), { recursive: true });
    writeFileSync(join(app, 'web', 'index.html'), '<html></html>');
    const { config } = loadConfig(app, { ...BASE_ENV, WEB_DIST_DIR: undefined });
    check('./web is served when it is the only console present',
          config.webDistDir, join(app, 'web'));
  }

  // ========================================================================
  console.log('\n== an explicit setting is never second-guessed ==');
  // ========================================================================
  {
    const t = makeTree({ withCopy: true, copyOlder: true }); trees.push(t.root);
    const { config } = loadConfig(t.app, { ...BASE_ENV, WEB_DIST_DIR: '/somewhere/else' });
    check('WEB_DIST_DIR wins over both candidates', config.webDistDir, '/somewhere/else');
  }

  // ========================================================================
  console.log('\n== a stale copy is detected and reported ==');
  //
  // For anyone who recreates the copy deliberately. Silence here is the whole
  // original bug, so the assertion is on the CONTENT of the message: it has to
  // name both paths and the command, because a warning that just says
  // "possible staleness" sends the reader back to guessing.
  // ========================================================================
  {
    const t = makeTree({ withCopy: true, copyOlder: true }); trees.push(t.root);
    const { config, staleConsoleWarning } = loadConfig(t.app, { ...BASE_ENV, WEB_DIST_DIR: undefined });
    check('the copy is what gets served, since it exists', config.webDistDir, join(t.app, 'web'));
    const prevCwd = process.cwd();
    process.chdir(t.app);
    const msg = staleConsoleWarning(join(t.app, 'web'));
    process.chdir(prevCwd);
    truthy('a warning is produced', msg);
    truthy('naming the directory being served', msg?.includes(join(t.app, 'web')));
    truthy('and the build it is behind', msg?.includes(t.dist));
    truthy('and saying the pages will still load, which is the confusing part',
           /every page/i.test(msg ?? ''));
    truthy('and giving the command that fixes it', msg?.includes('rm -rf'));
  }

  // ========================================================================
  console.log('\n== a copy that is up to date says nothing ==');
  //
  // A warning that fires when nothing is wrong gets ignored when something is.
  // ========================================================================
  {
    const t = makeTree({ withCopy: true, copyOlder: false }); trees.push(t.root);
    const { staleConsoleWarning } = loadConfig(t.app, { ...BASE_ENV, WEB_DIST_DIR: undefined });
    const prevCwd = process.cwd();
    process.chdir(t.app);
    const msg = staleConsoleWarning(join(t.app, 'web'));
    process.chdir(prevCwd);
    falsy('no warning for a fresh copy', msg);
  }

  // ========================================================================
  console.log('\n== serving the build itself is never "stale" ==');
  // ========================================================================
  {
    const t = makeTree({ withCopy: false }); trees.push(t.root);
    const { staleConsoleWarning } = loadConfig(t.app, { ...BASE_ENV, WEB_DIST_DIR: undefined });
    const prevCwd = process.cwd();
    process.chdir(t.app);
    const msg = staleConsoleWarning(t.dist);
    process.chdir(prevCwd);
    falsy('the live build cannot be behind itself', msg);
  }

  // ========================================================================
  console.log('\n== an image with no checkout beside it says nothing ==');
  //
  // There is no ../volt-web/dist to compare against in production, and a
  // warning there would be noise on every boot of every deployment.
  // ========================================================================
  {
    const root = mkdtempSync(join(tmpdir(), 'console-prod-')); trees.push(root);
    const app = join(root, 'app');
    mkdirSync(join(app, 'web'), { recursive: true });
    writeFileSync(join(app, 'web', 'index.html'), '<html></html>');
    const { staleConsoleWarning } = loadConfig(app, { ...BASE_ENV, WEB_DIST_DIR: undefined });
    const prevCwd = process.cwd();
    process.chdir(app);
    const msg = staleConsoleWarning(join(app, 'web'));
    process.chdir(prevCwd);
    falsy('nothing to compare against, so nothing is said', msg);
  }

  // ========================================================================
  console.log('\n== the repository itself does not carry the trap ==');
  //
  // The regression guard. volt-app/web must not exist in a checkout; if
  // somebody commits one, this fails here rather than three weeks later when
  // a change mysteriously does not appear.
  // ========================================================================
  {
    const here = join(__dirname, '..', 'web', 'index.html');
    const { existsSync } = require('node:fs');
    falsy('volt-app/web is not present in the checkout', existsSync(here));
  }
} finally {
  for (const t of trees) rmSync(t, { recursive: true, force: true });
}

console.log(`\nconsole-freshness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
