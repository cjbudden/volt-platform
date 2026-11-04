// Shared by deploy.mjs, its two drivers and its check (build queue D1).
// Everything here is pure or touches only files, so the check can run it
// without Docker or AWS.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENVIRONMENTS = process.env.DEPLOY_ENVIRONMENTS || join(ROOT, 'deploy', 'environments.json');
export const RECORD = process.env.DEPLOY_RECORD || join(ROOT, 'release', 'deployments.json');

/** States a deploy can leave an environment in, as written to the record. */
export const OUTCOMES = ['deployed', 'rolled-back', 'rollback', 'failed', 'dry-run'];

export function parseArgs(argv) {
  const o = { env: null, version: null, rollback: false, dryRun: false, current: false, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rollback') o.rollback = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--current') o.current = true;
    else if (a === '--version') o.version = argv[++i];
    else if (a.startsWith('--version=')) o.version = a.slice(10);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!o.env) o.env = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.env) throw new Error('usage: deploy.mjs <env> [--version vX.Y.Z] [--rollback] [--dry-run] [--current]');
  if (o.rollback && o.version) throw new Error('--rollback goes back to the version that ran before; it takes no --version');
  return o;
}

/** "v0.43.0" or "0.43.0" to "0.43.0". Anything else is refused, `latest` above all. */
export function normVersion(v) {
  const m = String(v ?? '').trim().match(/^v?(\d+\.\d+\.\d+)$/);
  if (!m) throw new Error(`"${v}" is not a release version (vX.Y.Z)`);
  return m[1];
}

/**
 * The tag every image of a release carries: the version AND the commit, so a
 * tag can never be moved to other bytes by a rebuild and a task definition
 * says exactly what it runs. Never `latest`.
 */
export function imageTag(version, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha ?? '')) throw new Error(`"${sha}" is not a git commit`);
  return `v${normVersion(version)}-${sha.slice(0, 7)}`;
}
export const IMAGE_TAG_RE = /^v\d+\.\d+\.\d+-[0-9a-f]{7}$/;

/**
 * Which release to deploy, and whether its images have to be built first.
 *
 *   requested    --version, or null for the VERSION file
 *   versionFile  contents of VERSION
 *   tagCommit    (version) => the commit `v<version>` points at, or null
 *   head         the checked-out commit;  clean: no uncommitted changes
 *   imagesExist  (tag) => true when every image for the tag is already there
 *
 * Images are only ever built from the release's own commit with nothing
 * uncommitted, so what runs is what the tag says. A release whose images
 * already exist (an earlier deploy, another environment) is deployed from any
 * checkout without a build.
 */
export async function resolveVersion({ requested, versionFile, tagCommit, head, clean, imagesExist }) {
  const version = normVersion(requested ?? versionFile);
  const commit = await tagCommit(version);
  if (!commit) throw new Error(`there is no git tag v${version}: cut the release first (scripts/release/release.mjs)`);
  const tag = imageTag(version, commit);
  if (await imagesExist(tag)) return { version, commit, tag, build: false };
  if (head !== commit) throw new Error(`the images for v${version} are not built yet and the checkout is not at v${version} (${commit.slice(0, 7)}): check out the tag, then deploy`);
  if (!clean) throw new Error(`the images for v${version} would be built from a tree with uncommitted changes: commit or stash them first`);
  return { version, commit, tag, build: true };
}

export function loadEnvironments(path = ENVIRONMENTS) {
  const all = JSON.parse(readFileSync(path, 'utf8'));
  return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('_')));
}

export function environment(name, path = ENVIRONMENTS) {
  const envs = loadEnvironments(path);
  const e = envs[name];
  if (!e) throw new Error(`no environment "${name}" in ${path} (have: ${Object.keys(envs).join(', ') || 'none'})`);
  if (!['compose', 'ecs'].includes(e.driver)) throw new Error(`environment "${name}": driver must be compose or ecs`);
  if (!e.baseUrl) throw new Error(`environment "${name}": baseUrl is required (the smoke test calls it)`);
  return { name, ...e };
}

