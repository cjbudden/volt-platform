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
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

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
