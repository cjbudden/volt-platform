// ============================================================================
//  SKIP MARKERS ON CDN-PLAYED ENCODES (build queue 2.1a-2b-6), against
//  Postgres and the real AWS SDK.
//
//  On S3 an encode's playlists are fetched from the CDN, so the intro, recap
//  and credits markers the API's /clips route writes in never reached viewers.
//  Now every set, accept and delete of a marker (and every encode landing in
//  the bucket) writes them into the bucket's media playlists (EXT-X-DATERANGE)
//  and MPD (EventStream), and a removed one leaves them.
//
//  The bucket is a small S3-compatible server inside this test; set
//  UPLOAD_S3_TEST_ENDPOINT to run the same checks against moto, MinIO or S3.
//
//  Usage: DATABASE_URL=... npx tsx test/bucket-markers.check.ts   (a migrated, disposable database)
// ============================================================================
import { createServer as httpServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
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

  const BUCKET = 'volt-bucket-markers-check';
  const external = process.env.UPLOAD_S3_TEST_ENDPOINT;
  let s3srv: any = null;
  if (!external) { s3srv = httpServer(fakeS3).listen(0, '127.0.0.1'); await new Promise((r) => s3srv.on('listening', r)); }
  const endpoint = external || `http://127.0.0.1:${s3srv.address().port}`;
  const work = mkdtempSync(join(tmpdir(), 'bucket-markers-'));
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

  const MASTER = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="a/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"\nv360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=1280x720,AUDIO="aud"\nv720/index.m3u8\n';
  const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg_1.m4s\n#EXT-X-ENDLIST\n';
  const MPD = '<?xml version="1.0"?><MPD type="static"><Period id="0" start="PT0S"><AdaptationSet contentType="video"><Representation id="v360" bandwidth="800000"/></AdaptationSet></Period></MPD>';
  const MEDIAS = ['v360/index.m3u8', 'v720/index.m3u8', 'a/index.m3u8'];
  const land = async (base: string) => {
    for (const m of MEDIAS) await putObject(`${base}/${m}`, MEDIA, 'application/vnd.apple.mpegurl');
    await putObject(`${base}/master.m3u8`, MASTER, 'application/vnd.apple.mpegurl');
    await putObject(`${base}/manifest.mpd`, MPD, 'application/dash+xml');
  };

  const { pool, one, query } = await import('../src/db');
  const mk = await import('../src/services/vodMarkers');
  const { syncBucketMarkers, mediaPlaylistKeys } = await import('../src/services/vodMarkersBucket');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`bucket-markers-${tag}`]))!.id;
  const asset = async (master: (id: string) => string) => {
    const id = randomUUID();
    await one(`INSERT INTO vod_assets (id, account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, master_key)
               VALUES ($1,$2,'upload','export','Episode',0,1800000,1800000,$3) RETURNING id`, [id, acct, master(id)]);
    return id;
  };
  const skips = (t: string | null) => (t ?? '').split('\n').filter((l) => l.startsWith('#EXT-X-DATERANGE:') && l.includes(mk.SKIP_CLASS));
  const kinds = (t: string | null) => skips(t).map((l) => /X-KIND="([^"]+)"/.exec(l)?.[1]).join(',');
  const events = (d: string | null) => [...(d ?? '').matchAll(/&quot;kind&quot;:&quot;(\w+)&quot;/g)].map((m) => m[1]).join(',');

  try {
    console.log('-- the playlists an encode names');
    ok(JSON.stringify(mediaPlaylistKeys(MASTER, 'vod/x')) === JSON.stringify(['vod/x/a/index.m3u8', 'vod/x/v360/index.m3u8', 'vod/x/v720/index.m3u8']),
      'variants and audio renditions, under the asset\'s folder', JSON.stringify(mediaPlaylistKeys(MASTER, 'vod/x')));
    const odd = '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="subs/abc.m3u8"\n#EXT-X-I-FRAME-STREAM-INF:URI="v1/index.iframes.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.example/x.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n../../other/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3\n/abs/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4\nv1/../v2/index.m3u8\n';
    ok(JSON.stringify(mediaPlaylistKeys(odd, 'vod/x')) === JSON.stringify(['vod/x/v2/index.m3u8']),
      'never a caption or I-frame playlist, an absolute address or one outside the folder', JSON.stringify(mediaPlaylistKeys(odd, 'vod/x')));

    console.log('-- a marker set on an encode in the bucket');
    const E = await asset((id) => `vod/${id}/master.m3u8`);
    await land(`vod/${E}`);
    await mk.setMarker(E, 'intro', 30_000, 90_000, null);
    for (const m of MEDIAS) ok(kinds(await get(`vod/${E}/${m}`)) === 'intro', `${m} carries the intro as EXT-X-DATERANGE`, String(await get(`vod/${E}/${m}`)));
    const v = await get(`vod/${E}/v360/index.m3u8`);
    ok(skips(v)[0]?.includes('START-DATE="2000-01-01T00:00:30.000Z"') && skips(v)[0]?.includes('DURATION=60.000') && skips(v)[0]?.includes('X-TO="90.000"'),
      'at its time against the playlist\'s clock', skips(v)[0]);
    ok((v ?? '').includes('#EXT-X-PROGRAM-DATE-TIME:2000-01-01T00:00:00.000Z'), 'with the PROGRAM-DATE-TIME a DATERANGE needs');
    ok(v === mk.annotateHls(v!, await mk.listMarkers(E), mk.VOD_EPOCH_MS, E), 'the same as the /clips route writes, so serving it through /clips adds nothing twice');
    ok(skips(await get(`vod/${E}/master.m3u8`)).length === 0 && (await get(`vod/${E}/master.m3u8`)) === MASTER, 'the master is left as it was');
    let d = await get(`vod/${E}/manifest.mpd`);
    ok(events(d) === 'intro' && (d ?? '').includes(`schemeIdUri="${mk.SKIP_SCHEME}"`) && (d ?? '').includes('presentationTime="30000" duration="60000"'), 'the MPD carries it as an EventStream', String(d));
    if (!external) {
      ok(objects.get(`${BUCKET}/vod/${E}/v360/index.m3u8`)?.cache === 'public, max-age=60' && objects.get(`${BUCKET}/vod/${E}/manifest.mpd`)?.cache === 'public, max-age=60',
        'written with the playlists\' 60 s cache, so the CDN picks up a change within a minute');
      ok(objects.get(`${BUCKET}/vod/${E}/v720/index.m3u8`)?.type === 'application/vnd.apple.mpegurl' && objects.get(`${BUCKET}/vod/${E}/manifest.mpd`)?.type === 'application/dash+xml', 'with their content types');
    }

    console.log('-- moved, a second one, a suggestion, accepted');
    await mk.setMarker(E, 'intro', 40_000, 95_000, null);
    ok(skips(await get(`vod/${E}/v720/index.m3u8`))[0]?.includes('START-DATE="2000-01-01T00:00:40.000Z"') && skips(await get(`vod/${E}/v720/index.m3u8`)).length === 1,
      'moving it rewrites it in place, once');
    await mk.setMarker(E, 'credits', 1_700_000, 1_800_000, null);
    ok(kinds(await get(`vod/${E}/a/index.m3u8`)) === 'intro,credits' && events(await get(`vod/${E}/manifest.mpd`)) === 'intro,credits', 'a second marker is added beside it');
    await query(`INSERT INTO vod_markers (vod_asset_id, kind, start_ms, end_ms, source, status, confidence) VALUES ($1,'recap',0,20000,'auto','suggested',0.3)`, [E]);
    await syncBucketMarkers(E);
    ok(kinds(await get(`vod/${E}/v360/index.m3u8`)) === 'intro,credits', 'a suggested marker stays out, as on /clips');
    await mk.acceptMarker(E, 'recap', null);
    ok(kinds(await get(`vod/${E}/v360/index.m3u8`)) === 'recap,intro,credits' && events(await get(`vod/${E}/manifest.mpd`)) === 'recap,intro,credits', 'accepting it writes it in');

    console.log('-- removed');
    await mk.deleteMarker(E, 'intro');
    for (const m of MEDIAS) ok(kinds(await get(`vod/${E}/${m}`)) === 'recap,credits', `${m} loses the removed intro`);
    ok(events(await get(`vod/${E}/manifest.mpd`)) === 'recap,credits', 'and so does the MPD');
    await mk.deleteMarker(E, 'recap'); await mk.deleteMarker(E, 'credits');
    ok(skips(await get(`vod/${E}/v360/index.m3u8`)).length === 0 && !(await get(`vod/${E}/manifest.mpd`))!.includes('EventStream'), 'with none left, no DATERANGE and no EventStream');
    ok((await get(`vod/${E}/manifest.mpd`)) === MPD, 'the MPD is back to the encode\'s own');

    console.log('-- a new encode lands, then the sync the encode job runs');
    await mk.setMarker(E, 'intro', 30_000, 90_000, null);
    await land(`vod/${E}`);
    ok(skips(await get(`vod/${E}/v360/index.m3u8`)).length === 0, '(a fresh encode\'s playlists carry no markers)');
    let r = await syncBucketMarkers(E);
    ok(!r.error && r.written.length === 4 && kinds(await get(`vod/${E}/v720/index.m3u8`)) === 'intro' && events(await get(`vod/${E}/manifest.mpd`)) === 'intro',
      'the asset\'s markers are written back in (three playlists and the MPD)', JSON.stringify(r));
    r = await syncBucketMarkers(E);
    ok(!r.error && r.written.length === 0, 'run again, nothing changes and nothing is written');

    console.log('-- with caption tracks on the same MPD at the same moment');
    const store = await import('../src/services/companions/store');
    const srt = Buffer.from('1\n00:00:00,500 --> 00:00:01,500\nHello\n');
    await Promise.all([store.addFile(E, acct, { name: 'ep.en.srt', buf: srt, language: 'en', by: 'check' }), mk.setMarker(E, 'credits', 1_700_000, 1_800_000, null)]);
    d = await get(`vod/${E}/manifest.mpd`);
    ok(events(d) === 'intro,credits' && (d ?? '').includes('contentType="text"'), 'neither write drops the other\'s (the two syncs queue per asset)', String(d));

    console.log('-- a repackaged title, and what is not an encode in the bucket');
    const R = await asset((id) => `vod/${id}/r-job12345-a1/master.m3u8`);
    await land(`vod/${R}/r-job12345-a1`); await land(`vod/${R}`);
    await mk.setMarker(R, 'intro', 30_000, 90_000, null);
    ok(kinds(await get(`vod/${R}/r-job12345-a1/v360/index.m3u8`)) === 'intro' && skips(await get(`vod/${R}/v360/index.m3u8`)).length === 0,
      'a repackaged title gets them beside its current master, not the old package');
    const before = objects.size;
    const M = await asset((id) => `/clips/vod/${id}/master.m3u8`);
    await mk.setMarker(M, 'intro', 30_000, 90_000, null);
    r = await syncBucketMarkers(M);
    ok(r.skipped === 'not an encode in the bucket' && (!!external || objects.size === before), 'an asset served from /clips (the Mac) is left alone: the route annotates it', JSON.stringify(r));
    const N = await asset((id) => `vod/${id}/master.m3u8`);
    r = await syncBucketMarkers(N);
    ok(r.skipped === 'the bucket has no master yet', 'an encode whose files are not in the bucket yet is skipped, not failed');
  } finally {
    s3srv?.close();
    await pool.end();
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}
