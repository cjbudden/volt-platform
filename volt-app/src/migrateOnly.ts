/**
 * APPLY THE SCHEMA AND EXIT (build queue D1).
 *
 *   node dist/migrateOnly.js        in the control-plane image
 *   npx tsx src/migrateOnly.ts      from a checkout
 *
 * A deploy (scripts/deploy/deploy.mjs) runs this once, as a one-off task of
 * the new image, BEFORE any service moves. Rolling deploys run old and new
 * tasks side by side, so the schema has to be in place before the first new
 * task starts, and old tasks have to keep working against it (which is what
 * the migration safety check, D2, holds releases to).
 *
 * Same runner, same lock and same top-ups as a boot (src/index.ts): the boot
 * of the schema-owning roles still migrates, and finds nothing left to do.
 * No server is started and no scheduler, worker or listener runs. Exit code 0
 * means the schema is current; anything else stops the deploy.
 */
import { migrate } from './services/migrate';
import { ensureSchema } from './services/bootSchema';
import { withBootLock } from './scale/boot';
import { pool } from './db';

async function main(): Promise<number> {
  const started = Date.now();
  const res = await withBootLock(async () => {
    const r = await migrate();
    await ensureSchema();
    return r;
  });
  const a = res.applied;
  const which = a.length > 4 ? `${a[0]} ... ${a[a.length - 1]}` : a.join(', ');
  console.log(`[migrate-only] ${a.length} applied${a.length ? ` (${which})` : ''}, ${res.skipped} already present, ${Date.now() - started} ms`);
  return 0;
}

main()
  .catch((e) => { console.error('[migrate-only] failed:', e); return 1; })
  .then(async (code) => { await pool.end().catch(() => {}); process.exit(code); });
