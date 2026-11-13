// ============================================================================
//  WHERE VIEWERS SAW THE LOOP, ON AWS (build queue 2.3c-8;
//  GET /api/recordings/:id/timeline `fallbacks`, services/clips/coverageBucket.ts
//  recordingFallbacksBucket, localRecordingIndex.ts parsePlayoutLog).
//
//  When a source drops, the playout splice puts the channel's loop or slate on
//  air; the loop is never packaged, so the recording has a hole there, and the
//  encoder writes the splice to playout.jsonl in its run folder. The recording
//  page draws that as a marker over the hole and names the hole "on air: loop".
//  On AWS the route answered no markers at all: the file was only looked for on
//  the task's disk. The uploader takes the file up with the run, so it is at
//  runs/<runId>/playout.jsonl. Against Postgres and a stand-in S3 client (the
//  coverage-bucket one, with object bodies), this checks a loop over a missing
//  minute, a run that ended on a forced slate, a window that cuts a marker, a
//  station with no file, the log parser's rules, and that only the playout
//  files are read (never a segment).
//
//  Usage: DATABASE_URL=... npx tsx test/recording-fallbacks-bucket.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-rfb-${Date.now().toString(36)}`);
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
const bucket = new Map<string, { size: number; at: number; cls: string; body?: string }>();
const reads: string[] = [];
const PAGE = 1000;
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    if (op === 'GetObject') {
      reads.push(i.Key);
      const o = bucket.get(i.Key);
      if (!o) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
      return { Body: { transformToString: async () => o.body ?? '' } };
    }
    if (op !== 'ListObjectsV2') throw new Error(`the timeline must not ${op}`);
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
const uploadedAt = (t: number) => Math.floor((Math.ceil(t / 2000) * 2000 + 300) / 1000) * 1000;
/** A run of `count` 4 s segments from `start` in each rendition, minus `skip`; `playout` lines as the encoder writes them. */
function bucketRun(root: string, start: number, count: number, rends: string[], skip = new Set<number>(), playout?: object[] | string) {
  const run = `${root}runs/${runIdAt(start)}/`;
  bucket.set(`${run}master_cc.m3u8`, { size: 1, at: start, cls: 'STANDARD' });
  for (const r of rends) {
    bucket.set(`${run}${r}/init.mp4`, { size: 1, at: uploadedAt(start), cls: 'STANDARD' });
    for (let n = 1; n <= count; n++) {
      if (skip.has(n)) continue;
      bucket.set(`${run}${r}/seg_${n}.m4s`, { size: 1, at: uploadedAt(start + n * 4000), cls: 'STANDARD' });
    }
  }
  if (playout !== undefined) {
    const body = typeof playout === 'string' ? playout : playout.map((l) => JSON.stringify(l)).join('\n') + '\n';
    bucket.set(`${run}playout.jsonl`, { size: body.length, at: start, cls: 'STANDARD', body });
  }
}
const splice = (to: 'loop' | 'live', at: number, reason = 'source-lost', filler = 'loop') =>
  ({ type: 'splice', to, reason, filler, splice: 1, at_ms: at, wall_ms: at + 300 });

const MIN = 60_000;

