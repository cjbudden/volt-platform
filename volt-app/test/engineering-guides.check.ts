/**
 * The engineering guides match the tree (build queue 1.14-G7).
 *
 * docs/engineering/ tells engineers which file does what and which command to
 * run. scripts/docs/check-engineering.mjs reads every guide and fails on a
 * path, script, npm script or check.js filter that is not there, a broken
 * link, a guide missing from the index, anything that looks like a secret and
 * an em dash. This runs it on the real tree (no problems allowed) and on small
 * made-up trees that break one rule each, so a checker that stopped noticing
 * would fail here instead of letting the guides go stale quietly.
 * No database, no API.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

const ROOT = join(__dirname, '../..');
const TOPICS = ['architecture.md', 'running-on-the-mac.md', 'check-suites.md', 'build-queue.md', 'releasing.md', 'docs-site.md', 'deploying-to-aws.md'];

/** A throwaway repository: a volt-app with one suite and one npm script, and guides. */
function fakeRepo(guides: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'eng-'));
  mkdirSync(join(root, 'volt-app/test'), { recursive: true });
  mkdirSync(join(root, 'volt-app/scripts'), { recursive: true });
  mkdirSync(join(root, 'docs/engineering'), { recursive: true });
  writeFileSync(join(root, 'volt-app/package.json'), JSON.stringify({ scripts: { 'docs:routes': 'x' } }));
  writeFileSync(join(root, 'volt-app/scripts/check.js'), '');
  writeFileSync(join(root, 'volt-app/test/clip-extract.check.ts'), '');
  writeFileSync(join(root, 'run-on-mac.sh'), '');
  const index = guides['README.md'] ?? `# Index\n\n${Object.keys(guides).filter((g) => g !== 'README.md').map((g) => `- [${g}](${g})`).join('\n')}\n`;
  writeFileSync(join(root, 'docs/engineering/README.md'), index);
  for (const [name, body] of Object.entries(guides)) if (name !== 'README.md') writeFileSync(join(root, 'docs/engineering', name), body);
  return root;
}
const fence = '```';
const good = [
  '# Good', '', 'Start with `run-on-mac.sh` and read [the index](README.md).', '',
  `${fence}bash`, 'bash run-on-mac.sh', 'cd volt-app', 'npm run docs:routes', 'node scripts/check.js clip', 'KEEP_DB=1 node scripts/check.js extract', fence, '',
].join('\n');

