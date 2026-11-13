// ============================================================================
//  A RECORDING'S TIMELINE FROM THE BUCKET, ON AWS (build queue 2.3c-7;
//  GET /api/recordings/:id/timeline, services/clips/coverageBucket.ts
//  recordingTimelineBucket).
//
//  The recording page draws the recording's spans and its holes from that
//  route. It read the run folders on the task's disk, which on AWS hold
//  nothing: every recording showed no media, one hole the length of the
//  recording and no sound. Against Postgres and the same stand-in S3 client
//  as coverage-bucket (4 s segments, the uploader's 2 s passes, a missing
//  minute, a restart), this checks the spans, the named holes, a recording
//  still being made, a station, an event and a recording with nothing.
//
//  Usage: DATABASE_URL=... npx tsx test/recording-timeline-bucket.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-rtlb-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
const BUCKET = 'volt-origin-test';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const near = (a: number | null | undefined, b: number, tol: number) => a != null && Math.abs(a - b) <= tol;

// ---- the stand-in bucket ----------------------------------------------------
const bucket = new Map<string, { size: number; at: number; cls: string }>();
const calls: { op: string; prefix?: string }[] = [];
const PAGE = 1000;
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    calls.push({ op, prefix: i.Prefix });
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    // The loop markers (2.3c-8) read each run's playout.jsonl; these runs have none.
    if (op === 'GetObject' && String(i.Key).endsWith('/playout.jsonl')) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
    if (op !== 'ListObjectsV2') throw new Error(`coverage must not ${op}`);
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
      Contents: page.filter((x: any) => x.k).map((x: any) => { const o = bucket.get(x.k)!; return { Key: x.k, Size: o.size, LastModified: new Date(o.at), StorageClass: o.cls }; }),
      CommonPrefixes: page.filter((x: any) => x.p).map((x: any) => ({ Prefix: x.p })),
      IsTruncated: more, NextContinuationToken: more ? String(start + PAGE) : undefined,
    };
  },
};
const runIdAt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
/** When the uploader puts a file written at `t`: the next 2 s pass, a few tenths later, in whole seconds. */
const uploadedAt = (t: number) => Math.floor((Math.ceil(t / 2000) * 2000 + 300) / 1000) * 1000;
/**
 * A run of `count` 4 s segments starting at `start`, numbered from 1, in each
 * rendition, minus `skip` (missing on purpose); `cold` are in Glacier.
 */
function bucketRun(root: string, start: number, count: number, rends: string[], skip = new Set<number>(), cold = new Set<number>()) {
  const run = `${root}runs/${runIdAt(start)}/`;
  bucket.set(`${run}master_cc.m3u8`, { size: 1, at: start, cls: 'STANDARD' });
  for (const r of rends) {
    bucket.set(`${run}${r}/init.mp4`, { size: 1, at: uploadedAt(start), cls: 'STANDARD' });
    for (let n = 1; n <= count; n++) {
      if (skip.has(n)) continue;
      bucket.set(`${run}${r}/seg_${n}.m4s`, { size: 1, at: uploadedAt(start + n * 4000), cls: cold.has(n) ? 'GLACIER' : 'STANDARD' });
    }
    bucket.set(`${run}${r}/index.m3u8`, { size: 1, at: uploadedAt(start + count * 4000), cls: 'STANDARD' });
  }
}

const MIN = 60_000;

