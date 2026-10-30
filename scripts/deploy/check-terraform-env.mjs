#!/usr/bin/env node
/* ============================================================================
 *  DOES TERRAFORM SET WHAT THE CONTROL PLANE READS?  (build queue 2.1)
 *
 *  The control plane reads a few hundred environment variables, almost all
 *  with a default that suits a Mac. On AWS a default can be quietly wrong: the
 *  media store driver defaulted to `local`, so clips would have been written
 *  to a Fargate task's disk and lost with the task, and nothing would have
 *  said so. This check reads every name the code under volt-app/src reads and
 *  every name the control-plane task definitions set, and fails unless each
 *  name the code reads is either set by Terraform or listed in
 *  deploy/terraform/env-coverage.json with its class and the reason.
 *
 *  It also holds the parts of the stack that only break at apply or at task
 *  start: a secret reference to a key the secret does not have, a setting
 *  that must have one value on AWS, and a variable with no line in
 *  terraform.tfvars.example.
 *
 *    node scripts/deploy/check-terraform-env.mjs          the real tree
 *    node scripts/deploy/check-terraform-env.mjs --list   also print each name and where it comes from
 *
 *  No terraform binary, no AWS: it reads the files.
 * ========================================================================= */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^[A-Z][A-Z0-9_]*$/;
export const CLASSES = ['default', 'local', 'operator', 'not-on-aws-yet'];

/** Settings that must have exactly this value on AWS, and why. */
export const REQUIRED_ON_AWS = {
  ORCH_LAUNCHER: { value: 'ecs', why: 'encoders start as ECS tasks, not local processes' },
  MEDIA_STORE_DRIVER: { value: 's3', why: 'media on a Fargate disk is lost with the task' },
  INGEST_DESTINATION: { value: 's3', why: 'uploads must land in the bucket every task can read' },
  IMAGE_STORE_DRIVER: { value: 's3', why: 'the image library must survive a task replacement' },
  FAST_OUTPUT: { value: 's3', why: 'FAST playouts write to the bucket the CDN serves' },
  VOD_STORE: { value: 's3', why: 'packaged library media must be readable by any task' },
  FILLER_STORE_DRIVER: { value: 's3', why: 'slates and loops on a Fargate disk are lost with the task and missing on the others' },
  UPLOAD_STAGING_DRIVER: { value: 's3', why: 'the load balancer spreads one upload\'s chunks over several tasks, so they must wait where every task reaches them' },
};

// ---------------------------------------------------------------- the code

/** TypeScript with comments removed; strings and template literals kept. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  // config.ts and workflowPolicy.ts take the environment as a parameter `env`
  /(?<![\w.])env\.([A-Z][A-Z0-9_]{2,})\b/g,
  // the small readers: req() in config.ts, num()/bool() in config.ts and
  // scale/config.ts, env() in services/social/platforms.ts
  /(?<![\w.])(?:req|num|bool|env)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

/** Every name the control plane's code reads, with the first file that reads it. */
export function namesReadByApp(root) {
  const src = join(root, 'volt-app/src');
  const found = new Map();
  for (const f of walk(src).sort()) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const re of READ_PATTERNS) {
      for (const m of code.matchAll(re)) if (!found.has(m[1])) found.set(m[1], relative(root, f));
    }
  }
  return found;
}

// ---------------------------------------------------------------- Terraform

function tfFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.tf')).sort().map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
}

/** The text of a `resource "<type>" "<name>" {` block, braces matched. */
function block(text, header) {
  const at = text.indexOf(header);
  if (at < 0) return null;
  let i = text.indexOf('{', at), depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(at, j + 1);
  }
  return null;
}

/** The lines of one local value (`  name = ...`) up to the next value at its depth. */
function localSpan(all, name) {
  for (const { text } of all) {
    const lines = text.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const m = new RegExp(`^(\\s*)${name}\\s*=`).exec(lines[k]);
      if (!m) continue;
      // only inside a locals block
      const before = lines.slice(0, k).join('\n');
      if (before.lastIndexOf('locals {') < 0) continue;
      const indent = m[1].length;
      const span = [lines[k]];
      for (let j = k + 1; j < lines.length; j++) {
        const l = lines[j];
        const lead = /^(\s*)/.exec(l)[1].length;
        if (l.trim() && lead <= indent && !/^\s*[\])}]/.test(l)) break;
        span.push(l);
      }
      return span.join('\n');
    }
  }
  return null;
}

