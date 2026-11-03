// ============================================================================
//  SLATE AND LOOP THUMBNAILS (services/media/fillerThumbs.ts, migration 0120).
//
//    1. a loop: its size, length and format read from the file; a dozen frames
//       scored, the best the thumbnail; sprite sheets in the sprite store with
//       an inventory row each (owner 'filler'), and a WebVTT over them;
//    2. a person's choice of frame stays through a rebuild, and Pick
//       automatically goes back to the best frame; a frame from elsewhere is
//       refused;
//    3. a slate: the image scaled is the thumbnail, no frames, no sprites, and
//       a rebuild leaves one thumbnail, not two;
//    4. a slate or loop whose file is missing fails with a reason; the sweep
//       queues only ready ones never tried; deleting removes every derived file.
//
//  Needs Postgres (DATABASE_URL, migrations applied) and ffmpeg.
//  Usage: npx tsx test/filler-thumbs.check.ts
// ============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = mkdtempSync(join(tmpdir(), 'filler-thumbs-'));
process.env.IMAGE_STORE_DIR = join(ROOT, 'store');
process.env.FILLER_DIR = join(ROOT, 'filler');
process.env.IMAGE_SIGNING_SECRET = 'filler-thumbs-check-signing-secret-0123456789';
process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`));
const truthy = (m: string, v: unknown) => (v ? ok(m) : bad(m, `expected truthy, got [${String(v)}]`));

function ffmpeg(args: string[]) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

async function main() {
  const { query, one, pool } = await import('../src/db');
  const { imageStore } = await import('../src/services/imageStore');
  const { localPathOf } = await import('../src/services/media/fillerStore');
  const T = await import('../src/services/media/fillerThumbs');
  const J = await import('../src/services/jobs/handlers/fillerThumbs');
  const store = imageStore();

  const ACC = randomUUID(), OTHER = randomUUID();
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'LoopCo'),($2,'Other')`, [ACC, OTHER]);
  const addFiller = async (kind: 'slate' | 'loop', ext: string, make: (path: string) => void) => {
    const id = randomUUID();
    const key = `filler/${ACC}/${id}${ext}`;
    const p = localPathOf(key)!;
    mkdirSync(dirname(p), { recursive: true });
    make(p);
    await query(`INSERT INTO filler_assets(id, account_id, kind, name, status, source_key) VALUES ($1,$2,$3,$4,'ready',$5)`, [id, ACC, kind, `${kind} ${ext}`, key]);
    return id;
  };
  const listAll = async (id: string) => [...await store.list(`${T.fillerFolder(ACC, id)}/`), ...await store.list(`derived/${ACC}/sprites/filler/${id}/`)].map((o) => o.key);

  // ---------------------------------------------------------------- 1. a loop
  console.log('== a loop ==');
  const LOOP = await addFiller('loop', '.mp4', (p) => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-ac', '2', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', p]));
  const r = await T.buildFillerThumbs(LOOP);
  let fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [LOOP]);
  check('thumbnails ready', fa.thumb_status, 'ready');
  check('size read from the file', [fa.width, fa.height], [1280, 720]);
  truthy('length read from the file (about 6 s)', Math.abs(Number(fa.duration_ms) - 6000) < 300);
  check('twelve frames to choose from', (fa.poster_candidates ?? []).length, 12);
  truthy('frames are best first', fa.poster_candidates.every((c: any, i: number, a: any[]) => i === 0 || (a[i - 1].score ?? 0) >= (c.score ?? 0)));
  check('the thumbnail is the best frame', fa.poster_key, (fa.poster_candidates.find((c: any) => !c.rejected) ?? fa.poster_candidates[0]).key);
  check('picked automatically', fa.poster_source, 'auto');
  truthy('thumbnail under the loop\'s own folder', String(fa.poster_key).startsWith(`derived/${ACC}/filler/${LOOP}/`));
  truthy('thumbnail is in the store', !!(await store.get(fa.poster_key)));
  truthy('sprite sheets made', r.sheets >= 1 && fa.sprite?.sheets?.length === r.sheets);
  const rows = await query<any>(`SELECT owner_kind, filler_asset_id, store_key FROM sprite_sheets WHERE filler_asset_id = $1`, [LOOP]);
  check('one inventory row per sheet, owner filler', [rows.length, rows.every((x) => x.owner_kind === 'filler')], [r.sheets, true]);
  truthy('sheets in the sprite store, not the library', rows.every((x) => x.store_key.startsWith(`derived/${ACC}/sprites/filler/${LOOP}/`)));
  check('format: H.264 High, 25 fps, progressive', [fa.probe?.video?.codec, fa.probe?.video?.profile, fa.probe?.video?.fps, fa.probe?.video?.scan], ['h264', 'High', 25, 'progressive']);
  check('format: AAC stereo 48 kHz', [fa.probe?.audio?.codec, fa.probe?.audio?.channels, fa.probe?.audio?.sampleRate], ['aac', 2, 48000]);
  check('format: the container named as people say it (not "QuickTime / MOV")', fa.probe?.container, 'MP4');
  const vtt = await T.fillerVtt(LOOP, ACC);
  truthy('a WebVTT over the sheets', !!vtt && vtt.startsWith('WEBVTT') && (vtt.match(/#xywh=/g) ?? []).length >= 6);
  check('no WebVTT for another account', await T.fillerVtt(LOOP, OTHER), null);

  // ---------------------------------------------------------------- 2. choosing
  console.log('== choosing the thumbnail ==');
  const pick = fa.poster_candidates[fa.poster_candidates.length - 1].key;
  check('a frame of this loop can be chosen', await T.setFillerPoster(LOOP, ACC, pick), true);
  check('a frame from elsewhere is refused', await T.setFillerPoster(LOOP, ACC, `derived/${ACC}/filler/${randomUUID()}/frame-00.jpg`), false);
  check('another account cannot choose', await T.setFillerPoster(LOOP, OTHER, pick), false);
  await T.buildFillerThumbs(LOOP);
  fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [LOOP]);
  check('a rebuild keeps the chosen frame', [fa.poster_key, fa.poster_source], [pick, 'manual']);
  check('a rebuild leaves the same number of sheets', (await query(`SELECT 1 FROM sprite_sheets WHERE filler_asset_id = $1`, [LOOP])).length, r.sheets);
  await T.autoFillerPoster(LOOP, ACC);
  fa = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [LOOP]);
  check('Pick automatically goes back to the best frame', [fa.poster_key, fa.poster_source], [(fa.poster_candidates.find((c: any) => !c.rejected) ?? fa.poster_candidates[0]).key, 'auto']);

  // ---------------------------------------------------------------- 3. a slate
  console.log('== a slate ==');
  const SLATE = await addFiller('slate', '.png', (p) => ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1', p]));
  await T.buildFillerThumbs(SLATE);
  let sl = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [SLATE]);
  check('slate thumbnail ready', sl.thumb_status, 'ready');
  check('slate size read', [sl.width, sl.height], [1920, 1080]);
  check('no frames and no sprites for a still', [sl.poster_candidates, sl.sprite], [null, null]);
  check('format says it is an image, with no container to name', [sl.probe?.video?.codec, sl.probe?.video?.still, sl.probe?.container], ['png', true, null]);
  check('container names by file type', [T.containerName('/x/a.mov', 'mov,mp4,m4a,3gp,3g2,mj2'), T.containerName('/x/a.mxf', 'mxf'), T.containerName('/x/a.ts', 'mpegts'), T.containerName('/x/a.mkv', 'matroska,webm')],
    ['QuickTime MOV', 'MXF', 'MPEG-TS', 'Matroska']);
  const first = sl.poster_key;
  await new Promise((res) => setTimeout(res, 5));
  await T.buildFillerThumbs(SLATE);
  sl = await one<any>(`SELECT * FROM filler_assets WHERE id = $1`, [SLATE]);
  check('a rebuild leaves one thumbnail, not two', [(await listAll(SLATE)).length, await store.exists(first), await store.exists(sl.poster_key)], [1, false, true]);
  check('no WebVTT for a slate', await T.fillerVtt(SLATE, ACC), null);

  // ---------------------------------------------------------------- 4. failures, sweep, delete
  console.log('== failures, the sweep and deleting ==');
  const GONE = randomUUID();
  await query(`INSERT INTO filler_assets(id, account_id, kind, name, status, source_key) VALUES ($1,$2,'loop','gone','ready',$3)`, [GONE, ACC, `filler/${ACC}/${GONE}.mp4`]);
  let why = ''; try { await T.buildFillerThumbs(GONE); } catch (e: any) { why = e.message; }
  truthy('a missing file fails with a reason', /missing/i.test(why));
  const UP = randomUUID();
  await query(`INSERT INTO filler_assets(id, account_id, kind, name, status) VALUES ($1,$2,'loop','uploading','uploading')`, [UP, ACC]);
  why = ''; try { await T.buildFillerThumbs(UP); } catch (e: any) { why = e.message; }
  truthy('one still uploading is refused', /uploading/.test(why));
  await query(`UPDATE filler_assets SET thumb_status = 'failed' WHERE id = $1`, [GONE]);
  const NEW = randomUUID();
  await query(`INSERT INTO filler_assets(id, account_id, kind, name, status, source_key) VALUES ($1,$2,'loop','new','ready',$3)`, [NEW, ACC, `filler/${ACC}/${NEW}.mp4`]);
  await J.sweepFillerThumbs();
  const queued = (await query<any>(`SELECT payload->>'fillerAssetId' AS id FROM jobs WHERE type = 'filler.thumbs'`)).map((x) => x.id).sort();
  check('the sweep queues only ready ones never tried', queued, [NEW]);
  await J.sweepFillerThumbs();
  check('and not twice', (await query(`SELECT 1 FROM jobs WHERE type = 'filler.thumbs'`)).length, 1);
  await T.deleteFillerThumbs(ACC, LOOP);
  await query(`DELETE FROM filler_assets WHERE id = $1`, [LOOP]);
  check('deleting removes every derived file', (await listAll(LOOP)).length, 0);
  check('and the inventory rows', (await query(`SELECT 1 FROM sprite_sheets WHERE filler_asset_id = $1`, [LOOP])).length, 0);

  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`filler-thumbs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
