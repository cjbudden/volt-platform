// THE MIGRATION SAFETY RULES (build queue D2), shared by check-migrations.mjs,
// check.mjs, release.mjs and the check suite.
//
// Why: a rolling deploy runs the new and the old control plane side by side
// against the same database, and a rollback (scripts/deploy/deploy.mjs) does
// not undo migrations. So a migration must leave a schema the PREVIOUS release
// can still run on. Adding is safe: new tables, nullable columns or columns
// with a default, indexes built concurrently. Taking away is not: drop or
// rename a table or column, change a column's type, or make a column NOT NULL
// without a default, and the old tasks start failing mid-deploy.
//
// Taking away is still possible, in two releases: release N stops using the
// thing, a later release removes it with a declaration in the migration file
//
//     -- volt:contract <table> after vX.Y.Z           (a table)
//     -- volt:contract <table>.<column> after vX.Y.Z  (a column)
//
// naming the release that stopped using it. That release must already be out
// (no later than release/state.json), because only then is it the oldest code
// a rollback can bring back. The check cannot prove the code stopped using the
// thing; the declaration is the author saying so, in review, where it shows.
//
// Migrations that have shipped are listed with their hash in
// release/migrations-baseline.json (release.mjs adds each release's files):
// they are not judged again, but editing or removing one is refused, since
// databases that already ran it would never see the edit.
//
// The analysis is lexical, not a full SQL parser: comments and string bodies
// are taken out, statements split on `;`, DO blocks looked into. Dynamic SQL
// built in a string (EXECUTE format(...)) is not seen.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** A file that must run outside a transaction (CREATE INDEX CONCURRENTLY). */
export const NO_TX_RE = /^[ \t]*--[ \t]*volt:no-transaction\b/m;
const CONTRACT_RE = /--[ \t]*volt:contract[ \t]+(\S+)[ \t]+after[ \t]+v?(\d+\.\d+\.\d+)\b/gi;
const BOOT_SCHEMA = 'volt-app/src/services/bootSchema.ts';
const MIGRATIONS = 'volt-app/migrations';
const BASELINE = 'release/migrations-baseline.json';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const cmpVersion = (a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - b.split('.').map(Number)[i], 0);

/**
 * Split SQL into statements. Each comes back with comments removed, string
 * literals emptied (so a word inside a string is never read as SQL), quoted
 * identifiers unquoted, whitespace collapsed, lower case, and the bodies of
 * dollar-quoted strings kept aside (a DO block's body is looked into).
 */
export function splitStatements(sql) {
  const out = [];
  let cur = '', bodies = [], line = 1, startLine = 1, i = 0;
  const n = sql.length;
  const push = () => {
    const text = cur.replace(/\s+/g, ' ').trim().toLowerCase();
    if (text) out.push({ text, bodies, line: startLine });
    cur = ''; bodies = [];
  };
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (!cur.trim()) startLine = line;
    if (c === '\n') { line++; cur += c; i++; continue; }
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; cur += ' '; continue; }
    if (c === '/' && d === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else { if (sql[i] === '\n') line++; i++; }
      }
      cur += ' '; continue;
    }
    if (c === "'") {
      // E'...' strings take backslash escapes; '' is a quote either way.
      const escapes = /(^|[^a-z0-9_])e$/i.test(cur.slice(-2));
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        if (sql[i] === '\n') line++;
        i++;
      }
      cur += "''"; continue;
    }
    if (c === '"') {
      let id = ''; i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { id += '"'; i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        id += sql[i++];
      }
      cur += id; continue;
    }
    if (c === '$' && !/[a-z0-9_$]/i.test(cur.slice(-1))) {
      const m = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const body = sql.slice(i + tag.length, end < 0 ? n : end);
        for (const ch of body) if (ch === '\n') line++;
        bodies.push(body);
        cur += ` $body${bodies.length - 1}$ `;
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (c === ';') { push(); i++; continue; }
    cur += c; i++;
  }
  push();
  return out;
}

const NAME = '([a-z_][a-z0-9_$]*(?:\\.[a-z_][a-z0-9_$]*)?)';
const norm = (name) => name.replace(/^public\./, '');

