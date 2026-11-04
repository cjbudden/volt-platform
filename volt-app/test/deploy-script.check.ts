/**
 * The deploy and rollback script (build queue D1): scripts/deploy/deploy.mjs.
 *
 * Part 1 checks the pieces with no Docker and no AWS: version resolution
 * (never `latest`, images built only from the release's own clean commit),
 * the deployments record and where a rollback goes, task definitions moved
 * to a new image tag with everything else kept, and the smoke test against a
 * small local server.
 *
 * Part 2 runs the real script against an AWS stand-in: an `aws` command on
 * PATH that keeps ECS services, task definitions and tasks in a JSON file,
 * and a local server answering the smoke test according to which image the
 * control-plane service runs. It deploys, deploys a version whose smoke test
 * fails (rolled back), deploys one the circuit breaker refuses (rolled back),
 * rolls back explicitly, and checks a dry run changes nothing.
 * The Docker staging stack itself is exercised by hand (VOLT_BUILD_STATUS D1).
 */
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
async function throwsAsync(fn: () => unknown, re: RegExp, msg: string) {
  try { await fn(); ok(false, `${msg} (did not throw)`); } catch (e: any) { ok(re.test(String(e.message)), `${msg} (${e.message.slice(0, 90)})`); }
}

const ROOT = join(__dirname, '../..');

