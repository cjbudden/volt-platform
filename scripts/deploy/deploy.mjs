#!/usr/bin/env node
/**
 * DEPLOY A RELEASE, OR ROLL ONE BACK (build queue D1).
 *
 *   node scripts/deploy/deploy.mjs <env>                    the version in VERSION
 *   node scripts/deploy/deploy.mjs <env> --version v0.43.0  a given release
 *   node scripts/deploy/deploy.mjs <env> --rollback         back to what ran before
 *   node scripts/deploy/deploy.mjs <env> --dry-run          print every change, make none
 *   node scripts/deploy/deploy.mjs <env> --current          print the image tag running there
 *
 * <env> is a name in deploy/environments.json: `compose` drives the Docker
 * staging stack (deploy/staging), `ecs` an AWS environment built by
 * deploy/terraform. In order, a deploy:
 *
 *   1. runs the release checks (change notes and the migration safety check,
 *      D2, both in check.mjs) and resolves the version to its git tag and commit
 *   2. builds and pushes every image tagged v<version>-<sha> (and v<version>),
 *      unless the images for that tag already exist. Never `latest`.
 *   3. registers the new service task definitions and runs the migrations ONCE,
 *      as a one-off task of the new image, before any service moves
 *   4. moves each service (rolling) and waits for steady state
 *   5. smoke test: /health/ready, a play gate call, a manifest fetch
 *   6. smoke test failed: puts back the services that ran before, says so,
 *      exits 1. Passed: registers the new encoder, FAST, radio and captions
 *      task revisions, so NEW streams take the new version while running
 *      streams keep theirs until they stop (no forced restarts)
 *   7. records the attempt and what runs where in release/deployments.json
 *
 * A rollback moves the services and task families back to the previous
 * recorded state. It does not undo migrations: releases only add to the
 * schema (RELEASING.md, "Deploying"), so the older code runs on it as it is.
 * Commit release/deployments.json after a deploy: it is the record.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ROOT, RECORD, parseArgs, environment, loadRecord, saveRecord, recordAttempt, rollbackTarget,
  resolveVersion, smokeTest,
} from './lib.mjs';
import { makeRunner } from './run.mjs';
import { ecsDriver } from './drivers/ecs.mjs';
import { composeDriver } from './drivers/compose.mjs';

const log = (...a) => console.log(...a);
const step = (n, s) => log(`\n[${n}] ${s}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = environment(args.env);
  const rec = loadRecord();
  const runner = makeRunner({ dryRun: args.dryRun, log });
  const driver = env.driver === 'ecs' ? ecsDriver(env, runner) : composeDriver(env, runner);
  const save = () => { if (!args.dryRun) saveRecord(rec); };

  if (args.current) {
    const r = rec.environments[env.name]?.running;
    if (!r) { console.error(`nothing recorded as running on ${env.name}`); return 1; }
    log(r.tag);
    return 0;
  }

  if (args.rollback) return rollback({ env, rec, runner, driver, save });

  /* 1. checks and version */
  step(1, 'release checks');
  const git = (...a) => runner.run('git', a, { mutates: false, quiet: true, allowFail: true });
  runner.run('node', [join(ROOT, 'scripts/release/check.mjs')], { mutates: false });
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const clean = git('status', '--porcelain', '--untracked-files=no').stdout.trim() === '';
  const rel = await resolveVersion({
    requested: args.version,
    versionFile: readFileSync(join(ROOT, 'VERSION'), 'utf8'),
    tagCommit: (v) => { const r = git('rev-list', '-n', '1', `v${v}`); return r.code === 0 ? r.stdout.trim() : null; },
    head, clean,
    imagesExist: (tag) => driver.imagesExist(tag),
  });
  log(`  deploying v${rel.version} (${rel.commit.slice(0, 7)}) to ${env.name} as image tag ${rel.tag}${rel.build ? '' : ' (images already built)'}`);

  const before = driver.describe();
  log(`  running now: ${Object.entries(before.services).map(([s, r]) => `${s}=${short(r)}`).join(', ') || 'nothing'}`);
  const attempt = { version: rel.version, tag: rel.tag, commit: rel.commit };

  /* 2. images */
  step(2, rel.build ? 'build and push images' : 'images exist: no build');
  if (rel.build) driver.build(rel);

  /* 3. task definitions and migrations */
  step(3, 'migrations (one-off task of the new image)');
  let plan;
  try {
    plan = driver.prepare(rel.tag);
    driver.migrate(rel.tag, plan);
  } catch (e) {
    log(`  FAILED before any service moved: ${e.message}`);
    recordAttempt(rec, env.name, { outcome: 'failed', ...attempt, error: e.message }); save();
    return 1;
  }

  /* 4. services */
  step(4, 'move the services and wait for steady state');
  const target = Object.fromEntries(Object.entries(plan).map(([s, p]) => [s, p.to]));
  let smoke = null;
  let reason = null;
  try {
    driver.updateServices(target, { encoderTag: driver.encoderTag?.(rel.tag) });
    driver.waitStable(target);
  } catch (e) { reason = e.message; }

  /* 5. smoke test */
  if (!reason) {
    step(5, `smoke test against ${env.baseUrl}`);
    if (args.dryRun) log('  [dry-run] smoke test not run');
    else {
      smoke = await smokeTest({ baseUrl: env.baseUrl, smoke: env.smoke, ...(env.smokeTiming ?? {}) });
      for (const s of smoke.steps) log(`  ${s.ok ? (s.skipped ? 'SKIP' : 'PASS') : 'FAIL'} ${s.step}: ${s.detail}`);
      if (!smoke.ok) reason = `smoke test failed: ${smoke.steps.filter((s) => !s.ok).map((s) => s.step).join(', ')}`;
    }
  }

  /* 6. roll back on failure */
  if (reason) {
    step(6, `rolling back: ${reason}`);
    const back = Object.fromEntries(Object.entries(plan).filter(([, p]) => p.from).map(([s, p]) => [s, p.from]));
    if (!Object.keys(back).length) {
      log('  nothing ran before this deploy: nothing to put back');
      recordAttempt(rec, env.name, { outcome: 'failed', ...attempt, smoke: smoke ?? undefined, error: reason }); save();
      return 1;
    }
    try {
      const prev = rec.environments[env.name]?.running;
      driver.updateServices(back, { encoderTag: prev?.encoderTag });
      driver.waitStable(back);
      const again = args.dryRun ? null : await smokeTest({ baseUrl: env.baseUrl, smoke: env.smoke, ...(env.smokeTiming ?? {}) });
      if (again) log(`  after the rollback the smoke test ${again.ok ? 'passes' : 'STILL FAILS: ' + again.steps.filter((s) => !s.ok).map((s) => `${s.step} (${s.detail})`).join(', ')}`);
      recordAttempt(rec, env.name, { outcome: 'rolled-back', ...attempt, smoke: smoke ?? undefined, error: reason }); save();
      log(`\nv${rel.version} was NOT deployed to ${env.name}; the previous version runs again.`);
    } catch (e) {
      log(`  the rollback did not complete: ${e.message}`);
      recordAttempt(rec, env.name, { outcome: 'failed', ...attempt, state: driver.describe(), smoke: smoke ?? undefined, error: `${reason}; rollback: ${e.message}` }); save();
      return 2;
    }
    return 1;
  }

  /* 6. per-stream images: new streams only */
  step(6, 'encoder images for new streams (running streams keep theirs)');
  const families = driver.moveFamilies(rel.tag);
  for (const [f, a] of Object.entries(families)) log(`  ${f} -> ${short(a)}`);

  /* 7. record */
  step(7, `record in ${relative(ROOT, RECORD)}`);
  const encoderTag = driver.encoderTag?.(rel.tag);
  recordAttempt(rec, env.name, { outcome: args.dryRun ? 'dry-run' : 'deployed', ...attempt, state: { services: target, families, ...(encoderTag ? { encoderTag } : {}) }, smoke: smoke ?? undefined });
  save();
  log(`\n${args.dryRun ? 'dry run done: nothing changed' : `v${rel.version} deployed to ${env.name}`}.`);
  return 0;
}

