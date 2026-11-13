// ============================================================================
//  THE FULL-RECORDING TITLE PLAYS (build queue 2.3c-4;
//  services/media/fullRecordingVod.ts, POST /api/recordings/:id/publish,
//  clips.ts deriveEventVod).
//
//  Publish full VOD and an event's automatic replay gave the title the
//  recording's own master_key (`channel/<id>/<day>`, `event/<id>`), a layout
//  nothing writes, so the title was "ready", published, and played nothing on
//  the Mac or on AWS. Against Postgres, a temporary origin on disk and a
//  stand-in S3 client, this checks that:
//    - on the disk the title's playlists cover every run inside the
//      recording's window and no other, with a discontinuity and the run's own
//      init between runs, /origin/ addresses, and ENDLIST;
//    - a station's title is the audio alone;
//    - in the bucket (nothing on the disk) the runs that started inside the
//      window are taken, addressed through the CDN, never thumbnails or the
//      loop, and the top rendition plus audio only;
//    - the playlists are kept under CLIPS_DIR/<asset>/ and in the bucket at
//      clips/<asset>/, and master_key is /clips/<asset>/master.m3u8, which the
//      server answers;
//    - Publish full VOD and the automatic event replay both do it;
//    - a recording with no media keeps the title as it was (nothing to point at).
//
//  Usage: DATABASE_URL=... npx tsx test/full-recording-vod.check.ts
// ============================================================================
import { mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ROOT = join(tmpdir(), `volt-frv-${Date.now().toString(36)}`);
process.env.ORIGIN_DIR = join(ROOT, 'origin');
process.env.CLIPS_DIR = join(ROOT, 'clips');
process.env.IMAGE_STORE_DIR = join(ROOT, 'image-store');
process.env.MEDIA_STORE_DRIVER = 's3';
process.env.S3_BUCKET = 'volt-origin-test';
process.env.CDN_BASE_URL = 'https://cdn.volt.test';
const BUCKET = 'volt-origin-test';
const CDN = 'https://cdn.volt.test';

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
/** A run on the disk: segments written every 4 s from `at`, so they are placed there. */
function diskRun(streamId: string, runId: string, at: number, rends = ['720p', 'audio'], segs = 3) {
  for (const r of rends) {
    const dir = join(process.env.ORIGIN_DIR!, streamId, 'runs', runId, r);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'init.mp4'), 'init');
    for (let s = 0; s < segs; s++) {
      const f = join(dir, `seg_${s}.m4s`);
      writeFileSync(f, 'seg');
      const t = (at + (s + 1) * 4000) / 1000;
      utimesSync(f, t, t);
    }
  }
}
const uris = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#'));