async function main() {
  const lib: any = await import(join(ROOT, 'scripts/deploy/lib.mjs'));

  console.log('\nversions and tags');
  ok(lib.normVersion('v0.43.0') === '0.43.0' && lib.normVersion('0.43.0\n') === '0.43.0', 'v0.43.0 and 0.43.0 both read as 0.43.0');
  await throwsAsync(() => lib.normVersion('latest'), /not a release version/, 'latest is refused');
  ok(lib.imageTag('0.43.0', 'abcdef1234567890') === 'v0.43.0-abcdef1', 'image tag is v<version>-<sha7>');
  ok(lib.IMAGE_TAG_RE.test('v0.43.0-abcdef1') && !lib.IMAGE_TAG_RE.test('latest'), 'image tag pattern');
  const base = { versionFile: '0.43.0\n', tagCommit: async (v: string) => (v === '0.43.0' ? 'a'.repeat(40) : v === '0.42.0' ? 'b'.repeat(40) : null), head: 'a'.repeat(40), clean: true, imagesExist: async () => false };
  let r = await lib.resolveVersion({ ...base, requested: null });
  ok(r.version === '0.43.0' && r.tag === 'v0.43.0-aaaaaaa' && r.build === true, 'no --version: VERSION, built from its own clean commit');
  await throwsAsync(() => lib.resolveVersion({ ...base, requested: 'v9.9.9' }), /no git tag v9\.9\.9/, 'a version with no git tag is refused');
  await throwsAsync(() => lib.resolveVersion({ ...base, requested: 'v0.42.0' }), /not built yet and the checkout is not at v0\.42\.0/, 'images missing and checkout elsewhere: refused, not built from the wrong commit');
  await throwsAsync(() => lib.resolveVersion({ ...base, requested: null, clean: false }), /uncommitted changes/, 'images missing and the tree is dirty: refused');
  r = await lib.resolveVersion({ ...base, requested: 'v0.42.0', imagesExist: async (t: string) => t === 'v0.42.0-bbbbbbb' });
  ok(r.build === false && r.tag === 'v0.42.0-bbbbbbb', 'images already built: deployed from any checkout without a build');

  console.log('\narguments');
  ok(lib.parseArgs(['staging', '--version', 'v0.43.0', '--dry-run']).dryRun === true, 'env, --version and --dry-run parsed');
  await throwsAsync(() => lib.parseArgs(['staging', '--rollback', '--version', 'v1.0.0']), /takes no --version/, '--rollback with --version refused');
  await throwsAsync(() => lib.parseArgs([]), /usage/, 'no environment: usage');

  console.log('\nthe deployments record');
  const rec = { environments: {} as any };
  const st = (n: number) => ({ services: { svc: `td:${n}` }, families: { fam: `fam:${n}` } });
  lib.recordAttempt(rec, 'e', { outcome: 'deployed', version: '0.1.0', tag: 'v0.1.0-1111111', commit: '1', state: st(1) });
  await throwsAsync(() => lib.rollbackTarget(rec, 'e'), /no earlier version/, 'one deploy: nothing to roll back to');
  lib.recordAttempt(rec, 'e', { outcome: 'deployed', version: '0.2.0', tag: 'v0.2.0-2222222', commit: '2', state: st(2) });
  lib.recordAttempt(rec, 'e', { outcome: 'rolled-back', version: '0.3.0', tag: 'v0.3.0-3333333', commit: '3', error: 'smoke' });
  const e = rec.environments.e;
  ok(e.running.tag === 'v0.2.0-2222222' && e.prior[0].tag === 'v0.1.0-1111111', 'a rolled-back deploy leaves running and prior as they were');
  ok(e.history.length === 3 && e.history[0].outcome === 'rolled-back' && e.history[0].error === 'smoke', 'every attempt is in the history, newest first');
  ok(lib.rollbackTarget(rec, 'e').tag === 'v0.1.0-1111111', 'rollback goes to the version that ran before');
  lib.recordAttempt(rec, 'e', { outcome: 'rollback', version: '0.1.0', tag: 'v0.1.0-1111111', commit: '1', state: st(1) });
  ok(e.running.tag === 'v0.1.0-1111111' && e.prior.length === 0, 'after the rollback v0.1.0 runs and leaves prior');
  ok(e.running.services.svc === 'td:1' && e.running.families.fam === 'fam:1', 'what runs where is recorded per service and task family');
  await throwsAsync(() => lib.recordAttempt(rec, 'e', { outcome: 'bogus' }), /unknown outcome/, 'unknown outcome refused');

  console.log('\ntask definitions');
  const td = {
    taskDefinitionArn: 'arn:aws:ecs:r:1:task-definition/volt-s-control-plane:7', revision: 7, status: 'ACTIVE', family: 'volt-s-control-plane',
    requiresAttributes: [], compatibilities: ['FARGATE'], registeredAt: 'x', registeredBy: 'y', cpu: '1024',
    containerDefinitions: [
      { name: 'control-plane', image: '1.dkr.ecr.r.amazonaws.com/volt-control-plane:v0.1.0-1111111', environment: [{ name: 'A', value: '1' }] },
      { name: 'sidecar', image: 'public.ecr.aws/x/otel:1.2' },
    ],
  };
  const inp = lib.retagTaskDefinition(td, ['volt-control-plane'], 'v0.2.0-2222222');
  ok(inp.containerDefinitions[0].image === '1.dkr.ecr.r.amazonaws.com/volt-control-plane:v0.2.0-2222222', 'the control-plane container moves to the new tag');
  ok(inp.containerDefinitions[1].image === 'public.ecr.aws/x/otel:1.2', 'a container from another repository is left alone');
  ok(inp.cpu === '1024' && inp.containerDefinitions[0].environment[0].value === '1', 'settings Terraform wrote are kept');
  ok(!('taskDefinitionArn' in inp) && !('revision' in inp) && !('registeredAt' in inp) && !('compatibilities' in inp), 'read-only fields dropped for register-task-definition');
  await throwsAsync(() => lib.retagTaskDefinition(td, ['volt-radio'], 'x'), /no container uses volt-radio/, 'no matching container: refused');
  ok(lib.tagOf('1.dkr.ecr.r.amazonaws.com:5000/volt-encoder:v1.0.0-abcdef1') === 'v1.0.0-abcdef1' && lib.tagOf('host:5000/img') === null, 'tag read from an image reference (registry port is not a tag)');

  console.log('\nthe smoke test');
  const mode = { ready: 200, gate: 401, manifest: 200 };
  const srv = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/health/ready') { res.writeHead(mode.ready); return res.end('{}'); }
    if (u.pathname === '/api/public/availability') {
      if (u.searchParams.get('appKey') === 'pk_real' && u.searchParams.get('assetId') === 'asset1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ available: true, mode: 'play', delivery: { hls: '/live/asset1/master.m3u8', dash: null } }));
      }
      res.writeHead(mode.gate, { 'content-type': 'application/json' }); return res.end('{"error":"invalid key"}');
    }
    if (u.pathname === '/live/asset1/master.m3u8') { res.writeHead(mode.manifest); return res.end(mode.manifest === 200 ? '#EXTM3U\n#EXT-X-VERSION:7\n' : 'nope'); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r2) => srv.listen(0, '127.0.0.1', () => r2()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const quick = { readyTries: 2, waitMs: 20 };
  let s = await lib.smokeTest({ baseUrl: url, ...quick });
  ok(s.ok && s.steps.find((x: any) => x.step === 'manifest').skipped, 'no asset configured: ready + gate refuses a made-up key; manifest skipped and said');
  s = await lib.smokeTest({ baseUrl: url, smoke: { appKey: 'pk_real', assetId: 'asset1' }, ...quick });
  ok(s.ok && s.steps.length === 3 && s.steps.every((x: any) => !x.skipped), 'a real asset: gate says play and its manifest is fetched');
  mode.manifest = 404;
  s = await lib.smokeTest({ baseUrl: url, smoke: { appKey: 'pk_real', assetId: 'asset1' }, ...quick });
  ok(!s.ok && s.steps.find((x: any) => x.step === 'manifest').ok === false, 'manifest 404: fails');
  mode.manifest = 200; mode.ready = 503;
  s = await lib.smokeTest({ baseUrl: url, ...quick });
  ok(!s.ok && s.steps[0].detail === 'HTTP 503', 'not ready: fails');
  mode.ready = 200; mode.gate = 500;
  s = await lib.smokeTest({ baseUrl: url, ...quick });
  ok(!s.ok, 'gate answering 500 to a made-up key: fails');
  const closed = await new Promise<number>((r2) => { const t = createServer(); t.listen(0, '127.0.0.1', () => { const p = (t.address() as AddressInfo).port; t.close(() => r2(p)); }); });
  s = await lib.smokeTest({ baseUrl: `http://127.0.0.1:${closed}`, readyTries: 1 });
  ok(!s.ok && /ECONNREFUSED/.test(s.steps[0].detail), 'nothing listening: fails with the reason');
  srv.close();

  await ecsFlows();
}

/* ---- part 2: the real script against an AWS stand-in --------------------- */

const FAKE_AWS = String.raw`#!/usr/bin/env node
const fs = require('fs');
const F = process.env.FAKE_AWS_STATE;
const s = JSON.parse(fs.readFileSync(F, 'utf8'));
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i < 0 ? null : a[i + 1]; };
const list = (k) => { const i = a.indexOf(k); const o = []; for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) o.push(a[j]); return o; };
s.calls.push(a.filter((x, i) => !(a[i - 1] === '--cli-input-json')).join(' '));
const save = () => fs.writeFileSync(F, JSON.stringify(s, null, 2));
const out = (o) => { save(); process.stdout.write(JSON.stringify(o)); process.exit(0); };
const arn = (fam, rev) => 'arn:aws:ecs:eu:111:task-definition/' + fam + ':' + rev;
const td = (ref) => {
  const m = ref.replace(/^.*task-definition\//, '').match(/^(.*?)(?::(\d+))?$/);
  const revs = s.tds[m[1]] || [];
  const d = m[2] ? revs[Number(m[2]) - 1] : revs[revs.length - 1];
  return d ? { ...d, taskDefinitionArn: arn(d.family, d.revision), status: 'ACTIVE', registeredAt: 1, compatibilities: ['FARGATE'] } : null;
};
const key = a[0] + ' ' + a[1];
if (key === 'sts get-caller-identity') out({ Account: '111' });
if (key === 'ecr describe-images') out({ imageDetails: [{}] });
if (key === 'ecr get-login-password') { save(); process.stdout.write('pw'); process.exit(0); }
if (key === 'ecs describe-services') out({ services: list('--services').filter((n) => s.services[n]).map((n) => ({
  serviceName: n, status: 'ACTIVE', taskDefinition: s.services[n].td,
  networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-1'], securityGroups: ['sg-1'] } },
  deployments: [{ status: 'PRIMARY', taskDefinition: s.services[n].td, rolloutState: s.services[n].rollout || 'COMPLETED' }] })) });
if (key === 'ecs describe-task-definition') { const d = td(opt('--task-definition')); if (!d) { save(); process.stderr.write('not found'); process.exit(254); } out({ taskDefinition: d }); }
if (key === 'ecs register-task-definition') {
  const inp = JSON.parse(fs.readFileSync(opt('--cli-input-json').replace('file://', ''), 'utf8'));
  for (const k of ['taskDefinitionArn', 'revision', 'status', 'registeredAt', 'compatibilities']) if (k in inp) { process.stderr.write('read-only field ' + k); process.exit(255); }
  const revs = (s.tds[inp.family] ||= []); const d = { ...inp, revision: revs.length + 1 }; revs.push(d);
  out({ taskDefinition: { ...d, taskDefinitionArn: arn(d.family, d.revision) } });
}
if (key === 'ecs update-service') {
  const n = opt('--service'); const to = opt('--task-definition'); const img = td(to).containerDefinitions[0].image;
  if (s.breakerRefuses && img.endsWith(':' + s.breakerRefuses)) { s.services[n].rollout = 'FAILED'; out({}); }
  s.services[n] = { td: to }; out({});
}
if (key === 'ecs run-task') { s.tasks.push({ td: opt('--task-definition'), overrides: JSON.parse(opt('--overrides')), net: JSON.parse(opt('--network-configuration')) }); out({ tasks: [{ taskArn: 'arn:task/' + s.tasks.length }] }); }
if (key === 'ecs wait') { save(); process.exit(0); }
if (key === 'ecs describe-tasks') out({ tasks: [{ containers: [{ name: 'control-plane', exitCode: s.migrateExit }], stoppedReason: 'Essential container exited' }] });
save(); process.stderr.write('fake aws: unhandled ' + a.join(' ')); process.exit(2);
`;

async function ecsFlows() {
  console.log('\nthe script against an AWS stand-in');
  const dir = mkdtempSync(join(tmpdir(), 'deploycheck-'));
  const bin = join(dir, 'bin');
  require('node:fs').mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), FAKE_AWS); chmodSync(join(bin, 'aws'), 0o755);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker $*" >> "$(dirname "$0")/../docker-calls"\n'); chmodSync(join(bin, 'docker'), 0o755);

  const stateFile = join(dir, 'aws.json');
  const reg = '111.dkr.ecr.eu.amazonaws.com';
  const def = (family: string, repo: string, tag: string, revision = 1) => ({ family, revision, cpu: '512', containerDefinitions: [{ name: family.split('-').pop(), image: `${reg}/${repo}:${tag}`, environment: [{ name: 'KEEP', value: 'me' }] }] });
  const T0 = 'v0.1.0-0000000';
  const state: any = {
    calls: [], tasks: [], migrateExit: 0, breakerRefuses: null,
    services: {
      'volt-t-control-plane': { td: 'arn:aws:ecs:eu:111:task-definition/volt-t-control-plane:1' },
      'volt-t-api-public': { td: 'arn:aws:ecs:eu:111:task-definition/volt-t-api-public:1' },
    },
    tds: {
      'volt-t-control-plane': [def('volt-t-control-plane', 'volt-control-plane', T0)],
      'volt-t-api-public': [def('volt-t-api-public', 'volt-control-plane', T0)],
      'volt-t-encoder': [def('volt-t-encoder', 'volt-encoder', T0)],
      'volt-t-radio': [def('volt-t-radio', 'volt-radio', T0)],
    },
  };
  const saveState = () => writeFileSync(stateFile, JSON.stringify(state));
  const loadState = () => Object.assign(state, JSON.parse(readFileSync(stateFile, 'utf8')));
  saveState();

  // The smoke server answers for whatever image the control-plane service runs now.
  let badTag = '';
  const srv = createServer((req, res) => {
    const st2 = JSON.parse(readFileSync(stateFile, 'utf8'));
    const ref = st2.services['volt-t-control-plane'].td.replace(/^.*task-definition\//, '');
    const [fam, rev] = ref.split(':');
    const img = st2.tds[fam][Number(rev) - 1].containerDefinitions[0].image;
    const sick = badTag && img.endsWith(badTag);
    if (req.url === '/health/ready') { res.writeHead(sick ? 503 : 200); return res.end('{}'); }
    if (req.url?.startsWith('/api/public/availability')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid key"}'); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r2) => srv.listen(0, '127.0.0.1', () => r2()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const envFile = join(dir, 'environments.json');
  writeFileSync(envFile, JSON.stringify({ t: { driver: 'ecs', project: 'volt', env: 't', region: 'eu', baseUrl: url, images: ['control-plane', 'encoder', 'thumbnailer', 'radio'], smokeTiming: { readyTries: 1, waitMs: 10 } } }));
  const recFile = join(dir, 'deployments.json');

  const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
  const sha = await new Promise<string>((res2) => { const p = spawn('git', ['rev-list', '-n', '1', `v${version}`], { cwd: ROOT }); let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => res2(o.trim())); });
  const TAG = `v${version}-${sha.slice(0, 7)}`;
  const deploy = (...args: string[]) => new Promise<{ code: number; out: string }>((res2) => {
    const p = spawn('node', [join(ROOT, 'scripts/deploy/deploy.mjs'), 't', ...args], {
      cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_STATE: stateFile, DEPLOY_ENVIRONMENTS: envFile, DEPLOY_RECORD: recFile },
    });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => res2({ code: code ?? 1, out }));
  });
  const imgOf = (svc: string) => { loadState(); const [fam, rev] = state.services[svc].td.replace(/^.*\//, '').split(':'); return state.tds[fam][Number(rev) - 1].containerDefinitions[0].image; };
  const newest = (fam: string) => { loadState(); const r2 = state.tds[fam]; return r2[r2.length - 1]; };

  // A dry run first: reads, changes nothing.
  let d = await deploy('--dry-run', '--version', `v${version}`);
  loadState();
  ok(d.code === 0 && /\[dry-run\] aws ecs update-service/.test(d.out) && imgOf('volt-t-control-plane').endsWith(T0), 'dry run: prints the update-service calls, moves nothing');
  ok(!state.calls.some((c: string) => /register-task-definition|update-service|run-task/.test(c)) && !require('node:fs').existsSync(recFile), 'dry run: no register, update or run-task call; no record written');

  // 1. a deploy that passes
  d = await deploy('--version', `v${version}`);
  loadState();
  ok(d.code === 0, `deploy v${version} exits 0${d.code ? `: ${d.out.slice(-400)}` : ''}`);
  ok(imgOf('volt-t-control-plane').endsWith(`:${TAG}`) && imgOf('volt-t-api-public').endsWith(`:${TAG}`), `both services run ${TAG}`);
  ok(newest('volt-t-control-plane').containerDefinitions[0].environment[0].value === 'me', 'the new revision keeps the settings Terraform wrote');
  const mig = state.tasks[0];
  ok(state.tasks.length === 1 && mig.overrides.containerOverrides[0].command.join(' ') === 'node dist/migrateOnly.js' && /control-plane:2$/.test(mig.td), 'migrations ran once, as a one-off task of the new revision');
  ok(mig.net.awsvpcConfiguration.subnets[0] === 'subnet-1', 'the migration task runs in the service\'s own subnets');
  const iMig = state.calls.findIndex((c: string) => c.startsWith('ecs run-task'));
  const iUpd = state.calls.findIndex((c: string) => c.startsWith('ecs update-service'));
  ok(iMig >= 0 && iUpd > iMig, 'migrations before any service moved');
  ok(newest('volt-t-encoder').containerDefinitions[0].image.endsWith(`:${TAG}`) && newest('volt-t-radio').containerDefinitions[0].image.endsWith(`:${TAG}`), 'encoder and radio families have a new revision on the release tag (new streams)');
  const iFam = state.calls.findIndex((c: string, i: number) => i > iUpd && /register-task-definition/.test(c));
  ok(iFam > iUpd, 'per-stream families moved only after the services settled and the smoke test passed');
  ok(!state.calls.some((c: string) => /stop-task/.test(c)), 'no running task is stopped');
  const rec1 = JSON.parse(readFileSync(recFile, 'utf8')).environments.t;
  ok(rec1.running.tag === TAG && rec1.running.services['volt-t-control-plane'].endsWith(':2') && rec1.running.families['volt-t-encoder'].endsWith(':2'), 'record: what runs where (service and family revisions)');
  ok(rec1.history[0].outcome === 'deployed' && rec1.history[0].smoke.ok === true, 'record: outcome and smoke result');
  ok(rec1.prior.length === 0, 'first recorded deploy: no prior state');

  // 2. the same release again, with its smoke test failing: rolled back
  badTag = TAG;
  // Make the "new" revision distinguishable: deploy the same tag again; the smoke server fails it.
  // First put the services back on the old image so there is something to return to.
  loadState(); state.services['volt-t-control-plane'].td = 'arn:aws:ecs:eu:111:task-definition/volt-t-control-plane:1'; state.services['volt-t-api-public'].td = 'arn:aws:ecs:eu:111:task-definition/volt-t-api-public:1'; state.tasks = []; saveState();
  d = await deploy('--version', `v${version}`);
  loadState();
  ok(d.code === 1 && /smoke test failed: ready/.test(d.out), 'a failing smoke test fails the deploy (exit 1)');
  ok(imgOf('volt-t-control-plane').endsWith(`:${T0}`) && state.services['volt-t-control-plane'].td.endsWith(':1'), 'the control plane is back on the exact revision it ran before');
  ok(imgOf('volt-t-api-public').endsWith(`:${T0}`), 'api-public is back too');
  ok(/after the rollback the smoke test passes/.test(d.out), 'the smoke test is run again after the rollback, and passes');
  const famBefore = state.tds['volt-t-encoder'].length;
  const rec2 = JSON.parse(readFileSync(recFile, 'utf8')).environments.t;
  ok(rec2.history[0].outcome === 'rolled-back' && /ready/.test(rec2.history[0].error), 'record: rolled-back with the reason');
  ok(famBefore === 2, 'a rolled-back deploy registers no new encoder revision');
  badTag = '';

  // 3. the circuit breaker refuses the new revision: rolled back as well
  loadState(); state.breakerRefuses = TAG; state.tasks = []; saveState();
  d = await deploy('--version', `v${version}`);
  loadState();
  ok(d.code === 1 && /did not settle/.test(d.out) && imgOf('volt-t-control-plane').endsWith(`:${T0}`), 'a service that never settles (circuit breaker) is rolled back');
  state.breakerRefuses = null; saveState();

  // 4. the migration fails: nothing moves
  loadState(); state.migrateExit = 1; state.tasks = []; saveState();
  const callsBefore = state.calls.length;
  d = await deploy('--version', `v${version}`);
  loadState();
  ok(d.code === 1 && /FAILED before any service moved/.test(d.out) && !state.calls.slice(callsBefore).some((c: string) => c.startsWith('ecs update-service')), 'a failed migration stops the deploy before any service moves');
  state.migrateExit = 0; saveState();

  // 5. deploy for real, then an explicit rollback to the recorded earlier state
  // (the record's running state is the first deploy; make an older one the prior)
  const recNow = JSON.parse(readFileSync(recFile, 'utf8'));
  recNow.environments.t.prior = [{ version: '0.1.0', tag: T0, commit: '0', services: { 'volt-t-control-plane': 'arn:aws:ecs:eu:111:task-definition/volt-t-control-plane:1', 'volt-t-api-public': 'arn:aws:ecs:eu:111:task-definition/volt-t-api-public:1' }, families: { 'volt-t-encoder': 'arn:aws:ecs:eu:111:task-definition/volt-t-encoder:1' } }];
  writeFileSync(recFile, JSON.stringify(recNow));
  loadState(); state.services['volt-t-control-plane'].td = rec1.running.services['volt-t-control-plane']; state.services['volt-t-api-public'].td = rec1.running.services['volt-t-api-public']; saveState();
  const callsBeforeRb = state.calls.length;
  d = await deploy('--rollback');
  loadState();
  ok(d.code === 0 && imgOf('volt-t-control-plane').endsWith(`:${T0}`) && imgOf('volt-t-api-public').endsWith(`:${T0}`), `--rollback: services back on ${T0}`);
  ok(newest('volt-t-encoder').containerDefinitions[0].image.endsWith(`:${T0}`), '--rollback: new streams take the earlier encoder again');
  ok(!state.calls.slice(callsBeforeRb).some((c: string) => /run-task|ecr describe-images/.test(c)), '--rollback: no migrations, no build');
  const rec3 = JSON.parse(readFileSync(recFile, 'utf8')).environments.t;
  ok(rec3.running.tag === T0 && rec3.history[0].outcome === 'rollback' && rec3.prior.length === 0, 'record: rollback, the earlier state runs, prior used up');
  d = await deploy('--rollback');
  ok(d.code === 1 && /no earlier version/.test(d.out), 'a second --rollback with nothing earlier recorded is refused');
  d = await deploy('--current');
  ok(d.code === 0 && d.out.trim() === T0, '--current prints the running tag (for terraform apply)');
  srv.close();
}

main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, (e) => { console.error(e); console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); });
