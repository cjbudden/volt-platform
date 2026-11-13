// ============================================================================
//  THE TIMELINE FILMSTRIP FROM THE BUCKET ON AWS (build queue 2.3c-13;
//  services/thumbs.ts, frames/store.ts streamSegmentStill).
//
//  The recordings timeline draws a strip of frames over a video stream's
//  media lane (GET /api/timeline/:id/thumbs). Its frames came from the run
//  folders on the task's disk and were written back into them, so on AWS,
//  where the encoder uploads its runs to the bucket and the disk holds none,
//  the strip was always empty. Against a stand-in S3 client holding a real
//  CMAF run (ffmpeg: 2 minutes, 25 fps, every frame different, 2 s
//  segments, in 360p and 1080p with the sound), this checks that:
//    - the strip fills from the bucket, each frame the opening picture of
//      the segment it names, at that segment's time;
//    - the frames are frame stills of the run in the image store (signed
//      image URLs, a frame_stills row each), not files on this disk;
//    - the segments come from the listing (no head reads), only the 360p
//      rendition is read, each frame's segment once; asking again reads
//      nothing and lists nothing;
//    - a segment in archive storage is never read;
//    - priming makes the frames of a whole window in the background;
//    - removing the run from the bucket takes its strip frames;
//    - a stream with runs on this disk is drawn from the disk as before, the
//      bucket not asked.
//
//  Usage: DATABASE_URL=... npx tsx test/thumbs-bucket.check.ts   (needs ffmpeg)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'volt-thumbs-bucket-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
process.env.VOLT_TRASH_DIR = join(WORK, 'trash');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.CLIP_BUCKET_UPLOAD_LAG_MS = '0';
process.env.IMAGE_SIGNING_SECRET = 'storyboards-bucket-signing-secret-0123456789';
process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';
process.env.COVERAGE_BUCKET_CACHE_MS = '30000';
// A request makes what it can in 4 s and leaves the rest to the primer; here every frame is counted, so no budget.
process.env.THUMBS_STRIP_BUDGET_MS = '60000';
const BUCKET = 'volt-origin-test';
mkdirSync(process.env.CLIPS_DIR, { recursive: true });
mkdirSync(process.env.ORIGIN_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m: string, c: unknown, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000002c3a01';
const G = '00000000-0000-0000-0000-0000002c3b01';
const CH = '00000000-0000-0000-0000-0000002c3c01';    // bucket: the strip, then the run removed
const CH2 = '00000000-0000-0000-0000-0000002c3c02';   // bucket: primed in the background
const CH3 = '00000000-0000-0000-0000-0000002c3c03';   // runs on this disk
const CH4 = '00000000-0000-0000-0000-0000002c3c04';   // bucket, one segment archived

// ---- the stand-in bucket -----------------------------------------------------
const bucket = new Map<string, { body: Buffer; at: number; cls: string }>();
const gets: { key: string; range: boolean }[] = [];
let lists = 0;
const listedPrefixes: string[] = [];
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    if (op === 'ListObjectsV2') {
      lists++; listedPrefixes.push(i.Prefix ?? '');
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
  const T = await import('../src/services/thumbs');
  const { clearCoverageCache } = await import('../src/services/clips/coverageBucket');
  const { imageStore } = await import('../src/services/imageStore');
  const { listRuns } = await import('../src/services/localRecordingIndex');
  const segGets = (rend?: string) => gets.filter((g) => !g.range && /seg_\d+\.m4s$/.test(g.key) && (!rend || g.key.includes(`/${rend}/`)));
  const keyOf = (url: string) => decodeURIComponent(url.slice(url.indexOf('/derived/') + 1));

  await query(`DELETE FROM accounts WHERE id = $1`, [A]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Thumbs bucket')`, [A]);
  await query(`INSERT INTO groups(id,account_id,name,max_channels) VALUES ($1,$2,'g',10)`, [G, A]);
  await query(`INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ($1,$5,'tb-1','scheduled','UTC','tv'),($2,$5,'tb-2','scheduled','UTC','tv'),
    ($3,$5,'tb-3','scheduled','UTC','tv'),($4,$5,'tb-4','scheduled','UTC','tv')`, [CH, CH2, CH3, CH4, G]);
  lay(CH);
  try {
    console.log('== a stream whose runs are only in the bucket ==');
    const strip = await T.thumbStrip(CH, T0, T0 + 120_000, 12);
    const filled = strip.thumbs.filter(Boolean);
    ok('the strip fills from the bucket: 12 of 12 frames, complete', filled.length === 12 && strip.complete && strip.pending === 0, { n: filled.length, pending: strip.pending });
    const t5 = strip.thumbs[5]!;
    ok('slot 5 (50 to 60 s) shows the segment nearest its centre: seg 27, placed at 54 s', t5 && t5.seq === 27 && t5.t === T0 + 54_000, t5);
    ok('the URLs are signed image URLs of frame stills of the run, not /origin paths',
      filled.every((t) => t!.url.startsWith('https://img.test/img/') && t!.url.includes(`/frames/streams/${CH}/${RUN}/360p/strip-`)), filled[0]?.url);
    const jpg = t5 ? await imageStore().get(keyOf(t5.url)) : null;
    const m = jpg ? mad(sigOf(jpg), truth(t5.seq * 50)) : 999, nb = jpg ? mad(sigOf(jpg), truth(t5.seq * 50 + 10)) : 0;
    ok(`the frame is the segment's opening picture: frame ${t5?.seq * 50} (MAD ${m.toFixed(2)} < 8), not ${t5?.seq * 50 + 10} (MAD ${nb.toFixed(2)})`, m < 8 && nb > m * 2);
    const rows = await query<any>(`SELECT s.store_key, o.logical_key, o.channel_id FROM frame_stills s JOIN media_objects o ON o.id = s.media_object_id WHERE s.store_key LIKE $1`, [`%/streams/${CH}/%strip-%`]);
    ok('each is recorded as a frame still of the run (12 rows, folder frames/run/<run>/360p, owned by the channel)',
      rows.length === 12 && rows.every((r) => r.logical_key === `frames/run/${RUN}/360p` && r.channel_id === CH), rows.length);
    ok('the segments were placed from the listing: no head read of any segment', !gets.some((g) => g.range && /seg_\d+\.m4s$/.test(g.key)));
    ok('only 360p is read, each frame\'s segment once (12 reads), nothing of 1080p or the sound',
      segGets('360p').length === 12 && new Set(segGets('360p').map((g) => g.key)).size === 12 && segGets('1080p').length === 0
      && !gets.some((g) => !g.range && (g.key.includes('/1080p/') || g.key.includes('/audio/'))), gets.filter((g) => !g.key.includes('/360p/')).map((g) => g.key));
    ok('nothing is written into the origin folder on this disk', !existsSync(join(process.env.ORIGIN_DIR!, CH)) && listRuns(CH).length === 0);

    gets.length = 0; lists = 0; listedPrefixes.length = 0;
    const again = await T.thumbStrip(CH, T0, T0 + 120_000, 12);
    ok(`asking again: the same 12 frames, nothing read, the segment listing kept (only ${lists} short folder listings)`, again.thumbs.filter(Boolean).length === 12 && gets.length === 0
      && !listedPrefixes.some((p) => p.endsWith('/360p/')) && lists <= 2 && again.thumbs[5]?.url === t5?.url, { gets: gets.length, listedPrefixes });

    console.log('\n== a segment in archive storage ==');
    lay(CH4, (i) => (i === 27 ? 'GLACIER' : 'STANDARD'));
    gets.length = 0;
    const s4 = await T.thumbStrip(CH4, T0, T0 + 120_000, 12);
    ok('it is never read; its slot takes the neighbouring segment and the strip is complete', !gets.some((g) => g.key.endsWith('/seg_27.m4s'))
      && s4.complete && s4.thumbs.filter(Boolean).length === 12 && [26, 28].includes(s4.thumbs[5]?.seq ?? -1), s4.thumbs.map((t) => t?.seq ?? null));

    console.log('\n== priming a window ==');
    lay(CH2);
    gets.length = 0;
    T.primeThumbs(CH2, T0, T0 + 120_000);
    for (let i = 0; i < 200 && T.isThumbPriming(CH2); i++) await new Promise((r) => setTimeout(r, 100));
    const primed = await one<any>(`SELECT count(*)::int AS n FROM frame_stills WHERE store_key LIKE $1`, [`%/streams/${CH2}/%strip-%`]);
    ok('priming made a frame for each of the 60 segments in the background', !T.isThumbPriming(CH2) && primed?.n === 60, primed);
    gets.length = 0;
    const full = await T.thumbStrip(CH2, T0, T0 + 120_000, 60);
    ok('a 60 frame strip of it is then complete with nothing read', full.complete && full.thumbs.filter(Boolean).length === 60 && segGets().length === 0, { n: full.thumbs.filter(Boolean).length, reads: segGets().length });

    console.log('\n== the disk first ==');
    const dir = join(process.env.ORIGIN_DIR!, CH3, 'runs', RUN, '360p');
    mkdirSync(dir, { recursive: true });
    for (const f of ['init.mp4', ...SEGS]) {
      writeFileSync(join(dir, f), readFileSync(join(MAKE, f)));
      const mm = /^seg_(\d+)\.m4s$/.exec(f);
      if (mm) { const t = (T0 + (Number(mm[1]) + 1) * 2000) / 1000; utimesSync(join(dir, f), t, t); }
    }
    lists = 0; gets.length = 0;
    const d = await T.thumbStrip(CH3, T0, T0 + 120_000, 12);
    ok('a stream with runs on this disk is drawn from the disk (/origin URLs), the bucket not asked',
      d.thumbs.filter(Boolean).length === 12 && d.thumbs.every((t) => t!.url.startsWith(`/origin/${CH3}/runs/${RUN}/thumbs/`)) && lists === 0 && gets.length === 0,
      { url: d.thumbs[0]?.url, lists, gets: gets.length });

    console.log('\n== removing the run from the bucket ==');
    const keys = rows.map((r) => r.store_key);
    await S.pruneS3Run({ uri: `s3://${BUCKET}/channel/${CH}/runs/${RUN}/360p/`, streamId: CH, reason: 'retention', actor: 'test' });
    const leftRows = await one<any>(`SELECT count(*)::int AS n FROM frame_stills WHERE store_key = ANY($1::text[])`, [keys]);
    const leftFiles = (await Promise.all(keys.map((k) => imageStore().exists(k)))).filter(Boolean).length;
    ok('the run\'s strip frames go with it: no row, no file', leftRows?.n === 0 && leftFiles === 0, { rows: leftRows?.n, files: leftFiles });
    clearCoverageCache();
    const after = await T.thumbStrip(CH, T0, T0 + 120_000, 12);
    ok('and the strip over that time is empty', after.thumbs.every((t) => t === null), after.thumbs.filter(Boolean).length);
  } finally {
    await query(`DELETE FROM accounts WHERE id = $1`, [A]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e); fail++; }).finally(() => {
  console.log(`\nthumbs-bucket: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