/** Split ALTER TABLE actions on commas outside parentheses. */
function actions(s) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * What one statement does to the schema. Returns { creates: [tables],
 * renamesNew: [[from,to]], findings: [{ kind, target, contractable, message }] }.
 * `isNew(table)` says whether a table is created by a migration that has not
 * shipped yet: nothing running uses it, so anything goes on it.
 */
export function analyseStatement(text, isNew) {
  const res = { creates: [], renamesNew: [], findings: [] };
  // Inside a DO block a statement can start with PL/pgSQL (IF ... THEN): read
  // from the first schema keyword on.
  const k = text.search(/\b(create|drop|alter)\s+(unique\s+|unlogged\s+|temp\s+|temporary\s+|materialized\s+)?(table|index|view)\b/);
  if (k < 0) return res;
  const s = text.slice(k);
  let m;
  const find = (kind, target, contractable, message) => res.findings.push({ kind, target, contractable, message });

  if ((m = new RegExp(`^create (?:unlogged |temp |temporary )?table (?:if not exists )?${NAME}`).exec(s))) {
    res.creates.push(norm(m[1]));
    return res;
  }
  if ((m = /^drop (table|view|materialized view) (?:if exists )?(.+?)(?: cascade| restrict)?$/.exec(s))) {
    for (const raw of m[2].split(',')) {
      const t = norm(raw.trim());
      if (m[1] === 'table' && isNew(t)) continue;
      find(`drop ${m[1]}`, t, true, `drops ${m[1]} ${t}`);
    }
    return res;
  }
  if ((m = new RegExp(`^create (unique )?index (concurrently )?(?:if not exists )?(?:${NAME} )?on (?:only )?${NAME}`).exec(s))) {
    const table = norm(m[4]);
    if (m[2]) find('concurrent index', table, false, null);   // fine; the file must be no-transaction (checked by the caller)
    else if (!isNew(table)) {
      find('blocking index', table, false,
        `builds an index on ${table} without CONCURRENTLY, which blocks writes to the table while it builds. ` +
        `Use CREATE INDEX CONCURRENTLY in a migration of its own marked "-- volt:no-transaction"`);
    }
    return res;
  }
  if ((m = new RegExp(`^alter table (?:if exists )?(?:only )?${NAME} (.*)$`).exec(s))) {
    const table = norm(m[1]);
    const rest = m[2].replace(/\s*\$body\d+\$\s*/g, ' ').trim();
    let r;
    if ((r = new RegExp(`^rename to ${NAME}`).exec(rest))) {
      if (isNew(table)) res.renamesNew.push([table, norm(r[1])]);
      else find('rename table', table, true, `renames table ${table} to ${norm(r[1])}`);
      return res;
    }
    if (/^rename constraint /.test(rest)) return res;
    if ((r = /^rename (?:column )?([a-z_][a-z0-9_$]*) to ([a-z_][a-z0-9_$]*)/.exec(rest))) {
      if (!isNew(table)) find('rename column', `${table}.${r[1]}`, true, `renames column ${table}.${r[1]} to ${r[2]}`);
      return res;
    }
    if (/^set schema /.test(rest)) {
      if (!isNew(table)) find('rename table', table, true, `moves table ${table} to another schema`);
      return res;
    }
    if (isNew(table)) return res;
    for (const a of actions(rest)) {
      if ((r = /^drop (?:column )?(?:if exists )?([a-z_][a-z0-9_$]*)/.exec(a)) && !/^drop (constraint|not null|default|identity|expression)\b/.test(a) && r[1] !== 'constraint') {
        find('drop column', `${table}.${r[1]}`, true, `drops column ${table}.${r[1]}`);
      } else if ((r = /^alter (?:column )?([a-z_][a-z0-9_$]*) (?:set data )?type /.exec(a))) {
        find('change type', `${table}.${r[1]}`, true, `changes the type of ${table}.${r[1]}`);
      } else if ((r = /^alter (?:column )?([a-z_][a-z0-9_$]*) set not null/.exec(a))) {
        find('set not null', `${table}.${r[1]}`, true, `makes ${table}.${r[1]} NOT NULL (the previous release may still insert rows without it)`);
      } else if ((r = /^add (?:column )?(?:if not exists )?([a-z_][a-z0-9_$]*) (.*)$/.exec(a))
        && !['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude'].includes(r[1])) {
        const def = r[2];
        const filled = /\bdefault\b/.test(def) || /\b(small|big)?serial\b/.test(def) || /\bgenerated\b/.test(def);
        if (/\bnot null\b/.test(def) && !filled) {
          find('not null without default', `${table}.${r[1]}`, true,
            `adds ${table}.${r[1]} as NOT NULL with no default (the previous release inserts rows without it)`);
        }
      }
    }
  }
  return res;
}