/* ---- the deployments record: release/deployments.json -------------------- */
//
// Per environment: `running` (what runs where now: the version, the image tag
// and each service's and task family's reference), `prior` (what ran before,
// newest first: where --rollback goes), and `history` (every attempt, newest
// first, with its outcome and smoke result).

export function loadRecord(path = RECORD) {
  if (!existsSync(path)) return { environments: {} };
  const r = JSON.parse(readFileSync(path, 'utf8'));
  r.environments ??= {};
  return r;
}

export function saveRecord(rec, path = RECORD) {
  writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
}

export function envRecord(rec, env) {
  rec.environments[env] ??= { running: null, prior: [], history: [] };
  return rec.environments[env];
}

const KEEP_PRIOR = 10;
const KEEP_HISTORY = 50;

/**
 * Write one attempt. `state` is what runs after it (for deployed and
 * rollback), `previous` what ran before.
 *   deployed     the new version runs; the old one becomes prior[0]
 *   rollback     an explicit --rollback: prior[0] runs again and leaves prior
 *   rolled-back  the smoke test failed and the old version was put back:
 *                running and prior are unchanged
 *   failed       stopped before anything moved (or the restore failed: then
 *                `state` says what is actually running)
 *   dry-run      nothing changed; history only
 */
export function recordAttempt(rec, env, { outcome, version, tag, commit, state, smoke, error, at = new Date().toISOString(), by = 'deploy.mjs' }) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome ${outcome}`);
  const e = envRecord(rec, env);
  e.history.unshift({ at, by, outcome, version, tag, commit, ...(smoke ? { smoke } : {}), ...(error ? { error } : {}) });
  e.history = e.history.slice(0, KEEP_HISTORY);
  if (outcome === 'deployed') {
    if (e.running) e.prior.unshift(e.running);
    e.running = { version, tag, commit, at, ...state };
  } else if (outcome === 'rollback') {
    e.prior.shift();
    e.running = { version, tag, commit, at, ...state };
  } else if (outcome === 'failed' && state) {
    // The restore did not complete: say what is really there.
    e.running = { ...(e.running ?? {}), ...state, at, note: 'restore after a failed deploy did not complete' };
  }
  e.prior = e.prior.slice(0, KEEP_PRIOR);
  return e;
}

/** Where --rollback goes: the newest earlier state with a different tag. */
export function rollbackTarget(rec, env) {
  const e = rec.environments[env];
  if (!e?.running) throw new Error(`nothing is recorded as running on ${env}: nothing to roll back`);
  const t = e.prior[0];
  if (!t) throw new Error(`no earlier version is recorded for ${env}: nothing to roll back to`);
  return t;
}

/* ---- ECS task definitions ------------------------------------------------- */

// Fields describe-task-definition returns that register-task-definition refuses.
const READ_ONLY = ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt'];

/**
 * A register-task-definition input from a described one, with every container
 * whose image comes from one of `repos` moved to `tag`. Everything else
 * (settings Terraform wrote, sizes, roles) is kept as it is, so the newest
 * revision Terraform registered is the base and only the image changes.
 */
export function retagTaskDefinition(td, repos, tag) {
  const input = Object.fromEntries(Object.entries(td).filter(([k]) => !READ_ONLY.includes(k)));
  let changed = 0;
  input.containerDefinitions = (td.containerDefinitions ?? []).map((c) => {
    const at = c.image.lastIndexOf(':');
    const slash = c.image.lastIndexOf('/');
    const repoPath = at > slash ? c.image.slice(0, at) : c.image;
    const repo = repoPath.slice(repoPath.lastIndexOf('/') + 1);
    if (!repos.includes(repo)) return c;
    changed++;
    return { ...c, image: `${repoPath}:${tag}` };
  });
  if (!changed) throw new Error(`task definition ${td.family}: no container uses ${repos.join(' or ')}`);
  return input;
}

/** The image tag a task definition's containers run, for the record. */
export function tagOf(image) {
  const at = image.lastIndexOf(':');
  return at > image.lastIndexOf('/') ? image.slice(at + 1) : null;
}

/* ---- the smoke test ---------------------------------------------------- */

/**
 * After the services settle: is the new version serving viewers?
 *   1. GET /health/ready answers 200 (boot finished, database reachable)
 *   2. the play gate answers: with `smoke.appKey` and `smoke.assetId`, the
 *      asset must be playable (200, available, an HLS address); without them,
 *      a made-up key must be refused with 401 and a JSON body, which still
 *      proves the route, the key lookup and the database
 *   3. a manifest: the HLS address the gate gave, or `smoke.manifestUrl`; it
 *      must answer 200 and start with #EXTM3U. With neither, skipped and said.
 */
const why = (e) => String(e.cause?.code ?? e.cause?.message ?? e.message);

export async function smokeTest({ baseUrl, smoke = {}, fetchImpl = fetch, readyTries = 6, waitMs = 5000, timeoutMs = 10000 }) {
  const base = baseUrl.replace(/\/$/, '');
  const steps = [];
  const get = async (url, headers = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { headers, signal: ac.signal, redirect: 'follow' });
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(t); }
  };
  const abs = (u) => (/^https?:\/\//.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);

  let ready = { ok: false, detail: '' };
  for (let i = 0; i < readyTries; i++) {
    try {
      const r = await get(`${base}/health/ready`);
      ready = { ok: r.status === 200, detail: `HTTP ${r.status}` };
    } catch (e) { ready = { ok: false, detail: why(e) }; }
    if (ready.ok) break;
    if (i < readyTries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  steps.push({ step: 'ready', ...ready });

  let hls = smoke.manifestUrl ? abs(smoke.manifestUrl) : null;
  try {
    const real = smoke.appKey && smoke.assetId;
    const q = new URLSearchParams({ appKey: real ? smoke.appKey : 'pk_deploy_smoke_probe', assetId: real ? smoke.assetId : '00000000-0000-4000-8000-000000000000' });
    const r = await get(`${base}/api/public/availability?${q}`, smoke.origin ? { Origin: smoke.origin } : {});
    let body = null;
    try { body = JSON.parse(r.text); } catch { /* checked below */ }
    if (real) {
      const ok = r.status === 200 && body?.available === true && !!body?.delivery?.hls;
      if (ok && !smoke.manifestUrl) hls = abs(body.delivery.hls);
      steps.push({ step: 'play-gate', ok, detail: `HTTP ${r.status}${body ? ` mode=${body.mode ?? '-'} available=${body.available}` : ' (not JSON)'}${body?.delivery?.hls ? '' : ', no HLS address'}` });
    } else {
      steps.push({ step: 'play-gate', ok: r.status === 401 && !!body, detail: `probe key: HTTP ${r.status}${body ? '' : ' (not JSON)'} (401 expected; set smoke.appKey and smoke.assetId to check a real asset)` });
    }
  } catch (e) { steps.push({ step: 'play-gate', ok: false, detail: why(e) }); }

  if (hls) {
    try {
      const r = await get(hls);
      steps.push({ step: 'manifest', ok: r.status === 200 && r.text.startsWith('#EXTM3U'), detail: `HTTP ${r.status} ${hls.replace(/\?.*$/, '')}` });
    } catch (e) { steps.push({ step: 'manifest', ok: false, detail: why(e) }); }
  } else {
    const gateFailed = smoke.appKey && smoke.assetId;
    steps.push({ step: 'manifest', ok: true, skipped: true, detail: gateFailed ? 'skipped: the play gate gave no address to fetch' : 'skipped: no smoke.assetId or smoke.manifestUrl for this environment' });
  }
  return { ok: steps.every((s) => s.ok), steps };
}
