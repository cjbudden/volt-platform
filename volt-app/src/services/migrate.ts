// ============================================================================
//  MIGRATION RUNNER
//
//  Until now the schema was one 1,053-line 0001_init.sql plus a growing list of
//  idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements executed on
//  every boot. That works for adding a nullable column and nothing else: it
//  cannot create a type, backfill a value, add a constraint that might fail, or
//  tell you whether a change has already been applied to a given database.
//
//  This runs numbered .sql files from migrations/ exactly once each, in order,
//  each inside its own transaction, recording what ran in schema_migrations.
//
//  RULES for a migration file
//    * Name it NNNN_short_name.sql. The number is the order and the identity;
//      never renumber or edit a file that has shipped — add a new one.
//    * It runs in ONE transaction. If it throws, nothing from that file lands
//      and the runner stops, so a half-applied schema is not a state we have.
//    * Write it to be safe on a database that already has the change (IF NOT
//      EXISTS, ON CONFLICT DO NOTHING), because dev databases have been topped
//      up by hand for months and are not all in the same shape.
//    * Postgres cannot ALTER TYPE … ADD VALUE inside a transaction block, so a
//      migration that adds an enum value must instead CREATE a new type. There
//      is a guard below that catches this at run time rather than in production.
//    * It must leave a schema the PREVIOUS release can run on: rolling deploys
//      run old and new tasks side by side and a rollback keeps the schema. So
//      add only (new tables, nullable columns or columns with a default,
//      indexes built concurrently); remove in a later release with a
//      `-- volt:contract` line. scripts/release/check-migrations.mjs enforces
//      it (build queue D2); RELEASING.md, "Schema", has the how.
//    * CREATE INDEX CONCURRENTLY cannot run in a transaction. A file with a
//      line `-- volt:no-transaction` holds only concurrent
//      index statements; each runs on its own and the file is recorded once
//      they all succeed. Write them to be re-run safely
//      (`DROP INDEX CONCURRENTLY IF EXISTS` first, then `CREATE ... IF NOT
//      EXISTS`): a failed concurrent build leaves an invalid index behind.
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** The marker for a file that runs outside a transaction (concurrent indexes). */
const NO_TX_RE = /^[ \t]*--[ \t]*volt:no-transaction\b/m;

/**
 * Split a migration into statements on `;`, outside comments, quoted strings
 * and dollar-quoted bodies. Only used for no-transaction files, which hold
 * plain index statements, but it copes with the rest so it never cuts a
 * statement in the middle.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? sql.length : e;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? sql.length : e + 2;
      cur += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$' && !/[A-Za-z0-9_$]/.test(cur.slice(-1))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        const end = e < 0 ? sql.length : e + m[0].length;
        cur += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface MigrationResult {
  applied: string[];
  skipped: number;
}

/** Files on disk, in order, with their number and contents. */
function discover(): { id: string; num: number; sql: string }[] {
  let names: string[];
  try {
    names = readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];   // no migrations dir (a consumer running against a managed DB)
  }
  const files = names.filter((n) => FILE_RE.test(n)).sort();
  const bad = names.filter((n) => n.endsWith('.sql') && !FILE_RE.test(n));
  if (bad.length) {
    throw new Error(
      `[migrate] these .sql files do not match NNNN_name.sql and would be skipped silently: ${bad.join(', ')}`
    );
  }
  const seen = new Map<number, string>();
  return files.map((id) => {
    const num = Number(FILE_RE.exec(id)![1]);
    if (seen.has(num)) {
      throw new Error(`[migrate] duplicate migration number ${num}: ${seen.get(num)} and ${id}`);
    }
    seen.set(num, id);
    return { id, num, sql: readFileSync(join(MIGRATIONS_DIR, id), 'utf8') };
  });
}

/**
 * Apply every migration that has not run yet.
 *
 * 0001_init.sql is the original whole-schema file. On a database that predates
 * this runner every object it creates already exists, so it is marked applied
 * without being executed when we can see its tables are there. A genuinely
 * empty database runs it normally.
 */
export async function migrate(): Promise<MigrationResult> {
  const files = discover();
  if (!files.length) return { applied: [], skipped: 0 };

  const client = await pool.connect();
  const applied: string[] = [];
  let skipped = 0;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER,
        checksum    TEXT
      )`);

    // One runner at a time. A second control plane booting concurrently waits
    // here rather than racing to create the same objects.
    await client.query(`SELECT pg_advisory_lock(4711)`);

    const done = new Set(
      (await client.query<{ id: string }>(`SELECT id FROM schema_migrations`)).rows.map((r) => r.id)
    );

    // Adopt a pre-runner database: if the init file has not been recorded but
    // its tables exist, the schema is already there. Record it, do not re-run.
    if (!done.has('0001_init.sql')) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables
          WHERE table_schema='public' AND table_name IN ('channels','recordings','vod_assets')`
      );
      if (Number(rows[0].n) === 3) {
        await client.query(
          `INSERT INTO schema_migrations(id, duration_ms, checksum) VALUES ($1, 0, 'adopted')
             ON CONFLICT (id) DO NOTHING`, ['0001_init.sql']
        );
        done.add('0001_init.sql');
        console.log('[migrate] adopted existing schema as 0001_init.sql (not re-run)');
      }
    }

    for (const f of files) {
      if (done.has(f.id)) { skipped++; continue; }
      // Catch the enum trap before it reaches a production database.
      if (/ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i.test(f.sql)) {
        throw new Error(
          `[migrate] ${f.id} uses ALTER TYPE … ADD VALUE, which Postgres cannot run inside a ` +
          `transaction block. Create a new type and migrate the column instead.`
        );
      }
      const started = Date.now();
      console.log(`[migrate] applying ${f.id}`);
      if (NO_TX_RE.test(f.sql)) {
        // No transaction: each statement on its own (Postgres runs a
        // multi-statement string as one implicit transaction, which
        // CONCURRENTLY refuses). Recorded only when every statement worked,
        // so a failure is retried from the top on the next run.
        const stmts = splitSql(f.sql);
        for (const [n, stmt] of stmts.entries()) {
          try {
            await client.query(stmt);
          } catch (e) {
            throw new Error(
              `[migrate] ${f.id} (no transaction) failed at statement ${n + 1} of ${stmts.length}: ` +
              `${(e as Error).message}. Statements before it stayed applied; the file runs again from the top next time`
            );
          }
        }
        await client.query(
          `INSERT INTO schema_migrations(id, duration_ms, checksum) VALUES ($1,$2,$3)`,
          [f.id, Date.now() - started, checksum(f.sql)]
        );
        applied.push(f.id);
        console.log(`[migrate] applied  ${f.id} in ${Date.now() - started}ms (no transaction, ${stmts.length} statement(s))`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        await client.query(
          `INSERT INTO schema_migrations(id, duration_ms, checksum) VALUES ($1,$2,$3)`,
          [f.id, Date.now() - started, checksum(f.sql)]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`[migrate] ${f.id} failed and was rolled back: ${(e as Error).message}`);
      }
      applied.push(f.id);
      console.log(`[migrate] applied  ${f.id} in ${Date.now() - started}ms`);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(4711)`).catch(() => {});
    client.release();
  }
  if (applied.length) console.log(`[migrate] ${applied.length} applied, ${skipped} already present`);
  return { applied, skipped };
}

/** Cheap content fingerprint, recorded so an edited shipped migration is visible. */
function checksum(sql: string): string {
  let h = 5381;
  for (let i = 0; i < sql.length; i++) h = ((h * 33) ^ sql.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}
