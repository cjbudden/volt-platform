// ============================================================================
//  AN ORPHANED RECORDING CLOSES AT ITS LAST SEGMENT ON AWS (build queue 2.3c-9;
//  services/orchestrator/service.ts reconcileOrphanRecordings).
//
//  When a stream stops without its recording being closed (the encoder died,
//  the control plane restarted), the orchestrator's sweep closes the recording
//  at the newest segment it can find. It looked only on the task's disk, which
//  on AWS holds no run, so every orphan closed at now: a recording whose
//  encoder stopped hours ago got hours of nothing counted in its length and its
//  retention, and a hole that long on its timeline. Against Postgres and a
//  stand-in S3 client (listings only, as coverage-bucket), this checks a
//  channel and an event closing at their last segment, retention counted from
//  there, one with nothing in the bucket closing at now, and a live one left
//  open.
//
//  Usage: DATABASE_URL=... npx tsx test/orphan-close-bucket.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-ocb-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
const BUCKET = 'volt-origin-test';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const near = (a: number | null | undefined, b: number, tol: number) => a != null && Math.abs(a - b) <= tol;

// ---- the stand-in bucket: listings only --------------------------------------
const bucket = new Map<string, { size: number; at: number; cls: string }>();
const PAGE = 1000;
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    if (op !== 'ListObjectsV2') throw new Error(`the sweep must not ${op}`);
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
function bucketRun(root: string, start: number, count: number, rends: string[]) {
  const run = `${root}runs/${runIdAt(start)}/`;
  bucket.set(`${run}master_cc.m3u8`, { size: 1, at: start, cls: 'STANDARD' });
  for (const r of rends) {
    bucket.set(`${run}${r}/init.mp4`, { size: 1, at: uploadedAt(start), cls: 'STANDARD' });
    for (let n = 1; n <= count; n++) bucket.set(`${run}${r}/seg_${n}.m4s`, { size: 1, at: uploadedAt(start + n * 4000), cls: 'STANDARD' });
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

(async () => {
  const { setS3RunsApi } = await import('../src/services/media/s3Runs');
  setS3RunsApi(fake as any);
  const { pool, one } = await import('../src/db');
  const { Orchestrator } = await import('../src/services/orchestrator/service');
  const { MockTaskLauncher } = await import('../src/services/orchestrator/launcher');
  const T0 = Math.floor((Date.now() - 3 * 60 * MIN) / 1000) * 1000;
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`ocb-${tag}`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'OCB') RETURNING id`, [acct]))!.id;
  const ch = async (name: string, status: string) => (await one<any>(`INSERT INTO channels(group_id, name, status) VALUES ($1,$2,$3) RETURNING id`, [g, name, status]))!.id;
  const tv = await ch('OCB TV', 'ended');
  const none = await ch('OCB Empty', 'ended');
  const live = await ch('OCB Live', 'live');
  const ev = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'OCB match','ended',to_timestamp($2),to_timestamp($3)) RETURNING id`, [g, T0 / 1000, (T0 + 30 * MIN) / 1000]))!.id;

  // The encoder stopped 20 minutes in (2 h 40 min ago); the event's 10 minutes in.
  bucketRun(`channel/${tv}/`, T0, 300, ['720p', 'audio']);
  bucketRun(`event/${ev}/`, T0, 150, ['1080p', 'audio']);
  bucketRun(`channel/${live}/`, T0, 300, ['720p', 'audio']);

  const rec = async (col: 'channel_id' | 'event_id', id: string, retention: number | null) => (await one<any>(
    `INSERT INTO recordings(kind, ${col}, day_utc, status, start_epoch_ms, master_key, retention_days)
     VALUES ($1,$2,$3,'recording',$4,'x',$5) RETURNING id`,
    [col === 'event_id' ? 'event' : 'channel_day', id, col === 'event_id' ? null : new Date(T0).toISOString().slice(0, 10), T0, retention]))!.id;
  const rTv = await rec('channel_id', tv, 7);
  const rEv = await rec('event_id', ev, null);
  const rNone = await rec('channel_id', none, null);
  const rLive = await rec('channel_id', live, null);
  const row = (id: string) => one<any>(`SELECT status, end_epoch_ms::float8 AS e, duration_ms::float8 AS d, extract(epoch from expires_at)*1000 AS x FROM recordings WHERE id=$1`, [id]);

  try {
    const before = Date.now();
    const n = await new Orchestrator(new MockTaskLauncher()).reconcileOrphanRecordings();
    const after = Date.now();
    ok(n === 3, 'three orphans found (the live one is not)', n);

    console.log('== a channel whose encoder stopped 20 minutes in ==');
    const a = await row(rTv);
    ok(a?.status === 'complete', 'closed', a?.status);
    ok(near(a?.e, T0 + 20 * MIN, 3000), 'at its last segment, within 3 s, not at now', a && [a.e - T0, before - T0]);
    ok(near(a?.d, 20 * MIN, 3000), 'twenty minutes long', a?.d);
    ok(near(a?.x, a?.e + 7 * DAY, 1000), 'retention counted from the real end', a && [a.x - a.e]);

    console.log('\n== an event, one with nothing in the bucket, a live one ==');
    const e = await row(rEv);
    ok(e?.status === 'complete' && near(e?.e, T0 + 10 * MIN, 3000), "the event's runs, under event/: ten minutes", e && [e.status, e.e - T0]);
    const z = await row(rNone);
    ok(z?.status === 'complete' && z.e >= before - 1000 && z.e <= after + 1000, 'nothing in the bucket: closed at now, as before', z && [z.status, z.e - before]);
    const l = await row(rLive);
    ok(l?.status === 'recording' && l?.e == null, 'a live channel\'s recording stays open', l);
  } finally {
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