/** Contract declarations in a file: target -> version. */
export function contracts(sql) {
  const out = new Map();
  for (const m of sql.matchAll(CONTRACT_RE)) out.set(norm(m[1].toLowerCase()), m[2]);
  return out;
}

/**
 * Judge one unshipped migration. `newTables` is the set of tables created by
 * unshipped migrations before this one; it is added to as this file creates
 * more. Returns problems as { line, message }.
 */
export function checkMigration(sql, { newTables, released }) {
  const problems = [];
  const declared = contracts(sql);
  const used = new Set();
  const noTx = NO_TX_RE.test(sql);
  const isNew = (t) => newTables.has(t);

  const visit = (stmts, inDo) => {
    for (const st of stmts) {
      if (noTx && !inDo && !/^(create (unique )?index concurrently|drop index concurrently)\b/.test(st.text)) {
        problems.push({ line: st.line, message: 'a "-- volt:no-transaction" migration may only hold CREATE INDEX CONCURRENTLY and DROP INDEX CONCURRENTLY statements (each runs on its own, so anything else could half-apply)' });
      }
      if (/^do\b/.test(st.text)) {
        for (const b of st.bodies) visit(splitStatements(b).map((x) => ({ ...x, line: st.line + x.line - 1 })), true);
        continue;
      }
      const r = analyseStatement(st.text, isNew);
      for (const t of r.creates) newTables.add(t);
      for (const [, to] of r.renamesNew) newTables.add(to);
      const concurrent = r.findings.some((f) => f.kind === 'concurrent index') || /^drop index concurrently\b/.test(st.text);
      if (!noTx && concurrent) {
        problems.push({ line: st.line, message: 'CONCURRENTLY cannot run inside the transaction a migration normally gets: put it in a migration of its own whose first line is "-- volt:no-transaction"' });
      }
      for (const f of r.findings) {
        if (!f.message) continue;
        if (!f.contractable) { problems.push({ line: st.line, message: f.message }); continue; }
        const v = declared.get(f.target);
        if (!v) {
          problems.push({ line: st.line, message: `${f.message}. The previous release still runs during a rolling deploy and after a rollback. Stop using it in one release, remove it in a later one with "-- volt:contract ${f.target} after v<that release>"` });
          continue;
        }
        used.add(f.target);
        if (released && cmpVersion(v, released) > 0) {
          problems.push({ line: st.line, message: `${f.message}: declared after v${v}, which is not out yet (the last release is v${released}). The release that stopped using it must ship first` });
        }
      }
    }
  };
  visit(splitStatements(sql), false);
  for (const t of declared.keys()) {
    if (!used.has(t)) problems.push({ line: 1, message: `declares "-- volt:contract ${t}" but no statement in the file drops, renames or narrows ${t}` });
  }
  return problems;
}

