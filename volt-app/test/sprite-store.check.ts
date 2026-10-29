// ============================================================================
//  SPRITE STORE (services/thumbnails/spriteStore.ts, migration 0112,
//  docs/THUMBNAILS.md "Where sprites live").
//
//    1. moving the old layout: live hours, an uploaded file's sheets and a
//       clip VTT that lived in the Image Library go to derived/{acct}/sprites/,
//       every key that pointed at them is rewritten, their library rows go,
//       the inventory gets a row each, and running it again changes nothing;
//    2. an uploaded file's sheets are built straight into the sprite store,
//       with no library row, and a shorter rebuild leaves no stale sheets;
//    3. removing the asset puts its sprites in the bin with it, and restoring
//       puts files and rows back.
//
//  Needs Postgres (DATABASE_URL, migrations applied) and ffmpeg.
//  Usage: npx tsx test/sprite-store.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'sprite-store-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');
process.env.VOLT_TRASH_DIR = join(ROOT, 'trash');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_SIGNING_SECRET = 'sprite-store-check-signing-secret-0123456789';
process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const S = await import('../src/services/thumbnails/spriteStore');
  const store = imageStore();

  const ACC = randomUUID(), GRP = randomUUID(), CH = randomUUID(), UP = randomUUID(), CLIP = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'SpriteCo')`, [ACC]);
  await query(`INSERT INTO groups(id,account_id,name) VALUES ($1,$2,'G')`, [GRP, ACC]);
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ($1,$2,'Sport One','ended','UTC','tv')`, [CH, GRP]);
  const jpg = (n: number) => Buffer.from(`fake-jpeg-${n}-`.padEnd(200 + n, 'x'));

  // ---------------------------------------------------------------- 1. the old layout
  console.log('== moving the old layout ==');
  const T = Date.UTC(2026, 9, 16, 18, 0, 0);
  const folder = 'thumbnails/Sport-One/2026-10-16/18';
  const oldSheets = [0, 1].map((i) => `library/${ACC}/${folder}/storyboard/Sport-One-20261016-18-m${i}0.jpg`);
  const oldVtt = `library/${ACC}/${folder}/storyboard/Sport-One-20261016-18.vtt`;
  for (const [i, k] of oldSheets.entries()) {
    await store.put(k, jpg(i), 'image/jpeg');
    await query(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source, channel_id, captured_at)
                 VALUES ($1,'storyboard',$2,$3,$4,$5,'encoder',$6,now())`, [ACC, k.slice(`library/${ACC}/`.length), `${folder}/storyboard`, k.split('/').pop(), k, CH]);
  }
  await store.put(oldVtt, Buffer.from('WEBVTT\n'), 'text/vtt');
  // a still in the same hour stays in the library
  const still = `library/${ACC}/${folder}/Sport-One-20261016-180000.jpg`;
  await store.put(still, jpg(9), 'image/jpeg');
  await query(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source, channel_id, captured_at)
               VALUES ($1,'keyframe',$2,$3,'Sport-One-20261016-180000.jpg',$4,'encoder',$5,now())`, [ACC, `${folder}/Sport-One-20261016-180000.jpg`, folder, still, CH]);
  const sheetsJson = oldSheets.map((k, i) => ({ key: k, start_ms: T + i * 600_000, slots: 60, filled: [0, 1, 2], skipped: [] }));
  const sb = await one<any>(`INSERT INTO storyboards(account_id, stream_kind, stream_id, unit_start, unit_end, folder, interval_ms, tile_w, tile_h, cols, rows, sheets, vtt_key, tiles, status)
     VALUES ($1,'channel',$2,$3,$4,$5,10000,160,90,10,6,$6::jsonb,$7,6,'complete') RETURNING id`,
    [ACC, CH, new Date(T), new Date(T + 3600_000), folder, JSON.stringify(sheetsJson), oldVtt]);

  // an uploaded file whose sheets were in thumbnails/files/<asset>/
  const upOld = [0, 1].map((i) => `library/${ACC}/thumbnails/files/${UP}/sheet-00${i}.jpg`);
  for (const [i, k] of upOld.entries()) {
    await store.put(k, jpg(i + 3), 'image/jpeg');
    await query(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source, metadata)
                 VALUES ($1,'storyboard',$2,$3,$4,$5,'auto',$6::jsonb)`, [ACC, k.slice(`library/${ACC}/`.length), `thumbnails/files/${UP}`, k.split('/').pop(), k, JSON.stringify({ assetId: UP })]);
  }
  const upSprite = { folder: `thumbnails/files/${UP}`, intervalMs: 1000, tileW: 160, tileH: 90, cols: 10, rows: 6, durationMs: 90_000,
    sheets: [{ key: upOld[0], from: 0, tiles: 60 }, { key: upOld[1], from: 60_000, tiles: 30 }] };
  await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, sprite, storyboard_key)
               VALUES ($1,$2,'upload','export','Uploaded',0,0,90000,$3::jsonb,$4)`, [UP, ACC, JSON.stringify(upSprite), upOld[0]]);

  // a clip of the hour with its VTT beside the channel thumbnails
  const oldClipVtt = `library/${ACC}/thumbnails/Sport-One/clips/Goal-${CLIP.slice(0, 8)}.vtt`;
  await store.put(oldClipVtt, Buffer.from('WEBVTT\n\nold'), 'text/vtt');
  await query(`INSERT INTO vod_assets(id, channel_id, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, thumbs_vtt_key)
               VALUES ($1,$2,'clip','Goal',$3,$4,$5,20000,$6)`, [CLIP, CH, `vod/${CLIP}/master.m3u8`, T + 5_000, T + 25_000, oldClipVtt]);

  // a library sheet row nothing points at any more
  const orphan = `library/${ACC}/thumbnails/Sport-One/2026-10-15/03/storyboard/orphan-m00.jpg`;
  await store.put(orphan, jpg(7), 'image/jpeg');
  await query(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source) VALUES ($1,'storyboard',$2,'thumbnails/Sport-One/2026-10-15/03/storyboard','orphan-m00.jpg',$3,'encoder')`,
    [ACC, orphan.slice(`library/${ACC}/`.length), orphan]);

  truthy('old-layout sprites are noticed', await S.legacySpritesRemain());
  // The orphan sweep runs once nothing referenced is left, so it can take a second run.
  const sum = { hours: 0, assets: 0, clipVtts: 0, libraryRows: 0 };
  let r = await S.relocateLegacySprites();
  for (let i = 0; ; i++) {
    sum.hours += r.hours; sum.assets += r.assets; sum.clipVtts += r.clipVtts; sum.libraryRows += r.libraryRows;
    if (r.done || i > 3) break;
    r = await S.relocateLegacySprites();
  }
  // Relocation is for every account; a database with other old-layout data reports more.
  truthy('at least one hour, one upload and one clip VTT moved; 5 library rows dropped',
    sum.hours >= 1 && sum.assets >= 1 && sum.clipVtts >= 1 && sum.libraryRows >= 5);
  truthy('relocation reports done', r.done && !(await S.legacySpritesRemain()));

  const sb2 = await one<any>(`SELECT sheets, vtt_key FROM storyboards WHERE id = $1`, [sb.id]);
  const newSheets = sb2.sheets.map((x: any) => x.key);
  check('hour sheets moved to the sprite store', newSheets, oldSheets.map((k) => `derived/${ACC}/sprites/streams/Sport-One/2026-10-16/18/${k.split('/').pop()}`));
  check('the hour VTT too', sb2.vtt_key, `derived/${ACC}/sprites/streams/Sport-One/2026-10-16/18/Sport-One-20261016-18.vtt`);
  truthy('files are at the new keys', (await store.get(newSheets[1]))?.equals(jpg(1)) && await store.exists(sb2.vtt_key));
  check('and gone from the old ones', await Promise.all([...oldSheets, oldVtt].map((k) => store.exists(k))), [false, false, false]);
  check('tiles and sheet metadata kept', sb2.sheets.map((x: any) => x.filled.length), [3, 3]);
  check('the still stays in the library', !!(await one<any>(`SELECT 1 FROM media_files WHERE store_key = $1`, [still])) && await store.exists(still), true);

  const up = await one<any>(`SELECT sprite, storyboard_key FROM vod_assets WHERE id = $1`, [UP]);
  check('upload sheets moved to the asset folder', up.sprite.sheets.map((x: any) => x.key), [0, 1].map((i) => `derived/${ACC}/sprites/assets/${UP}/sheet-00${i}.jpg`));
  check('its storyboard_key follows', up.storyboard_key, up.sprite.sheets[0].key);
  check('its layout is kept', [up.sprite.intervalMs, up.sprite.sheets[1].from, up.sprite.sheets[1].tiles], [1000, 60_000, 30]);

  const clip = await one<any>(`SELECT thumbs_vtt_key, storyboard_key FROM vod_assets WHERE id = $1`, [CLIP]);
  check('the clip VTT is written again in the asset folder', clip.thumbs_vtt_key, `derived/${ACC}/sprites/assets/${CLIP}/thumbs.vtt`);
  const clipVtt = (await store.get(clip.thumbs_vtt_key))?.toString() ?? '';
  truthy('pointing at the moved sheets', clipVtt.includes(`/derived/${ACC}/sprites/streams/`) && !clipVtt.includes('/library/'));
  truthy('and its first-sheet URL too', String(clip.storyboard_key).includes(`/derived/${ACC}/sprites/streams/`));
  check('the old clip VTT is gone', await store.exists(oldClipVtt), false);

  check('no sheet is left in the Image Library', (await query<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND kind = 'storyboard'`, [ACC])).length, 0);
  check('the orphan file went with its row', await store.exists(orphan), false);
  const inv = await query<any>(`SELECT owner_kind, kind, count(*)::int AS n FROM sprite_sheets WHERE account_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [ACC]);
  check('the inventory has every sprite', inv.map((x: any) => `${x.owner_kind}/${x.kind}:${x.n}`), ['asset/sheet:2', 'asset/vtt:1', 'stream/sheet:2', 'stream/vtt:1']);
  const usage = await S.spriteUsage(ACC);
  truthy('usage counts files and bytes', usage.reduce((n, u) => n + u.files, 0) === 6 && usage.every((u) => u.bytes > 0));
  const again = await S.relocateLegacySprites();
  check('running it again changes nothing', [again.hours, again.assets, again.clipVtts, again.objects, again.libraryRows, again.done], [0, 0, 0, 0, 0, true]);

  // ---------------------------------------------------------------- 2. an upload's sheets
  console.log('== an upload builds straight into the sprite store ==');
  const F = await import('../src/services/thumbnails/fileSprites');
  const src = join(ROOT, 'src.mp4'), short = join(ROOT, 'short.mp4');
  const enc = (out: string, secs: number) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:duration=${secs}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-y', out]).status === 0;
  if (!enc(src, 75) || !enc(short, 20)) { console.log('SKIP uploads: ffmpeg could not encode'); }
  else {
    const NEW = randomUUID();
    await query(`INSERT INTO vod_assets(id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms)
                 VALUES ($1,$2,'upload','export','Fresh',0,0,75000)`, [NEW, ACC]);
    const sp = await F.buildFileSprites(NEW, ACC, src, 75_000);
    check('75 s at one preview a second: two sheets', sp?.sheets.length, 2);
    truthy('in the asset folder', sp!.sheets.every((x) => x.key.startsWith(`derived/${ACC}/sprites/assets/${NEW}/`)));
    check('no library row', (await query<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND kind = 'storyboard'`, [ACC])).length, 0);
    check('an inventory row each', (await query<any>(`SELECT tiles FROM sprite_sheets WHERE vod_asset_id = $1 AND kind = 'sheet' ORDER BY start_ms`, [NEW])).map((x: any) => x.tiles), [60, 15]);
    const vtt = F.fileSpriteVtt(sp!);
    truthy('its VTT points into the sprite store through the image service', vtt.includes(`https://img.test/img/`) && vtt.includes(`/derived/${ACC}/sprites/assets/${NEW}/sheet-000.jpg#xywh=0,0,160,90`));
    const sp2 = await F.buildFileSprites(NEW, ACC, short, 20_000);
    check('a shorter rebuild: one sheet', sp2?.sheets.length, 1);
    check('the second sheet is removed, file and row', [await store.exists(sp!.sheets[1].key), (await query<any>(`SELECT 1 FROM sprite_sheets WHERE vod_asset_id = $1`, [NEW])).length], [false, 1]);

    // ---------------------------------------------------------------- 3. the bin
    console.log('== removing and restoring the asset ==');
    const { removeVodAsset } = await import('../src/services/vodRemove');
    const { restoreItem } = await import('../src/services/media/trash');
    const key = sp2!.sheets[0].key;
    const binId = await removeVodAsset(NEW, { reason: 'check' });
    truthy('removed into the bin', !!binId);
    check('its sheet file and row are gone', [await store.exists(key), (await query<any>(`SELECT 1 FROM sprite_sheets WHERE vod_asset_id = $1`, [NEW])).length], [false, 0]);
    await restoreItem(binId!);
    check('restoring brings both back', [await store.exists(key), (await query<any>(`SELECT 1 FROM sprite_sheets WHERE vod_asset_id = $1`, [NEW])).length], [true, 1]);
  }

  await query(`DELETE FROM accounts WHERE id = $1`, [ACC]);
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
