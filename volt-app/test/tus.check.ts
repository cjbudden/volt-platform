// tus 1.0.0 over real HTTP with the memory store. No database. Run:
//   npx tsc --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck \
//     --outDir /tmp/ing --rootDir . test/tus.check.ts && node /tmp/ing/test/tus.check.js
import express from 'express';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createTusRouter, MemoryTusStore, parseMetadata, encodeMetadata, type TusInfo } from '../src/services/ingest/tus';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tus-'));
  const store = new MemoryTusStore(dir);
  const completed: { info: TusInfo; sha: string; who: any }[] = [];
  const app = express();
  app.use('/api/tus', createTusRouter({
    store, basePath: '/api/tus', maxBytes: 1_000_000,
    authorise: async (req) => { if (req.get('authorization') !== 'Bearer ok') throw Object.assign(new Error('nope'), { status: 401 }); return { accountId: 'acc' }; },
    onComplete: async (info, who, sha) => { completed.push({ info, who, sha }); },
  }));
  const srv = app.listen(0);
  const port = (srv.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/tus`;
  const H = { 'Tus-Resumable': '1.0.0', authorization: 'Bearer ok' };
  const f = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...H, ...(init.headers as any) } });

  // OPTIONS
  let r = await fetch(base, { method: 'OPTIONS' });
  check('options advertises version and extensions', [r.status, r.headers.get('tus-version'), r.headers.get('tus-extension')?.includes('creation-with-upload'), r.headers.get('tus-max-size')], [204, '1.0.0', true, '1000000']);
  // missing version header
  r = await fetch(base, { method: 'POST', headers: { authorization: 'Bearer ok', 'Upload-Length': '10' } });
  check('missing Tus-Resumable is 412', r.status, 412);
  r = await f(base, { method: 'POST', headers: { authorization: 'Bearer bad', 'Upload-Length': '10' } });
  check('bad auth is 401', r.status, 401);
  r = await f(base, { method: 'POST', headers: { 'Upload-Length': '2000000' } });
  check('too large is 413', r.status, 413);

  // creation
  const data = randomBytes(300_000);
  const md = encodeMetadata({ filename: 'Match Day.mxf', filetype: 'application/mxf', relativePath: 'Shoots/Day 1/Match Day.mxf', metadata: JSON.stringify({ competition: 'NRL' }) });
  r = await f(base, { method: 'POST', headers: { 'Upload-Length': String(data.length), 'Upload-Metadata': md } });
  const loc = r.headers.get('location')!;
  check('created', [r.status, loc.startsWith('/api/tus/'), r.headers.get('upload-offset')], [201, true, '0']);
  const url = `http://127.0.0.1:${port}${loc}`;
  check('metadata round trips', parseMetadata(md).filename, 'Match Day.mxf');

  // HEAD
  r = await f(url, { method: 'HEAD' });
  check('head offset 0, length known, metadata echoed', [r.status, r.headers.get('upload-offset'), r.headers.get('upload-length'), parseMetadata(r.headers.get('upload-metadata')!).relativePath], [200, '0', String(data.length), 'Shoots/Day 1/Match Day.mxf']);

  // PATCH first 100k
  const part1 = data.subarray(0, 100_000);
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', 'Content-Length': String(part1.length) }, body: part1 });
  check('first patch', [r.status, r.headers.get('upload-offset')], [204, '100000']);
  // wrong offset
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '50', 'Content-Length': '10' }, body: data.subarray(50, 60) });
  check('wrong offset is 409 and reports the real one', [r.status, r.headers.get('upload-offset')], [409, '100000']);
  // wrong content type
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '100000', 'Content-Length': '10' }, body: data.subarray(100000, 100010) });
  check('wrong content type is 415', r.status, 415);
  // checksum mismatch rolls back
  const part2 = data.subarray(100_000, 200_000);
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '100000', 'Content-Length': String(part2.length), 'Upload-Checksum': 'sha256 ' + Buffer.from('nope').toString('base64') }, body: part2 });
  check('checksum mismatch is 460', r.status, 460);
  r = await f(url, { method: 'HEAD' });
  check('mismatched bytes were rolled back', r.headers.get('upload-offset'), '100000');
  // checksum ok
  const good = createHash('sha256').update(part2).digest('base64');
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '100000', 'Content-Length': String(part2.length), 'Upload-Checksum': 'sha256 ' + good }, body: part2 });
  check('checksum ok', [r.status, r.headers.get('upload-offset')], [204, '200000']);
  check('not complete yet', completed.length, 0);
  // over length
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '200000', 'Content-Length': '200000' }, body: randomBytes(200000) });
  check('exceeding the length is 413', r.status, 413);
  // final part
  const part3 = data.subarray(200_000);
  r = await f(url, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '200000', 'Content-Length': String(part3.length) }, body: part3 });
  check('final patch', [r.status, r.headers.get('upload-offset')], [204, String(data.length)]);
  await new Promise((res) => setTimeout(res, 50));
  check('onComplete fired once with the sha of the whole file', [completed.length, completed[0]?.sha, completed[0]?.who.accountId], [1, createHash('sha256').update(data).digest('hex'), 'acc']);
  const onDisk = readFileSync(store.dataPath(completed[0].info));
  check('bytes on disk are the bytes sent', Buffer.compare(onDisk, data), 0);

  // creation-with-upload
  const small = randomBytes(5000);
  r = await f(base, { method: 'POST', headers: { 'Upload-Length': String(small.length), 'Content-Type': 'application/offset+octet-stream', 'Content-Length': String(small.length) }, body: small });
  check('creation with upload completes in one request', [r.status, r.headers.get('upload-offset'), completed.length], [201, '5000', 2]);

  // termination
  const loc2 = r.headers.get('location')!;
  r = await f(`http://127.0.0.1:${port}${loc2}`, { method: 'DELETE' });
  check('delete', r.status, 204);
  r = await f(`http://127.0.0.1:${port}${loc2}`, { method: 'HEAD' });
  check('gone after delete', r.status, 404);

  srv.close();
  console.log(`tus: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
