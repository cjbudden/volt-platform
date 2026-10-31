/**
 * Terraform sets what the control plane reads (build queue 2.1).
 *
 * scripts/deploy/check-terraform-env.mjs reads every environment variable the
 * code under volt-app/src reads and every name the control-plane task
 * definitions set, and fails unless each one is set by Terraform or listed in
 * deploy/terraform/env-coverage.json with its reason. It also fails on a
 * secret reference to a key the secret does not have, a setting that must
 * have one value on AWS, and a variable with no line in
 * terraform.tfvars.example. This runs it on the real tree (no problems
 * allowed), on the real Terraform with this item's settings taken out (it must
 * notice), and on small made-up trees that break one rule each.
 * No database, no API, no terraform binary.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

const ROOT = join(__dirname, '../..');

const REQUIRED = [
  ['ORCH_LAUNCHER', 'ecs'], ['MEDIA_STORE_DRIVER', 's3'], ['INGEST_DESTINATION', 's3'],
  ['IMAGE_STORE_DRIVER', 's3'], ['FAST_OUTPUT', 's3'], ['VOD_STORE', 's3'], ['FILLER_STORE_DRIVER', 's3'],
  ['UPLOAD_STAGING_DRIVER', 's3'], ['VOD_SOURCE_DRIVER', 's3'],
];

/** A throwaway tree: one source file and a minimal control-plane task definition. */
function fakeRepo(o: { code?: string; env?: string[]; values?: Record<string, string>; secretKeys?: string[]; refs?: string[]; coverage?: object; variables?: string[]; example?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tfenv-'));
  mkdirSync(join(root, 'volt-app/src'), { recursive: true });
  mkdirSync(join(root, 'deploy/terraform'), { recursive: true });
  writeFileSync(join(root, 'volt-app/src/config.ts'), o.code ?? 'export const a = process.env.A_SET;\n');
  const values = { ...Object.fromEntries(REQUIRED), ...(o.values ?? {}) };
  const envLines = [...(o.env ?? ['A_SET']).map((n) => `    { name = "${n}", value = "1" },`), ...Object.entries(values).map(([k, v]) => `    { name = "${k}", value = "${v}" },`)];
  const refs = o.refs ?? ['S_KEY'];
  const tf = [
    'resource "aws_ecs_task_definition" "control_plane" {',
    '  container_definitions = jsonencode([{',
    '    environment = concat(local.base_env, [',
    '      { name = "ROLE", value = "all" },',
    '    ])',
    '    secrets = concat(local.base_secrets)',
    '  }])',
    '}',
    '',
    'locals {',
    '  base_env = [',
    ...envLines,
    '  ]',
    '  base_secrets = [',
    ...refs.map((k) => `    { name = "${k}", valueFrom = "\${aws_secretsmanager_secret.app.arn}:${k}::" },`),
    '  ]',
    '}',
    '',
    'resource "aws_secretsmanager_secret_version" "app" {',
    '  secret_string = jsonencode({',
    ...(o.secretKeys ?? ['S_KEY']).map((k) => `    ${k} = "x"`),
    '  })',
    '}',
    '',
    ...(o.variables ?? ['region']).map((v) => `variable "${v}" {\n  type = string\n}\n`),
  ].join('\n');
  writeFileSync(join(root, 'deploy/terraform/main.tf'), tf);
  writeFileSync(join(root, 'deploy/terraform/terraform.tfvars.example'), o.example ?? 'region = "us-east-1"\n');
  writeFileSync(join(root, 'deploy/terraform/env-coverage.json'), JSON.stringify(o.coverage ?? { settings: {} }));
  return root;
}

(async () => {
  const mod: any = await import(join(ROOT, 'scripts/deploy/check-terraform-env.mjs'));
  const { checkTerraformEnv, stripComments, namesReadByApp } = mod;
  const errsOf = (o: Parameters<typeof fakeRepo>[0]) => checkTerraformEnv({ root: fakeRepo(o) }).errors as string[];
  const has = (errs: string[], re: RegExp) => errs.some((e) => re.test(e));

  console.log('the real tree');
  const real = checkTerraformEnv({ root: ROOT });
  ok(real.errors.length === 0, `no problems${real.errors.length ? ': ' + real.errors.slice(0, 5).join(' | ') : ''}`);
  ok(real.checked.read >= 250, `${real.checked.read} settings read by the control plane`);
  ok(real.checked.set >= 70 && real.checked.set + real.checked.covered === real.checked.read, `${real.checked.set} of them set by Terraform, the other ${real.checked.covered} covered`);
  for (const c of ['default', 'local', 'operator', 'not-on-aws-yet']) ok(real.checked.byClass[c] > 0, `${real.checked.byClass[c]} covered as ${c}`);
  ok(real.checked.secretRefs >= 12, `${real.checked.secretRefs} secret references, each to a key its secret has`);
  ok(real.checked.variables >= 90, `${real.checked.variables} variables, each with a line in terraform.tfvars.example`);
  for (const n of ['VOLT_DEPLOYMENT', 'MEDIA_STORE_DRIVER', 'INGEST_DESTINATION', 'INGEST_S3_ACCELERATE', 'MEDIA_ARCHIVE_ENABLED', 'SOCIAL_TOKEN_KEY']) {
    ok(real.wired.has(n), `${n} is set by Terraform`);
  }
  const cov = JSON.parse(readFileSync(join(ROOT, 'deploy/terraform/env-coverage.json'), 'utf8'));
  ok(cov.settings.SMTP_URL?.class === 'operator' && cov.settings.SMTP_URL?.how === 'app_secret_keys', 'SMTP_URL is the operator\'s, as a secret');
  // 2.1a: slates and loops live in the bucket on AWS; FILLER_DIR is only where one lands.
  ok(cov.settings.FILLER_DIR?.class === 'default' && real.wired.has('FILLER_STORE_DRIVER'), 'slates and loops are in the bucket on AWS, FILLER_DIR only scratch (2.1a)');
  ok(Object.values(cov.settings as Record<string, any>).every((v) => v.item !== '2.1a'), 'nothing is left waiting on 2.1a itself (the rest is 2.1a-2 to 2.1a-4)');
  // 2.1a-2: upload chunks wait in the bucket, so an upload spread over tasks assembles.
  ok(real.wired.has('UPLOAD_STAGING_DRIVER') && cov.settings.UPLOAD_STAGING_DIR?.class === 'default', 'upload chunks wait in the bucket on AWS, UPLOAD_STAGING_DIR only scratch (2.1a-2)');
  ok(/resource "aws_s3_bucket_lifecycle_configuration" "origin"[\s\S]*?prefix = "upload-staging\/"/.test(readFileSync(join(ROOT, 'deploy/terraform/s3_cloudfront.tf'), 'utf8')), 'the origin bucket expires forgotten upload parts (2.1a-2)');
  // 2.1a-2b: an asset's original is in the bucket, so an upload finished on one task
  // encodes on another; the CDN may not serve originals or upload parts.
  ok(real.wired.has('VOD_SOURCE_DRIVER') && cov.settings.VOD_SOURCE_CACHE_DIR?.class === 'default', 'originals are in the bucket on AWS, VOD_SOURCE_CACHE_DIR only scratch (2.1a-2b)');
  {
    const cdn = readFileSync(join(ROOT, 'deploy/terraform/s3_cloudfront.tf'), 'utf8');
    const deny = /sid\s*=\s*"DenyCloudFrontPrivatePrefixes"[\s\S]*?effect\s*=\s*"Deny"[\s\S]*?resources\s*=\s*\[([^\]]*)\]/.exec(cdn);
    ok(!!deny && /\/vod-src\/\*/.test(deny[1]) && /\/upload-staging\/\*/.test(deny[1]), 'the CDN cannot read originals or upload parts from the origin bucket (2.1a-2b)');
  }
  for (const [n, item] of [['CLIPS_DIR', '2.1a-2b-2'], ['VOLT_TRASH_DIR', '2.1a-2c'], ['ORIGIN_DIR', '2.1a-3'], ['FFMPEG_BIN', '2.1a-4']]) ok(cov.settings[n]?.class === 'not-on-aws-yet' && cov.settings[n]?.item === item, `${n} is named as not on AWS yet (${item})`);
  // 2.1b wired radio, captions and the GPU pool; only the Icecast relay waits (2.1c).
  for (const n of ['RADIO_TASK_DEF', 'CAPTIONS_TASK_DEF', 'ECS_GPU_PROVIDER', 'FLEET_GPU_TYPES']) ok(real.wired.has(n) && !cov.settings[n], `${n} is set by Terraform (2.1b)`);
  ok(cov.settings.ICECAST_HOST?.class === 'not-on-aws-yet' && cov.settings.ICECAST_HOST?.item === '2.1c', 'the Icecast relay is named as not on AWS yet (2.1c)');
  const queue = readFileSync(join(ROOT, 'BUILD_QUEUE.md'), 'utf8');
  const items = [...new Set(Object.values(cov.settings as Record<string, any>).map((v) => v.item).filter(Boolean))] as string[];
  for (const item of items) ok(new RegExp(`^\\| ${item.replace('.', '\\.')} \\|`, 'm').test(queue), `queue item ${item} exists for what is not on AWS yet`);

  console.log('the real Terraform without this item\'s settings');
  {
    const root = mkdtempSync(join(tmpdir(), 'tfenv-real-'));
    mkdirSync(join(root, 'volt-app'), { recursive: true });
    symlinkSync(join(ROOT, 'volt-app/src'), join(root, 'volt-app/src'));
    cpSync(join(ROOT, 'deploy/terraform'), join(root, 'deploy/terraform'), { recursive: true, filter: (p) => !p.includes('.terraform') });
    const f = join(root, 'deploy/terraform/ecs_services.tf');
    const before = readFileSync(f, 'utf8');
    writeFileSync(f, before.replace(/local\.app_settings_env, /g, '').replace(/local\.app_settings_secrets, /g, ''));
    const errs = checkTerraformEnv({ root }).errors as string[];
    ok(has(errs, /MEDIA_STORE_DRIVER must be "s3"/), 'the media store left on the Mac default is caught');
    ok(has(errs, /INGEST_DESTINATION must be "s3"/), 'uploads left on the local disk are caught');
    ok(has(errs, /SOCIAL_TOKEN_KEY is read by .* but Terraform does not set it/), 'a setting read and set by nobody is caught');
  }

  console.log('reading the code');
  const stripped = stripComments([
    "// process.env.IN_A_LINE_COMMENT",
    "/* process.env.IN_A_BLOCK */ const u = 'https://example.com'; const v = process.env.AFTER_A_URL;",
    "const t = `${process.env.IN_A_TEMPLATE}`;",
  ].join('\n'));
  ok(!/IN_A_LINE_COMMENT|IN_A_BLOCK/.test(stripped), 'comments are not counted as reads');
  ok(/AFTER_A_URL/.test(stripped) && /'https:\/\/example\.com'/.test(stripped), 'a // inside a string is not a comment');
  ok(/IN_A_TEMPLATE/.test(stripped), 'reads inside a template literal are kept');
  {
    const root = fakeRepo({ code: [
      "process.env.R_ONE; process.env['R_TWO']; env.R_THREE; num('R_FOUR', 1); req('R_FIVE'); bool('R_SIX', false); env('R_SEVEN');",
      "config.env.NOT_A_READ; foo.num('NOT_EITHER');",
    ].join('\n') });
    const names = [...namesReadByApp(root).keys()].sort();
    ok(names.join(',') === 'R_FIVE,R_FOUR,R_ONE,R_SEVEN,R_SIX,R_THREE,R_TWO', `every way the code reads a setting is seen, and nothing else (${names.join(', ')})`);
  }

  console.log('made-up trees, one broken rule each');
  ok(errsOf({}).length === 0, 'a tree with everything set passes');
  ok(has(errsOf({ code: 'process.env.A_SET; process.env.B_UNSET;' }), /B_UNSET is read by volt-app\/src\/config\.ts but Terraform does not set it/), 'a setting nobody sets and nobody explains');
  ok(errsOf({ code: 'process.env.A_SET; process.env.B_UNSET;', coverage: { settings: { B_UNSET: { class: 'default', why: 'fine' } } } }).length === 0, 'the same setting explained passes');
  ok(errsOf({ code: 'process.env.A_SET; process.env.P_ONE; process.env.P_TWO;', coverage: { settings: { 'P_*': { class: 'default', why: 'tuning' } } } }).length === 0, 'a prefix entry covers a family');
  ok(has(errsOf({ coverage: { settings: { 'Q_*': { class: 'default', why: 'x' } } } }), /Q_\* matches nothing/), 'a prefix entry that matches nothing');
  ok(has(errsOf({ coverage: { settings: { A_SET: { class: 'default', why: 'x' } } } }), /A_SET is listed but Terraform sets it/), 'an entry for a setting Terraform sets');
  ok(has(errsOf({ coverage: { settings: { GONE: { class: 'default', why: 'x' } } } }), /GONE is listed but nothing under volt-app\/src reads it/), 'an entry for a setting nothing reads');
  const one = (entry: object, re: RegExp, what: string) =>
    ok(has(errsOf({ code: 'process.env.A_SET; process.env.B_UNSET;', coverage: { settings: { B_UNSET: entry } } }), re), what);
  one({ class: 'maybe', why: 'x' }, /class "maybe"/, 'an unknown class');
  one({ class: 'default', why: ' ' }, /says no why/, 'an entry with no reason');
  one({ class: 'operator', why: 'x' }, /does not say how/, 'an operator setting that does not say how it is set');
  one({ class: 'not-on-aws-yet', why: 'x' }, /names no queue item/, 'a gap with no queue item');
  one({ class: 'default', why: 'a \u2014 b' }, /em dash/, 'an em dash');
  ok(has(errsOf({ refs: ['S_KEY', 'S_MISSING'] }), /reads S_MISSING from secret "app", which has no such key/), 'a secret reference to a key the secret does not have');
  ok(has(errsOf({ values: { MEDIA_STORE_DRIVER: 'local' } }), /MEDIA_STORE_DRIVER must be "s3" on AWS .*Terraform sets "local"/), 'a setting with the wrong value for AWS');
  ok(has(errsOf({ variables: ['region', 'zone'] }), /variable zone has no line in terraform\.tfvars\.example/), 'a variable missing from the example');
  ok(errsOf({ variables: ['region', 'zone'], example: 'region = "x"\n# zone = "a"\n' }).length === 0, 'a commented line in the example counts');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