async function rollback({ env, rec, runner, driver, save }) {
  const to = rollbackTarget(rec, env.name);
  const from = rec.environments[env.name].running;
  step(1, `roll ${env.name} back from ${from.tag} to ${to.tag} (no build, no migrations)`);
  driver.updateServices(to.services, { encoderTag: to.encoderTag });
  driver.waitStable(to.services);
  const families = driver.restoreFamilies(to.families);
  step(2, `smoke test against ${env.baseUrl}`);
  let smoke = null;
  if (runner.dryRun) log('  [dry-run] smoke test not run');
  else {
    smoke = await smokeTest({ baseUrl: env.baseUrl, smoke: env.smoke, ...(env.smokeTiming ?? {}) });
    for (const s of smoke.steps) log(`  ${s.ok ? (s.skipped ? 'SKIP' : 'PASS') : 'FAIL'} ${s.step}: ${s.detail}`);
  }
  recordAttempt(rec, env.name, {
    outcome: runner.dryRun ? 'dry-run' : 'rollback', version: to.version, tag: to.tag, commit: to.commit,
    state: { services: to.services, families: Object.keys(families).length ? families : (to.families ?? {}), ...(to.encoderTag ? { encoderTag: to.encoderTag } : {}) },
    smoke: smoke ?? undefined,
  });
  save();
  if (smoke && !smoke.ok) { log(`\n${env.name} runs ${to.tag} again, but its smoke test FAILS: look before deploying anything else.`); return 1; }
  log(`\n${runner.dryRun ? 'dry run done: nothing changed' : `${env.name} runs v${to.version} (${to.tag}) again`}.`);
  return 0;
}

function short(ref) { return String(ref).replace(/^.*task-definition\//, ''); }

main().then((code) => process.exit(code), (e) => { console.error(`deploy: ${e.message}`); process.exit(1); });
