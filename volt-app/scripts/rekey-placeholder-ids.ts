/**
 * RE-KEY HAND-TYPED IDS to real random UUIDs.
 *
 * The demo seed and some early fixtures used ids typed by hand to be easy to
 * spot: 00000000-0000-0000-0000-00000000a001 for RTM, ...0c0001 for RTM News 24
 * and so on. They are valid UUIDs, but they show in every URL and every image
 * path, they look sequential, and they give away what a UUID is for. Anything
 * the app creates gets gen_random_uuid() (a version 4 UUID). This finds every
 * row id that is NOT one of those and gives it a fresh random one.
 *
 * HOW A HAND-TYPED ID IS RECOGNISED. A generated UUID is version 4: the first
 * digit of its third group is 4. Every hand-typed id here has 0000 there
 * (version 0), which nothing generates. So: an `id` whose third group starts
 * with 0.
 *
 * WHAT IS REWRITTEN, in one transaction:
 *   - every uuid and uuid[] column in the public schema (keys and references)
 *   - every text, varchar, text[] and jsonb value containing an old id: image
 *     paths (/library/<account id>/...), store keys, audit details, settings
 *   - then, after the commit, files and folders whose names contain an old id
 *     under the origin, image store, clips and filler folders (recordings and
 *     the image library are kept in folders named by channel and account id),
 *     and small playlist / index files that mention one.
 *
 * Foreign keys are switched off for the transaction (session_replication_role
 * = replica, which needs a superuser; the local volt role is one) because a
 * key and the rows pointing at it cannot change in a single statement. They
 * are all rewritten before the commit, and the script checks afterwards that
 * no reference points at nothing.
 *
 * Stop the app first: a running encoder writes into the old folders, and a
 * signed-in browser holds a token naming the old ids (sign in again after).
 *
 *   npx tsx scripts/rekey-placeholder-ids.ts            dry run: what would change
 *   npx tsx scripts/rekey-placeholder-ids.ts --apply    do it
 *
 * Running it again after --apply finds nothing and changes nothing.
 */
import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { connect } from 'node:net';
import { pool } from '../src/db';
import { config } from '../src/config';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
/** Version-0 UUID: the third group starts with 0. */
const HAND = '^[0-9a-f]{8}-[0-9a-f]{4}-0[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** Any version-0 UUID inside a longer string (cheap pre-filter). */
const HAND_IN = '[0-9a-f]{8}-[0-9a-f]{4}-0[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}';

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.setTimeout(800, () => { s.destroy(); res(false); });
  });
}

interface Col { table: string; column: string; kind: 'uuid' | 'uuid[]' | 'text' | 'text[]' | 'jsonb' }

