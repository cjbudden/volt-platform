// ============================================================================
//  A RECORDING'S EXACT FRAMES ON AWS READ THE BUCKET (build queue 2.3c-11;
//  services/frames/bucket.ts, store.ts streamFrameAt and streamFrameStill).
//
//  On AWS the encoder uploads its runs to s3://<bucket>/<kind>/<id>/runs/ and
//  the control plane's disk holds none, so GET /api/recordings/:id/frame said
//  "a gap in the capture" for every moment of every recording. Against a
//  stand-in S3 client holding a real CMAF video run (made with ffmpeg: 25 fps,
//  a picture that changes every frame, 2 s segments, B-frames), this checks
//  that:
//    - the route answers from the bucket: frame 137 is segment 2, frame 37,
//      5480 ms in, and the still is that frame of the source;
//    - the boundary between two segments falls where it does on the wall clock;
//    - the still is recorded like the Mac's (folder owned by the channel,
//      keyed by run and rendition), so retention and removal find it;
//    - the next frame of the same minute lists nothing and reads the
//      segment from memory; init.mp4 is read once;
//    - nothing is written into the origin folder on this disk;
//    - a moment in archive storage is refused with 409 saying to restore,
//      a hole in the capture is still 404;
//    - a stream with runs on this disk is read from the disk, the bucket not
//      asked.
//
//  Usage: DATABASE_URL=... npx tsx test/frames-bucket.check.ts   (needs ffmpeg)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const WORK = mkdtempSync(join(tmpdir(), 'volt-frames-bucket-'));
process.env.CLIPS_DIR = join(WORK, 'clips');
process.env.ORIGIN_DIR = join(WORK, 'origin');
process.env.IMAGE_STORE_DIR = join(WORK, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.CLIP_BUCKET_UPLOAD_LAG_MS = '0';
const BUCKET = 'volt-origin-test';
mkdirSync(process.env.CLIPS_DIR, { recursive: true });
mkdirSync(process.env.ORIGIN_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m: string, c: unknown, extra?: unknown) => {
  if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`)); }
};

const A = '00000000-0000-0000-0000-0000002c1a01';
const A2 = '00000000-0000-0000-0000-0000002c1a02';
const G = '00000000-0000-0000-0000-0000002c1b01';
const CH = '00000000-0000-0000-0000-0000002c1c01';
const CH2 = '00000000-0000-0000-0000-0000002c1c02';
const CH3 = '00000000-0000-0000-0000-0000002c1c03';
const U = '00000000-0000-0000-0000-0000002c1d01';
const U2 = '00000000-0000-0000-0000-0000002c1d02';
const REC = '00000000-0000-0000-0000-0000002c1e01';
const REC2 = '00000000-0000-0000-0000-0000002c1e02';
const REC3 = '00000000-0000-0000-0000-0000002c1e03';

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
      return { ContentLength: body.length, Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    throw new Error(`stand-in S3 does not do ${op}`);
  },
};

const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

// ---- media: 20 s, 25 fps, every frame different -------------------------------
const SRC = join(WORK, 'source.mp4');
ff(['-f', 'lavfi', '-i', "nullsrc=size=640x360:rate=25:duration=20,geq=lum='mod(2*X+41*N,256)':cb='mod(Y+3*N,256)':cr=128",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2', '-b:v', '1500k', SRC]);
const MAKE = join(WORK, 'run');
mkdirSync(MAKE, { recursive: true });
ff(['-i', SRC, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', join(MAKE, 'seg_%d.m4s'), join(MAKE, 'index.m3u8')]);
const SEGS = readdirSync(MAKE).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

const RUN = '20261102T120000Z';
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
/** A stream's run in the bucket, segment i uploaded when its content ended. */
function lay(streamId: string, cls: (i: number) => string = () => 'STANDARD') {
  const pre = `channel/${streamId}/runs/${RUN}/`;
  bucket.set(`${pre}720p/init.mp4`, { body: readFileSync(join(MAKE, 'init.mp4')), at: T0, cls: 'STANDARD' });
  for (const f of SEGS) {
    const i = Number(/\d+/.exec(f)![0]);
    bucket.set(`${pre}720p/${f}`, { body: readFileSync(join(MAKE, f)), at: T0 + (i + 1) * 2000, cls: cls(i) });
  }
  // The sound beside it, as a TV run has (keys only: never read here).
  bucket.set(`${pre}audio/init.mp4`, { body: Buffer.from('x'), at: T0, cls: 'STANDARD' });
  bucket.set(`${pre}index.m3u8`, { body: Buffer.from('#EXTM3U\n'), at: T0, cls: 'STANDARD' });
}

// ---- ground truth ------------------------------------------------------------
function truth(n: number): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', SRC, '-vf', `select=eq(n\\,${n}),scale=32:32,format=gray`,
    '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
}
function sigOf(jpg: Buffer): Buffer {
  const p = join(WORK, `sig-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(p, jpg);
  return execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'scale=32:32,format=gray', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 20 });
}
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

