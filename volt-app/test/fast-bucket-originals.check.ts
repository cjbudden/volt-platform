// ============================================================================
//  FAST COUNTS BUCKET ORIGINALS (build queue 2.1a-2b-5). On AWS an upload's
//  original lives in the bucket (s3://<bucket>/vod-src/...), and Prepare
//  fetches it for the job. The FAST library used to read any s3:// original as
//  "no source", so a title not yet packaged for splicing could not be picked
//  for a channel there. Now the library uses the readiness check's own test
//  (media/vodSource.ts vodSourceAvailable): a bucket original under vod-src/
//  counts, a local file counts when it is on this disk, and a missing file or
//  an s3:// address outside vod-src/ still reads as no source.
//    DATABASE_URL=... npx tsx test/fast-bucket-originals.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${w}] got [${g}]`); fail++ }
};

(async () => {
  const { createServer } = await import('../src/server');
  const { pool, one } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { libraryFor, libraryForMedia, sourceOnServer } = await import('../src/services/fast/store');
  const { vodSourceAvailable } = await import('../src/services/media/vodSource');
  const tag = Date.now().toString(36);
  const work = mkdtempSync(join(tmpdir(), 'fbo-'));
  const local = join(work, 'here.mp4'); writeFileSync(local, 'x');
  const BUCKET = 'volt-origin-test';

  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`fbo-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `fbo-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' });
  const g = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [a]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, tz, kind, origin, fast_media) VALUES ($1,'Films','ended','UTC','tv','playlist','video') RETURNING id`, [g]))!.id;
  // Not splice-ready (no zeroStart): only its original decides whether it can air.
  const asset = async (title: string, sourceKey: string | null, zeroStart = false) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, source_key, start_epoch_ms, end_epoch_ms, duration_ms, encode_result, qc_state)
     VALUES ($1,'upload','export',$2,$3,$4,0,0,1800000,$5::jsonb,'pass') RETURNING id`,
    [a, title, `/clips/vod/${title}/master.m3u8`, sourceKey, JSON.stringify({ zeroStart, segmentSeconds: 4 })]))!.id as string;
  const inBucket = await asset('Bucket', `s3://${BUCKET}/vod-src/2026/11/bucket.mp4`);
  const onDisk = await asset('Disk', local);
  const gone = await asset('Gone', join(work, 'missing.mp4'));
  const foreign = await asset('Foreign', `s3://${BUCKET}/filler/acct/x.mp4`);
  const none = await asset('None', null);
  const ready = await asset('Ready', null, true);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (path: string) => {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${tok}` } });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };

  try {
    check('the test the FAST library uses is the readiness check\'s test',
      [sourceOnServer(`s3://${BUCKET}/vod-src/a.mp4`), sourceOnServer(local), sourceOnServer(join(work, 'missing.mp4')), sourceOnServer(`s3://${BUCKET}/filler/a.mp4`), sourceOnServer(null)],
      [vodSourceAvailable(`s3://${BUCKET}/vod-src/a.mp4`), vodSourceAvailable(local), vodSourceAvailable(join(work, 'missing.mp4')), vodSourceAvailable(`s3://${BUCKET}/filler/a.mp4`), vodSourceAvailable(null)]);
    check('a bucket original under vod-src/ counts as a source', sourceOnServer(`s3://${BUCKET}/vod-src/a.mp4`), true);
    check('an s3:// address outside vod-src/ does not (nothing fetches it)', sourceOnServer(`s3://${BUCKET}/filler/a.mp4`), false);

    const lib = await libraryFor(a);
    const ok = (id: string) => lib.get(id)?.sourceOk;
    check('library: an asset with only a bucket original can air', ok(inBucket), true);
    check('library: a local original on this disk can air (unchanged)', ok(onDisk), true);
    check('library: a local original that is not on this disk cannot', ok(gone), false);
    check('library: an original outside vod-src/ cannot', ok(foreign), false);
    check('library: no original and not splice-ready cannot', ok(none), false);
    check('library: splice-ready needs no original (unchanged)', ok(ready), true);
    const forVideo = libraryForMedia(lib, 'video');
    check('the video channel\'s library offers the bucket title',
      [inBucket, onDisk, gone, foreign, none, ready].map((id) => forVideo.has(id)), [true, true, false, false, false, true]);

    const r = await call(`/api/fast/library?channel=${ch}&all=1`);
    const ids = new Set<string>((r.j?.assets ?? r.j?.items ?? r.j ?? []).map((x: any) => String(x.id)));
    check('the builder\'s library route lists the bucket title', [r.s, ids.has(inBucket)], [200, true]);
    check('and leaves out the three with no readable original, counted as No source', r.j?.hidden?.noSource, 3);
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass}/${pass + fail} passed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
