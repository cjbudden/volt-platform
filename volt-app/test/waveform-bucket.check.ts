// ============================================================================
//  THE WAVEFORM ON AWS READS THE BUCKET (build queue 2.3c-10;
//  services/waveform.ts audioSegments, readSrc, the bucket peak cache).
//
//  On AWS the encoder uploads its runs to s3://<bucket>/<kind>/<id>/runs/ and
//  the control plane's disk holds none, so the waveform behind the clipping
//  timeline found no audio and drew nothing. Against a stand-in S3 client
//  holding a real fMP4 audio run (made with ffmpeg: 4 s loud, 4 s quiet,
//  alternating), this checks that:
//    - a short window is measured exactly from the bucket, and the loud and
//      quiet seconds land where they are on the wall clock;
//    - a second look is served from memory with no GetObject;
//    - nothing is written to this disk: no .peaks.json, no run folder, so
//      the stream is still answered from the bucket afterwards;
//    - a wide window is sampled from the listing and complete;
//    - the background primer measures a bucket recording, after which the
//      exact window needs no GetObject;
//    - a segment in archive storage is a gap, not pending forever;
//    - init.mp4 is fetched once per run;
//    - a stream with runs on this disk is still read from the disk, the
//      bucket not asked.
//
//  Usage: npx tsx test/waveform-bucket.check.ts   (needs ffmpeg; no database)
// ============================================================================
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-wfb-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.CLIP_BUCKET_UPLOAD_LAG_MS = '0';
const BUCKET = 'volt-origin-test';
mkdirSync(process.env.ORIGIN_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

// key -> { body, modified, storageClass }
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

const RUN = '20261112T100000Z';
const BASE = Date.parse('2026-11-12T10:00:10Z');   // first segment's content starts here

(async () => {
  // ---- a real audio run, 10 segments of 4 s ---------------------------------
  const make = join(ROOT, 'make');
  mkdirSync(make, { recursive: true });
  const ff = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
    '-af', "volume='if(lt(mod(t,8),4),1.0,0.05)':eval=frame",
    '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg_%05d.m4s', '-hls_list_size', '0', 'live.m3u8',
  ], { cwd: make });
  if (ff.status !== 0) { console.log('SKIP ffmpeg unavailable or failed'); process.exit(0); }
  // The first ten: ffmpeg ends 40 s with a sliver of a segment, which an
  // encoder running live never uploads as if it were 4 s long.
  const files = readdirSync(make).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort().slice(0, 10);
  // Put a stream's run in the bucket: segment N uploaded when its content ended.
  const lay = (streamId: string, cls: (n: number) => string = () => 'STANDARD') => {
    const pre = `channel/${streamId}/runs/${RUN}/`;
    bucket.set(`${pre}audio/init.mp4`, { body: readFileSync(join(make, 'init.mp4')), at: BASE, cls: 'STANDARD' });
    files.forEach((f, n) => bucket.set(`${pre}audio/${f}`, { body: readFileSync(join(make, f)), at: BASE + (n + 1) * 4000, cls: cls(n) }));
    // A picture rendition beside it, as a TV run has (keys only: never read here).
    bucket.set(`${pre}720p/init.mp4`, { body: Buffer.from('x'), at: BASE, cls: 'STANDARD' });
  };

  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const W = await import('../src/services/waveform');
  const { listRuns } = await import('../src/services/localRecordingIndex');
  const { coverageFromBucket } = await import('../src/services/clips/coverageBucket');

  const from = BASE, to = BASE + files.length * 4000;
  const louder = (w: Awaited<ReturnType<typeof W.waveform>>, a: number, b: number) => {
    const pick = (t0: number, t1: number) => w.buckets.filter((x) => x && x.t >= t0 && x.t < t1).map((x) => x!.peak);
    const avg = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
    return { loud: avg(pick(a, a + 3000)), quiet: avg(pick(b, b + 3000)) };
  };

  // ---- exact, from the bucket -------------------------------------------------
  const st = '000000c1-0000-0000-0000-0000000000a1';
  lay(st);
  gets.length = 0;
  let w = await W.waveform(st, from, to, 200);
  ok(w.mode === 'exact' && w.complete && w.coverage?.measured === files.length, 'a short window is measured completely from the bucket', { mode: w.mode, complete: w.complete, coverage: w.coverage });
  ok(w.buckets.filter(Boolean).length >= 190, 'and every column drawn', w.buckets.filter(Boolean).length);
  // loud 0-4 s, quiet 4-8 s, loud 8-12 s on the wall clock (half a second in from each edge)
  const a = louder(w, from + 500, from + 4500);
  const b = louder(w, from + 8500, from + 12500);
  ok(a.loud > a.quiet * 5 && b.loud > b.quiet * 5, 'the loud seconds are drawn where they are on the wall clock', { a, b });
  const fullGets = gets.filter((g) => !g.range);
  ok(fullGets.filter((g) => g.key.endsWith('init.mp4')).length === 1, 'init.mp4 is fetched whole once for the run', fullGets.filter((g) => g.key.endsWith('init.mp4')).length);
  ok(fullGets.filter((g) => g.key.endsWith('.m4s')).length === files.length, 'each segment fetched whole once', fullGets.length);
  ok(!gets.some((g) => g.key.includes('/720p/') && !g.key.endsWith('init.mp4')), 'the picture rendition is not read');

  gets.length = 0;
  w = await W.waveform(st, from, to, 200);
  ok(w.complete && gets.filter((g) => !g.range).length === 0, 'a second look is served from memory, no object fetched', gets.filter((g) => !g.range));

  const z = await W.waveform(st, from + 10_000, from + 13_000, 300);
  ok(z.complete && z.buckets.filter(Boolean).length === 300, 'clip zoom (3 s) is filled from the cached envelope', z.buckets.filter(Boolean).length);

  ok(!existsSync(join(process.env.ORIGIN_DIR!, st)) && listRuns(st).length === 0, 'nothing written to this disk: no run folder, no .peaks.json', readdirSync(process.env.ORIGIN_DIR!));
  ok(coverageFromBucket(st), 'so the stream is still answered from the bucket');

  // ---- sampled, from the listing --------------------------------------------
  const st2 = '000000c1-0000-0000-0000-0000000000a2';
  lay(st2);
  const s = await W.waveform(st2, from - 3 * 3600e3, to + 3600e3, 400);
  ok(s.mode === 'sampled' && s.complete && s.pending === 0, 'a wide window is sampled from the listing and complete', { mode: s.mode, complete: s.complete, pending: s.pending, coverage: s.coverage });
  ok(s.buckets.filter(Boolean).length >= 1, 'with the recording drawn in it', s.buckets.filter(Boolean).length);

  // ---- the primer -------------------------------------------------------------
  const st3 = '000000c1-0000-0000-0000-0000000000a3';
  lay(st3);
  W.primeWaveformCache(st3, from, to);
  for (let i = 0; i < 40 && (W.isPriming(st3) || !W.primingProgress(st3)); i++) await new Promise((r) => setTimeout(r, 250));
  const p = W.primingProgress(st3);
  ok(!!p && p.total === files.length && p.measured === p.total, 'the primer measures a recording in the bucket', p);
  gets.length = 0;
  w = await W.waveform(st3, from, to, 200);
  ok(w.complete && gets.filter((g) => !g.range).length === 0, 'after priming, the exact window needs no object fetched', gets.filter((g) => !g.range));
  const c = louder(w, from + 500, from + 4500);
  ok(c.loud > c.quiet * 5, 'and the primed envelope is drawn in the right place', c);

  // ---- archive storage is a gap -------------------------------------------------
  const st4 = '000000c1-0000-0000-0000-0000000000a4';
  lay(st4, (n) => (n === 5 ? 'GLACIER' : 'STANDARD'));
  const g1 = await W.waveform(st4, from - 3 * 3600e3, to + 3600e3, 400);
  ok(g1.complete && g1.pending === 0, 'a sampled window with a segment in Glacier is complete, not pending', { complete: g1.complete, pending: g1.pending });
  const g2 = await W.waveform(st4, from, to, 200);
  ok(g2.complete && g2.pending === 0 && g2.coverage?.measured === files.length - 1, 'an exact window measures the rest and leaves the archived one as a gap', { complete: g2.complete, pending: g2.pending, coverage: g2.coverage });
  const gapT = from + 5 * 4000 + 2000;
  const gapCol = g2.buckets.find((x, i) => x == null && Math.abs(from + i * g2.bucketMs - gapT) < 1000) === null;
  ok(gapCol, 'the archived seconds are not drawn');
  gets.length = 0;
  await W.waveform(st4, from, to, 200);
  ok(!gets.some((g) => g.key.endsWith('seg_00005.m4s') && !g.range), 'and it is not asked for again straight away', gets);

  // ---- the disk first ---------------------------------------------------------
  const st5 = '000000c1-0000-0000-0000-0000000000a5';
  lay(st5);
  const dir = join(process.env.ORIGIN_DIR!, st5, 'runs', RUN, 'audio');
  mkdirSync(dir, { recursive: true });
  spawnSync('cp', [join(make, 'init.mp4'), ...files.slice(0, 3).map((f) => join(make, f)), dir]);
  gets.length = 0; lists = 0;
  const d = await W.waveform(st5, 0, 9e15, 100);
  ok(gets.length === 0 && lists === 0, 'a stream with runs on this disk is read from the disk, the bucket not asked', { gets: gets.length, lists });
  ok(d.buckets.filter(Boolean).length > 0, 'and drawn from it', d.buckets.filter(Boolean).length);

  rmSync(ROOT, { recursive: true, force: true });
  console.log(`waveform-bucket: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
