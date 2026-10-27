// ============================================================================
//  S3 WATCH FOLDERS, EVENT-DRIVEN (build queue 2.6).
//
//  A drop in an S3 watch folder is announced by the bucket (ObjectCreated on an
//  SQS queue) instead of found by listing the prefix every minute. Pinned here:
//
//    THE MESSAGES ARE READ AS AWS SENDS THEM: S3's own notification with its
//    URL-encoded keys ('+' for a space), the same inside an SNS envelope, and
//    EventBridge's "Object Created". Removals, test events and other buckets
//    are acknowledged and left alone.
//
//    THE REQUEST IS SIGNED RIGHT: the Signature Version 4 signer against AWS's
//    published get-vanilla vector, and the real client against a local
//    stand-in (the JSON protocol's target header, the signed scope).
//
//    A DROP LANDS WITHOUT A WALK: real Postgres, the real store and the real
//    scanner and ingest, an in-memory bucket and queue. The announced slate is
//    in the Image Library, the unmatched file is in review in the bucket too,
//    the junk and the review prefix are not fetched, and the bucket was never
//    listed.
//
//    NOTHING IS LOST: a fetch that fails leaves its message on the queue, and
//    it lands when the queue delivers it again. A second delivery of the same
//    drop makes nothing twice.
//
//    THE WALK BECOMES THE BACKSTOP: with the queue set, the minute pass walks
//    an S3 folder once and then not again until the backstop is due; with no
//    queue it walks every time, as before.
//
//    THE LOOP polls, handles and deletes until stopped.
//
//  Usage: DATABASE_URL=... npx tsx test/watchfolder-s3-events.check.ts
// ============================================================================
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(m) : bad(m, `expected ${w} got ${g}`);
};

/** A real 1x1 PNG header, so the image probe has something true to read. */
function png(w = 1, h = 1): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([sig, ihdr, Buffer.alloc(64)]);
}

