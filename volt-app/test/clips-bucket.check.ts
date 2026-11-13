// ============================================================================
//  CLIPS CUT FROM RECORDED RUNS IN THE BUCKET (build queue 2.3c-2;
//  services/clips/resolveBucket.ts, jobs/handlers/clipExtract.ts and the clip,
//  re-trim, rebuild and export routes).
//
//  On AWS a stream's runs are only in s3://<bucket>/<kind>/<id>/runs/<runId>/
//  (2.2): the control plane's disk and the media-jobs task's disk hold none of
//  them, so every clip was refused with "Nothing is recorded". Against
//  Postgres, real packaged media (test/lib/make-fixture-runs.sh) and a
//  stand-in S3 client that records every call, this checks that:
//    - the bucket resolution places the same segments as the disk would, from
//      the decode time at the head of each object and the bucket's write time;
//    - it reads only the head of the segments the range can need, never a
//      whole segment, and lists the run once;
//    - a range across a restart has two blocks and a between-runs gap, a
//      missing segment is a missing-media gap refused unless accepted, nothing
//      in the bucket is no_media;
//    - a segment in archive storage is refused as media_archived, never read;
//    - an event's runs (event/<id>/) resolve the same way;
//    - the disk is asked first: a stream with runs on this machine never
//      touches the bucket;
//    - staging copies exactly the named files into scratch, byte for byte;
//    - the clip.extract job on AWS cuts a frame-accurate clip from the bucket,
//      the asset is ready and the scratch copy is gone afterwards;
//    - the routes resolve through the bucket-aware resolver.
//
//  Usage: DATABASE_URL=... npx tsx test/clips-bucket.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

const ROOT = join(tmpdir(), `volt-clipsb-${Date.now().toString(36)}`);
const EMPTY_ORIGIN = join(ROOT, 'origin');       // this machine's disk: no runs
const FIXTURE = join(ROOT, 'fixture');           // where the media is made
const SCRATCH = join(ROOT, 'scratch');
process.env.ORIGIN_DIR = EMPTY_ORIGIN;
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.VOD_SOURCE_CACHE_DIR = SCRATCH;
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.CLIPS_S3_UPLOAD = 'false';
const BUCKET = 'volt-origin-test';
// The encoder's uploader runs a pass every 2 s and a pass takes a few tenths
// of a second: an object lands at the next pass after the file was written.
const PASS_MS = 2000, PASS_PHASE_MS = 700, PASS_TAKES_MS = 300;
const landedAt = (written: number) => Math.ceil((written - PASS_PHASE_MS) / PASS_MS) * PASS_MS + PASS_PHASE_MS + PASS_TAKES_MS;

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

// ---- the stand-in bucket ----------------------------------------------------
type Obj = { body: Buffer; at: number; cls: string };
const bucket = new Map<string, Obj>();
const calls: { op: string; key?: string; prefix?: string; range?: string }[] = [];
const PAGE = 9;
function body(buf: Buffer): any {
  const r: any = Readable.from([buf]);
  r.transformToByteArray = async () => new Uint8Array(buf);
  return r;
}
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    switch (op) {
      case 'ListObjectsV2': {
        calls.push({ op, prefix: i.Prefix });
        const keys = [...bucket.keys()].filter((k) => k.startsWith(i.Prefix ?? '')).sort();
        const contents: string[] = []; const prefixes = new Set<string>();
        for (const k of keys) {
          const rest = k.slice((i.Prefix ?? '').length);
          if (i.Delimiter && rest.includes(i.Delimiter)) prefixes.add((i.Prefix ?? '') + rest.slice(0, rest.indexOf(i.Delimiter) + 1));
          else contents.push(k);
        }
        const items = [...contents.map((k) => ({ k })), ...[...prefixes].sort().map((p) => ({ p }))];
        const start = Number(i.ContinuationToken ?? 0); const page = items.slice(start, start + PAGE);
        const more = start + PAGE < items.length;
        return {
          // The bucket's clock is whole seconds.
          Contents: page.filter((x: any) => x.k).map((x: any) => { const o = bucket.get(x.k)!; return { Key: x.k, Size: o.body.length, LastModified: new Date(Math.floor(o.at / 1000) * 1000), StorageClass: o.cls }; }),
          CommonPrefixes: page.filter((x: any) => x.p).map((x: any) => ({ Prefix: x.p })),
          IsTruncated: more, NextContinuationToken: more ? String(start + PAGE) : undefined,
        };
      }
      case 'GetObject': {
        calls.push({ op, key: i.Key, range: i.Range });
        const o = bucket.get(i.Key);
        if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
        if (o.cls === 'GLACIER' || o.cls === 'DEEP_ARCHIVE') { const e: any = new Error('InvalidObjectState'); e.name = 'InvalidObjectState'; throw e; }
        let buf = o.body;
        const m = /^bytes=(\d+)-(\d+)$/.exec(i.Range ?? '');
        if (m) buf = buf.subarray(Number(m[1]), Number(m[2]) + 1);
        return { Body: body(buf), ContentLength: buf.length };
      }
      default: throw new Error(`stand-in S3 does not do ${op}`);
    }
  },
};