(async () => {
  const { setS3RunsApi } = await import('../src/services/media/s3Runs');
  setS3RunsApi(fake as any);
  const T0 = Math.floor((Date.now() - 3 * 60 * MIN) / 1000) * 1000;
  const T1 = T0 + 70 * MIN;
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { createServer } = await import('../src/server');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rtlb-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `rtlb-${tag}@example.com`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'RTLB') RETURNING id`, [acct]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'RTLB TV') RETURNING id`, [g]))!.id;
  const radio = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'RTLB FM','radio') RETURNING id`, [g]))!.id;
  const live = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'RTLB Live') RETURNING id`, [g]))!.id;
  const empty = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'RTLB Empty') RETURNING id`, [g]))!.id;
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'RTLB match','ended',to_timestamp($2),to_timestamp($3)) RETURNING id`, [g, T0 / 1000, (T0 + 30 * MIN) / 1000]))!.id;

  bucketRun(`channel/${tv}/`, T0, 900, ['720p', '360p', 'audio'], new Set(Array.from({ length: 15 }, (_, i) => 451 + i)));
  bucketRun(`channel/${tv}/`, T1, 150, ['720p', '360p', 'audio']);
  bucketRun(`channel/${radio}/`, T0, 450, ['audio']);
  bucketRun(`event/${ev}/`, T0, 300, ['1080p', 'audio']);
  // still being made: started 20 minutes ago, the last segment a few seconds old
  const L0 = Math.floor((Date.now() - 20 * MIN) / 1000) * 1000;
  bucketRun(`channel/${live}/`, L0, 298, ['720p', 'audio']);

  const rec = async (col: 'channel_id' | 'event_id', id: string, s: number, e: number | null, status = 'complete') => (await one<any>(
    `INSERT INTO recordings(kind, ${col}, day_utc, status, start_epoch_ms, end_epoch_ms, duration_ms, master_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'x') RETURNING id`,
    [col === 'event_id' ? 'event' : 'channel_day', id, col === 'event_id' ? null : new Date(s).toISOString().slice(0, 10), status, s, e, e == null ? null : e - s]))!.id;
  const rTv = await rec('channel_id', tv, T0, T0 + 80 * MIN);
  const rRadio = await rec('channel_id', radio, T0, T0 + 30 * MIN);
  const rEv = await rec('event_id', ev, T0, T0 + 20 * MIN);
  const rLive = await rec('channel_id', live, L0, null, 'recording');
  const rEmpty = await rec('channel_id', empty, T0, T0 + 10 * MIN);

  const srv = createServer().listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const get = async (path: string) => { const res = await fetch(base + path, { headers: { authorization: `Bearer ${T}` } }); return { s: res.status, j: await res.json().catch(() => null) as any }; };
  try {
    console.log('== a TV recording with a missing minute and a restart ==');
    const a = await get(`/api/recordings/${rTv}/timeline`);
    ok(a.s === 200, 'answered', a.s);
    ok(a.j?.spans?.length === 2, 'two runs, two spans', a.j?.spans?.length);
    ok(near(a.j?.spans?.[0]?.startMs, T0, 3000) && near(a.j?.spans?.[0]?.endMs, T0 + 60 * MIN, 3000), 'the first run, start and end within 3 s', [a.j?.spans?.[0]?.startMs - T0, a.j?.spans?.[0]?.endMs - T0]);
    ok(near(a.j?.spans?.[1]?.startMs, T1, 3000) && near(a.j?.spans?.[1]?.endMs, T1 + 10 * MIN, 3000), 'the restarted run', [a.j?.spans?.[1]?.startMs - T1, a.j?.spans?.[1]?.endMs - T1]);
    ok(a.j?.spans?.[0]?.segments === 885 && a.j?.spans?.[1]?.segments === 150, 'segment counts (900 less the missing 15, and 150)', a.j?.spans?.map((s: any) => s.segments));
    const reasons = (a.j?.gaps ?? []).map((x: any) => x.reason).join(',');
    ok(reasons === 'missing-media,between-runs', 'the holes, named: missing media, then between runs', reasons);
    ok(near(a.j?.gaps?.[0]?.ms, MIN, 3000) && near(a.j?.gaps?.[1]?.ms, 10 * MIN, 3000), 'a minute and ten minutes', a.j?.gaps?.map((x: any) => x.ms));
    ok(near(a.j?.missingMs, 11 * MIN, 5000), 'missing about eleven minutes in all', a.j?.missingMs);
    ok(a.j?.hasAudio === true && a.j?.audioOnly === false, 'sound and picture', [a.j?.hasAudio, a.j?.audioOnly]);
    ok(a.j?.live === false && a.j?.endMs === T0 + 80 * MIN, 'the recording window as stored', [a.j?.live, a.j?.endMs]);

    console.log('\n== a station, an event, one still recording, one with nothing ==');
    const r2 = await get(`/api/recordings/${rRadio}/timeline`);
    ok(r2.s === 200 && r2.j?.audioOnly === true && r2.j?.spans?.length === 1 && (r2.j?.gaps ?? []).length === 0, 'a station: sound only, one span, no holes', [r2.s, r2.j?.audioOnly, r2.j?.spans?.length, r2.j?.gaps]);
    const e2 = await get(`/api/recordings/${rEv}/timeline`);
    ok(e2.s === 200 && e2.j?.spans?.length === 1 && e2.j?.audioOnly === false && (e2.j?.gaps ?? []).length === 0, "an event's runs, under event/", [e2.s, e2.j?.spans?.length, e2.j?.gaps]);
    const l2 = await get(`/api/recordings/${rLive}/timeline`);
    ok(l2.s === 200 && l2.j?.live === true && l2.j?.spans?.length === 1, 'still recording: one span', [l2.s, l2.j?.live, l2.j?.spans?.length]);
    ok((l2.j?.gaps ?? []).length === 0, 'and the edge still to be written is not a hole', l2.j?.gaps);
    const n2 = await get(`/api/recordings/${rEmpty}/timeline`);
    ok(n2.s === 200 && (n2.j?.spans ?? []).length === 0 && n2.j?.gaps?.[0]?.reason === 'no-recording' && near(n2.j?.missingMs, 10 * MIN, 10), 'nothing in the bucket: no spans, the whole window missing', [n2.s, n2.j?.spans, n2.j?.gaps]);
    ok(n2.j?.hasAudio === false, 'and no sound', n2.j?.hasAudio);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
