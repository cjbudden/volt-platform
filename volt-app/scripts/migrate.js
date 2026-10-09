#!/usr/bin/env node
/* ============================================================================
 *  APPLY MIGRATIONS (deploy entry point).
 *
 *  This file used to be a SECOND, independent migration runner. It kept its
 *  own ledger in a table called `_migrations`, while the service records what
 *  it has applied in `schema_migrations`. The two never saw each other, so on
 *  any database the service had already migrated — which is every database —
 *  this script found an empty ledger and started by re-applying
 *  0001_init.sql to a live schema. It failed loudly on the first CREATE TYPE,
 *  which is the only reason it was harmless rather than destructive.
 *
 *  There is one runner. It lives in src/services/migrate.ts, it is the one the
 *  service runs on boot, it records checksums and durations, and it is what
 *  this script now calls. A deploy and a boot must apply migrations the same
 *  way or the ledger is a work of fiction.
 * ========================================================================= */
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const r = spawnSync(
  join(ROOT, 'node_modules/.bin/tsx'),
  ['-e', `
    import { migrate } from './src/services/migrate';
    import { pool } from './src/db';
    migrate()
      .then(async (res) => {
        console.log('[migrate] ' + res.applied.length + ' applied, ' + res.skipped + ' already present');
        await pool.end();
      })
      .catch(async (e) => {
        console.error(e);
        try { await pool.end(); } catch { /* ignore */ }
        process.exit(1);
      });
  `],
  { cwd: ROOT, stdio: 'inherit', env: process.env }
);
process.exit(r.status ?? 1);
