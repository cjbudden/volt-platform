#!/usr/bin/env node
/**
 * CHECK THE ENGINEERING GUIDES (build queue 1.14-G7).
 *
 * The guides in docs/engineering/ are full of file names and commands, and
 * those go stale the day someone renames a script. This reads every guide and
 * fails on anything that no longer matches the tree, so a stale guide fails a
 * check instead of misleading the next person who follows it:
 *
 *   - a path in inline code that is not in the repository
 *   - in a bash code block: a script run with node, tsx, bash, sh or python3
 *     that is not there, an `npm run` script the folder's package.json does not
 *     have, a `node scripts/check.js` filter that matches no suite, or any other
 *     path-looking argument that is missing. Each block starts at the
 *     repository root and follows its own `cd`, the way a person pasting it
 *     would.
 *   - a relative markdown link that goes nowhere
 *   - a guide the index (README.md) does not link to
 *   - anything that looks like a secret (keys, tokens, passwords, the local
 *     development secrets in run-on-mac.sh)
 *   - an em dash (the house style for anything written for Christian)
 *
 * Exported for volt-app/test/engineering-guides.check.ts, which also feeds it
 * small broken trees so a checker that stopped noticing would fail there.
 *
 *   node scripts/docs/check-engineering.mjs            check docs/engineering
 *   node scripts/docs/check-engineering.mjs --list     also list every path and command checked
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// Folders that are made when Volt runs, so a fresh checkout does not have
// them: the control plane's origin (ORIGIN_DIR default, made on start, holding
// segments and the logs run-on-mac.sh writes) and the standalone encoder's
// scratch output. volt-clean.sh names both; the suite holds it to that.
export const RUNTIME = ['volt-app/origin', 'volt-encoder/_local_out'];

const EXT = /\.(md|mdx|ts|tsx|js|mjs|cjs|sh|json|tf|py|sql|css|yml|yaml|html|txt|example)$/;

// Things that look like secrets. The local Postgres URL with volt:volt is the
// throwaway database run-on-mac.sh creates on the developer's own machine, so
// it is allowed; any other user:password in a URL is not.
const SECRET_RULES = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{6,}/, 'an API key (use pk_live_... with the dots)'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT'],
  [/dev-(access|refresh)-secret|INGEST_TOKEN=dev-/, 'a local development secret from run-on-mac.sh'],
  [/volt1234/, 'the demo account password (run-on-mac.sh prints it)'],
  [/\b(password|passwd|secret|token)\s*[:=]\s*["']?[A-Za-z0-9!@#%^&*_\-]{4,}/i, 'a password or token value'],
  [/\b[a-z][a-z0-9+.-]*:\/\/(?!volt:volt@localhost)[^\s/:@]+:[^\s/@]+@/i, 'credentials in a URL'],
];

/** Is this inline-code token meant as a path in the repository? */
function looksLikePath(t) {
  if (!t || /\s/.test(t)) return false;
  if (/[<>*$`{}|]/.test(t) || t.includes('://') || t.includes(':')) return false;
  if (/^[\d/.]+$/.test(t)) return false;                       // 33/33, 1.14
  if (t.startsWith('.') && !t.startsWith('./') && !t.startsWith('../')) return false; // .check.sh
  if (t.startsWith('/') || t.startsWith('-') || t.startsWith('@') || t.startsWith('~') || t.startsWith('.git')) return false;
  if (t.includes('/')) return true;
  return EXT.test(t) && /^[\w.-]+$/.test(t) && /[A-Za-z]/.test(t.replace(EXT, ''));
}

/** The words of a shell command, with simple quotes removed. */
function words(cmd) {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
}

/** Split a line into commands on && ; | (not inside quotes, good enough for guides). */
function commandsOf(line) {
  return line.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean);
}

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

export function checkEngineering({ root, dir = join(root, 'docs/engineering') }) {
  const errors = [];
  const checked = { paths: 0, commands: 0, links: 0, guides: 0 };
  const seen = [];
  if (!existsSync(dir)) return { errors: [`no guides folder at ${relative(root, dir) || dir}`], checked, seen };
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  if (!files.includes('README.md')) errors.push('docs/engineering has no README.md index');

  const exists = (base, p) => {
    const abs = resolve(base, p);
    if (existsSync(abs)) return true;
    const rel = relative(root, abs);
    return RUNTIME.some((r) => rel === r || rel.startsWith(r + '/'));
  };
  const suites = existsSync(join(root, 'volt-app/test'))
    ? readdirSync(join(root, 'volt-app/test')).filter((f) => /\.check\.(ts|sh)$/.test(f)) : [];

  for (const f of files) {
    checked.guides++;
    const where = (n) => `${f}:${n}`;
    const text = readFileSync(join(dir, f), 'utf8');
    const lines = text.split('\n');

    // Secrets and em dashes, anywhere in the file.
    lines.forEach((l, i) => {
      for (const [re, what] of SECRET_RULES) if (re.test(l)) errors.push(`${where(i + 1)}: looks like ${what}`);
      if (l.includes('\u2014')) errors.push(`${where(i + 1)}: em dash`);
    });

    let inBlock = false, lang = '', cwd = root;
    lines.forEach((raw, i) => {
      const n = i + 1;
      const fence = raw.match(/^\s*```\s*([\w-]*)/);
      if (fence) {
        if (!inBlock) { inBlock = true; lang = fence[1].toLowerCase(); cwd = root; } else { inBlock = false; }
        return;
      }
      if (inBlock) {
        if (!['bash', 'sh', 'shell', 'zsh'].includes(lang)) return;
        // Comments are prose. A line marked (Mac) or (AWS) is still checked for
        // its files; only running it needs the Mac or the cloud.
        const line = raw.replace(/(^|\s)#.*$/, '').trim();
        if (!line) return;
        for (const cmd of commandsOf(line)) {
          const w = words(cmd).filter((x) => !/^[A-Z_][A-Z0-9_]*=/.test(x)); // drop VAR=value prefixes
          if (!w.length) continue;
          checked.commands++;
          seen.push(`${relative(root, cwd) || '.'} $ ${cmd}`);
          const [c0, c1, c2] = w;
          if (c0 === 'cd') {
            const to = c1 || '';
            if (/[$<~]/.test(to)) continue;
            const next = resolve(cwd, to);
            if (!existsSync(next) || !statSync(next).isDirectory()) errors.push(`${where(n)}: cd ${to}: no such folder`);
            else cwd = next;
            continue;
          }
          if (c0 === 'npm' && c1 === 'run' && c2) {
            const pkg = readJson(join(cwd, 'package.json'));
            if (!pkg) errors.push(`${where(n)}: npm run ${c2}: no package.json in ${relative(root, cwd) || '.'}`);
            else if (!pkg.scripts || !(c2 in pkg.scripts)) errors.push(`${where(n)}: npm run ${c2}: not a script in ${relative(root, join(cwd, 'package.json'))}`);
            continue;
          }
          // node scripts/check.js <filters>: each filter must match a suite.
          const isCheck = (c0 === 'node' && c1 === 'scripts/check.js' && relative(root, cwd) === 'volt-app')
            || (c0 === 'node' && c1 === 'volt-app/scripts/check.js');
          if (isCheck) {
            for (const q of w.slice(2)) {
              if (q.startsWith('-') || /[<$]/.test(q)) continue;
              if (!suites.some((s) => s.includes(q))) errors.push(`${where(n)}: node scripts/check.js ${q}: no suite matches`);
            }
          }
          // Every path-looking word, the script being run included.
          const runners = new Set(['node', 'bash', 'sh', 'python3', 'tsx', 'npx']);
          w.forEach((x, k) => {
            if (k === 0 && runners.has(x)) return;
            if (x === 'tsx' && w[k - 1] === 'npx') return;
            if (!looksLikePath(x)) return;
            // An argument after a command we do not know may be a name, not a
            // file (git tags, docker images). Only check those with an extension
            // or a slash and only when the command runs a file or lists one.
            const runsFile = runners.has(c0) || /^(\.\/|scripts\/)/.test(c0) || ['cat', 'ls', 'cp', 'less', 'head', 'tail', 'psql', 'source', '.'].includes(c0) || k === 0;
            if (!runsFile && !EXT.test(x)) return;
            if (['docker', 'git', 'terraform', 'aws', 'curl', 'brew', 'open'].includes(c0)) return;
            checked.paths++;
            if (!exists(cwd, x)) errors.push(`${where(n)}: ${x}: not found from ${relative(root, cwd) || 'the repository root'}`);
          });
        }
        return;
      }

      // Prose: inline code paths (from the repository root) and links.
      for (const m of raw.matchAll(/`([^`]+)`/g)) {
        const t = m[1].trim().replace(/[.,;]$/, '');
        if (!looksLikePath(t)) continue;
        checked.paths++;
        seen.push(`path ${t}`);
        if (!exists(root, t)) errors.push(`${where(n)}: \`${t}\`: not in the repository (paths in code are from the repository root)`);
      }
      for (const m of raw.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
        checked.links++;
        const p = normalize(join(dirname(join(dir, f)), target.split('#')[0]));
        if (!existsSync(p)) errors.push(`${where(n)}: link ${target}: not found`);
      }
    });
    if (inBlock) errors.push(`${f}: a code block is never closed`);
  }

  // The index links to every guide.
  if (files.includes('README.md')) {
    const idx = readFileSync(join(dir, 'README.md'), 'utf8');
    for (const f of files) if (f !== 'README.md' && !idx.includes(`](${f})`)) errors.push(`README.md does not link to ${f}`);
  }
  return { errors, checked, seen };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const r = checkEngineering({ root });
  if (process.argv.includes('--list')) for (const s of r.seen) console.log(`  ${s}`);
  console.log(`engineering guides: ${r.checked.guides} guides, ${r.checked.paths} paths, ${r.checked.commands} commands, ${r.checked.links} links checked`);
  for (const e of r.errors) console.log(`  FAIL ${e}`);
  console.log(r.errors.length ? `${r.errors.length} problem(s)` : 'all match the tree');
  process.exit(r.errors.length ? 1 : 0);
}
