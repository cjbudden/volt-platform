/**
 * The migration safety check (build queue D2): scripts/release/migrations.mjs,
 * check-migrations.mjs, and the runner's no-transaction files.
 *
 * Part 1 judges sample migrations, passing and failing, one rule at a time.
 * Part 2 runs the command against a scratch checkout: a baseline, a bad new
 * file, an edited and a removed shipped file, a two-release removal, a new
 * boot top-up. Part 3 runs it over the real repo (every shipped migration
 * baselined; --all reports what the rule would have said about each).
 * Part 4 (needs DATABASE_URL, so it runs under scripts/check.js) applies a
 * `-- volt:no-transaction` file with CREATE INDEX CONCURRENTLY through the
 * real runner, and shows a failing one is not recorded and the same index
 * without the marker is refused by Postgres.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}

const ROOT = join(__dirname, '../..');
const APP = join(__dirname, '..');

async function main() {
  const m: any = await import(join(ROOT, 'scripts/release/migrations.mjs'));
  const judge = (sql: string, opts: { released?: string; newTables?: string[] } = {}) =>
    m.checkMigration(sql, { newTables: new Set(opts.newTables ?? []), released: opts.released ?? '0.43.0' }) as { line: number; message: string }[];
  const passes = (sql: string, msg: string, opts?: any) => {
    const p = judge(sql, opts);
    ok(p.length === 0, `${msg}${p.length ? ` (got: ${p.map((x) => x.message.slice(0, 80)).join(' | ')})` : ''}`);
  };
  const refuses = (sql: string, re: RegExp, msg: string, opts?: any) => {
    const p = judge(sql, opts);
    ok(p.length > 0 && p.some((x) => re.test(x.message)), `${msg}${p.length ? ` (${p[0].message.slice(0, 70)})` : ' (passed)'}`);
  };

  console.log('\npart 1: additive migrations pass');
  passes(`CREATE TABLE IF NOT EXISTS d2_things (id UUID PRIMARY KEY, name TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS d2_things_name ON d2_things(name);
          ALTER TABLE d2_things ADD COLUMN extra TEXT NOT NULL;
          ALTER TABLE d2_things DROP COLUMN extra;`, 'a new table: indexed, given NOT NULL columns, even dropped from (nothing running uses it)');
  passes(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS d2_note TEXT;`, 'a nullable column');
  passes(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS d2_on BOOLEAN NOT NULL DEFAULT false;`, 'NOT NULL with a default');
  passes(`ALTER TABLE channels ADD COLUMN d2_seq BIGSERIAL NOT NULL, ADD COLUMN d2_gen INT GENERATED ALWAYS AS (1) STORED NOT NULL;`, 'serial and generated columns count as filled');
  passes(`ALTER TABLE channels ALTER COLUMN name DROP NOT NULL; ALTER TABLE channels DROP CONSTRAINT IF EXISTS c1;
          ALTER TABLE channels ALTER COLUMN name SET DEFAULT 'x'; ALTER TABLE channels ADD CONSTRAINT c2 CHECK (true) NOT VALID;`, 'loosening: DROP NOT NULL, dropping a constraint, a default');
  passes(`-- the old way was DROP TABLE channels; do not do that
          /* ALTER TABLE channels DROP COLUMN name; */
          INSERT INTO notes(body) VALUES ('ALTER TABLE channels DROP COLUMN name;');
          UPDATE channels SET name = E'it''s \\' DROP TABLE x' WHERE false;`, 'words in comments and strings are not read as SQL');
  passes(`-- volt:no-transaction
          DROP INDEX CONCURRENTLY IF EXISTS channels_d2_idx;
          CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_d2_idx ON channels(group_id);`, 'CREATE INDEX CONCURRENTLY in a no-transaction file');
  passes(`-- volt:contract channels.legacy after v0.42.0
          ALTER TABLE channels DROP COLUMN IF EXISTS legacy;`, 'a column removed with a contract naming a release that is out');
  passes(`-- volt:contract old_things after v0.43.0
          DROP TABLE IF EXISTS public.old_things CASCADE;`, 'a table removed, contract naming the last release, schema-qualified');
  passes(`ALTER TABLE d2_new DROP COLUMN a; ALTER TABLE d2_new RENAME TO d2_newer; ALTER TABLE d2_newer RENAME COLUMN b TO c;`,
    'a table created by an earlier unshipped migration may still change', { newTables: ['d2_new'] });
  passes(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='channels' AND column_name='d2') THEN
              ALTER TABLE channels ADD COLUMN d2 TEXT;
            END IF;
          END $$;`, 'a DO block that adds');
  passes(`CREATE OR REPLACE FUNCTION f() RETURNS void AS $fn$ BEGIN DROP TABLE x; END $fn$ LANGUAGE plpgsql;`,
    'a function body is not run by the migration, so not judged');

  console.log('\npart 1: taking away is refused');
  refuses(`DROP TABLE channels;`, /drops table channels.*volt:contract channels after/, 'DROP TABLE, with the contract line to write');
  refuses(`DROP TABLE IF EXISTS d2_new, channels;`, /drops table channels/, 'DROP TABLE of several: the existing one caught', { newTables: ['d2_new'] });
  refuses(`DROP VIEW vod_library;`, /drops view vod_library/, 'DROP VIEW');
  refuses(`ALTER TABLE channels DROP COLUMN name;`, /drops column channels\.name/, 'DROP COLUMN');
  refuses(`ALTER TABLE channels ADD COLUMN x TEXT, DROP legacy;`, /drops column channels\.legacy/, 'DROP as the second action, COLUMN left out');
  refuses(`ALTER TABLE "Channels" DROP COLUMN "Name";`, /drops column channels\.name/, 'quoted identifiers');
  refuses(`ALTER TABLE channels RENAME COLUMN name TO title;`, /renames column channels\.name/, 'RENAME COLUMN');
  refuses(`ALTER TABLE ONLY channels RENAME name TO title;`, /renames column channels\.name/, 'RENAME without COLUMN');
  refuses(`ALTER TABLE channels RENAME TO streams;`, /renames table channels/, 'RENAME TO');
  refuses(`ALTER TABLE channels ALTER COLUMN watermark_scale TYPE REAL;`, /changes the type of channels\.watermark_scale/, 'ALTER COLUMN TYPE');
  refuses(`ALTER TABLE channels ALTER watermark_scale SET DATA TYPE REAL;`, /changes the type/, 'SET DATA TYPE');
  refuses(`ALTER TABLE channels ADD COLUMN d2_req TEXT NOT NULL;`, /NOT NULL with no default/, 'NOT NULL with no default');
  refuses(`ALTER TABLE channels ALTER COLUMN name SET NOT NULL;`, /makes channels\.name NOT NULL/, 'SET NOT NULL');
  refuses(`CREATE INDEX channels_d2 ON channels(name);`, /without CONCURRENTLY/, 'a blocking index on an existing table');
  refuses(`CREATE UNIQUE INDEX IF NOT EXISTS channels_d2 ON public.channels USING btree (name);`, /without CONCURRENTLY/, 'unique, IF NOT EXISTS, USING');
  refuses(`CREATE INDEX CONCURRENTLY channels_d2 ON channels(name);`, /cannot run inside the transaction/, 'CONCURRENTLY without the no-transaction marker');
  refuses(`-- volt:no-transaction
           CREATE INDEX CONCURRENTLY a ON channels(name);
           ALTER TABLE channels ADD COLUMN x TEXT;`, /may only hold CREATE INDEX CONCURRENTLY/, 'a no-transaction file with anything else in it');
  refuses(`DO $$ BEGIN IF true THEN ALTER TABLE channels DROP COLUMN name; END IF; END $$;`, /drops column channels\.name/, 'inside a DO block');
  refuses(`-- volt:contract channels.name after v0.44.0
           ALTER TABLE channels DROP COLUMN name;`, /not out yet \(the last release is v0\.43\.0\)/, 'a contract naming a release not out yet');
  refuses(`-- volt:contract channels.nmae after v0.40.0
           ALTER TABLE channels DROP COLUMN name;`, /drops column channels\.name/, 'a contract for another column does not cover this one');
  refuses(`-- volt:contract channels.nmae after v0.40.0
           ALTER TABLE channels DROP COLUMN name;`, /declares .*channels\.nmae.* but no statement/, '...and the stray declaration is reported');
  {
    const p = judge(`SELECT 1;\n\nALTER TABLE channels\n  DROP COLUMN name;`);
    ok(p[0]?.line === 3, `the problem points at the statement's line (${p[0]?.line})`);
  }

  console.log('\npart 2: the command on a scratch checkout');
  const tmp = mkdtempSync(join(tmpdir(), 'mig-safety-'));
  mkdirSync(join(tmp, 'volt-app/migrations'), { recursive: true });
  mkdirSync(join(tmp, 'volt-app/src/services'), { recursive: true });
  mkdirSync(join(tmp, 'release'));
  writeFileSync(join(tmp, 'release/state.json'), JSON.stringify({ version: '0.43.0' }));
  const mig = (f: string, sql: string) => writeFileSync(join(tmp, 'volt-app/migrations', f), sql);
  mig('0001_init.sql', 'CREATE TABLE channels (id INT PRIMARY KEY, name TEXT, legacy TEXT);\n');
  mig('0002_old_index.sql', 'CREATE INDEX channels_name ON channels(name);\n');   // shipped before the rule
  writeFileSync(join(tmp, 'volt-app/src/services/bootSchema.ts'), "await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS a TEXT`);\n");
  const cli = (...a: string[]) => {
    const r = spawnSync('node', [join(ROOT, 'scripts/release/check-migrations.mjs'), '--root', tmp, ...a], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  let r = cli('--all');
  ok(r.code === 1 && /0002_old_index\.sql:1 +builds an index on channels/.test(r.out), '--all reports the shipped file the rule would refuse');
  r = cli('--update-baseline', '--release=0.43.0');
  ok(r.code === 0 && /2 migration\(s\) recorded as shipped/.test(r.out), 'baseline written: 2 shipped files');
  const base = JSON.parse(readFileSync(join(tmp, 'release/migrations-baseline.json'), 'utf8'));
  ok(Object.keys(base.migrations).length === 2 && base.bootSchema.length === 1 && base.release === '0.43.0', 'baseline holds both files, their hashes and the boot statement');
  r = cli();
  ok(r.code === 0 && /ok \(0 unshipped migration\(s\) checked, 2 shipped\)/.test(r.out), 'shipped files are not judged again');
  mig('0003_add.sql', 'ALTER TABLE channels ADD COLUMN IF NOT EXISTS d2 TEXT;\n');
  r = cli();
  ok(r.code === 0 && /1 unshipped/.test(r.out), 'a new additive migration passes');
  mig('0004_drop.sql', 'ALTER TABLE channels DROP COLUMN legacy;\n');
  r = cli();
  ok(r.code === 1 && /0004_drop\.sql:1 +drops column channels\.legacy/.test(r.out) && /RELEASING\.md, "Schema"/.test(r.out), 'a new DROP COLUMN fails the command, file and line named');
  mig('0004_drop.sql', '-- volt:contract channels.legacy after v0.43.0\nALTER TABLE channels DROP COLUMN legacy;\n');
  r = cli();
  ok(r.code === 0, 'the same drop with a contract after the last release passes');
  r = cli('--update-baseline', '--release=0.44.0');
  ok(r.code === 0 && /2 migration\(s\) recorded/.test(r.out), 'cutting the next release records 0003 and 0004 as shipped');
  mig('0002_old_index.sql', 'CREATE INDEX channels_name ON channels(name, id);\n');
  r = cli();
  ok(r.code === 1 && /0002_old_index\.sql.*was edited/.test(r.out), 'editing a shipped migration is refused');
  r = cli('--update-baseline');
  ok(r.code === 1 && /edited after shipping/.test(r.out), '...and the baseline will not take the edit');
  mig('0002_old_index.sql', 'CREATE INDEX channels_name ON channels(name);\n');
  rmSync(join(tmp, 'volt-app/migrations/0003_add.sql'));
  r = cli();
  ok(r.code === 1 && /0003_add\.sql.*was removed/.test(r.out), 'removing a shipped migration is refused');
  mig('0003_add.sql', 'ALTER TABLE channels ADD COLUMN IF NOT EXISTS d2 TEXT;\n');
  writeFileSync(join(tmp, 'volt-app/src/services/bootSchema.ts'),
    "await query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS a TEXT`);\nawait query(`ALTER TABLE channels DROP COLUMN IF EXISTS a`);\n");
  r = cli();
  ok(r.code === 1 && /bootSchema\.ts:2 +drops column channels\.a.*boot top-ups run on every task/.test(r.out), 'a new boot top-up that drops is refused; the shipped one is not');
  rmSync(tmp, { recursive: true, force: true });

  console.log('\npart 3: the real repo');
  const real = spawnSync('node', [join(ROOT, 'scripts/release/check-migrations.mjs')], { encoding: 'utf8' });
  ok(real.status === 0 && /migration safety: ok/.test(real.stdout), `every migration passes with the shipped ones baselined (${real.stdout.trim()})`);
  const all = spawnSync('node', [join(ROOT, 'scripts/release/check-migrations.mjs'), '--all'], { encoding: 'utf8' });
  const m79 = /(\d+) problem\(s\) in (\d+) file\(s\)/.exec(all.stderr);
  ok(all.status === 1 && m79 && /0080_watermark_scale_real\.sql:12 +changes the type of channels\.watermark_scale/.test(all.stderr)
    && /0027_publishing_rules\.sql:78 +changes the type of publications\.platform/.test(all.stderr),
    `--all over every existing migration: ${m79?.[1]} problems in ${m79?.[2]} files, the known type changes among them`);
  const baseline = JSON.parse(readFileSync(join(ROOT, 'release/migrations-baseline.json'), 'utf8'));
  ok(Object.keys(baseline.migrations).length >= 111, `the baseline holds the shipped migrations (${Object.keys(baseline.migrations).length})`);
  const rel = readFileSync(join(ROOT, 'scripts/release/release.mjs'), 'utf8');
  const chk = readFileSync(join(ROOT, 'scripts/release/check.mjs'), 'utf8');
  ok(/checkRepo\(ROOT\)/.test(rel) && /updateBaseline\(ROOT/.test(rel) && /release\/migrations-baseline\.json/.test(rel), 'release.mjs refuses an unsafe migration, records the shipped ones and commits the baseline');
  ok(/checkRepo\(ROOT, \{ trackedOnly/.test(chk) && /check\.mjs/.test(readFileSync(join(ROOT, 'scripts/deploy/deploy.mjs'), 'utf8')), 'check.mjs runs it (pre-commit and deploy.mjs both run check.mjs)');

  console.log('\npart 4: the runner and no-transaction files');
  if (!process.env.DATABASE_URL) {
    console.log('  skip (no DATABASE_URL; scripts/check.js sets one)');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'mig-runner-'));
    mkdirSync(join(dir, 'migrations'));
    const put = (f: string, sql: string) => writeFileSync(join(dir, 'migrations', f), sql);
    put('9001_d2_table.sql', `CREATE TABLE d2_rows (id INT PRIMARY KEY, label TEXT);
      INSERT INTO d2_rows SELECT g, 'r' || g FROM generate_series(1, 2000) g;`);
    put('9002_d2_index.sql', `-- volt:no-transaction
      -- a failed concurrent build leaves an invalid index, so drop first
      DROP INDEX CONCURRENTLY IF EXISTS d2_rows_label;
      CREATE INDEX CONCURRENTLY IF NOT EXISTS d2_rows_label ON d2_rows(label);`);
    const cwd = process.cwd();
    process.chdir(dir);   // the runner reads ./migrations, fixed when it loads
    const mod: any = await import(join(APP, 'src/services/migrate.ts'));
    const db: any = await import(join(APP, 'src/db.ts'));
    process.chdir(cwd);
    ok(JSON.stringify(mod.splitSql(`SELECT ';'; -- x;\nDO $b$ BEGIN PERFORM 1; END $b$; /* ; */ SELECT "a;b"`)) ===
      JSON.stringify([`SELECT ';'`, `DO $b$ BEGIN PERFORM 1; END $b$`, `SELECT "a;b"`]), 'the runner splits on ; outside strings, comments and dollar bodies');
    let res = await mod.migrate();
    ok(JSON.stringify(res.applied) === JSON.stringify(['9001_d2_table.sql', '9002_d2_index.sql']), `both files applied (${res.applied.join(', ')})`);
    const idx = await db.pool.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'd2_rows_label'`);
    ok(idx.rows[0]?.indisvalid === true, 'the concurrent index exists and is valid');
    const rec = await db.pool.query(`SELECT id FROM schema_migrations WHERE id LIKE '900%' ORDER BY id`);
    ok(rec.rows.map((x: any) => x.id).join() === '9001_d2_table.sql,9002_d2_index.sql', 'both recorded in schema_migrations');
    res = await mod.migrate();
    ok(res.applied.length === 0, 'a second run applies nothing');

    put('9003_d2_bad.sql', `-- volt:no-transaction
      CREATE INDEX CONCURRENTLY IF NOT EXISTS d2_rows_ok ON d2_rows(id);
      CREATE INDEX CONCURRENTLY d2_rows_bad ON d2_rows(no_such_column);`);
    let err = '';
    try { await mod.migrate(); } catch (e: any) { err = e.message; }
    ok(/9003_d2_bad\.sql \(no transaction\) failed at statement 2 of 2.*no_such_column/.test(err), `a failing statement stops the runner and says which (${err.slice(0, 90)})`);
    const r3 = await db.pool.query(`SELECT 1 FROM schema_migrations WHERE id = '9003_d2_bad.sql'`);
    ok(r3.rowCount === 0, 'the failed file is not recorded, so it runs again next time');
    put('9003_d2_bad.sql', `-- volt:no-transaction
      CREATE INDEX CONCURRENTLY IF NOT EXISTS d2_rows_ok ON d2_rows(id);`);
    res = await mod.migrate();
    ok(res.applied.join() === '9003_d2_bad.sql', 'fixed and re-run from the top: IF NOT EXISTS skips what already landed');

    put('9004_d2_no_marker.sql', `CREATE INDEX CONCURRENTLY d2_rows_label2 ON d2_rows(label);`);
    err = '';
    try { await mod.migrate(); } catch (e: any) { err = e.message; }
    ok(/cannot run inside a transaction block/.test(err), 'the same index without the marker is refused by Postgres, which is why the check asks for it');
    await db.pool.end();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
