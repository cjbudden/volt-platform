// ============================================================================
//  WHAT IS RECORDED, FROM THE BUCKET LISTING, ON AWS (build queue 2.3c-6;
//  services/clips/coverageBucket.ts).
//
//  On AWS the control plane's disk holds no run folders, so every coverage
//  question read "nothing recorded": the schedule called every aired
//  programme Unavailable (no Convert to VOD), and the recordings timeline and
//  the schedule grid drew no media and no gaps. Against Postgres and a
//  stand-in S3 client holding a realistic upload pattern (4 s segments, the
//  uploader's 2 s passes, the bucket's whole-second clock, a missing minute,
//  a restart, some segments in Glacier), this checks that coverage now comes
//  from the listing alone (no object is read), lands within a few seconds of
//  the truth, is remembered briefly, and reaches the schedule's VOD states,
//  the coverage and timeline routes and the grid.
//
//  Usage: DATABASE_URL=... npx tsx test/coverage-bucket.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-covb-${Date.now().toString(36)}`);
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
  const { cadenceMs, coverageRangeBucket, coverageRangeAny, clearCoverageCache } = await import('../src/services/clips/coverageBucket');

  console.log('== the cadence of a run, from its uploads ==');
  const chain = (n: number, ms: number, from = 1) => Array.from({ length: n }, (_, i) => ({ seq: from + i, lastModified: uploadedAt(1_000_000_000 + (from + i) * ms) }));
  ok(near(cadenceMs(chain(900, 4000)), 4000, 5), '4 s segments read as 4 s', cadenceMs(chain(900, 4000)));
  ok(near(cadenceMs(chain(300, 6000)), 6000, 10), '6 s segments read as 6 s', cadenceMs(chain(300, 6000)));
  ok(near(cadenceMs(chain(600, 2000)), 2000, 5), '2 s segments read as 2 s', cadenceMs(chain(600, 2000)));
  ok(cadenceMs(chain(2, 6000)) === 4000, 'two segments are too few to say: the nominal 4 s');
  ok(near(cadenceMs([...chain(5, 6000), ...chain(400, 6000, 50)]), 6000, 10), 'the longest unbroken chain decides');

  const T0 = Math.floor((Date.now() - 3 * 60 * MIN) / 1000) * 1000;
  const T1 = T0 + 70 * MIN;
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { createServer } = await import('../src/server');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`covb-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `covb-${tag}@example.com`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'COVB') RETURNING id`, [acct]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'COVB TV') RETURNING id`, [g]))!.id;
  const radio = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'COVB FM','radio') RETURNING id`, [g]))!.id;
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'COVB match','ended',to_timestamp($2),to_timestamp($3)) RETURNING id`, [g, T0 / 1000, (T0 + 30 * MIN) / 1000]))!.id;

  // TV: an hour (900 segments) with segments 451..465 (one minute) missing,
  // then a restart at +70 min for ten minutes whose first ten are in Glacier.
  bucketRun(`channel/${tv}/`, T0, 900, ['720p', '360p', 'audio'], new Set(Array.from({ length: 15 }, (_, i) => 451 + i)));
  bucketRun(`channel/${tv}/`, T1, 150, ['720p', '360p', 'audio'], new Set(), new Set(Array.from({ length: 10 }, (_, i) => 1 + i)));
  bucketRun(`channel/${radio}/`, T0, 450, ['audio']);
  bucketRun(`event/${ev}/`, T0, 300, ['1080p', 'audio']);

  console.log('\n== coverage from the listing ==');
  calls.length = 0;
  // A minute inside each end, so the window's edges are not left to the
  // second-level jitter of the placement.
  const r = await coverageRangeBucket(tv, T0 + MIN, T0 + 79 * MIN, 'video');
  ok(calls.every((c) => c.op === 'ListObjectsV2'), 'nothing but listings', [...new Set(calls.map((c) => c.op))]);
  ok(calls.length <= 12, `a few listings for 1,050 segments (${calls.length})`, calls.length);
  ok(r.blocks.length === 3, 'three blocks: the hole splits the first run, the restart starts the third', r.blocks.length);
  ok(r.blocks.every((b) => b.rendition === '720p'), 'the top rendition', r.blocks.map((b) => b.rendition));
  ok(near(r.blocks[0]?.startMs, T0 + 15 * 4000, 5000), 'the first block starts with the segment holding the window start (within 3 s)', r.blocks[0]?.startMs - T0);
  ok(near(r.blocks[0]?.endMs, T0 + 450 * 4000, 3000), 'and ends where the missing minute begins', r.blocks[0]?.endMs - (T0 + 450 * 4000));
  ok(near(r.blocks[1]?.startMs, T0 + 465 * 4000, 3000), 'the second starts after it', r.blocks[1]?.startMs - (T0 + 465 * 4000));
  ok(near(r.blocks[1]?.endMs, T0 + 60 * MIN, 3000), 'and ends with the run', r.blocks[1]?.endMs - (T0 + 60 * MIN));
  ok(near(r.blocks[2]?.startMs, T1, 3000) && near(r.blocks[2]?.endMs, T1 + 9 * MIN, 5000), 'the restarted run, placed', [r.blocks[2]?.startMs - T1, r.blocks[2]?.endMs - T1]);
  const gaps = r.gaps.map((x) => x.reason).join(',');
  ok(gaps === 'missing-media,between-runs', 'a missing-media gap and a between-runs gap', gaps);
  ok(near(r.gaps[0]?.ms, MIN, 3000), 'the missing minute is a minute', r.gaps[0]?.ms);
  ok(near(r.gaps[1]?.ms, 10 * MIN, 3000), 'the restart gap is ten minutes', r.gaps[1]?.ms);
  ok(near(r.coveragePct, 85.9, 0.2), 'coverage 85.9 % (67 of 78 minutes)', r.coveragePct);
  ok(r.archivedSegments === 10, 'cold segments are counted as recorded, and reported', r.archivedSegments);
  ok(r.blocks[0].segments[0].path.startsWith(`s3://${BUCKET}/channel/${tv}/runs/`), 'segment addresses are in the bucket', r.blocks[0].segments[0].path);
  const a = await coverageRangeBucket(tv, T0, T0 + 10 * MIN, 'audio');
  ok(a.blocks[0]?.rendition === 'audio' && near(a.coveragePct, 100, 0.5), 'audio coverage from the audio rendition', [a.blocks[0]?.rendition, a.coveragePct]);
  const e = await coverageRangeBucket(ev, T0 - MIN, T0 + 21 * MIN, 'video');
  ok(e.blocks[0]?.rendition === '1080p' && near(e.coveredMs, 20 * MIN, 3000), "an event's runs, under event/", [e.blocks[0]?.rendition, e.coveredMs]);
  const none = await coverageRangeBucket(tv, T0 - 5 * 60 * MIN, T0 - 4 * 60 * MIN, 'video');
  ok(none.blocks.length === 0 && none.coveragePct === 0 && none.gaps[0]?.reason === 'no-recording', 'before anything was recorded: nothing, said so', [none.blocks.length, none.gaps[0]?.reason]);
  const any = await coverageRangeAny(tv, T0, T0 + 10 * MIN, 'video');
  ok((any as any).measured === 'listing', 'with no runs on this disk the bucket answers');

  console.log('\n== remembered briefly ==');
  calls.length = 0;
  await coverageRangeBucket(tv, T0 + MIN, T0 + 79 * MIN, 'video');
  const segLists = () => calls.filter((c) => /\/720p\/$/.test(c.prefix ?? '')).length;
  ok(segLists() === 0, 'asked again at once: the renditions are not listed again', segLists());
  clearCoverageCache(); calls.length = 0;
  await coverageRangeBucket(tv, T0 + MIN, T0 + 79 * MIN, 'video');
  ok(segLists() === 2, 'after the cache is cleared they are', segLists());

  // ---- through the routes ---------------------------------------------------
  const at = (ms: number) => new Date(ms).toISOString();
  const prog = async (title: string, s: number, en: number) => (await one<any>(
    `INSERT INTO programmes(channel_id, title, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,'aired') RETURNING id`, [tv, title, at(s), at(en)]))!.id;
  const pWhole = await prog('Inside the first run', T0 + 5 * MIN, T0 + 25 * MIN);
  const pHole = await prog('Across the missing minute', T0 + 29 * MIN, T0 + 33 * MIN);
  const pGone = await prog('Between the runs', T0 + 61 * MIN, T0 + 69 * MIN);
  const now = Date.now();
  const pNext = (await one<any>(`INSERT INTO programmes(channel_id, title, starts_at, ends_at, status) VALUES ($1,'Later',$2,$3,'scheduled') RETURNING id`, [tv, at(now + 60 * MIN), at(now + 120 * MIN)]))!.id;

  const srv = createServer().listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const get = async (path: string) => { const res = await fetch(base + path, { headers: { authorization: `Bearer ${T}` } }); return { s: res.status, j: await res.json().catch(() => null) as any }; };
  try {
    console.log('\n== the schedule: what each aired programme can become ==');
    const vs = await get(`/api/epg/vod-status?channelId=${tv}&from=${encodeURIComponent(at(T0))}&to=${encodeURIComponent(at(now + 3 * 60 * MIN))}`);
    const st = (id: string) => vs.j?.programmes?.[id];
    ok(vs.s === 200, 'answered', vs.s);
    ok(st(pWhole)?.state === 'convertible' && near(st(pWhole)?.coveragePct, 100, 0.5), 'a programme inside the recording is Convertible, fully covered', [st(pWhole)?.state, st(pWhole)?.coveragePct]);
    ok(st(pHole)?.state === 'convertible' && near(st(pHole)?.coveragePct, 75, 2), 'one across the missing minute is Convertible at about 75 %', [st(pHole)?.state, st(pHole)?.coveragePct]);
    ok(st(pGone)?.state === 'unavailable', 'one between the runs is Unavailable', st(pGone)?.state);
    ok(st(pNext)?.state === 'manual', 'one still to air is unchanged (Manual)', st(pNext)?.state);

    console.log('\n== the recordings timeline ==');
    const cov = await get(`/api/channels/${tv}/coverage?from=${T0 + MIN}&to=${T0 + 79 * MIN}`);
    ok(cov.s === 200 && near(cov.j?.coveragePct, 85.9, 0.2), 'coverage route: 85.9 %', [cov.s, cov.j?.coveragePct]);
    ok(cov.j?.runs?.length === 3 && cov.j?.gaps?.length === 2, 'three spans and two gaps', [cov.j?.runs?.length, cov.j?.gaps?.length]);
    const tl = await get(`/api/channels/${tv}/timeline?from=${T0 + MIN}&to=${T0 + 79 * MIN}`);
    ok(tl.s === 200 && tl.j?.media?.runs?.length === 3 && near(tl.j?.media?.coveragePct, 85.9, 0.2), "the timeline's media lane", [tl.s, tl.j?.media?.runs?.length, tl.j?.media?.coveragePct]);
    const rc = await get(`/api/channels/${radio}/coverage?from=${T0}&to=${T0 + 30 * MIN}`);
    ok(rc.s === 200 && rc.j?.runs?.[0]?.rendition === 'audio' && near(rc.j?.coveragePct, 100, 0.5), "a station's coverage is its audio", [rc.s, rc.j?.runs?.[0]?.rendition, rc.j?.coveragePct]);

    console.log('\n== the schedule grid ==');
    const gr = await get(`/api/timeline/grid?from=${encodeURIComponent(at(T0 + MIN))}&to=${encodeURIComponent(at(T0 + 79 * MIN))}`);
    const row = (gr.j?.rows ?? []).find((x: any) => x.id === tv);
    ok(gr.s === 200 && row?.media?.runs?.length === 3, 'the TV row draws three spans', [gr.s, row?.media?.runs?.length]);
    ok((row?.media?.gaps ?? []).some((x: any) => x.reason === 'between-runs'), 'and the restart gap', row?.media?.gaps);
    const gp = (row?.programmes ?? []).find((x: any) => x.id === pWhole);
    ok(gp?.vodState === 'convertible', "a programme block's VOD state", gp?.vodState);
    const sl = await get(`/api/timeline/selection?kind=channel&id=${tv}&from=${T0 + 5 * MIN}&to=${T0 + 10 * MIN}`);
    ok(sl.s === 200 && sl.j?.clippable === true, 'a dragged range inside the recording is clippable', [sl.s, sl.j?.clippable, sl.j?.reason]);
    const sg = await get(`/api/timeline/selection?kind=channel&id=${tv}&from=${T0 + 62 * MIN}&to=${T0 + 68 * MIN}`);
    ok(sg.s === 200 && sg.j?.clippable === false && sg.j?.reason?.code === 'no_media', 'one between the runs is not, and says why', [sg.s, sg.j?.clippable, sg.j?.reason?.code]);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