async function main() {
  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const { query, one, pool } = await import('../src/db');
  const { createServer } = await import('../src/server');
  const { signAccess } = await import('../src/auth/jwt');
  const { clearFrameBucketCache } = await import('../src/services/frames/bucket');
  const { listRuns } = await import('../src/services/localRecordingIndex');

  await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]);
  await query(`INSERT INTO accounts(id,name) VALUES ($1,'Frames bucket'),($2,'Other')`, [A, A2]);
  await query(`INSERT INTO groups(id,account_id,name,max_channels) VALUES ($1,$2,'g',10)`, [G, A]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$4,'fb-1','scheduled'),($2,$4,'fb-2','scheduled'),($3,$4,'fb-3','scheduled')`, [CH, CH2, CH3, G]);
  await query(`INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ($1,$2,'fb@test.local','x','admin','active'),($3,$4,'fb-other@test.local','x','admin','active')`, [U, A, U2, A2]);
  for (const [rec, ch] of [[REC, CH], [REC2, CH2], [REC3, CH3]]) {
    await query(`INSERT INTO recordings(id,kind,channel_id,title,status,start_epoch_ms,end_epoch_ms,duration_ms,day_utc) VALUES ($1,'channel_day',$2,'Noon',$3,$4,$5,20000,'2026-11-02')`,
      [rec, ch, 'complete', T0, T0 + 20000]);
  }
  lay(CH);

  const app = createServer();
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${signAccess({ sub: U, account_id: A, role: 'admin' } as any)}` };
  const H2 = { authorization: `Bearer ${signAccess({ sub: U2, account_id: A2, role: 'admin' } as any)}` };
  const get = async (p: string, h: Record<string, string> = H) => {
    const r = await fetch(base + p, { headers: h });
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ }
    return { status: r.status, j };
  };
  try {
    console.log('== a recording whose run is in the bucket ==');
    const rf = await get(`/api/recordings/${REC}/frame?n=137&w=320`);
    ok('frame 137 answers from the bucket: segment 2, frame 37, 5480 ms in, 00:00:05:12',
      rf.status === 200 && rf.j.frame === 137 && rf.j.segment.seq === 2 && rf.j.segment.frame === 37 && rf.j.segment.run === RUN
      && rf.j.segment.rendition === '720p' && Math.abs(rf.j.ms - 5480) < 0.5 && rf.j.timecode === '00:00:05:12' && rf.j.cache === 'made', rf);
    const row = await one<any>(`SELECT s.*, o.channel_id, o.logical_key, o.kind FROM frame_stills s JOIN media_objects o ON o.id = s.media_object_id WHERE s.store_key LIKE $1`, [`%/streams/${CH}/%2-37.jpg`]);
    const jpg = row ? readFileSync(join(process.env.IMAGE_STORE_DIR!, row.store_key)) : null;
    const m = jpg ? mad(sigOf(jpg), truth(137)) : 999;
    const nb = jpg ? mad(sigOf(jpg), truth(138)) : 0;
    ok(`the still is frame 137 of the source (MAD ${m.toFixed(2)} < 3) and not 138 (MAD ${nb.toFixed(2)})`, m < 3 && nb > Math.max(3, m * 3));
    ok('the still is recorded as on the Mac: folder owned by the channel, keyed by run and rendition',
      row?.kind === 'frame_stills' && row.channel_id === CH && row.logical_key === `frames/run/${RUN}/720p` && row.folder.endsWith(`/streams/${CH}/${RUN}/720p`), row);
    ok('only the picture rendition is read', !gets.some((g) => g.key.includes('/audio/') && !g.range), gets.filter((g) => g.key.includes('/audio/')));

    const atWall = await get(`/api/recordings/${REC}/frame?at=${T0 + 4000}`);
    const before4 = await get(`/api/recordings/${REC}/frame?at=${T0 + 3999}`);
    ok('across the segment boundary on the wall clock: 4000 ms is frame 100 (segment 2), 3999 ms frame 99 (segment 1)',
      atWall.j?.frame === 100 && atWall.j.segment.seq === 2 && atWall.j.segment.frame === 0
      && before4.j?.frame === 99 && before4.j.segment.seq === 1 && before4.j.segment.frame === 49, { a: atWall.j, b: before4.j });

    console.log('\n== stepping through a scene costs no listing ==');
    lists = 0; gets.length = 0;
    const next = await get(`/api/recordings/${REC}/frame?n=138`);
    ok('the next frame answers', next.status === 200 && next.j.frame === 138 && next.j.segment.seq === 2 && next.j.segment.frame === 38, next.j);
    ok('with no listing and no object read (window and segment kept)', lists === 0 && gets.length === 0, { lists, gets });
    const again = await get(`/api/recordings/${REC}/frame?n=137`);
    ok('a frame already made is served from the image store (cached)', again.j?.cache === 'cached', again.j);
    const initReads = () => gets.filter((g) => !g.range && g.key.endsWith('/720p/init.mp4')).length;
    gets.length = 0;
    clearFrameBucketCache();
    await get(`/api/recordings/${REC}/frame?n=300`);
    await get(`/api/recordings/${REC}/frame?n=420`);
    ok('init.mp4 is read once for frames in different segments', initReads() === 1, initReads());

    ok('nothing is written into the origin folder on this disk, so the stream is still read from the bucket',
      !existsSync(join(process.env.ORIGIN_DIR!, CH)) && listRuns(CH).length === 0, readdirSync(process.env.ORIGIN_DIR!));

    console.log('\n== refusals ==');
    ok('outside the recording: 404', (await get(`/api/recordings/${REC}/frame?ms=25000`)).status === 404);
    ok('another account: 404', (await get(`/api/recordings/${REC}/frame?n=1`, H2)).status === 404);

    // Segment 3 (6 to 8 s) in Glacier.
    lay(CH2, (i) => (i === 3 ? 'GLACIER' : 'STANDARD'));
    const arch = await get(`/api/recordings/${REC2}/frame?ms=7000`);
    ok('a moment in archive storage: 409 saying to restore the recording', arch.status === 409 && /archive/.test(arch.j?.error ?? '') && /restore/i.test(arch.j?.error ?? ''), arch);
    const beside = await get(`/api/recordings/${REC2}/frame?ms=9000`);
    ok('the moment beside it still answers', beside.status === 200 && beside.j.segment.seq === 4, beside.j);

    // A hole: segments 3 and 4 never uploaded.
    lay(CH3);
    bucket.delete(`channel/${CH3}/runs/${RUN}/720p/seg_3.m4s`);
    bucket.delete(`channel/${CH3}/runs/${RUN}/720p/seg_4.m4s`);
    const hole = await get(`/api/recordings/${REC3}/frame?ms=8000`);
    ok('a hole in the capture is still 404 (a gap), not 409', hole.status === 404 && /gap/.test(hole.j?.error ?? ''), hole);

    console.log('\n== the disk first ==');
    // CH has runs in the bucket; give CH2 a run on this disk too.
    const dir = join(process.env.ORIGIN_DIR!, CH2, 'runs', RUN, '720p');
    mkdirSync(dir, { recursive: true });
    for (const f of ['init.mp4', ...SEGS]) {
      writeFileSync(join(dir, f), readFileSync(join(MAKE, f)));
      const mm = /^seg_(\d+)\.m4s$/.exec(f);
      if (mm) { const t = (T0 + (Number(mm[1]) + 1) * 2000) / 1000; utimesSync(join(dir, f), t, t); }
    }
    clearFrameBucketCache();
    lists = 0; gets.length = 0;
    const disk = await get(`/api/recordings/${REC2}/frame?ms=7000`);
    ok('a stream with runs on this disk is read from the disk (the archived bucket copy is not asked)',
      disk.status === 200 && disk.j.segment.seq === 3 && lists === 0 && gets.length === 0, { disk: disk.j, lists, gets: gets.length });
  } finally {
    srv.close();
    await query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[A, A2]]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e); fail++; }).finally(() => {
  console.log(`\nframes-bucket: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