async function main() {
  const c = await pool.connect();
  try {
    // ---- which ids
    const idTables = (await c.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid'
          AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
        ORDER BY 1`)).rows.map((r) => r.table_name as string);
    const found: { table: string; id: string }[] = [];
    for (const t of idTables) {
      const r = await c.query(`SELECT id::text FROM ${qi(t)} WHERE id::text ~ $1`, [HAND]);
      for (const row of r.rows) found.push({ table: t, id: row.id });
    }
    if (!found.length) { console.log('No hand-typed ids. Nothing to do.'); return; }
    const byTable = new Map<string, number>();
    for (const f of found) byTable.set(f.table, (byTable.get(f.table) ?? 0) + 1);
    console.log(`${found.length} hand-typed id(s):`);
    for (const [t, n] of byTable) console.log(`  ${t.padEnd(32)} ${n}`);
    const named = await c.query(
      `SELECT 'account' AS k, id::text, name FROM accounts WHERE id::text ~ $1
       UNION ALL SELECT kind, c.id::text, c.name FROM channels c WHERE c.id::text ~ $1
       UNION ALL SELECT 'user', id::text, email FROM users WHERE id::text ~ $1 ORDER BY 1, 3`, [HAND]).catch(() => ({ rows: [] as any[] }));
    for (const r of named.rows) console.log(`    ${String(r.k).padEnd(8)} ${r.id}  ${r.name}`);

    // ---- every column that can hold one
    const cols: Col[] = (await c.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.udt_name
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'
          AND (c.data_type IN ('uuid', 'text', 'character varying', 'jsonb') OR c.udt_name IN ('_uuid', '_text', '_varchar'))
        ORDER BY 1, 2`)).rows.map((r) => ({
      table: r.table_name, column: r.column_name,
      kind: r.data_type === 'uuid' ? 'uuid' : r.udt_name === '_uuid' ? 'uuid[]' : r.data_type === 'jsonb' ? 'jsonb'
        : (r.udt_name === '_text' || r.udt_name === '_varchar') ? 'text[]' : 'text',
    }));

    if (!APPLY) {
      console.log(`\nDry run. ${cols.length} columns would be checked. Run with --apply to re-key.`);
      return;
    }
    if (!FORCE && await portOpen(config.port || 8080)) {
      console.error(`\nThe app is running on :${config.port || 8080}. Stop it first (or pass --force).`);
      process.exitCode = 1; return;
    }

    await c.query('BEGIN');
    try {
      await c.query(`SET LOCAL session_replication_role = replica`);
    } catch (e: any) {
      await c.query('ROLLBACK');
      throw new Error(`Needs a superuser connection (foreign keys are paused during the re-key): ${e.message}`);
    }
    await c.query(`CREATE TEMP TABLE idmap(old uuid PRIMARY KEY, new uuid NOT NULL UNIQUE) ON COMMIT DROP`);
    await c.query(`INSERT INTO idmap(old, new) SELECT DISTINCT x::uuid, gen_random_uuid() FROM unnest($1::text[]) x`, [found.map((f) => f.id)]);
    await c.query(`
      CREATE FUNCTION pg_temp.rekey(t text) RETURNS text LANGUAGE plpgsql AS $f$
      DECLARE r record;
      BEGIN
        IF t IS NULL OR t !~ '${HAND_IN}' THEN RETURN t; END IF;
        FOR r IN SELECT old::text AS o, new::text AS n FROM idmap LOOP
          t := replace(t, r.o, r.n);
        END LOOP;
        RETURN t;
      END $f$`);

    let touched = 0;
    for (const col of cols) {
      const T = qi(col.table), C = qi(col.column);
      let sql: string;
      if (col.kind === 'uuid') sql = `UPDATE ${T} x SET ${C} = m.new FROM idmap m WHERE x.${C} = m.old`;
      else if (col.kind === 'uuid[]') sql = `UPDATE ${T} SET ${C} = (SELECT array_agg(COALESCE(m.new, u.v) ORDER BY u.o) FROM unnest(${C}) WITH ORDINALITY u(v, o) LEFT JOIN idmap m ON m.old = u.v)
                                             WHERE ${C} && (SELECT array_agg(old) FROM idmap)`;
      else if (col.kind === 'jsonb') sql = `UPDATE ${T} SET ${C} = pg_temp.rekey(${C}::text)::jsonb WHERE ${C}::text ~ '${HAND_IN}'`;
      else if (col.kind === 'text[]') sql = `UPDATE ${T} SET ${C} = (SELECT array_agg(pg_temp.rekey(v) ORDER BY o) FROM unnest(${C}) WITH ORDINALITY u(v, o))
                                             WHERE array_to_string(${C}, ' ') ~ '${HAND_IN}'`;
      else sql = `UPDATE ${T} SET ${C} = pg_temp.rekey(${C}) WHERE ${C} ~ '${HAND_IN}'`;
      const r = await c.query(sql);
      if (r.rowCount) { touched += r.rowCount; console.log(`  ${col.table}.${col.column}: ${r.rowCount}`); }
    }

    // Nothing may point at an id that no longer exists.
    const fks = (await c.query(
      `SELECT conrelid::regclass::text AS t, confrelid::regclass::text AS ft,
              (SELECT array_agg(attname::text ORDER BY k.n) FROM unnest(conkey) WITH ORDINALITY k(a, n) JOIN pg_attribute ON attrelid = conrelid AND attnum = k.a) AS cols,
              (SELECT array_agg(attname::text ORDER BY k.n) FROM unnest(confkey) WITH ORDINALITY k(a, n) JOIN pg_attribute ON attrelid = confrelid AND attnum = k.a) AS fcols
         FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)).rows;
    for (const fk of fks) {
      const cs: string[] = fk.cols, fcs: string[] = fk.fcols;
      const bad = await c.query(
        `SELECT count(*)::int AS n FROM ${fk.t} a WHERE ${cs.map((x) => `a.${qi(x)} IS NOT NULL`).join(' AND ')}
           AND NOT EXISTS (SELECT 1 FROM ${fk.ft} b WHERE ${cs.map((x, i) => `b.${qi(fcs[i])} = a.${qi(x)}`).join(' AND ')})`);
      if (bad.rows[0].n) throw new Error(`${fk.t}(${cs.join(',')}) has ${bad.rows[0].n} row(s) pointing at a missing ${fk.ft}; nothing was changed`);
    }
    const map = (await c.query(`SELECT old::text, new::text FROM idmap`)).rows as { old: string; new: string }[];
    await c.query('COMMIT');
    console.log(`\nRe-keyed ${map.length} id(s), ${touched} value(s) rewritten.`);

    // ---- files and folders named by an old id
    const swap = (s: string) => map.reduce((acc, m) => acc.split(m.old).join(m.new), s);
    const roots = [...new Set([config.testStream?.originDir, (config as any).imageStore?.localDir, (config as any).clips?.dir,
      (config as any).uploads?.fillerDir].filter(Boolean) as string[])];
    let renamed = 0, rewritten = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      let ents: import('node:fs').Dirent[];
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        let p = join(dir, e.name);
        const nn = swap(e.name);
        if (nn !== e.name) {
          const to = join(dir, nn);
          try { await fs.rename(p, to); renamed++; p = to; } catch (err: any) { console.warn(`  could not rename ${p}: ${err.message}`); }
        }
        if (e.isDirectory() && depth < 8) await walk(p, depth + 1);
        else if (e.isFile() && /\.(json|m3u8|mpd|txt|ndjson)$/i.test(nn)) {
          try {
            const st = await fs.stat(p);
            if (st.size > 5 * 1024 * 1024) continue;
            const s = await fs.readFile(p, 'utf8');
            const out = swap(s);
            if (out !== s) { await fs.writeFile(p, out); rewritten++; }
          } catch { /* unreadable: leave it */ }
        }
      }
    }
    for (const r of roots) await walk(r, 0);
    console.log(`Files: ${renamed} renamed, ${rewritten} rewritten under ${roots.map((r) => basename(dirname(r)) + '/' + basename(r)).join(', ') || '(no storage folders)'}.`);
    console.log('\nOld -> new:');
    for (const m of map) console.log(`  ${m.old} -> ${m.new}`);
    console.log('\nSign in again: a browser that was signed in holds the old ids.');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