(async () => {
  const mod: any = await import(join(ROOT, 'scripts/docs/check-engineering.mjs'));
  const { checkEngineering } = mod;
  const errsOf = (guides: Record<string, string>) => checkEngineering({ root: fakeRepo(guides) }).errors as string[];

  console.log('the real tree');
  const real = checkEngineering({ root: ROOT });
  ok(real.errors.length === 0, `no problems in docs/engineering${real.errors.length ? ': ' + real.errors.join(' | ') : ''}`);
  for (const t of TOPICS) ok(existsSync(join(ROOT, 'docs/engineering', t)), `the ${t.replace('.md', '')} guide is there`);
  ok(real.checked.guides === TOPICS.length + 1, `${real.checked.guides} guides read (seven topics and the index)`);
  ok(real.checked.paths >= 150, `${real.checked.paths} paths checked against the tree`);
  ok(real.checked.commands >= 50, `${real.checked.commands} commands checked`);
  ok(real.seen.some((s: string) => s.startsWith('volt-app $ node scripts/check.js')), 'a check.js command is checked from volt-app, following its cd');

  console.log('folders made at run time');
  const clean = require('node:fs').readFileSync(join(ROOT, 'volt-clean.sh'), 'utf8');
  for (const r of mod.RUNTIME as string[]) ok(clean.includes(r), `${r} is accepted without being in the tree because Volt makes it when it runs (volt-clean.sh names it)`);
  ok(errsOf({ 'g.md': 'Logs: `volt-app/origin/_control-plane.log`.\n' }).length === 0, 'a log inside the origin folder is accepted in a fresh tree');
  ok(errsOf({ 'g.md': 'Logs: `volt-app/originals/x.log`.\n' }).length === 1, 'a path that only starts with the same letters is not');

  console.log('a guide that follows the rules');
  ok(errsOf({ 'good.md': good }).length === 0, 'passes');

  console.log('each rule, broken once');
  const one = (body: string, re: RegExp, msg: string) => {
    const e = errsOf({ 'g.md': body });
    ok(e.length >= 1 && e.some((x) => re.test(x)), `${msg}${e.length ? '' : ' (nothing reported)'}`);
  };
  one('Read `volt-app/src/gone.ts`.\n', /gone\.ts.*not in the repository/, 'a path in prose that is not in the tree');
  one(`${fence}bash\ncd volt-app\nnpx tsx scripts/missing.ts\n${fence}\n`, /scripts\/missing\.ts: not found from volt-app/, 'a script run after a cd that is not in that folder');
  one(`${fence}bash\nnpx tsx scripts/check.js\n${fence}\n`, /scripts\/check\.js: not found from the repository root/, 'a block starts at the root, so a script under volt-app needs its cd');
  one(`${fence}bash\ncd volt-app\nnpm run docs:nothing\n${fence}\n`, /npm run docs:nothing: not a script/, 'an npm script the package.json does not have');
  one(`${fence}bash\ncd volt-app\nnode scripts/check.js nosuchsuite\n${fence}\n`, /nosuchsuite: no suite matches/, 'a check.js filter that matches no suite');
  one(`${fence}bash\ncd volt-gone\n${fence}\n`, /cd volt-gone: no such folder/, 'a cd into a folder that is not there');
  one('See [the plan](missing-plan.md).\n', /link missing-plan\.md: not found/, 'a broken relative link');
  // Built at run time so no scanner mistakes this file for a leak.
  one(`A key: ${'AKIA'}${'ABCDEFGHIJKLMNOP'}\n`, /AWS access key/, 'an AWS access key id');
  one('Sign in with volt1234.\n', /demo account password/, 'the demo password');
  one('export JWT_ACCESS_SECRET=dev-access-secret\n', /local development secret/, 'a local development secret');
  one(`Use ${'sk_'}live_abc123def456 for it.\n`, /API key/, 'a real-looking API key');
  one('DATABASE_URL=postgres://admin:hunter22@db.example.com/volt\n', /credentials in a URL/, 'credentials in a URL');
  one('One thing \u2014 then another.\n', /em dash/, 'an em dash');
  one(`${fence}bash\nls\n`, /never closed/, 'a code block that is never closed');

  console.log('allowed on purpose');
  ok(errsOf({ 'g.md': `${fence}bash\nexport DATABASE_URL=postgres://volt:volt@localhost:5432/volt\n${fence}\nKeys look like \`pk_live_...\`. Routes like \`/api/live-streams\` and results like \`33/33\` are not paths.\n` }).length === 0,
    'the local throwaway database URL, placeholder keys, API routes and numbers');
  ok(errsOf({ 'g.md': `${fence}ts\nimport x from './nowhere';\n${fence}\n` }).length === 0, 'code in other languages is an example, not a command');

  console.log('the index');
  const e = errsOf({ 'README.md': '# Index\n\nNothing linked.\n', 'orphan.md': '# Orphan\n' });
  ok(e.some((x) => /README\.md does not link to orphan\.md/.test(x)), 'a guide the index does not link to');
  const noIndex = mkdtempSync(join(tmpdir(), 'eng-'));
  mkdirSync(join(noIndex, 'docs/engineering'), { recursive: true });
  writeFileSync(join(noIndex, 'docs/engineering/a.md'), '# A\n');
  ok(checkEngineering({ root: noIndex }).errors.some((x: string) => /no README\.md index/.test(x)), 'a guides folder with no index');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
