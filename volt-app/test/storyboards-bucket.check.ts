// ============================================================================
//  STORYBOARDS AND ENCODER STILLS FROM THE BUCKET ON AWS (build queue 2.3c-12;
//  services/thumbnails/builder.ts, media/prune.ts removeDerivedImages,
//  media/s3Runs.ts pruneS3Run).
//
//  On AWS the encoder uploads its runs to s3://<bucket>/<kind>/<id>/runs/ and
//  the control plane's disk holds none, so the thumbnail pass found no stream
//  with material: no hover preview, sprite sheet, VTT or library still was
//  made there. And removing a run from the bucket left its stills and sheets
//  behind, showing pictures of media that no longer exists. Against a
//  stand-in S3 client holding a real CMAF run (ffmpeg: 2 minutes, 25 fps, every
//  frame different, 2 s segments), this checks that:
//    - the scheduler's pass finds the stream in the bucket and builds its
//      hour: tiles, sheets, the VTT and the library stills;
//    - a tile is the picture of its moment (the opening frame of the segment
//      covering it), not a neighbour's;
//    - only the lightest rendition tall enough is read (360p, not 1080p, not
//      the sound), only the segments a tile comes from, each once, init once;
//      nothing lands on this disk;
//    - a pass over a finished hour reads nothing; a running hour resolves only
//      the time still to fill, not the hour again;
//    - a segment in archive storage becomes a gap, not a failed pass;
//    - a stream with runs on this disk is built from the disk, the bucket not
//      asked;
//    - removing the run from the bucket takes its stills and sheets to the
//      restore bin, keeps what a clip was cut from, and a restore puts them
//      back.
//
//  Usage: DATABASE_URL=... npx tsx test/storyboards-bucket.check.ts   (needs ffmpeg)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'volt-storyboards-bucket-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
process.env.VOLT_TRASH_DIR = join(WORK, 'trash');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.CLIP_BUCKET_UPLOAD_LAG_MS = '0';
process.env.IMAGE_SIGNING_SECRET = 'storyboards-bucket-signing-secret-0123456789';
process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';
// Minute sheets so a 2 minute run fills whole ones: a tile every 6 s, 10 tiles a sheet, a still every minute.
process.env.THUMBS_TILE_INTERVAL_SEC = '6';
process.env.THUMBS_SHEET_COLS = '10';
process.env.THUMBS_SHEET_ROWS = '1';
process.env.THUMBS_FRAME_INTERVAL_SEC = '60';
process.env.THUMBS_FRAME_HEIGHT = '360';
process.env.THUMBS_LAG_SEC = '0';
const BUCKET = 'volt-origin-test';
mkdirSync(process.env.CLIPS_DIR, { recursive: true });
mkdirSync(process.env.ORIGIN_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m: string, c: unknown, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000002c2a01';
const G = '00000000-0000-0000-0000-0000002c2b01';
const CH = '00000000-0000-0000-0000-0000002c2c01';    // bucket, built by the pass, then removed
const CH2 = '00000000-0000-0000-0000-0000002c2c02';   // bucket, a running hour, then removed with a clip kept
const CH3 = '00000000-0000-0000-0000-0000002c2c03';   // runs on this disk
const CH4 = '00000000-0000-0000-0000-0000002c2c04';   // bucket, one segment archived

// ---- the stand-in bucket -----------------------------------------------------
const bucket = new Map<string, { body: Buffer; at: number; cls: string }>();
const gets: { key: string; range: boolean }[] = [];
let lists = 0;
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    if (op === 'ListObjectsV2') {
      lists++;
      const contents: string[] = []; const prefixes = new Set<string>();
      for (const k of [...bucket.keys()].filter((k) => k.startsWith(i.Prefix ?? '')).sort()) {
        const rest = k.slice((i.Prefix ?? '').length);
        if (i.Delimiter && rest.includes(i.Delimiter)) prefixes.add((i.Prefix ?? '') + rest.slice(0, rest.indexOf(i.Delimiter) + 1));
        else contents.push(k);
      }
      return {
        Contents: contents.map((k) => ({ Key: k, Size: bucket.get(k)!.body.length, LastModified: new Date(bucket.get(k)!.at), StorageClass: bucket.get(k)!.cls })),
        CommonPrefixes: [...prefixes].map((p) => ({ Prefix: p })), IsTruncated: false,
      };
    }
    if (op === 'GetObject') {
      const o = bucket.get(i.Key);
      gets.push({ key: i.Key, range: !!i.Range });
      if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
      if (o.cls === 'GLACIER' || o.cls === 'DEEP_ARCHIVE') { const e: any = new Error('InvalidObjectState'); e.name = 'InvalidObjectState'; throw e; }
      let body = o.body;
      const m = /^bytes=(\d+)-(\d+)$/.exec(i.Range ?? '');
      if (m) body = body.subarray(Number(m[1]), Number(m[2]) + 1);
      return { ContentLength: body.length, Body: { transformToByteArray: async () => new Uint8Array(body), transformToString: async () => body.toString() } };
    }
    if (op === 'DeleteObjects') {
      for (const o of i.Delete?.Objects ?? []) bucket.delete(o.Key);
      return { Errors: [] };
    }
    throw new Error(`stand-in S3 does not do ${op}`);
  },
};

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

