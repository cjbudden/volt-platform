#!/usr/bin/env node
/* Minimal forward-only migration runner for RDS / non-docker environments.
   docker-compose applies migrations automatically via /docker-entrypoint-initdb.d,
   so this is for deploying to an existing database (e.g. RDS). */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const done = new Set((await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) { console.log(`skip  ${f}`); continue; }
    console.log(`apply ${f}`);
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  await client.end();
  console.log('migrations up to date');
}
main().catch((e) => { console.error(e); process.exit(1); });