/** Put a stream's fixture runs into the bucket, as the uploader would: same keys, written a pass later. */
function upload(localStream: string, rootKey: string): string[] {
  const runs = readdirSync(join(localStream, 'runs')).sort();
  for (const run of runs) {
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r);
        else bucket.set(`${rootKey}runs/${run}/${r}`, { body: readFileSync(p), at: landedAt(statSync(p).mtimeMs), cls: 'STANDARD' });
      }
    };
    walk(join(localStream, 'runs', run), '');
  }
  return runs;
}
const probeMs = (p: string) => Math.round(parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', p], { encoding: 'utf8' }).trim()) * 1000);

(async () => {
  const { pool, one } = await import('../src/db');
  const { config } = await import('../src/config');
  const S = await import('../src/services/media/s3Runs');
  S.setS3RunsApi(fake);
  const { resolveRangeBucket, resolveRangeAny, assessRangeAny, stageResolution, resolvesFromBucket, runsForRange } = await import('../src/services/clips/resolveBucket');
  const { resolveRange, segmentCount } = await import('../src/services/clips/resolve');
  const { invalidateRunScan } = await import('../src/services/localRecordingIndex');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`clipsb-${tag}`]))!.id as string;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type) VALUES ($1,'T','[]','transcode') RETURNING id`, [acct]))!.id;
  const grp = (await one<any>(`INSERT INTO groups(account_id, name, output_profile_id) VALUES ($1,'G',$2) RETURNING id`, [acct, prof]))!.id as string;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, tz) VALUES ($1,'Bucket TV','UTC') RETURNING id`, [grp]))!.id as string;

  // ---- real media: two 24 s runs with a gap between them ---------------------
  const local = join(FIXTURE, ch);
  mkdirSync(FIXTURE, { recursive: true });
  const gen = spawnSync('bash', [join(__dirname, 'lib', 'make-fixture-runs.sh'), local, '2', '24'], { encoding: 'utf8' });
  if (gen.status !== 0) { console.log('SKIP could not generate fixture media (needs ffmpeg)', gen.stderr); console.log('\nclips-bucket: 0 passed, 0 failed (skipped)'); process.exit(0); }
  const runs = upload(local, `channel/${ch}/`);
  ok(runs.length === 2, 'two fixture runs uploaded under channel/<id>/runs/', runs);

  // The disk's view of the same media, for comparison: point the origin at
  // the fixture, resolve, point it back at the empty disk.
  const origin = config.testStream.originDir;
  (config.testStream as any).originDir = FIXTURE;
  const { recordingSpans } = await import('../src/services/localRecordingIndex');
  const spans = recordingSpans(ch);
  const span = spans[spans.length - 1];
  const from = Math.round(span.startMs + 5_400), to = Math.round(Math.min(span.endMs - 2_600, from + 14_000));
  const disk = resolveRange(ch, from, to, 'video');
  const both = resolveRange(ch, spans[0].startMs + 4_000, span.startMs + 6_000, 'video');
  (config.testStream as any).originDir = origin;
  invalidateRunScan(ch);
  ok(disk.blocks.length === 1 && disk.coveragePct === 100, 'the disk resolves the range (control)', disk.coveragePct);

  // ---- the bucket resolution ------------------------------------------------
  ok(resolvesFromBucket(ch), 'this machine has no run of the stream, so the bucket is asked');
  calls.length = 0;
  const r = await resolveRangeBucket(ch, from, to, 'video');
  ok(r.fromBucket === true && r.blocks.length === 1, 'one block from the bucket', r.blocks.length);
  ok(r.coveragePct === 100 && r.gaps.length === 0, 'full coverage, no gaps', { c: r.coveragePct, g: r.gaps });
  const dSegs = disk.blocks[0].segments, bSegs = r.blocks[0].segments;
  // The same segments as the disk, give or take one at an edge (placement can
  // differ by up to about 1.5 s: the uploader's pass and the bucket's clock).
  const common = bSegs.filter((s) => dSegs.some((d) => d.seq === s.seq));
  ok(common.length >= dSegs.length - 1 && Math.abs(bSegs.length - dSegs.length) <= 1, 'the same segments as the disk, at most one different at an edge', { b: bSegs.map((s) => s.seq), d: dSegs.map((s) => s.seq) });
  const dOf = (seq: number) => dSegs.find((d) => d.seq === seq)!;
  const drift = Math.max(...common.map((s) => Math.abs(s.startMs - dOf(s.seq).startMs)));
  ok(drift <= 1500, `each segment placed within 1.5 s of the disk's placement (${drift} ms)`, drift);
  ok(common.every((s) => Math.abs((s.endMs - s.startMs) - (dOf(s.seq).endMs - dOf(s.seq).startMs)) <= 1), 'the same measured durations (decode times from the object heads)');
  ok(bSegs.every((s) => s.path.startsWith(`s3://${BUCKET}/channel/${ch}/runs/${runs[1]}/360p/seg_`)), 'segment paths are keys in the second run\'s top video rendition');
  ok(r.blocks[0].initPath === `s3://${BUCKET}/channel/${ch}/runs/${runs[1]}/360p/init.mp4`, 'the run\'s own init segment');
  ok(r.blocks[0].segments[0].partial && r.blocks[0].segments[0].takeFromMs > 0, 'an off-grid start is trimmed, as on the disk');
  const gets = calls.filter((c) => c.op === 'GetObject');
  ok(gets.length > 0 && gets.every((c) => /^bytes=0-\d+$/.test(c.range ?? '')), 'only ranged reads of object heads, never a whole segment', gets.filter((c) => !c.range).map((c) => c.key));
  ok(gets.filter((c) => /seg_/.test(c.key ?? '')).length <= bSegs.length + 4 + Math.ceil(120_000 / 4000), 'at most the range, two neighbours each side and the upload window are read');
  ok(!calls.some((c) => (c.key ?? c.prefix ?? '').includes('/audio/') || (c.key ?? '').includes(runs[0])), 'not the audio rendition, not the earlier run');
  ok(calls.filter((c) => c.op === 'ListObjectsV2' && c.prefix === `channel/${ch}/runs/${runs[1]}/360p/`).length >= 1, 'the rendition is listed');

  // ---- a long run: only the range is read ----------------------------------
  // Two hours of a 24/7 channel (1,800 segments) in a later run; a 10 s clip
  // in the middle of it must not read the head of every segment.
  {
    const longStart = Math.ceil(span.endMs / 1000) * 1000 + 3_600_000;
    const runIdAt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const longRun = `channel/${ch}/runs/${runIdAt(longStart)}/360p/`;
    const segBody = bucket.get(`channel/${ch}/runs/${runs[1]}/360p/seg_1.m4s`)!.body;
    bucket.set(`${longRun}init.mp4`, { ...bucket.get(`channel/${ch}/runs/${runs[1]}/360p/init.mp4`)! });
    for (let i = 0; i < 1800; i++) bucket.set(`${longRun}seg_${i}.m4s`, { body: segBody, at: longStart + (i + 1) * 4000 + 500, cls: 'STANDARD' });
    calls.length = 0;
    const mid = longStart + 3_600_000;
    const rl = await resolveRangeBucket(ch, mid, mid + 10_000, 'video');
    const read = calls.filter((c) => c.op === 'GetObject' && (c.key ?? '').startsWith(longRun) && /seg_/.test(c.key ?? '')).length;
    ok(rl.blocks.length >= 1 && rl.coveredMs >= 9_000, 'a 10 s clip an hour into a two-hour run resolves', { b: rl.blocks.length, c: rl.coveredMs });
    ok(read > 0 && read <= 40, `only the segments the range can need are read (${read} of 1800)`, read);
    for (const k of [...bucket.keys()]) if (k.startsWith(`channel/${ch}/runs/${runIdAt(longStart)}/`)) bucket.delete(k);
  }

  // ---- across the restart ----------------------------------------------------
  const rb = await resolveRangeBucket(ch, both.requestedFromMs, both.requestedToMs, 'video');
  ok(rb.blocks.length === 2 && rb.runCount === 2, 'a range across the restart: two blocks, two runs', rb.blocks.length);
  ok(rb.gaps.some((g) => g.reason === 'between-runs'), 'with a between-runs gap', rb.gaps);
  ok(Math.abs(rb.coveragePct - both.coveragePct) <= 10, 'coverage close to the disk\'s', { b: rb.coveragePct, d: both.coveragePct });
  const refused = assessRangeAny(rb);
  ok(!refused.ok && (refused as any).code === 'coverage_gap', 'refused unless the gap is accepted', refused);
  const gapMs = rb.gaps.reduce((n, g) => n + g.ms, 0);
  ok(assessRangeAny(rb, { maxGapMs: gapMs + 1000 }).ok, 'accepted with the gap accepted');

  // ---- a missing segment -----------------------------------------------------
  const holeKey = `channel/${ch}/runs/${runs[1]}/360p/seg_${bSegs[1].seq}.m4s`;
  const hole = bucket.get(holeKey)!; bucket.delete(holeKey);
  const rh = await resolveRangeBucket(ch, from, to, 'video');
  ok(rh.gaps.some((g) => g.reason === 'missing-media') && rh.blocks.length === 2, 'a segment missing from the bucket is a missing-media gap', rh.gaps);
  ok(!assessRangeAny(rh).ok, 'and the range is refused');
  bucket.set(holeKey, hole);

  // ---- archive storage -------------------------------------------------------
  hole.cls = 'GLACIER';
  calls.length = 0;
  const ra = await resolveRangeBucket(ch, from, to, 'video');
  const va = assessRangeAny(ra);
  ok(!va.ok && (va as any).code === 'media_archived' && /Restore/.test((va as any).message), 'a segment in archive storage: refused as media_archived, restore first', va);
  ok(!calls.some((c) => c.op === 'GetObject' && c.key === holeKey), 'the archived segment is never read');
  hole.cls = 'STANDARD';

  // ---- nothing there ---------------------------------------------------------
  const rn = await resolveRangeBucket(ch, span.endMs + 3_600_000, span.endMs + 3_660_000, 'video');
  const vn = assessRangeAny(rn);
  ok(!vn.ok && (vn as any).code === 'no_media', 'an hour after the last run: no_media', vn);
  const unknown = await resolveRangeBucket('00000000-0000-0000-0000-00000000dead', from, to, 'video');
  ok(unknown.blocks.length === 0, 'a stream with no runs in the bucket resolves to nothing');

  // ---- audio, and an event's runs --------------------------------------------
  const rau = await resolveRangeBucket(ch, from, to, 'audio');
  ok(rau.blocks.length === 1 && rau.blocks[0].rendition === 'audio', 'an audio clip takes the audio rendition');
  const ev = '0000000e-0000-0000-0000-0000000000b5';
  for (const [k, v] of [...bucket.entries()]) if (k.startsWith(`channel/${ch}/`)) bucket.set(k.replace(`channel/${ch}/`, `event/${ev}/`), { ...v });
  const re = await resolveRangeBucket(ev, from, to, 'video');
  ok(re.blocks.length === 1 && re.blocks[0].initPath.includes(`/event/${ev}/runs/`), 'an event\'s runs resolve from event/<id>/');

  // ---- which runs ------------------------------------------------------------
  const ids = ['20261112T080000Z', '20261112T100000Z', '20261112T120000Z', '20261112T140000Z'];
  const t = (h: number) => Date.UTC(2026, 10, 12, h);
  ok(JSON.stringify(runsForRange(ids, t(11), t(13))) === JSON.stringify(ids.slice(1, 3)), 'runs for a range: the one running at its start and those starting inside it');
  ok(JSON.stringify(runsForRange(ids, t(7), t(7.5))) === '[]', 'none before the first run');

  // ---- the disk first --------------------------------------------------------
  (config.testStream as any).originDir = FIXTURE;
  calls.length = 0;
  const any = await resolveRangeAny(ch, from, to, 'video');
  ok(!any.fromBucket && any.blocks.length === 1 && !calls.length, 'a stream with runs on this disk resolves from the disk, the bucket untouched');
  (config.testStream as any).originDir = origin;
  invalidateRunScan(ch);
  const any2 = await resolveRangeAny(ch, from, to, 'video');
  ok(any2.fromBucket === true, 'without them, from the bucket');

  // ---- staging ---------------------------------------------------------------
  const st = await stageResolution(r, join(SCRATCH, 'stage-test'));
  const sb = st.resolution.blocks[0];
  ok(st.files === segmentCount(r) + 1, 'staging copies the named segments and the init, nothing else', st.files);
  ok(existsSync(sb.initPath) && sb.segments.every((s) => existsSync(s.path)), 'local paths that exist');
  ok(sb.segments.every((s, i) => readFileSync(s.path).equals(bucket.get(r.blocks[0].segments[i].path.replace(`s3://${BUCKET}/`, ''))!.body)), 'byte for byte the bucket objects');
  ok(sb.segments.every((s, i) => s.takeFromMs === r.blocks[0].segments[i].takeFromMs && s.startMs === r.blocks[0].segments[i].startMs), 'the placement and the cut points unchanged');
  await st.release();
  ok(!existsSync(join(SCRATCH, 'stage-test')), 'release removes the scratch copy');

  // ---- the job ---------------------------------------------------------------
  const { createClipVod } = await import('../src/services/clips');
  const { handleClipExtract } = await import('../src/services/jobs/handlers/clipExtract');
  const rec = await one<any>(
    `INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key, start_epoch_ms, end_epoch_ms, duration_ms, thumb_status)
     VALUES ('channel_day', $1, CURRENT_DATE, 'complete', '360p', $2, $3, $4, $5, 'ready') RETURNING *`,
    [ch, `channel/${ch}/day`, Math.floor(spans[0].startMs), Math.ceil(span.endMs), Math.ceil(span.endMs) - Math.floor(spans[0].startMs)]);
  const asset = await createClipVod({ ownerCol: 'channel_id', ownerId: ch, recordingId: rec.id, title: 'From the bucket', startMs: from, endMs: to, outputKind: 'both' as any, masterKeyBase: rec.master_key });
  const notes: string[] = [];
  const ctx: any = {
    job: { id: 'job-1', type: 'clip.extract', attempts: 1, max_attempts: 3, channel_id: ch, event_id: null,
      payload: { vodAssetId: asset.id, streamId: ch, fromMs: from, toMs: to, formats: ['mp4', 'hls'], kind: 'video', acceptGapsMs: 0 } },
    progress: async (_p: number, n?: string) => { if (n) notes.push(n); },
    isCancelled: () => false,
  };
  let err: any = null;
  try { await handleClipExtract(ctx); } catch (e) { err = e; }
  ok(!err, 'the clip.extract job runs on AWS', String(err?.stack ?? err));
  const after = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [asset.id]);
  ok(after?.media_state === 'ready' && after?.master_key === `/clips/${asset.id}/hls/index.m3u8`, 'the asset is ready with its HLS', { s: after?.media_state, k: after?.master_key });
  const mp4 = join(config.clips.dir, asset.id, 'clip.mp4');
  ok(existsSync(mp4), 'the MP4 is written');
  if (existsSync(mp4)) { const ms = probeMs(mp4); ok(Math.abs(ms - (to - from)) <= 300, `frame-accurate: ${ms} ms for ${to - from} ms asked`, ms); }
  ok(notes.some((n) => /from the bucket/.test(n)), 'the job says it fetched from the bucket', notes);
  ok(!existsSync(SCRATCH) || readdirSync(SCRATCH).length === 0, 'no scratch copy left behind', existsSync(SCRATCH) ? readdirSync(SCRATCH) : []);
  const prov = await one<any>(`SELECT count(*)::int AS n FROM clip_segments WHERE vod_asset_id = $1`, [asset.id]).catch(() => null);
  ok((prov?.n ?? 0) >= 1, 'provenance recorded for the clip', prov);

  // a job whose range is archived fails for good, with the reason on the asset
  hole.cls = 'GLACIER';
  const a2 = await createClipVod({ ownerCol: 'channel_id', ownerId: ch, recordingId: rec.id, title: 'Archived', startMs: from, endMs: to, outputKind: 'both' as any, masterKeyBase: rec.master_key });
  let e2: any = null;
  try { await handleClipExtract({ ...ctx, job: { ...ctx.job, payload: { ...ctx.job.payload, vodAssetId: a2.id } } }); } catch (e) { e2 = e; }
  const a2r = await one<any>(`SELECT media_state, media_error_code FROM vod_assets WHERE id = $1`, [a2.id]);
  ok(e2 && a2r?.media_state === 'failed' && a2r?.media_error_code === 'media_archived', 'an archived range fails the job with media_archived on the asset', a2r);
  hole.cls = 'STANDARD';

  // ---- the routes ------------------------------------------------------------
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');
  for (const p of ['modules/recordings.ts', 'modules/vod.ts']) {
    const s = src(p);
    ok(!/[^y]resolveRange\(streamId/.test(s) && (s.match(/await resolveRangeAny\(streamId/g) ?? []).length === 2 && (s.match(/assessRangeAny\(resolution/g) ?? []).length === 2,
      `${p}: the clip routes resolve through the bucket-aware resolver`);
  }

  console.log(`\nclips-bucket: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