// ---- media: 2 min, 25 fps, every frame different, a keyframe every segment ----
const SRC = join(WORK, 'source.mp4');
ff(['-f', 'lavfi', '-i', "nullsrc=size=320x180:rate=25:duration=120,geq=lum='mod(4*X+41*N,256)':cb='mod(Y+3*N,256)':cr=128",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-b:v', '600k', SRC]);
const MAKE = join(WORK, 'run');
mkdirSync(MAKE, { recursive: true });
ff(['-i', SRC, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', join(MAKE, 'seg_%d.m4s'), join(MAKE, 'index.m3u8')]);
const SEGS = readdirSync(MAKE).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

const RUN = '20261102T120000Z';
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
/** A stream's run in the bucket, segment i uploaded when its content ended, in two picture renditions and the sound. */
function lay(streamId: string, cls: (i: number) => string = () => 'STANDARD') {
  const pre = `channel/${streamId}/runs/${RUN}/`;
  for (const rend of ['360p', '1080p']) {
    bucket.set(`${pre}${rend}/init.mp4`, { body: readFileSync(join(MAKE, 'init.mp4')), at: T0, cls: 'STANDARD' });
    for (const f of SEGS) {
      const i = Number(/\d+/.exec(f)![0]);
      bucket.set(`${pre}${rend}/${f}`, { body: readFileSync(join(MAKE, f)), at: T0 + (i + 1) * 2000, cls: cls(i) });
    }
  }
  bucket.set(`${pre}audio/init.mp4`, { body: Buffer.from('x'), at: T0, cls: 'STANDARD' });
  bucket.set(`${pre}index.m3u8`, { body: Buffer.from('#EXTM3U\n'), at: T0, cls: 'STANDARD' });
}

// ---- ground truth ------------------------------------------------------------
function truth(n: number): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', SRC, '-vf', `select=eq(n\\,${n}),scale=32:32,format=gray`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
}
function sigOf(img: Buffer): Buffer {
  const p = join(WORK, `sig-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(p, img);
  return execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'scale=32:32,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
}
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

async function main() {
  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const { query, one, pool } = await import('../src/db');
  const B = await import('../src/services/thumbnails/builder');
  const { hourUnit } = await import('../src/services/thumbnails/naming');
  const { imageStore } = await import('../src/services/imageStore');
  const { restoreItem } = await import('../src/services/media/trash');
  const { listRuns } = await import('../src/services/localRecordingIndex');
  const sharp = (await import('sharp')).default;
  const segGets = (rend?: string) => gets.filter((g) => !g.range && /seg_\d+\.m4s$/.test(g.key) && (!rend || g.key.includes(`/${rend}/`)));

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Storyboards bucket')`, [A]);
  await query(`INSERT INTO groups(id,account_id,name,max_channels) VALUES ($1,$2,'g',10)`, [G, A]);
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ($1,$5,'sb-1','scheduled','UTC','tv'),($2,$5,'sb-2','scheduled','UTC','tv'),
    ($3,$5,'sb-3','scheduled','UTC','tv'),($4,$5,'sb-4','scheduled','UTC','tv')`, [CH, CH2, CH3, CH4, G]);
  lay(CH);
  try {
    console.log('== the pass finds a stream whose runs are only in the bucket ==');
    const r = await B.thumbnailPass(T0 + 60_000);
    const sb = await one<any>(`SELECT * FROM storyboards WHERE stream_id = $1`, [CH]);
    const tiles = (sb?.sheets ?? []).reduce((n: number, x: any) => n + x.filled.length, 0);
    ok('the pass built the stream from the bucket: one hour, 20 tiles (one every 6 s over 2 min)', r && r.streams >= 1 && sb && tiles === 20, { r, tiles });
    const withTiles = (sheets: any[]) => (sheets ?? []).filter((x: any) => x.filled.length);
    ok('two sheets of 10 tiles (the rest of the hour gaps), and the hour VTT, in the image store',
      withTiles(sb?.sheets).length === 2 && withTiles(sb?.sheets).every((x: any) => x.filled.length === 10) && await imageStore().exists(sb.sheets[0].key)
      && await imageStore().exists(sb.sheets[1].key) && await imageStore().exists(sb.vtt_key), withTiles(sb?.sheets));
    const stills = await query<any>(`SELECT * FROM media_files WHERE channel_id = $1 AND source = 'encoder' AND kind = 'keyframe' ORDER BY captured_at`, [CH]);
    ok('library stills on the minute: 12:00 and 12:01', stills.length === 2
      && new Date(stills[0].captured_at).getTime() === T0 && new Date(stills[1].captured_at).getTime() === T0 + 60_000, stills.map((s) => s.captured_at));
    const sprites = await one<any>(`SELECT count(*)::int AS n FROM sprite_sheets WHERE stream_id = $1`, [CH]).catch(() => null);
    ok('the sheets and the VTT are in the sprite inventory (3 rows)', sprites?.n === 3, sprites);

    // Tile 3 of sheet 0 is 18 s in: segment 9 opens on frame 450.
    const sheet = await imageStore().get(sb.sheets[0].key);
    const tile = sheet ? await sharp(sheet).extract({ left: 3 * 160, top: 0, width: 160, height: 90 }).jpeg().toBuffer() : null;
    const m = tile ? mad(sigOf(tile), truth(450)) : 999, nb = tile ? mad(sigOf(tile), truth(460)) : 0;
    ok(`the tile at 18 s is frame 450 of the source (MAD ${m.toFixed(2)} < 8), not frame 460 of the same segment (MAD ${nb.toFixed(2)})`, m < 8 && nb > m * 2);
    const still = await imageStore().get(stills[1]?.store_key ?? '-');
    const ms = still ? mad(sigOf(still), truth(1500)) : 999;
    ok(`the still at 1 min is frame 1500 of the source (MAD ${ms.toFixed(2)} < 4)`, ms < 4);

    ok('only the 360p rendition is read: no 1080p segment, nothing of the sound', segGets('1080p').length === 0
      && !gets.some((g) => g.key.includes('/1080p/') && !g.range) && !gets.some((g) => g.key.includes('/audio/') && !g.range), gets.filter((g) => !g.key.includes('/360p/')));
    const reads = segGets('360p').map((g) => g.key);
    ok('only the 20 segments a tile comes from are read whole, each once (not the 60 of the run)', reads.length === 20 && new Set(reads).size === 20, reads.length);
    const initWhole = gets.filter((g) => !g.range && g.key.endsWith('/360p/init.mp4')).length;
    ok('init.mp4 read whole once', initWhole === 1, initWhole);
    ok('nothing is written into the origin folder on this disk', !existsSync(join(process.env.ORIGIN_DIR!, CH)) && listRuns(CH).length === 0);

    console.log('\n== a finished hour costs nothing ==');
    gets.length = 0;
    await B.buildRange(CH, T0, T0 + 60_000);
    ok('building the same hour again reads no object', gets.length === 0, gets.length);

    console.log('\n== a running hour resolves only what is still to fill ==');
    lay(CH2);
    const s2 = (await B.streamInfo(CH2))!;
    const u = hourUnit(T0, 'UTC');
    ok('firstOpenSlot of nothing built is the hour start', B.firstOpenSlot([], u.start, T0 + 10_000, B.layoutOf()) === u.start);
    gets.length = 0;
    const first = await B.buildUnit(s2, u, T0 + 60_000, Date.now() + 60_000, T0 + 60_000);
    ok('the first minute: 10 tiles', first.tilesAdded === 10, first);
    const row2 = await one<any>(`SELECT sheets FROM storyboards WHERE stream_id = $1`, [CH2]);
    ok('then firstOpenSlot is 1 min in', B.firstOpenSlot(row2.sheets, u.start, T0 + 120_000, B.layoutOf()) === T0 + 60_000);
    gets.length = 0;
    const second = await B.buildUnit(s2, u, T0 + 120_000, Date.now() + 60_000, T0 + 120_000);
    const early = gets.filter((g) => { const n = /\/seg_(\d+)\.m4s$/.exec(g.key); return n && Number(n[1]) < 27; });
    const touched = new Set(gets.filter((g) => /seg_\d+\.m4s$/.test(g.key)).map((g) => g.key)).size;
    ok('the next minute: 10 more tiles', second.tilesAdded === 10, second);
    ok(`and the first minute's segments are not touched again (nothing before segment 27: only the few that measure the edge are headed; ${touched} of 60 touched)`, early.length === 0 && touched <= 34, early.map((g) => g.key));

    console.log('\n== a segment in archive storage ==');
    lay(CH4, (i) => (i === 9 ? 'GLACIER' : 'STANDARD'));
    const r4 = await B.buildRange(CH4, T0, T0 + 60_000);
    const sb4 = await one<any>(`SELECT sheets FROM storyboards WHERE stream_id = $1`, [CH4]);
    ok('the pass does not fail: 19 tiles, slot 3 (18 s) a gap', r4.tiles === 19 && (sb4?.sheets?.[0]?.skipped ?? []).includes(3) && !sb4.sheets[0].filled.includes(3), { r4, sb4 });

    console.log('\n== the disk first ==');
    const dir = join(process.env.ORIGIN_DIR!, CH3, 'runs', RUN, '360p');
    mkdirSync(dir, { recursive: true });
    for (const f of ['init.mp4', ...SEGS]) {
      writeFileSync(join(dir, f), readFileSync(join(MAKE, f)));
      const mm = /^seg_(\d+)\.m4s$/.exec(f);
      if (mm) { const t = (T0 + (Number(mm[1]) + 1) * 2000) / 1000; utimesSync(join(dir, f), t, t); }
    }
    lists = 0; gets.length = 0;
    const r3 = await B.buildRange(CH3, T0, T0 + 60_000);
    ok('a stream with runs on this disk is built from the disk, the bucket not asked', r3.tiles === 20 && lists === 0 && gets.length === 0, { r3, lists, gets: gets.length });

    console.log('\n== removing the run from the bucket takes its stills and sheets ==');
    const p1 = await S.pruneS3Run({ uri: `s3://${BUCKET}/channel/${CH}/runs/${RUN}/360p/`, streamId: CH, reason: 'retention', actor: 'test' });
    const left = await query<any>(`SELECT id FROM media_files WHERE channel_id = $1 AND source = 'encoder' AND kind = 'keyframe'`, [CH]);
    const sbAfter = await one<any>(`SELECT sheets FROM storyboards WHERE stream_id = $1`, [CH]);
    ok('the run is gone from the bucket', ![...bucket.keys()].some((k) => k.startsWith(`channel/${CH}/runs/${RUN}/`)));
    ok('both stills and both sheets with tiles went; the hour keeps no tile', p1?.stills === 2 && p1?.sheets === 2 && left.length === 0 && withTiles(sbAfter?.sheets).length === 0, { p1, left: left.length });
    ok('their files left the library for the restore bin', !(await imageStore().exists(stills[0].store_key)) && !(await imageStore().exists(stills[1].store_key))
      && !(await imageStore().exists(sb.sheets[0].key)) && !(await imageStore().exists(sb.sheets[1].key)));
    const item = await one<any>(`SELECT * FROM trash_items WHERE id = $1`, [p1?.binId ?? null]);
    ok('one bin item for the account, saying the media itself was removed from the bucket', item?.account_id === A && item.kind === 'recording_media' && /removed from the bucket/.test(item.label), item?.label);
    const back = await restoreItem(p1!.binId!, { accountId: A, by: 'test' });
    const sbBack = await one<any>(`SELECT sheets FROM storyboards WHERE stream_id = $1`, [CH]);
    ok('a restore puts the stills, the sheets and the hour back', back && await imageStore().exists(stills[0].store_key) && await imageStore().exists(sb.sheets[1].key)
      && withTiles(sbBack?.sheets).length === 2 && (await query<any>(`SELECT id FROM media_files WHERE channel_id = $1 AND source = 'encoder'`, [CH])).length === 2, { back, sbBack });

    console.log('\n== what a clip was cut from stays ==');
    const clip = (await one<any>(`INSERT INTO vod_assets(account_id, channel_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
        VALUES ($1,$2,'recording','clip','Goal',$3,$4,2000,'ready') RETURNING id`, [A, CH2, T0 + 62_000, T0 + 64_000]))!.id;
    await query(`INSERT INTO clip_segments(vod_asset_id, ordinal, run_id, rendition, first_seq, last_seq, segment_count, source_from_ms, source_to_ms, clip_offset_ms, duration_ms)
        VALUES ($1,0,$2,'360p',31,31,1,$3,$4,0,2000)`, [clip, RUN, T0 + 62_000, T0 + 64_000]);
    const sb2 = await one<any>(`SELECT * FROM storyboards WHERE stream_id = $1`, [CH2]);
    const p2 = await S.pruneS3Run({ uri: `s3://${BUCKET}/channel/${CH2}/runs/${RUN}/360p/`, streamId: CH2, reason: 'retention', actor: 'test' });
    const sb2After = await one<any>(`SELECT sheets FROM storyboards WHERE stream_id = $1`, [CH2]);
    const st2 = await query<any>(`SELECT captured_at FROM media_files WHERE channel_id = $1 AND source = 'encoder' AND kind = 'keyframe'`, [CH2]);
    ok('the sheet of the first minute went; the one the clip is in stays, with the hour', p2?.sheets === 1 && withTiles(sb2After?.sheets).length === 1
      && withTiles(sb2After.sheets)[0].start_ms === T0 + 60_000 && !(await imageStore().exists(sb2.sheets[0].key)) && await imageStore().exists(sb2.sheets[1].key), { p2, sb2After });
    ok('the still at 12:00 went, the one at 12:01 (by the clip) stays', p2?.stills === 1 && st2.length === 1 && new Date(st2[0].captured_at).getTime() === T0 + 60_000, st2);
  } finally {
    await query(`DELETE FROM accounts WHERE id = $1`, [A]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e); fail++; }).finally(() => {
  console.log(`\nstoryboards-bucket: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
