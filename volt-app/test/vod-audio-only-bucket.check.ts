// ============================================================================
//  WHETHER A RECORDED ASSET IS SOUND ONLY, ON AWS (build queue 2.3c-5;
//  modules/vod.ts GET /api/vod/:id and GET /api/vod/:id/encode).
//
//  The asset detail says `audioOnly`, and the console puts up an audio player
//  or a video one on its word. It read the stream's run folders on this disk,
//  which on AWS hold nothing: every clip of an event or a station there was
//  called video (the encode tab knew a radio channel by its kind, the detail
//  did not even that). Against Postgres and a stand-in S3 client, this checks
//  that both answers (the detail's flag and the encode tab's deliveries) now come from isAudioOnlyAny: a radio channel by its kind,
//  an event by its newest run in the bucket, a TV channel stays video, and a
//  stream with nothing anywhere stays video.
//
//  Usage: DATABASE_URL=... npx tsx test/vod-audio-only-bucket.check.ts
// ============================================================================
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), `volt-vaob-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
const BUCKET = 'volt-origin-test';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

// ---- the stand-in bucket ----------------------------------------------------
const bucket = new Map<string, { size: number; at: number; body: string; type?: string }>();
const PAGE = 7;
const fake = {
  async send(cmd: any): Promise<any> {
    const op = cmd.constructor.name.replace(/Command$/, ''); const i = cmd.input ?? {};
    if (i.Bucket !== BUCKET) throw new Error(`wrong bucket ${i.Bucket}`);
    switch (op) {
      case 'ListObjectsV2': {
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
          Contents: page.filter((x: any) => x.k).map((x: any) => ({ Key: x.k, Size: bucket.get(x.k)!.size, LastModified: new Date(bucket.get(x.k)!.at), StorageClass: 'STANDARD' })),
          CommonPrefixes: page.filter((x: any) => x.p).map((x: any) => ({ Prefix: x.p })),
          IsTruncated: more, NextContinuationToken: more ? String(start + PAGE) : undefined,
        };
      }
      case 'PutObject':
        bucket.set(i.Key, { size: String(i.Body).length, at: Date.now(), body: String(i.Body), type: i.ContentType });
        return {};
      default: throw new Error(`stand-in S3 does not do ${op}`);
    }
  },
};
const runIdAt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
function bucketRun(root: string, runId: string, rends = ['720p', '360p', 'audio'], segs = 3) {
  const run = `${root}runs/${runId}/`;
  const put = (k: string) => bucket.set(k, { size: 100, at: Date.now(), body: 'x' });
  put(`${run}master_cc.m3u8`);
  for (const r of rends) {
    put(`${run}${r}/init.mp4`);
    for (let s = 1; s <= segs; s++) put(`${run}${r}/seg_${s}.m4s`);
    put(`${run}${r}/index.m3u8`);
  }
  put(`${run}thumbs/t_1.jpg`);
  put(`${run}filler/loop_720p_init.mp4`);
}

(async () => {
  const { setS3RunsApi } = await import('../src/services/media/s3Runs');
  setS3RunsApi(fake as any);
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`vaob-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `vaob-${tag}@example.com`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'VAOB') RETURNING id`, [acct]))!.id;
  const tv = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'VAOB TV') RETURNING id`, [g]))!.id;
  const radio = (await one<any>(`INSERT INTO channels(group_id, name, kind) VALUES ($1,'VAOB FM','radio') RETURNING id`, [g]))!.id;
  const now = Math.floor(Date.now() / 1000);
  const mkEvent = async (name: string) => (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,$2,'ended',to_timestamp($3),to_timestamp($4)) RETURNING id`, [g, name, now - 7200, now - 3600]))!.id;
  const evAudio = await mkEvent('VAOB podcast'), evVideo = await mkEvent('VAOB match'), evNone = await mkEvent('VAOB nothing');
  bucketRun(`event/${evAudio}/`, '20261113T001000Z', ['audio']);
  bucketRun(`event/${evVideo}/`, '20261113T001000Z', ['720p', 'audio']);
  bucketRun(`channel/${tv}/`, '20261113T000000Z', ['1080p', '720p', 'audio']);
  // an older run of the audio event that had a picture: the NEWEST run decides
  bucketRun(`event/${evAudio}/`, '20261112T231000Z', ['720p', 'audio']);
  const mkClip = async (col: 'channel_id' | 'event_id', id: string) => (await one<any>(
    `INSERT INTO vod_assets(${col}, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms)
     VALUES ($1,'clip','VAOB clip','/clips/x/master.m3u8',0,60000,60000) RETURNING id`, [id]))!.id;
  const cases: [string, string, boolean][] = [
    ['a radio station clip (by its kind)', await mkClip('channel_id', radio), true],
    ["an event whose newest run in the bucket has only the sound", await mkClip('event_id', evAudio), true],
    ['an event with a picture', await mkClip('event_id', evVideo), false],
    ['a TV channel clip', await mkClip('channel_id', tv), false],
    ['an event with nothing anywhere', await mkClip('event_id', evNone), false],
  ];
  const srv = createServer().listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const get = async (path: string) => { const r = await fetch(base + path, { headers: { authorization: `Bearer ${T}` } }); return { s: r.status, j: await r.json().catch(() => null) as any }; };
  try {
    for (const [what, id, want] of cases) {
      const d = await get(`/api/vod/${id}`);
      ok(d.s === 200 && d.j?.audioOnly === want, `detail: ${what} -> audioOnly ${want}`, [d.s, d.j?.audioOnly]);
      const e = await get(`/api/vod/${id}/encode`);
      // The encode tab shows it in its deliveries: "HLS (audio only)" and no MP4.
      const labels: string[] = (e.j?.deliveries ?? []).map((x: any) => x.label);
      const audioTab = labels.includes('HLS (audio only)') && !labels.some((l) => l.startsWith('MP4'));
      ok(e.s === 200 && labels.length > 0 && audioTab === want, `encode tab: ${what} -> ${want ? 'audio only, no MP4' : 'video, with an MP4'}`, [e.s, labels]);
    }
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
