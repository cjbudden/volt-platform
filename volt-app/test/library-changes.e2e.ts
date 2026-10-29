// ============================================================================
//  THE LIBRARY'S "WHAT CHANGED SINCE" POLL (GET /api/vod/changes) AND IMAGES
//  REPLACED AT THE SAME PATH NOT RENDERING STALE. Needs DATABASE_URL.
//  Usage: npx tsx test/library-changes.e2e.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const T = mkdtempSync(join(tmpdir(), 'volt-c-'));
process.env.IMAGE_STORE_DIR = join(T, 'images'); process.env.IMAGE_STORE_DRIVER = 'local'; process.env.IMAGE_CACHE_DRIVER = 'none';
let pass = 0, fail = 0;
const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };
async function main() {
  await (await import('../src/services/migrate')).migrate();
  const { one, query, pool } = await import('../src/db');
  const express = (await import('express')).default;
  const { assetImagesRouter } = await import('../src/modules/assetImages');
  const acct = (await one<any>(`INSERT INTO accounts (name) VALUES ('C') RETURNING id`))!.id;
  const other = (await one<any>(`INSERT INTO accounts (name) VALUES ('C2') RETURNING id`))!.id;
  const app = express();
  app.use((req: any, _r, n) => { req.auth = { account_id: req.headers['x-acct'], user_id: null }; n(); });
  app.use('/api/vod', assetImagesRouter);
  app.use((e: any, _q: any, r: any, _n: any) => r.status(e.status ?? 500).json({ error: String(e.message) }));
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}/api/vod/changes`;
  const get = async (a: string, since?: string) => (await fetch(since ? `${base}?since=${encodeURIComponent(since)}` : base, { headers: { 'x-acct': a } })).json();
  const mk = (a: string, t: string) => one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload',$2,'/x',0,1,1) RETURNING id`, [a, t]);
  const a1 = (await mk(acct, 'One'))!.id; await mk(other, 'Theirs');
  await new Promise((r) => setTimeout(r, 4000));    // the assets are older than the overlap window
  const first = await get(acct);
  ok(!!first.now && first.changes.length === 0, 'the first call answers only now');
  await new Promise((r) => setTimeout(r, 2100));    // past the 2 s shared answer
  const quiet = await get(acct, new Date(first.now).toISOString());
  ok(quiet.changes.length === 0, 'nothing changed: an empty answer', JSON.stringify(quiet.changes.map((c: any) => c.title)));
  await query(`UPDATE vod_assets SET poster_key = 'library/x/new.jpg', poster_picked_at = now(), updated_at = now() WHERE id = $1`, [a1]);
  await query(`UPDATE vod_assets SET title = 'Theirs 2', updated_at = now() WHERE account_id = $1`, [other]);
  await new Promise((r) => setTimeout(r, 2100));    // past the 2 s shared answer
  const ch = await get(acct, new Date(quiet.now).toISOString());
  ok(ch.changes.length === 1 && ch.changes[0].id === a1 && ch.changes[0].poster_key === 'library/x/new.jpg' && !!ch.changes[0].poster_picked_at, 'the changed asset, with its new image', JSON.stringify(ch));
  ok(!ch.changes.some((c: any) => c.title === 'Theirs 2'), "another account's change is not shown");
  const plan = await query<any>(`EXPLAIN SELECT id FROM vod_assets v WHERE v.updated_at > now() - interval '10 seconds'`);
  ok(JSON.stringify(plan).includes('idx_vod_assets_updated_at') || JSON.stringify(plan).includes('Seq Scan'), 'index exists (planner may still scan a tiny table)');
  ok((await query<any>(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_vod_assets_updated_at'`)).length === 1, 'updated_at index present');

  console.log('== overwritten at the same path ==');
  const sharp = (await import('sharp')).default;
  const { saveToLibrary } = await import('../src/services/media/libraryImages');
  const { imageService, signedImageUrl } = await import('../src/modules/images');
  const img = (c: string) => sharp({ create: { width: 64, height: 36, channels: 3, background: c } }).png().toBuffer();
  const render = async (key: string, spec: string) => { const u = new URL(signedImageUrl(key, spec), 'http://x'); const p = u.pathname.replace(/^\/img\//, '').split('/'); return (await imageService().handle(p[0], decodeURIComponent(p.slice(1).join('/')))).body; };
  const k = await saveToLibrary(acct, 'media/x', 'poster.png', await img('#ff0000'), 'image/png', 'poster', {});
  const px = async (b: Buffer) => (await sharp(b).raw().toBuffer({ resolveWithObject: true })).data.slice(0, 3).join(',');
  ok((await px(await render(k, '32x18,cover,fmt=png'))).startsWith('25'), 'renders red');
  await saveToLibrary(acct, 'media/x', 'poster.png', await img('#0000ff'), 'image/png', 'poster', {});
  const after = await px(await render(k, '32x18,cover,fmt=png,v=2'));
  ok(after.endsWith('255') && after.startsWith('0'), 'replaced at the same path, a new version renders the new picture (not the bytes held in memory)', after);
  srv.close(); await pool.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
