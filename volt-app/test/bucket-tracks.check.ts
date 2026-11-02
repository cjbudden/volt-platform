// ============================================================================
//  CAPTION TRACKS ON CDN-PLAYED ENCODES (build queue 2.1a-2b-4 (b)), against
//  Postgres and the real AWS SDK.
//
//  On S3 an encode's master_key is the bucket key vod/<id>/master.m3u8 and
//  players get it from the CDN, so the tracks the API's /clips route writes in
//  never reached them. Now every add, change and delete of a caption file (and
//  every encode landing in the bucket) writes the tracks into the bucket's
//  master and MPD, with each track's playlist and WebVTT beside them.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3.
//
//  Usage: DATABASE_URL=... npx tsx test/bucket-tracks.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

main().catch((e) => { console.error(e); process.exit(1); });

async function main() {
  let pass = 0, fail = 0;
  const ok = (c: boolean, m: string, d = '') => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log(`FAIL ${m}${d ? ' -- ' + d : ''}`); } };

  // ---------------------------------------------------------------- the bucket
  const objects = new Map<string, { body: Buffer; type: string; cache: string }>();
  function decodeAwsChunked(b: Buffer): Buffer {
    const out: Buffer[] = []; let i = 0;
    for (;;) {
      const nl = b.indexOf('\r\n', i); if (nl < 0) break;
      const size = parseInt(b.subarray(i, nl).toString().split(';')[0], 16);
      if (!size) break;
      out.push(b.subarray(nl + 2, nl + 2 + size)); i = nl + 2 + size + 2;
    }
    return Buffer.concat(out);
  }
  function fakeS3(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const path = decodeURIComponent(u.pathname.slice(1));
      if (req.method === 'PUT') {
        let body = Buffer.concat(chunks);
        if (String(req.headers['content-encoding'] ?? '').includes('aws-chunked') || String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-')) body = decodeAwsChunked(body);
        objects.set(path, { body, type: String(req.headers['content-type'] ?? 'application/octet-stream'), cache: String(req.headers['cache-control'] ?? '') });
        res.writeHead(200, { ETag: '"e"' }); return res.end();
      }
      if (req.method === 'DELETE') { objects.delete(path); res.writeHead(204); return res.end(); }
      const o = objects.get(path);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type, ETag: '"e"' }); res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  }

  const BUCKET = 'volt-bucket-tracks-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'bucket-tracks-'));
  const clips = join(work, 'clips');
  mkdirSync(clips, { recursive: true });
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: endpoint, S3_FORCE_PATH_STYLE: '1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'volt', AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'voltvoltvolt',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1', S3_BUCKET: BUCKET,
    CLIPS_DIR: clips, FILLER_DIR: join(work, 'filler'), IMAGE_STORE_DIR: join(work, 'images'), MEDIA_STORE_DRIVER: 's3', VOD_STORE: 's3', VOD_SOURCE_DRIVER: 's3',
  });
  const { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const raw = new S3Client({ region: process.env.AWS_REGION, forcePathStyle: true });
  await raw.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => { /* exists, or the fake */ });
  const get = async (key: string): Promise<string | null> => {
    if (!external) return objects.get(`${BUCKET}/${key}`)?.body.toString('utf8') ?? null;
    try { const r: any = await raw.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return Buffer.from(await r.Body.transformToByteArray()).toString('utf8'); } catch { return null; }
  };
  const putObject = (key: string, body: Buffer | string, type = 'application/octet-stream') =>
    raw.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: typeof body === 'string' ? Buffer.from(body) : body, ContentType: type }));

  // An encode's files as vodEncode leaves them in the bucket: CMAF, the first segment 10 s in.
  const { timestampMap } = await import('../src/services/companions/delivery');
  const box = (type: string, body: Buffer) => { const b = Buffer.alloc(8); b.writeUInt32BE(8 + body.length); b.write(type, 4, 'ascii'); return Buffer.concat([b, body]); };
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(90_000, 12);
  const init = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', box('trak', box('mdia', box('mdhd', mdhd))))]);
  const tfdt = Buffer.alloc(12); tfdt[0] = 1; tfdt.writeBigUInt64BE(10n * 90_000n, 4);
  const seg = Buffer.concat([box('styp', Buffer.alloc(8)), box('moof', Buffer.concat([box('mfhd', Buffer.alloc(8)), box('traf', Buffer.concat([box('tfhd', Buffer.alloc(8)), box('tfdt', tfdt)]))]))]);
  const want = timestampMap(10n * 90_000n, 90_000);
  const MASTER = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nv360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=1280x720\nv720/index.m3u8\n';
  const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg_1.m4s\n#EXT-X-ENDLIST\n';
  const MPD = '<?xml version="1.0"?><MPD type="static"><Period id="0"><AdaptationSet contentType="video"><Representation id="v360" bandwidth="800000"/></AdaptationSet></Period></MPD>';
  const landEncode = async (id: string) => {
    await putObject(`vod/${id}/v360/init.mp4`, init, 'video/mp4');
    await putObject(`vod/${id}/v360/seg_1.m4s`, seg, 'video/iso.segment');
    await putObject(`vod/${id}/v360/index.m3u8`, MEDIA, 'application/vnd.apple.mpegurl');
    await putObject(`vod/${id}/master.m3u8`, MASTER, 'application/vnd.apple.mpegurl');
    await putObject(`vod/${id}/manifest.mpd`, MPD, 'application/dash+xml');
  };

  const { pool, one } = await import('../src/db');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`bucket-tracks-${tag}`]))!.id;
  const asset = async (masterKey: string) => {
    const id = randomUUID();
    await one(`INSERT INTO vod_assets (id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, master_key)
               VALUES ($1,$2,'upload','export','Captioned',0,2000,2000,$3) RETURNING id`, [id, acct, masterKey]);
    return id;
  };
  const srt = (text: string) => Buffer.from(`1\n00:00:00,500 --> 00:00:01,500\n${text}\n`);
  const store = await import('../src/services/companions/store');
  const subsLines = (m: string | null) => (m ?? '').split('\n').filter((l) => l.includes('GROUP-ID="volt-subs"'));

  try {
    console.log('-- an encode in the bucket gets its tracks written into its playlists');
    const E = await asset(''); await one(`UPDATE vod_assets SET master_key = $2 WHERE id = $1 RETURNING id`, [E, `vod/${E}/master.m3u8`]);
    await landEncode(E);
    const en = (await store.addFile(E, acct, { name: 'feature.en.srt', buf: srt('Hello'), language: 'en', by: 'check' })).file;
    let m = await get(`vod/${E}/master.m3u8`), d = await get(`vod/${E}/manifest.mpd`);
    ok(subsLines(m).length === 1 && subsLines(m)[0].includes(`URI="subs/${en.id}.m3u8"`) && subsLines(m)[0].includes('LANGUAGE="en"') && subsLines(m)[0].includes('DEFAULT=YES'),
      'adding a caption file lists it in the bucket master', String(m));
    ok((m ?? '').split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF:')).every((l) => l.endsWith(',SUBTITLES="volt-subs"')), 'every variant names the subtitles group');
    ok((d ?? '').includes(`<BaseURL>subs/${en.id}.dash.vtt</BaseURL>`) && (d ?? '').includes('contentType="text"') && (d ?? '').includes('lang="en"'), 'and in the bucket MPD (DASH)', String(d));
    const pl = await get(`vod/${E}/subs/${en.id}.m3u8`);
    ok(!!pl && pl.includes(`${en.id}.vtt`) && pl.includes('#EXT-X-ENDLIST'), 'the track\'s playlist is beside the master', String(pl));
    const vtt = await get(`vod/${E}/subs/${en.id}.vtt`);
    ok(!!vtt && vtt.split('\n')[1] === want && vtt.includes('00:00:00.500 --> 00:00:01.500') && vtt.includes('Hello'), 'its WebVTT carries the X-TIMESTAMP-MAP of the encode\'s first segment', JSON.stringify(vtt?.slice(0, 120)));
    const dv = await get(`vod/${E}/subs/${en.id}.dash.vtt`);
    ok(!!dv && !dv.includes('X-TIMESTAMP-MAP') && dv.includes('Hello'), 'the DASH WebVTT has the cues and no map');
    if (!external) {
      ok(objects.get(`${BUCKET}/vod/${E}/master.m3u8`)?.cache === 'public, max-age=60' && objects.get(`${BUCKET}/vod/${E}/subs/${en.id}.vtt`)?.cache === 'public, max-age=60',
        'written with the playlists\' 60 s cache, so the CDN picks up a change within a minute');
      ok(objects.get(`${BUCKET}/vod/${E}/master.m3u8`)?.type === 'application/vnd.apple.mpegurl' && objects.get(`${BUCKET}/vod/${E}/manifest.mpd`)?.type === 'application/dash+xml', 'with their content types');
    }

    const fr = (await store.addFile(E, acct, { name: 'feature.fr.srt', buf: srt('Bonjour'), language: 'fr', by: 'check' })).file;
    m = await get(`vod/${E}/master.m3u8`); d = await get(`vod/${E}/manifest.mpd`);
    ok(subsLines(m).length === 2 && subsLines(m)[0].includes(en.id) && subsLines(m)[1].includes(fr.id) && subsLines(m)[1].includes('DEFAULT=NO'), 'a second track is listed after the default one', String(m));
    ok(((d ?? '').match(/contentType="text"/g) ?? []).length === 2, 'both in the MPD');

    console.log('-- switching a track off and on, deleting it');
    await store.updateFile(E, acct, en.id, { enabled: false });
    m = await get(`vod/${E}/master.m3u8`); d = await get(`vod/${E}/manifest.mpd`);
    ok(subsLines(m).length === 1 && subsLines(m)[0].includes(fr.id) && !(m ?? '').includes(en.id), 'a disabled track leaves the bucket master', String(m));
    ok(!(d ?? '').includes(en.id) && (d ?? '').includes(fr.id), 'and the bucket MPD');
    ok((await get(`vod/${E}/subs/${en.id}.m3u8`)) === null && (await get(`vod/${E}/subs/${en.id}.vtt`)) === null && (await get(`vod/${E}/subs/${en.id}.dash.vtt`)) === null,
      'its copies are taken out of the bucket');
    await store.updateFile(E, acct, fr.id, { enabled: false });
    m = await get(`vod/${E}/master.m3u8`); d = await get(`vod/${E}/manifest.mpd`);
    ok(m === MASTER, 'with every track off the master is the encode\'s own again', JSON.stringify(m));
    ok(d === MPD, 'and so is the MPD', JSON.stringify(d));
    await store.updateFile(E, acct, en.id, { enabled: true });
    ok(subsLines(await get(`vod/${E}/master.m3u8`)).length === 1 && !!(await get(`vod/${E}/subs/${en.id}.vtt`)), 'switching it back on lists it and writes its files again');
    await store.updateFile(E, acct, en.id, { label: 'English (UK)' });
    ok(subsLines(await get(`vod/${E}/master.m3u8`))[0]?.includes('NAME="English (UK)"'), 'a new label reaches the master');
    await store.deleteFile(E, acct, en.id);
    m = await get(`vod/${E}/master.m3u8`);
    ok(m === MASTER && (await get(`vod/${E}/subs/${en.id}.vtt`)) === null, 'deleting the file takes it out of the master and the bucket', JSON.stringify(m));

    console.log('-- a new encode writes a master with no tracks');
    await store.updateFile(E, acct, fr.id, { enabled: true });
    await landEncode(E);                                            // what uploadVodDir leaves
    ok(subsLines(await get(`vod/${E}/master.m3u8`)).length === 0, '(the re-encoded master has none)');
    const { syncBucketTracks } = await import('../src/services/companions/bucketTracks');
    const st = await syncBucketTracks(E);
    m = await get(`vod/${E}/master.m3u8`);
    ok(!st.error && subsLines(m).length === 1 && subsLines(m)[0].includes(fr.id) && (await get(`vod/${E}/manifest.mpd`))!.includes(fr.id), 'the sync the encode runs puts the tracks back', JSON.stringify(st));
    const enc = readFileSync(join(__dirname, '..', 'src', 'services', 'jobs', 'handlers', 'vodEncode.ts'), 'utf8');
    const iUp = enc.indexOf('uploadVodDir(outDir, p.vodAssetId)'), iSync = enc.indexOf('syncBucketTracks(p.vodAssetId)'), iUpd = enc.indexOf('SET master_key = COALESCE($2, master_key)');
    ok(iUp > 0 && iUpd > iUp && iSync > iUpd, 'vodEncode runs it after the upload and after master_key names the bucket copy');

    console.log('-- left alone: the Mac, an encode not in the bucket yet');
    const L = await asset(''); await one(`UPDATE vod_assets SET master_key = $2 WHERE id = $1 RETURNING id`, [L, `/clips/vod/${L}/master.m3u8`]);
    const before = objects.size;
    const lf = (await store.addFile(L, acct, { name: 'en.srt', buf: srt('Local'), language: 'en', by: 'check' })).file;
    ok(!!lf.id && (external || objects.size === before), 'a /clips master (the Mac) writes nothing to a bucket');
    ok((await syncBucketTracks(L)).skipped === 'not an encode in the bucket', 'and says why');
    const N = await asset(''); await one(`UPDATE vod_assets SET master_key = $2 WHERE id = $1 RETURNING id`, [N, `vod/${N}/master.m3u8`]);
    const nf = await store.addFile(N, acct, { name: 'en.srt', buf: srt('Early'), language: 'en', by: 'check' });
    ok(!!nf.file.id && (await syncBucketTracks(N)).skipped === 'the bucket has no master yet', 'a caption file added before the encode lands is stored; the encode\'s sync writes it later');
    const { bucketBaseOf } = await import('../src/services/companions/bucketTracks');
    ok(bucketBaseOf(E, `vod/${E}/master.m3u8`) === `vod/${E}` && bucketBaseOf(E, `vod/${randomUUID()}/master.m3u8`) === null && bucketBaseOf(E, `https://cdn.example/vod/${E}/master.m3u8`) === null,
      'only the asset\'s own bucket master counts');

    console.log('-- the API route strips a stale listing when no track is left');
    const { withTracks } = await import('../src/services/companions/serve');
    const { withHlsSubtitles, withoutHlsSubtitles, withDashSubtitles } = await import('../src/services/companions/delivery');
    const T = await asset('');
    const stale = withHlsSubtitles(MASTER, [{ id: randomUUID(), language: 'en', label: 'English', isDefault: true, forced: false, sdh: false }]);
    ok((await withTracks(stale, T, false)) === MASTER, 'HLS: an asset with no tracks is served without the stale group');
    ok((await withTracks(withDashSubtitles(MPD, [{ id: randomUUID(), language: 'en', label: 'English', isDefault: true, forced: false, sdh: false }], ''), T, true)) === MPD, 'DASH: the same');
    const other = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cc",NAME="CC",URI="cc.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="cc"\nv.m3u8\n';
    ok(withoutHlsSubtitles(other) === other, 'another SUBTITLES group is left as it is');
  } finally {
    s3srv?.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