/** S3's own notification, as it arrives on the queue (key URL-encoded). */
const s3Event = (bucket: string, key: string, eventName = 'ObjectCreated:Put', size = 1) => JSON.stringify({
  Records: [{ eventVersion: '2.1', eventSource: 'aws:s3', awsRegion: 'eu-west-1', eventTime: new Date().toISOString(), eventName,
    s3: { s3SchemaVersion: '1.0', configurationId: 'watch-drops', bucket: { name: bucket, arn: `arn:aws:s3:::${bucket}` },
      object: { key: encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+'), size, eTag: 'abc', sequencer: '00' } } }],
});

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-s3ev-'));
  process.env.WATCH_S3_QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/volt-test-watch-drops';
  process.env.WATCH_S3_BACKSTOP_MIN = '60';
  process.env.INGEST_S3_STAGING_DIR = join(root, 'staging');
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, 'images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');

  const { parseS3Message, foldersFor, handleS3Messages, startS3EventLoop } = await import('../src/services/watchfolder/s3events');
  const { signV4, realSqs, MemorySqs } = await import('../src/services/ingest/sqs');
  const { MemoryS3 } = await import('../src/services/ingest/s3');

  // ---------------------------------------------------------------- parsing
  console.log('== the messages AWS sends ==');
  let p = parseS3Message(s3Event('volt-drops', 'watch/agency/Evening News (v2).png'));
  check('an S3 notification: bucket and decoded key', p.drops.map((d) => [d.bucket, d.key]), [['volt-drops', 'watch/agency/Evening News (v2).png']]);
  p = parseS3Message(JSON.stringify({ Type: 'Notification', MessageId: 'x', Message: s3Event('volt-drops', 'watch/a/b.png') }));
  check('inside an SNS envelope', p.drops.map((d) => d.key), ['watch/a/b.png']);
  p = parseS3Message(JSON.stringify({ source: 'aws.s3', 'detail-type': 'Object Created', detail: { bucket: { name: 'volt-drops' }, object: { key: 'watch/a/c d.png', size: 9, etag: 'e' } } }));
  check('EventBridge Object Created (key not encoded)', p.drops.map((d) => [d.key, d.bytes]), [['watch/a/c d.png', 9]]);
  p = parseS3Message(s3Event('volt-drops', 'watch/a/b.png', 'ObjectRemoved:Delete'));
  check('a removal is not a drop', [p.drops.length, p.ignored], [0, 1]);
  p = parseS3Message(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent', Bucket: 'volt-drops' }));
  check('S3\'s test event is recognised', [p.test, p.drops.length, p.unreadable], [true, 0, false]);
  check('anything else is unreadable', parseS3Message('not json').unreadable && parseS3Message('{"a":1}').unreadable, true);
  const folders = [
    { id: 'f1', bucket: 'volt-drops', prefix: 'watch/agency/', stagingRoot: '', quarantinePath: '_review', minAgeMs: 60000 },
    { id: 'f2', bucket: 'volt-drops', prefix: 'watch/', stagingRoot: '', quarantinePath: '_review', minAgeMs: 60000 },
    { id: 'f3', bucket: 'other', prefix: '', stagingRoot: '', quarantinePath: '_review', minAgeMs: 60000 },
  ];
  const homes = (key: string, bucket = 'volt-drops') => foldersFor({ bucket, key, bytes: 1, etag: 'e' }, folders).map((h) => `${h.folder.id}:${h.rel}`);
  check('a key belongs to every folder whose prefix holds it', homes('watch/agency/s.png'), ['f1:s.png', 'f2:agency/s.png']);
  check('the review prefix is not a drop', homes('watch/agency/_review/s.png'), ['f2:agency/_review/s.png']);
  check('another bucket is another folder', homes('x.png', 'other'), ['f3:x.png']);
  check('a key under no folder has no home', homes('channel/abc/seg_1.m4s'), []);

  // ----------------------------------------------------------------- signer
  console.log('\n== Signature Version 4 ==');
  const vanilla = signV4({
    method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', region: 'us-east-1', service: 'service',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    now: new Date('2015-08-30T12:36:00Z'),
  });
  check('AWS get-vanilla test vector', vanilla.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const sessionSigned = signV4({ method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com/', headers: { 'Content-Type': 'application/x-amz-json-1.0' }, body: '{}',
    region: 'eu-west-1', service: 'sqs', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN' }, now: new Date('2026-10-27T00:00:00Z') });
  check('a task role\'s session token is sent and signed', [sessionSigned['x-amz-security-token'], /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/.test(sessionSigned.authorization)], ['TOKEN', true]);
  // The SDK's own signer, when it is in node_modules (it comes with client-s3), must agree on a POST with a body.
  try {
    const { SignatureV4 } = require('@smithy/signature-v4');
    const { createHash, createHmac } = require('node:crypto');
    class Sha256 { private h: any; constructor(secret?: any) { this.h = secret ? createHmac('sha256', secret) : createHash('sha256'); } update(d: any) { this.h.update(d); } async digest() { return new Uint8Array(this.h.digest()); } }
    const sdk = new SignatureV4({ service: 'sqs', region: 'eu-west-1', sha256: Sha256, credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } });
    const when = new Date('2026-10-27T10:11:12Z');
    const body = JSON.stringify({ QueueUrl: 'q', MaxNumberOfMessages: 10 });
    const theirs = await sdk.sign({ method: 'POST', protocol: 'https:', hostname: 'sqs.eu-west-1.amazonaws.com', path: '/', headers: { host: 'sqs.eu-west-1.amazonaws.com', 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ReceiveMessage' }, body }, { signingDate: when });
    // The SDK adds and signs x-amz-content-sha256 on its own; given the same header, the two must agree.
    const mine = signV4({ method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com/', headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ReceiveMessage', 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') }, body, region: 'eu-west-1', service: 'sqs', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' }, now: when });
    const sig = (a: string) => /Signature=([0-9a-f]+)/.exec(a)?.[1];
    check('agrees with the AWS SDK\'s signer on a signed POST', sig(mine.authorization), sig(String(theirs.headers.authorization)));
  } catch (e: any) { console.log(`(the SDK signer is not importable here, skipped: ${String(e?.message ?? e).split('\n')[0]})`); }

  console.log('\n== the client against a local stand-in ==');
  const seen: any[] = [];
  const stand = httpServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ target: req.headers['x-amz-target'], ct: req.headers['content-type'], auth: String(req.headers.authorization ?? ''), body: JSON.parse(b || '{}') });
      res.setHeader('content-type', 'application/x-amz-json-1.0');
      if (req.headers['x-amz-target'] === 'AmazonSQS.ReceiveMessage') {
        res.end(JSON.stringify({ Messages: [{ MessageId: 'm1', ReceiptHandle: 'rh1', Body: '{"x":1}', Attributes: { ApproximateReceiveCount: '2' } }] }));
      } else if (req.headers['x-amz-target'] === 'AmazonSQS.DeleteMessage' && JSON.parse(b).ReceiptHandle === 'bad') {
        res.statusCode = 400; res.end(JSON.stringify({ __type: 'com.amazonaws.sqs#ReceiptHandleIsInvalid', message: 'The receipt handle is not valid' }));
      } else res.end('{}');
    });
  });
  await new Promise<void>((r) => stand.listen(0, '127.0.0.1', () => r()));
  const ep = `http://127.0.0.1:${(stand.address() as any).port}`;
  const client = await realSqs({ region: 'eu-west-1', endpoint: ep, credentials: async () => ({ accessKeyId: 'AKTEST', secretAccessKey: 'secret' }) });
  const got = await client.receive('https://sqs.eu-west-1.amazonaws.com/1/q', 25, 0);
  check('receive: parsed', got, [{ id: 'm1', receipt: 'rh1', body: '{"x":1}', receiveCount: 2 }]);
  check('receive: JSON protocol', [seen[0]?.target, seen[0]?.ct], ['AmazonSQS.ReceiveMessage', 'application/x-amz-json-1.0']);
  check('receive: queue, batch capped at 10, wait', [seen[0]?.body.QueueUrl, seen[0]?.body.MaxNumberOfMessages, seen[0]?.body.WaitTimeSeconds], ['https://sqs.eu-west-1.amazonaws.com/1/q', 10, 0]);
  check('receive: signed for sqs in the region', /^AWS4-HMAC-SHA256 Credential=AKTEST\/\d{8}\/eu-west-1\/sqs\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/.test(seen[0]?.auth), true);
  await client.delete('q', 'rh1');
  check('delete: by receipt', [seen[1]?.target, seen[1]?.body.ReceiptHandle], ['AmazonSQS.DeleteMessage', 'rh1']);
  let err = '';
  try { await client.delete('q', 'bad'); } catch (e: any) { err = String(e.message); }
  check('an SQS error says what it was', err, 'SQS DeleteMessage 400: ReceiptHandleIsInvalid: The receipt handle is not valid');
  stand.close();

  // --------------------------------------------------------- the real store
  console.log('\n== a drop lands without a walk (real Postgres, store, scanner, ingest) ==');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { config } = await import('../src/config');
  const store = await import('../src/services/watchfolder/store');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfs3-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `wfs3-${tag}@volt.test`]))!.id;
  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' });
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  const BUCKET = 'volt-drops';
  const mem = new MemoryS3();
  store.setS3Api(mem);
  const sqs = new MemorySqs();
  const URL_ = config.ingest.s3EventsQueueUrl;
  const items = async (F: string) => Object.fromEntries((await query<any>(`SELECT object_key, status FROM watchfolder_items WHERE watchfolder_id = $1 ORDER BY id`, [F])).map((r) => [r.object_key, r.status]));
  const handle = async () => {
    const msgs = await sqs.receive(URL_, 10, 0);
    const r = await handleS3Messages(msgs, await store.s3EventDeps());
    for (const rc of r.done) await sqs.delete(URL_, rc);
    return r;
  };

  try {
    const f = await call('POST', '/api/watchfolders', { name: 'Agency (S3)', kind: 's3', config: { bucket: BUCKET, prefix: 'watch/agency/', min_age_ms: 60000 } });
    check('S3 folder created', f.s, 201);
    const F = f.j?.id;
    check('slate rule', (await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Slates', matchType: 'glob', pattern: 'slate_*', targetKind: 'slate' })).s, 201);

    await mem.put(BUCKET, 'watch/agency/slate_open.png', png(2, 2), 'image/png');
    await mem.put(BUCKET, 'watch/agency/notes.txt', 'no rule for me', 'text/plain');
    await mem.put(BUCKET, 'watch/agency/.DS_Store', 'x', 'application/octet-stream');
    await mem.put(BUCKET, 'watch/agency/_review/old.txt', 'already in review', 'text/plain');
    mem.calls = [];
    sqs.send(s3Event(BUCKET, 'watch/agency/slate_open.png'));
    sqs.send(JSON.stringify({ Type: 'Notification', Message: s3Event(BUCKET, 'watch/agency/notes.txt') }));
    sqs.send(s3Event(BUCKET, 'watch/agency/.DS_Store'));
    sqs.send(s3Event(BUCKET, 'watch/agency/_review/old.txt'));
    sqs.send(s3Event('someone-elses-bucket', 'watch/agency/slate_x.png'));
    sqs.send(s3Event(BUCKET, 'watch/agency/slate_deleted_since.png'));
    sqs.send(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }));
    const r1 = await handle();
    check('seven messages, all done with', [r1.messages, r1.done.length, r1.kept.length], [7, 7, 0]);
    // The review prefix and the other bucket have no home folder ('elsewhere'): neither is a drop.
    check('two fetched; junk, review copy, deleted and other bucket not', r1.outcomes, { downloaded: 2, known: 0, junk: 1, gone: 1, review: 0, elsewhere: 2 });
    check('the queue is empty', sqs.size, 0);
    check('the folder was taken in once', r1.foldersTakenIn, [F]);
    check('...without an error', r1.takeInErrors, []);
    check('the bucket was never listed', mem.calls.filter((c) => c.startsWith('list')).length, 0);
    const it1 = await items(F);
    check('the slate is ingested', it1['slate_open.png'], 'ingested');
    check('the file no rule takes is in review', it1['notes.txt'], 'quarantined');
    check('the junk and the review copy were never recorded', ['.DS_Store' in it1, '_review/old.txt' in it1], [false, false]);
    const mf = await one<any>(`SELECT path FROM media_files WHERE account_id = $1 AND path LIKE '%slate_open%'`, [acct]);
    check('the slate is in the Image Library', !!mf, true);
    // Before 27 Oct an S3 folder's accepted files were never ingested at all:
    // both ingest loaders asked for kind 'local' only, so they stayed 'seen'.
    check('the mirror copy is gone once the library has it (the bucket keeps the original)',
      existsSync(join(process.env.INGEST_S3_STAGING_DIR!, F, 'slate_open.png')), false);
    const keys = [...mem.objects.keys()];
    check('the review decision is mirrored in the bucket', [keys.includes(`${BUCKET}/watch/agency/notes.txt`), keys.some((k) => k.startsWith(`${BUCKET}/watch/agency/_review/`) && k.endsWith('notes.txt'))], [false, true]);
    const fol = await one<any>(`SELECT last_scan_at, last_scan_error FROM watchfolders WHERE id = $1`, [F]);
    check('the folder shows the pass', [!!fol?.last_scan_at, fol?.last_scan_error], [true, null]);

    console.log('\n== the same drop announced twice makes nothing twice ==');
    sqs.send(s3Event(BUCKET, 'watch/agency/slate_open.png'));
    const r2 = await handle();
    check('known, not fetched', [r2.outcomes.known, r2.outcomes.downloaded, r2.foldersTakenIn.length], [1, 0, 0]);
    check('still one library entry', Number((await one<any>(`SELECT count(*) AS n FROM media_files WHERE account_id = $1 AND path LIKE '%slate_open%'`, [acct]))?.n), 1);

    console.log('\n== a failed fetch keeps its message ==');
    await mem.put(BUCKET, 'watch/agency/slate_close.png', png(3, 3), 'image/png');
    const realGet = mem.getStream.bind(mem);
    let fails = 1;
    (mem as any).getStream = async (b: string, k: string, rg?: string) => { if (fails-- > 0) throw new Error('connection reset'); return realGet(b, k, rg); };
    sqs.send(s3Event(BUCKET, 'watch/agency/slate_close.png'));
    const r3 = await handle();
    check('kept, with the reason', [r3.done.length, r3.kept.map((k) => k.error)], [0, ['connection reset']]);
    check('still on the queue, hidden until its timeout', [sqs.size, sqs.visible], [1, 0]);
    check('no half file left in the mirror', existsSync(join(process.env.INGEST_S3_STAGING_DIR!, F, 'slate_close.png')), false);
    sqs.release();
    const r4 = await handle();
    check('delivered again, it lands', [r4.outcomes.downloaded, r4.done.length, sqs.size], [1, 1, 0]);
    check('and is ingested', (await items(F))['slate_close.png'], 'ingested');

    console.log('\n== the walk is the backstop ==');
    store.resetWalks();
    mem.calls = [];
    await store.scanAllFolders();
    check('the first pass after a start walks', mem.calls.filter((c) => c.startsWith('list')).length, 1);
    check('...and does not fetch what the library already has', existsSync(join(process.env.INGEST_S3_STAGING_DIR!, F, 'slate_open.png')), false);
    check('...so nothing is recorded twice', Number((await one<any>(`SELECT count(*) AS n FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'slate_open.png'`, [F]))?.n), 1);
    await store.scanAllFolders();
    await store.scanAllFolders();
    check('the next passes do not', mem.calls.filter((c) => c.startsWith('list')).length, 1);
    check('due again after the backstop time', [store.walkDue(F, Date.now() + 59 * 60_000), store.walkDue(F, Date.now() + 61 * 60_000)], [false, true]);
    (config.ingest as any).s3EventsQueueUrl = '';
    await store.scanAllFolders();
    await store.scanAllFolders();
    check('with no queue every pass walks, as before', mem.calls.filter((c) => c.startsWith('list')).length, 3);
    (config.ingest as any).s3EventsQueueUrl = URL_;
    const scanNow = await call('POST', `/api/watchfolders/${F}/scan`);
    check('Scan now still walks', [scanNow.s, mem.calls.filter((c) => c.startsWith('list')).length], [200, 4]);

    console.log('\n== the loop ==');
    await mem.put(BUCKET, 'watch/agency/slate_loop.png', png(4, 4), 'image/png');
    const results: any[] = [];
    const stop = startS3EventLoop({ sqs, queueUrl: URL_, deps: store.s3EventDeps, waitSec: 1, errorPauseMs: 50, onResult: (r) => results.push(r) });
    sqs.send(s3Event(BUCKET, 'watch/agency/slate_loop.png'));
    for (let i = 0; i < 100 && sqs.size; i++) await new Promise((r) => setTimeout(r, 50));
    await stop();
    check('the loop took the message and deleted it', [sqs.size, results.reduce((n, r) => n + r.outcomes.downloaded, 0)], [0, 1]);
    check('the drop is ingested', (await items(F))['slate_loop.png'], 'ingested');
  } catch (e: any) {
    bad('the store run', String(e?.stack ?? e));
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