(async () => {
  const { setS3RunsApi } = await import('../src/services/media/s3Runs');
  setS3RunsApi(fake as any);
  const F = await import('../src/services/media/fullRecordingVod');

  const HOUR = 3600_000;
  const t0 = Date.UTC(2026, 10, 12, 10, 0, 0);

  // ---- 1. on the disk -------------------------------------------------------
  const chA = randomUUID();
  const rBefore = runIdAt(t0 - 2 * HOUR), r1 = runIdAt(t0 + 60_000), r2 = runIdAt(t0 + HOUR), rAfter = runIdAt(t0 + 5 * HOUR);
  diskRun(chA, rBefore, t0 - 2 * HOUR);
  diskRun(chA, r1, t0 + 60_000);
  diskRun(chA, r2, t0 + HOUR);
  diskRun(chA, rAfter, t0 + 5 * HOUR);
  const recA = { id: randomUUID(), channel_id: chA, hi_res_rendition: '720p', start_epoch_ms: t0, end_epoch_ms: t0 + 2 * HOUR };
  const pa = await F.buildFullRecordingPackage(recA);
  ok(pa?.from === 'disk', 'disk: the segments are found on the disk first', pa?.from);
  const vu = uris(pa?.video ?? '');
  ok(vu.length === 6 && vu.every((u) => u.startsWith(`/origin/${chA}/runs/`)), 'disk: video covers the two runs inside the window (6 segments), /origin/ addresses', vu);
  ok(vu.slice(0, 3).every((u) => u.includes(`/runs/${r1}/720p/`)) && vu.slice(3).every((u) => u.includes(`/runs/${r2}/720p/`)), 'disk: in order, the earlier run first');
  ok(!vu.some((u) => u.includes(rBefore) || u.includes(rAfter)), 'disk: no run before or after the recording');
  ok((pa?.video ?? '').split('#EXT-X-DISCONTINUITY').length === 2, 'disk: one discontinuity between the two runs');
  ok((pa?.video ?? '').includes(`#EXT-X-MAP:URI="/origin/${chA}/runs/${r1}/720p/init.mp4"`) && (pa?.video ?? '').includes(`#EXT-X-MAP:URI="/origin/${chA}/runs/${r2}/720p/init.mp4"`), "disk: each run's own init");
  ok(/#EXT-X-PLAYLIST-TYPE:VOD/.test(pa?.video ?? '') && /#EXT-X-ENDLIST\n?$/.test(pa?.video ?? ''), 'disk: a VOD playlist with ENDLIST');
  ok(uris(pa?.audio ?? '').length === 6 && uris(pa?.audio ?? '').every((u) => u.includes('/audio/')), 'disk: the audio playlist too');
  ok(/URI="audio\.m3u8"/.test(pa?.master ?? '') && uris(pa?.master ?? '').join() === 'video.m3u8', 'disk: the master names video.m3u8 with the audio group', pa?.master);

  // a station: sound only
  const st = randomUUID(); const rs = runIdAt(t0 + 120_000);
  diskRun(st, rs, t0 + 120_000, ['audio']);
  const ps = await F.buildFullRecordingPackage({ id: randomUUID(), channel_id: st, hi_res_rendition: 'audio', start_epoch_ms: t0, end_epoch_ms: t0 + HOUR });
  ok(!!ps && ps.video === null && uris(ps.master).join() === 'audio.m3u8' && !/TYPE=AUDIO/.test(ps.master), "station: the audio alone is the title's variant", ps?.master);

  // ---- 2. in the bucket -------------------------------------------------------
  const ev = randomUUID(); const root = `event/${ev}/`;
  const b1 = runIdAt(t0 + 30_000), b2 = runIdAt(t0 + 40 * 60_000), bOut = runIdAt(t0 + 3 * HOUR), bEarly = runIdAt(t0 - HOUR);
  bucketRun(root, bEarly); bucketRun(root, b1); bucketRun(root, b2); bucketRun(root, bOut);
  bucketRun(`event/${randomUUID()}/`, b1);   // another stream, same run id
  const recB = { id: randomUUID(), event_id: ev, hi_res_rendition: '720p', start_epoch_ms: t0, end_epoch_ms: t0 + 2 * HOUR };
  const pb = await F.buildFullRecordingPackage(recB);
  ok(pb?.from === 'bucket', 'bucket: nothing on the disk, so the bucket is read', pb?.from);
  const bu = uris(pb?.video ?? '');
  ok(bu.length === 6 && bu.every((u) => u.startsWith(`${CDN}/event/${ev}/runs/`) && u.includes('/720p/')), 'bucket: the two runs inside the window, top rendition, through the CDN', bu);
  ok(!bu.some((u) => u.includes(bEarly) || u.includes(bOut)), 'bucket: no run before or after');
  ok(!(pb?.video ?? '').includes('thumbs/') && !(pb?.video ?? '').includes('filler/') && !(pb?.video ?? '').includes('/360p/'), 'bucket: never thumbnails, the loop or a lower rung');
  ok((pb?.video ?? '').includes(`#EXT-X-MAP:URI="${CDN}/event/${ev}/runs/${b2}/720p/init.mp4"`) && (pb?.video ?? '').split('#EXT-X-DISCONTINUITY').length === 2, "bucket: each run's init through the CDN, a discontinuity between runs");
  ok(uris(pb?.audio ?? '').length === 6 && uris(pb?.audio ?? '').every((u) => u.includes('/audio/')), 'bucket: the audio playlist');
  ok(!(pb?.video ?? '').includes('s3://'), 'bucket: no s3:// address reaches a viewer');

  ok(await F.buildFullRecordingPackage({ id: randomUUID(), event_id: randomUUID(), hi_res_rendition: '720p', start_epoch_ms: t0, end_epoch_ms: t0 + HOUR }) === null, 'nothing anywhere: null');

  const assetW = randomUUID();
  const w = await F.writeFullRecordingPackage(assetW, recB);
  ok(w?.masterKey === `/clips/${assetW}/master.m3u8`, 'write: master_key is the /clips path', w);
  ok(['master.m3u8', 'video.m3u8', 'audio.m3u8'].every((f) => existsSync(join(process.env.CLIPS_DIR!, assetW, f))), 'write: kept on the disk under CLIPS_DIR/<asset>/');
  ok(['master.m3u8', 'video.m3u8', 'audio.m3u8'].every((f) => bucket.get(`clips/${assetW}/${f}`)?.type === 'application/vnd.apple.mpegurl'), 'write: and in the bucket at clips/<asset>/');
  ok(await F.writeFullRecordingPackage('../../etc', recB) === null, 'write: an asset id that is not a uuid writes nothing');

  // ---- 3. the routes ----------------------------------------------------------
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`frv-${tag}`]))!.id;
  const user = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `frv-${tag}@example.com`]))!.id;
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'FRV') RETURNING id`, [acct]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'FRV News') RETURNING id`, [g]))!.id;
  const chEmpty = (await one<any>(`INSERT INTO channels(group_id, name) VALUES ($1,'FRV Empty') RETURNING id`, [g]))!.id;
  const evId = (await one<any>(`INSERT INTO events(group_id, name, status, scheduled_start, scheduled_end) VALUES ($1,'FRV Final','ended',to_timestamp($2),to_timestamp($3)) RETURNING id`, [g, t0 / 1000, (t0 + 2 * HOUR) / 1000]))!.id;
  diskRun(ch, r1, t0 + 60_000);
  bucketRun(`event/${evId}/`, b1);
  const mkRec = async (o: { channel_id?: string; event_id?: string }, day: string | null) => (await one<any>(
    `INSERT INTO recordings(channel_id, event_id, kind, status, start_epoch_ms, end_epoch_ms, duration_ms, master_key, day_utc, hi_res_rendition)
     VALUES ($1,$2,$3,'complete',$4,$5,$6,$7,$8,'720p') RETURNING *`,
    [o.channel_id ?? null, o.event_id ?? null, o.event_id ? 'event' : 'channel_day', t0, t0 + 2 * HOUR, 2 * HOUR,
      o.event_id ? `event/${o.event_id}` : `channel/${o.channel_id}/${day}`, day]))!;
  const recCh = await mkRec({ channel_id: ch }, '2026-11-12');
  const recEmpty = await mkRec({ channel_id: chEmpty }, '2026-11-12');
  const recEv = await mkRec({ event_id: evId }, null);

  const srv = createServer().listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const T = signAccess({ sub: user, account_id: acct, role: 'owner' });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  try {
    let r = await call('POST', `/api/recordings/${recCh.id}/publish`, { title: 'FRV full day' });
    ok(r.s === 201 && r.j?.kind === 'full_event', 'publish: 201, a full recording', r);
    const id = r.j?.id;
    const row = await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [id]);
    ok(row?.master_key === `/clips/${id}/master.m3u8`, 'publish: the title points at its own master, not the old layout', row?.master_key);
    ok(r.j?.master_key === `/clips/${id}/master.m3u8`, 'publish: and the answer says so', r.j?.master_key);
    const m = await fetch(`${base}/clips/${id}/master.m3u8`);
    const mt = await m.text();
    ok(m.status === 200 && /^#EXTM3U/.test(mt) && mt.includes('video.m3u8'), 'publish: the server answers the master', [m.status, mt.slice(0, 80)]);
    const v = await fetch(`${base}/clips/${id}/video.m3u8`); const vt = await v.text();
    ok(v.status === 200 && uris(vt).length === 3 && uris(vt).every((u) => u.startsWith(`/origin/${ch}/runs/${r1}/720p/`)), 'publish: and the video playlist over the recorded segments', uris(vt));
    const seg = await fetch(`${base}${uris(vt)[0]}`);
    ok(seg.status === 200, 'publish: the first segment it names is served by the origin', seg.status);

    r = await call('POST', `/api/recordings/${recEmpty.id}/publish`, {});
    const er = await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [r.j?.id]);
    ok(r.s === 201 && er?.master_key === `channel/${chEmpty}/2026-11-12`, 'publish: a recording with no media keeps the title as it was', [r.s, er?.master_key]);

    const { deriveEventVod } = await import('../src/services/clips');
    const auto = await deriveEventVod(recEv);
    const ar = await one<any>(`SELECT master_key FROM vod_assets WHERE id = $1`, [auto?.id]);
    ok(ar?.master_key === `/clips/${auto?.id}/master.m3u8`, 'automatic replay: the event title points at its own master', ar?.master_key);
    const avt = bucket.get(`clips/${auto?.id}/video.m3u8`)?.body ?? '';
    ok(uris(avt).length === 3 && uris(avt).every((u) => u.startsWith(`${CDN}/event/${evId}/runs/${b1}/720p/`)), 'automatic replay: from the bucket, through the CDN', uris(avt));
    ok(readFileSync(join(process.env.CLIPS_DIR!, auto?.id, 'audio.m3u8'), 'utf8').includes('/audio/seg_1.m4s'), 'automatic replay: the audio beside it');
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