(async () => {
  const { parsePlayoutLog } = await import('../src/services/localRecordingIndex');
  console.log('== the log parser ==');
  const p = parsePlayoutLog([
    'not json',
    JSON.stringify({ type: 'other', to: 'loop', at_ms: 1 }),
    JSON.stringify(splice('live', 50)),                   // back to live with nothing open: ignored
    JSON.stringify(splice('loop', 100)),
    JSON.stringify(splice('loop', 150)),                  // already on the loop: ignored
    JSON.stringify(splice('live', 400)),
    JSON.stringify({ type: 'splice', to: 'loop', at_ms: 'x' }),
    JSON.stringify(splice('loop', 900, 'forced', 'slate')),
  ].join('\n'));
  ok(p.closed.length === 1 && p.closed[0].fromMs === 100 && p.closed[0].toMs === 400 && !p.closed[0].open, 'one closed span, 100 to 400', p.closed);
  ok(p.open?.fromMs === 900 && p.open?.filler === 'slate' && p.open?.reason === 'forced' && p.open?.open === true, 'and one still open: a forced slate', p.open);

  const { setS3RunsApi } = await import('../src/services/media/s3Runs');
  setS3RunsApi(fake as any);
  const T0 = Math.floor((Date.now() - 3 * 60 * MIN) / 1000) * 1000;
  const T1 = T0 + 70 * MIN;
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { createServer } = await import('../src/server');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rfb-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `rfb-${tag}@example.com`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'RFB') RETURNING id`, [acct]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'RFB TV') RETURNING id`, [g]))!.id;
  const radio = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'RFB FM','radio') RETURNING id`, [g]))!.id;
  // A second channel with the same first run, for a recording that ends inside the
  // loop (one channel_day recording per channel and day).
  const tv2 = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'RFB TV 2') RETURNING id`, [g]))!.id;

  // TV: segments 451..465 missing (the source dropped for a minute at about 30 min)
  // and the loop on air over it; the restarted run ends on a forced slate it never
  // came back from. Junk in the log is skipped.
  bucketRun(`channel/${tv}/`, T0, 900, ['720p', 'audio'], new Set(Array.from({ length: 15 }, (_, i) => 451 + i)),
    [splice('loop', T0 + 30 * MIN + 1000), splice('live', T0 + 31 * MIN + 1000)]);
  bucketRun(`channel/${tv}/`, T1, 150, ['720p', 'audio'], new Set(),
    JSON.stringify(splice('loop', T1 + 9 * MIN, 'forced', 'slate')) + '\n{"type":"splice","to":"li');
  bucketRun(`channel/${radio}/`, T0, 450, ['audio']);
  bucketRun(`channel/${tv2}/`, T0, 900, ['720p', 'audio'], new Set(Array.from({ length: 15 }, (_, i) => 451 + i)),
    [splice('loop', T0 + 30 * MIN + 1000), splice('live', T0 + 31 * MIN + 1000)]);

  const rec = async (id: string, s: number, e: number) => (await one<any>(
    `INSERT INTO recordings(kind, channel_id, day_utc, status, start_epoch_ms, end_epoch_ms, duration_ms, master_key)
     VALUES ('channel_day',$1,$2,'complete',$3,$4,$5,'x') RETURNING id`,
    [id, new Date(s).toISOString().slice(0, 10), s, e, e - s]))!.id;
  const rTv = await rec(tv, T0, T0 + 80 * MIN);
  const rCut = await rec(tv2, T0, T0 + 30 * MIN + 31_000);
  const rRadio = await rec(radio, T0, T0 + 30 * MIN);

  const srv = createServer().listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const get = async (path: string) => { const res = await fetch(base + path, { headers: { authorization: `Bearer ${T}` } }); return { s: res.status, j: await res.json().catch(() => null) as any }; };
  try {
    console.log('\n== a TV recording: the loop over a missing minute, a run ending on a slate ==');
    const a = await get(`/api/recordings/${rTv}/timeline`);
    ok(a.s === 200, 'answered', a.s);
    const f = a.j?.fallbacks ?? [];
    ok(f.length === 2, 'two markers', f);
    ok(near(f[0]?.fromMs, T0 + 30 * MIN + 1000, 1) && near(f[0]?.toMs, T0 + 31 * MIN + 1000, 1) && f[0]?.filler === 'loop' && f[0]?.reason === 'source-lost' && f[0]?.open === false,
      'the loop, a minute, source lost, closed', f[0]);
    ok(near(f[1]?.fromMs, T1 + 9 * MIN, 1) && near(f[1]?.toMs, T1 + 10 * MIN, 3000) && f[1]?.filler === 'slate' && f[1]?.reason === 'forced' && f[1]?.open === true,
      'the slate, forced, open, lasting to the run\'s last segment (within 3 s)', f[1] && [f[1].fromMs - T1, f[1].toMs - T1, f[1].filler, f[1].open]);
    ok(near(a.j?.fallbackMs, 2 * MIN, 3000), 'about two minutes on air instead', a.j?.fallbackMs);
    const gaps = a.j?.gaps ?? [];
    ok(gaps[0]?.reason === 'missing-media' && gaps[0]?.onAir === 'loop' && gaps[0]?.onAirReason === 'source-lost', 'the missing minute is named: on air, the loop', gaps[0]);
    ok(gaps[1]?.reason === 'between-runs' && gaps[1]?.onAir === undefined, 'the gap between runs had nothing on air', gaps[1]);
    ok(near(a.j?.missingMs, 11 * MIN, 5000), 'missing media unchanged by the markers (about eleven minutes)', a.j?.missingMs);

    console.log('\n== a window that cuts the marker, a station with no log ==');
    const c = await get(`/api/recordings/${rCut}/timeline`);
    ok(c.s === 200 && c.j?.fallbacks?.length === 1 && near(c.j?.fallbacks?.[0]?.toMs, T0 + 30 * MIN + 31_000, 1) && near(c.j?.fallbacks?.[0]?.ms, 30_000, 1),
      'cut at the window: 30 s of it', c.j?.fallbacks);
    const r = await get(`/api/recordings/${rRadio}/timeline`);
    ok(r.s === 200 && (r.j?.fallbacks ?? []).length === 0 && r.j?.fallbackMs === 0, 'no playout.jsonl: no markers, and no error', [r.s, r.j?.fallbacks]);

    ok(reads.length > 0 && reads.every((k) => k.endsWith('/playout.jsonl')), 'only the playout logs are read, never a segment', reads.filter((k) => !k.endsWith('/playout.jsonl')));
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
