// Shared by change.mjs, check.mjs and release.mjs.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UNRELEASED = join(ROOT, 'changes', 'unreleased');
export const SCOPES = ['core', 'saas', 'internal'];
export const TYPES = ['added', 'improved', 'fixed', 'changed', 'removed', 'security'];
export const TYPE_HEADING = { added: 'New', improved: 'Improved', fixed: 'Fixed', changed: 'Changed', removed: 'Removed', security: 'Security' };

export function git(...args) {
  // A large working tree (many uncommitted files) overflows the 1 MB default.
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
}

/** Glob to RegExp: ** crosses folders, * does not. */
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const rules = JSON.parse(readFileSync(join(ROOT, 'release', 'scopes.json'), 'utf8')).rules
  .flatMap((r) => r.globs.map((g) => ({ scope: r.scope, re: globRe(g) })));
export function scopeOf(path) {
  return rules.find((r) => r.re.test(path))?.scope ?? 'internal';
}

/** A change note: YAML-ish front matter (scope, type, area) and a short body. */
export function parseNote(file) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = Object.fromEntries(m[1].split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  const body = m[2].trim();
  const errs = [];
  if (!SCOPES.includes(meta.scope)) errs.push(`scope must be one of ${SCOPES.join(', ')}`);
  if (!TYPES.includes(meta.type)) errs.push(`type must be one of ${TYPES.join(', ')}`);
  if (meta.scope === 'core' && !meta.area) errs.push('a core note needs an area (e.g. Channels, EPG, Player)');
  if (!body) errs.push('the note has no text');
  if (/TODO|lorem/i.test(body)) errs.push('the note still has placeholder text');
  if (errs.length) throw new Error(`${file}: ${errs.join('; ')}`);
  return { file, scope: meta.scope, type: meta.type, area: meta.area || '', body };
}

export function unreleasedNotes() {
  if (!existsSync(UNRELEASED)) return [];
  return readdirSync(UNRELEASED).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().map((f) => parseNote(join(UNRELEASED, f)));
}

export function state() {
  return JSON.parse(readFileSync(join(ROOT, 'release', 'state.json'), 'utf8'));
}

/** Paths are reported relative to the volt/ folder, whatever the git root is. */
export function relToRoot(paths) {
  const prefix = git('rev-parse', '--show-prefix');
  return paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
}