/** The SQL each `query(\`...\`)` in bootSchema.ts runs (no interpolations). */
export function bootStatements(src) {
  const out = [];
  const re = /query\(\s*`([^`]*)`/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    for (const st of splitStatements(m[1])) out.push({ ...st, line, raw: m[1].trim() });
  }
  return out;
}

function tracked(root, rel) {
  try {
    const files = execFileSync('git', ['ls-files', '--', rel], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    return new Set(files.map((f) => f.split('/').pop()));
  } catch { return null; }   // not a git checkout: every file on disk counts
}

export function loadBaseline(root) {
  const p = join(root, BASELINE);
  if (!existsSync(p)) return { migrations: {}, bootSchema: [] };
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Check the repo at `root`. Options: all (ignore the baseline and judge every
 * file), trackedOnly (only files git knows, for the pre-commit hook).
 * Returns { checked, baselined, problems: [{ file, line, message }] }.
 */
export function checkRepo(root, { all = false, trackedOnly = false } = {}) {
  const baseline = all ? { migrations: {}, bootSchema: [] } : loadBaseline(root);
  const statePath = join(root, 'release', 'state.json');
  const released = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).version : null;
  const dir = join(root, MIGRATIONS);
  const known = trackedOnly ? tracked(root, MIGRATIONS) : null;
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => FILE_RE.test(f)).sort() : [];
  const problems = [];
  const newTables = new Set();
  let checked = 0, baselined = 0;

  for (const [f, hash] of Object.entries(baseline.migrations ?? {})) {
    if (!names.includes(f)) problems.push({ file: `${MIGRATIONS}/${f}`, line: 1, message: 'a shipped migration was removed; databases that ran it keep its changes. Put it back' });
    else if (sha256(readFileSync(join(dir, f), 'utf8')) !== hash) {
      problems.push({ file: `${MIGRATIONS}/${f}`, line: 1, message: 'a shipped migration was edited; databases that already ran it will never see the change. Put it back and add a new migration' });
    }
  }
  for (const f of names) {
    if (baseline.migrations?.[f]) { baselined++; continue; }
    if (known && !known.has(f)) continue;
    checked++;
    const sql = readFileSync(join(dir, f), 'utf8');
    // --all judges each file as if it were a release of its own: a table made
    // by an earlier file counts as existing.
    const tables = all ? new Set() : newTables;
    for (const p of checkMigration(sql, { newTables: tables, released })) problems.push({ file: `${MIGRATIONS}/${f}`, ...p });
  }

  const bootPath = join(root, BOOT_SCHEMA);
  if (existsSync(bootPath)) {
    const known = new Set(baseline.bootSchema ?? []);
    for (const st of bootStatements(readFileSync(bootPath, 'utf8'))) {
      if (known.has(sha256(st.raw))) continue;
      if (/^do\b/.test(st.text)) continue;
      const r = analyseStatement(st.text, (t) => newTables.has(t));
      for (const t of r.creates) newTables.add(t);
      for (const f of r.findings) {
        if (!f.message) continue;
        problems.push({ file: BOOT_SCHEMA, line: st.line, message: `${f.message}. The boot top-ups run on every task, old and new, so they may only add; put a removal in a migration` });
      }
    }
  }
  return { checked, baselined, released, problems };
}

/** Add every current (git-tracked) migration and boot statement to the baseline. */
export function updateBaseline(root, { release } = {}) {
  const b = loadBaseline(root);
  const dir = join(root, MIGRATIONS);
  const known = tracked(root, MIGRATIONS);
  const added = [];
  b.migrations = b.migrations ?? {};
  for (const f of readdirSync(dir).filter((x) => FILE_RE.test(x)).sort()) {
    if (known && !known.has(f)) continue;   // another session's file, not part of this release
    const h = sha256(readFileSync(join(dir, f), 'utf8'));
    if (b.migrations[f] && b.migrations[f] !== h) throw new Error(`${f} differs from its baselined copy; it was edited after shipping`);
    if (!b.migrations[f]) { b.migrations[f] = h; added.push(f); }
  }
  const bootPath = join(root, BOOT_SCHEMA);
  const boot = new Set(b.bootSchema ?? []);
  if (existsSync(bootPath)) for (const st of bootStatements(readFileSync(bootPath, 'utf8'))) boot.add(sha256(st.raw));
  const out = {
    _comment: 'Migrations and boot schema statements that have shipped (build queue D2). check-migrations.mjs does not judge them again but refuses an edit or removal. release.mjs adds each release\'s files; nothing else should change this file.',
    release: release ?? b.release ?? null,
    migrations: Object.fromEntries(Object.entries(b.migrations).sort(([a], [c]) => a.localeCompare(c))),
    bootSchema: [...boot].sort(),
  };
  writeFileSync(join(root, BASELINE), JSON.stringify(out, null, 2) + '\n');
  return added;
}