const namesIn = (text) => [...text.matchAll(/name\s*=\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
const valuesIn = (text) => {
  const out = {};
  for (const m of text.matchAll(/\{\s*name\s*=\s*"([A-Z][A-Z0-9_]*)"\s*,\s*value\s*=\s*"([^"]*)"\s*\}/g)) out[m[1]] = m[2];
  return out;
};

/** What the control-plane task definitions set: env names, secret names, fixed values, secret refs. */
export function controlPlaneSettings(tfDir) {
  const all = tfFiles(tfDir);
  const joined = all.map((f) => f.text).join('\n');
  const task = block(joined, 'resource "aws_ecs_task_definition" "control_plane"');
  if (!task) throw new Error('no aws_ecs_task_definition.control_plane');
  const env = new Set(), secrets = new Set(), values = {}, locals = new Set(), missingLocals = [];
  const take = (kind) => {
    const m = new RegExp(`\\b${kind}\\s*=\\s*concat\\(`).exec(task);
    if (!m) return;
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < task.length; j++) { if (task[j] === '(') depth++; else if (task[j] === ')' && --depth === 0) break; }
    const expr = task.slice(m.index, j + 1);
    const into = kind === 'environment' ? env : secrets;
    for (const n of namesIn(expr)) into.add(n);
    Object.assign(values, valuesIn(expr));
    // A local may itself concat another (qoe_env takes cdn_logs_env, build
    // queue 2.9), so the locals are followed until none is new.
    const todo = [...expr.matchAll(/local\.([a-z_]+)/g)].map((l) => l[1]);
    const seen = new Set();
    while (todo.length) {
      const name = todo.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      locals.add(name);
      const span = localSpan(all, name);
      if (span == null) { missingLocals.push(name); continue; }
      for (const n of namesIn(span)) into.add(n);
      Object.assign(values, valuesIn(span));
      for (const l of span.matchAll(/local\.([a-z_]+)/g)) todo.push(l[1]);
    }
  };
  take('environment');
  take('secrets');
  // the role services add their own (scaling_services.tf, role_tasks[*].extra)
  const roles = localSpan(all, 'role_tasks');
  if (roles) for (const n of namesIn(roles)) env.add(n);
  // secret references: "${aws_secretsmanager_secret.<s>.arn}:<KEY>::"
  const refs = [...joined.matchAll(/\$\{aws_secretsmanager_secret\.([a-z_]+)\.arn\}:([A-Z][A-Z0-9_]*)::/g)].map((m) => ({ secret: m[1], key: m[2] }));
  const secretKeys = {};
  for (const s of new Set(refs.map((r) => r.secret))) {
    const v = block(joined, `resource "aws_secretsmanager_secret_version" "${s}"`);
    secretKeys[s] = v ? new Set([...v.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1])) : null;
  }
  const variables = [...joined.matchAll(/^variable\s+"([a-z0-9_]+)"/gm)].map((m) => m[1]);
  return { env, secrets, values, locals, missingLocals, refs, secretKeys, variables };
}

// ---------------------------------------------------------------- the check

function coverageEntry(settings, name) {
  if (settings[name]) return { key: name, ...settings[name] };
  for (const [k, v] of Object.entries(settings)) if (k.endsWith('*') && name.startsWith(k.slice(0, -1))) return { key: k, ...v };
  return null;
}

export function checkTerraformEnv({ root }) {
  const errors = [];
  const tfDir = join(root, 'deploy/terraform');
  const read = namesReadByApp(root);
  const tf = controlPlaneSettings(tfDir);
  const wired = new Set([...tf.env, ...tf.secrets]);
  const covPath = join(tfDir, 'env-coverage.json');
  const cov = existsSync(covPath) ? JSON.parse(readFileSync(covPath, 'utf8')) : { settings: {} };
  const settings = cov.settings ?? {};

  for (const l of tf.missingLocals) errors.push(`the control plane uses local.${l}, which this check cannot find`);

  // 1. every name the code reads is set, or covered with a reason
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const usedKeys = new Set();
  for (const [name, file] of read) {
    if (wired.has(name)) continue;
    const e = coverageEntry(settings, name);
    if (!e) { errors.push(`${name} is read by ${file} but Terraform does not set it and env-coverage.json does not say why`); continue; }
    usedKeys.add(e.key);
    byClass[e.class] = (byClass[e.class] ?? 0) + 1;
  }

  // 2. the coverage file is well formed and not stale
  for (const [key, v] of Object.entries(settings)) {
    const exact = !key.endsWith('*');
    if (!NAME.test(exact ? key : key.slice(0, -1))) errors.push(`env-coverage.json: "${key}" is not a variable name`);
    if (!CLASSES.includes(v.class)) errors.push(`env-coverage.json: ${key} has class "${v.class}" (one of ${CLASSES.join(', ')})`);
    if (!String(v.why ?? '').trim()) errors.push(`env-coverage.json: ${key} says no why`);
    if (/\u2014/.test(`${v.why ?? ''} ${v.how ?? ''}`)) errors.push(`env-coverage.json: ${key} has an em dash`);
    if (v.class === 'operator' && !['app_env', 'app_secret_keys'].includes(v.how)) errors.push(`env-coverage.json: ${key} is set by the operator but does not say how (app_env or app_secret_keys)`);
    if (v.class === 'not-on-aws-yet' && !String(v.item ?? '').trim()) errors.push(`env-coverage.json: ${key} is not on AWS yet but names no queue item`);
    if (exact && wired.has(key)) errors.push(`env-coverage.json: ${key} is listed but Terraform sets it (remove the entry)`);
    if (exact && !read.has(key)) errors.push(`env-coverage.json: ${key} is listed but nothing under volt-app/src reads it (remove the entry)`);
    if (!exact && !usedKeys.has(key)) errors.push(`env-coverage.json: ${key} matches nothing the code reads (remove the entry)`);
  }

  // 3. secret references point at keys the secret has
  for (const r of tf.refs) {
    const keys = tf.secretKeys[r.secret];
    if (keys === null) continue;   // populated out of band (integrations)
    if (!keys.has(r.key)) errors.push(`a task reads ${r.key} from secret "${r.secret}", which has no such key: the task would not start`);
  }

  // 4. settings that must have one value on AWS
  for (const [name, { value, why }] of Object.entries(REQUIRED_ON_AWS)) {
    if (tf.values[name] !== value) errors.push(`${name} must be "${value}" on AWS (${why}); Terraform sets ${tf.values[name] === undefined ? 'nothing' : `"${tf.values[name]}"`}`);
  }

  // 5. every variable has a line in terraform.tfvars.example
  const exPath = join(tfDir, 'terraform.tfvars.example');
  const example = existsSync(exPath) ? readFileSync(exPath, 'utf8') : '';
  for (const v of tf.variables) {
    if (!new RegExp(`^\\s*#?\\s*${v}\\s*=`, 'm').test(example)) errors.push(`variable ${v} has no line in terraform.tfvars.example`);
  }

  return {
    errors,
    read,
    wired,
    checked: { read: read.size, set: [...read.keys()].filter((n) => wired.has(n)).length, wired: wired.size, covered: Object.values(byClass).reduce((a, b) => a + b, 0), byClass, secretRefs: tf.refs.length, variables: tf.variables.length },
  };
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const r = checkTerraformEnv({ root });
  if (process.argv.includes('--list')) {
    for (const [name, file] of [...r.read].sort()) console.log(`${r.wired.has(name) ? 'terraform' : 'coverage '}  ${name}  (${file})`);
  }
  const c = r.checked;
  console.log(`${c.read} settings read by the control plane: ${c.set} set by Terraform, ${c.covered} covered (${Object.entries(c.byClass).map(([k, v]) => `${v} ${k}`).join(', ')}); ${c.secretRefs} secret references; ${c.variables} variables`);
  for (const e of r.errors) console.log(`  problem: ${e}`);
  console.log(r.errors.length ? `${r.errors.length} problem(s)` : 'no problems');
  process.exit(r.errors.length ? 1 : 0);
}
