// ============================================================================
//  EVERY LAYOUT THE DATABASE CAN STORE MUST BE ONE THE BUNDLE CAN BUILD.
//
//  This suite exists because of a failure that produced no error anywhere.
//
//  The player's layout registry listed one name, `card`. The database's CHECK
//  constraint allowed four. The console offered all four. So an operator could
//  pick `stage`, save it, get a success toast, and the embed on their customer's
//  website would quietly render a card: the registry's fallback did exactly what
//  it is designed to do for an unknown name, and an unknown name is precisely
//  what a valid, saved, supported layout had become.
//
//  Nothing failed. No request errored, no exception was thrown, nothing was
//  logged. Three finished layouts, about 1,200 lines of them, were unreachable
//  and the only symptom was the wrong skin on somebody else's site.
//
//  THE FALLBACK IS NOT THE BUG and must not be removed: rendering a default
//  player for a name from a newer console is better than a blank box on a
//  customer's page. What was missing is anything that notices the two lists
//  have drifted apart. That is this file.
//
//  It reads both sources of truth as TEXT rather than importing them: the
//  migration is SQL, the registry is a browser bundle that imports Shaka, and
//  neither is loadable from a node test. Reading them is the point anyway --
//  the question is whether the two DECLARATIONS agree.
//
//  Usage: npx tsx test/player-layouts.check.ts
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };

const ROOT = join(__dirname, '..');
const PLAYER = join(ROOT, '..', 'volt-player', 'src');

/** The names the CHECK constraint allows, from the newest migration that sets it. */
function fromMigrations(): string[] {
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let names: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // The LAST migration to redefine it wins, exactly as it does in Postgres.
    const m = sql.match(/CHECK\s*\(\s*layout\s+IN\s*\(([^)]*)\)/i);
    if (m) names = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  }
  return names;
}

/** The names the registry can actually build. */
function fromRegistry(): string[] {
  const src = readFileSync(join(PLAYER, 'layouts', 'index.ts'), 'utf8');
  const body = src.slice(src.indexOf('const REGISTRY'), src.indexOf('export function pickLayout'));
  return [...body.matchAll(/^\s*([a-z_]+)\s*:\s*\w+Layout\s*,/gm)].map((m) => m[1]);
}

/** The names the shared type admits. */
function fromTypes(): string[] {
  const src = readFileSync(join(PLAYER, 'types.ts'), 'utf8');
  const m = src.match(/export type LayoutName\s*=([^;]*);/);
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
}

const sorted = (a: string[]) => [...a].sort().join(',');

(async () => {
  const db = fromMigrations();
  const reg = fromRegistry();
  const ty = fromTypes();

  console.log(`\n  migration CHECK : ${db.join(', ') || '(none found)'}`);
  console.log(`  registry        : ${reg.join(', ') || '(none found)'}`);
  console.log(`  LayoutName type : ${ty.join(', ') || '(none found)'}\n`);

  db.length ? ok(`the migration declares ${db.length} layout(s)`)
            : bad('the migration declares layouts', 'no CHECK (layout IN (...)) found');
  reg.length ? ok(`the registry builds ${reg.length} layout(s)`)
             : bad('the registry builds layouts', 'no entries matched');

  // THE HEADLINE. A name the database accepts and the bundle cannot build is a
  // silently wrong skin on a customer's website.
  const unbuildable = db.filter((n) => !reg.includes(n));
  unbuildable.length === 0
    ? ok('every layout the database accepts can actually be built')
    : bad('every layout the database accepts can actually be built',
          `the registry cannot build: ${unbuildable.join(', ')}`);

  // The other direction is milder but still wrong: a layout nobody can select.
  const unreachable = reg.filter((n) => !db.includes(n));
  unreachable.length === 0
    ? ok('and every layout the bundle builds can actually be selected')
    : bad('and every layout the bundle builds can actually be selected',
          `the CHECK constraint rejects: ${unreachable.join(', ')}`);

  sorted(ty) === sorted(reg)
    ? ok('the LayoutName type agrees with the registry')
    : bad('the LayoutName type agrees with the registry', `${sorted(ty)} vs ${sorted(reg)}`);

  // Each named layout must have a file behind it. A registry entry importing a
  // module that does not exist fails the build, but a name in the type or the
  // migration with no implementation fails nothing at all.
  const files = readdirSync(join(PLAYER, 'layouts'));
  for (const n of db) {
    files.includes(`${n}.ts`)
      ? ok(`${n} has an implementation`)
      : bad(`${n} has an implementation`, `no layouts/${n}.ts`);
  }

  // And the fallback stays, because it is right: an unknown name from a newer
  // console must render something rather than throw on a customer's page.
  const idx = readFileSync(join(PLAYER, 'layouts', 'index.ts'), 'utf8');
  /\?\?\s*cardLayout/.test(idx)
    ? ok('an unknown name still falls back rather than throwing')
    : bad('an unknown name still falls back rather than throwing',
          'pickLayout has no ?? cardLayout fallback');

  console.log(`\nplayer-layouts: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
