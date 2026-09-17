// Remote sources over a fake provider on localhost: the parallel range fetcher
// (order independence, retry, single-stream fallback), and the URL, Dropbox,
// OneDrive and Google Drive adapters' request shapes and locate logic.
import express from 'express';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fetchToFile } from '../src/services/ingest/sources/fetcher';
import { UrlSource } from '../src/services/ingest/sources/url';
import { DropboxSource } from '../src/services/ingest/sources/dropbox';
import { OneDriveSource } from '../src/services/ingest/sources/onedrive';
import { GoogleDriveSource } from '../src/services/ingest/sources/gdrive';
import { fetchRemote, filenameFromDisposition } from '../src/services/ingest/sources';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };

(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  const data = randomBytes(1_000_000);
  const sha = createHash('sha256').update(data).digest('hex');
  const app = express();
  let rangeHits = 0, flaky = 0; const seen: string[] = [];
  // express answers HEAD from a GET route, so the HEAD route must come first
  app.head('/file.mxf', (_req, res) => { res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(data.length), 'Content-Type': 'application/mxf', 'Content-Disposition': "attachment; filename*=UTF-8''Caf%C3%A9%20Day.mxf" }).end(); });
  app.get('/file.mxf', (req, res) => {
    seen.push(req.method + ' ' + (req.headers.range ?? '-'));
    const r = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ''));
    res.set('Accept-Ranges', 'bytes'); res.set('Content-Disposition', 'attachment; filename="Match Day.mxf"'); res.type('application/mxf');
    if (r) { rangeHits++; if (flaky > 0 && rangeHits === 2) { flaky--; return res.status(503).end(); } const s = Number(r[1]), e = Number(r[2]); res.status(206).set('Content-Range', `bytes ${s}-${e}/${data.length}`).send(data.subarray(s, e + 1)); }
    else res.status(200).set('Content-Length', String(data.length)).send(data);
  });
  app.get('/noranges.bin', (_req, res) => { res.status(200).set('Content-Length', String(data.length)).send(data); });
  app.head('/noranges.bin', (_req, res) => { res.status(405).end(); });
  // fake Dropbox
  app.use(express.json());
  const dbx: any[] = [];
  app.post('/dbx/:ep(*)', (req, res) => {
    dbx.push({ ep: req.params.ep, auth: req.headers.authorization, body: req.body });
    if (req.params.ep === 'files/get_temporary_link') return res.json({ link: `http://127.0.0.1:${port}/file.mxf`, metadata: { name: 'Match Day.mxf', size: data.length, client_modified: '2026-09-01T00:00:00Z' } });
    if (req.params.ep === 'files/get_metadata') return req.body.path === '/Shoots/Day 1/Match Day.mxf' ? res.json({ '.tag': 'file', id: 'id:abc', name: 'Match Day.mxf', size: data.length, path_display: req.body.path }) : res.status(409).json({ error_summary: 'path/not_found' });
    if (req.params.ep === 'files/search_v2') return res.json({ matches: [{ metadata: { metadata: { '.tag': 'file', id: 'id:abc', name: 'Match Day.mxf', size: data.length, path_display: '/x/Match Day.mxf' } } }, { metadata: { metadata: { '.tag': 'file', id: 'id:zzz', name: 'match day.MXF', size: 5, path_display: '/y/match day.MXF' } } }] });
    res.status(404).end();
  });
  // fake Graph
  app.get('/graph/me/drive/items/:id', (req, res) => res.json({ id: req.params.id, name: 'promo.mov', size: data.length, file: { mimeType: 'video/quicktime' }, '@microsoft.graph.downloadUrl': `http://127.0.0.1:${port}/file.mxf` }));
  app.get('/graph/me/drive/root::path(*)', (req, res) => { const p = decodeURIComponent(req.params.path); p === '/Shoots/promo.mov' ? res.json({ id: 'od1', name: 'promo.mov', size: data.length, parentReference: { path: '/drive/root:/Shoots' } }) : res.status(404).end(); });
  app.get('/graph/me/drive/root/search*', (_req, res) => res.json({ value: [{ id: 'od1', name: 'promo.mov', size: data.length, file: {}, parentReference: { path: '/drive/root:/Shoots' } }] }));
  // fake Drive
  app.get('/gd/files/:id', (req, res) => { if (req.query.alt === 'media') { const r = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? '')); if (r) { const s = Number(r[1]), e = Number(r[2]); return res.status(206).send(data.subarray(s, e + 1)); } return res.send(data); } res.json({ id: req.params.id, name: 'clip.mp4', size: String(data.length), mimeType: 'video/mp4', modifiedTime: '2026-09-02T00:00:00Z' }); });
  const srv = app.listen(0); const port = (srv.address() as any).port; const base = `http://127.0.0.1:${port}`;

  console.log('== fetcher ==');
  let r = await fetchToFile({ bytes: data.length, ranges: true, open: (s, e) => fetch(`${base}/file.mxf`, { headers: s != null ? { Range: `bytes=${s}-${e}` } : {} }) }, join(dir, 'a.mxf'), { rangeBytes: 100_000, parallel: 4 });
  check('parallel ranges reassemble exactly', [r.bytes, r.sha256 === sha, rangeHits], [data.length, true, 10]);
  check('bytes on disk', Buffer.compare(readFileSync(join(dir, 'a.mxf')), data), 0);
  rangeHits = 0; flaky = 1;
  r = await fetchToFile({ bytes: data.length, ranges: true, open: (s, e) => fetch(`${base}/file.mxf`, { headers: { Range: `bytes=${s}-${e}` } }) }, join(dir, 'b.mxf'), { rangeBytes: 250_000, parallel: 2, retries: 2 });
  check('a 503 on one range is retried alone', [r.sha256 === sha, rangeHits], [true, 5]);
  r = await fetchToFile({ bytes: data.length, ranges: false, open: () => fetch(`${base}/noranges.bin`) }, join(dir, 'c.bin'), {});
  check('no ranges: single stream, same hash', [r.bytes, r.sha256 === sha], [data.length, true]);
  let err = ''; try { await fetchToFile({ bytes: data.length + 5, ranges: false, open: () => fetch(`${base}/noranges.bin`) }, join(dir, 'd.bin')); } catch (e: any) { err = e.message; }
  check('short body is an error', /expected/.test(err), true);

  console.log('== url source ==');
  const url = new UrlSource(fetch);
  let d = await url.describe({ provider: 'url', ref: `${base}/file.mxf` });
  check('HEAD describes the link', [d.name, d.bytes, d.mime, d.ranges], ['Café Day.mxf', data.length, 'application/mxf', true]);
  d = await url.describe({ provider: 'url', ref: `${base}/noranges.bin` });
  check('HEAD 405 falls back to a ranged GET and reports no ranges', [d.name, d.ranges], ['noranges.bin', false]);
  err = ''; try { await url.describe({ provider: 'url', ref: 'ftp://x/y' }); } catch (e: any) { err = e.message; }
  check('non-http refused', /http/.test(err), true);
  check('disposition parsing', [filenameFromDisposition('attachment; filename="a b.mp4"', 'x'), filenameFromDisposition(null, 'fallback.bin')], ['a b.mp4', 'fallback.bin']);
  const whole = await fetchRemote(url, { provider: 'url', ref: `${base}/file.mxf` }, null, join(dir, 'e.mxf'), fetch, { rangeBytes: 300_000, parallel: 3 });
  check('fetchRemote end to end', [whole.name, whole.sha256 === sha], ['Café Day.mxf', true]);

  console.log('== dropbox ==');
  const dx = new DropboxSource(fetch, `${base}/dbx`);
  d = await dx.describe({ provider: 'dropbox', ref: 'id:abc' }, { accessToken: 'tok' });
  check('temporary link with metadata', [d.name, d.bytes, d.ranges, d.downloadUrl?.endsWith('/file.mxf'), dbx[0].auth, dbx[0].body.path], ['Match Day.mxf', data.length, true, true, 'Bearer tok', 'id:abc']);
  let hit = await dx.locate({ name: 'Match Day.mxf', bytes: data.length, relativePath: 'Shoots/Day 1/Match Day.mxf' }, { accessToken: 'tok' });
  check('locate by path wins', [hit?.strength, hit?.ref.ref], ['path', 'id:abc']);
  hit = await dx.locate({ name: 'Match Day.mxf', bytes: data.length, relativePath: 'nope/x.mxf' }, { accessToken: 'tok' });
  check('locate by name and size, case-insensitive, ignores a different size', [hit?.strength, hit?.ref.ref], ['name_and_size', 'id:abc']);
  hit = await dx.locate({ name: 'Match Day.mxf', bytes: 999 }, { accessToken: 'tok' });
  check('two same-name candidates and no size match is no hit', hit, null);
  err = ''; try { await dx.describe({ provider: 'dropbox', ref: 'id:abc' }, null); } catch (e: any) { err = e.message; }
  check('unlinked dropbox is a clear error', /not linked/.test(err), true);
  const fetched = await fetchRemote(dx, { provider: 'dropbox', ref: 'id:abc' }, { accessToken: 'tok' }, join(dir, 'f.mxf'), fetch, { rangeBytes: 200_000 });
  check('dropbox fetch goes through the temporary link in ranges', fetched.sha256 === sha, true);

  console.log('== onedrive ==');
  const od = new OneDriveSource(fetch, `${base}/graph`);
  d = await od.describe({ provider: 'onedrive', ref: 'od1' }, { accessToken: 'tok' });
  check('graph item with download url', [d.name, d.mime, d.downloadUrl?.endsWith('/file.mxf')], ['promo.mov', 'video/quicktime', true]);
  hit = await od.locate({ name: 'promo.mov', bytes: data.length, relativePath: 'Shoots/promo.mov' }, { accessToken: 'tok' });
  check('onedrive locate by path', [hit?.strength, hit?.ref.ref, hit?.path], ['path', 'od1', '/drive/root:/Shoots/promo.mov']);
  hit = await od.locate({ name: 'promo.mov', bytes: data.length }, { accessToken: 'tok' });
  check('onedrive locate by search', [hit?.strength, hit?.ref.ref], ['name_and_size', 'od1']);

  console.log('== google drive ==');
  const gd = new GoogleDriveSource(fetch, `${base}/gd`);
  d = await gd.describe({ provider: 'gdrive', ref: 'g1', token: 'picker-token' }, null);
  check('drive describe with the picker token', [d.name, d.bytes, d.mime, d.downloadHeaders?.authorization, d.downloadUrl?.includes('alt=media')], ['clip.mp4', data.length, 'video/mp4', 'Bearer picker-token', true]);
  err = ''; try { await gd.describe({ provider: 'gdrive', ref: 'g1' }, null); } catch (e: any) { err = e.message; }
  check('drive without any token is a clear error', /picker token/.test(err), true);
  const g = await fetchRemote(gd, { provider: 'gdrive', ref: 'g1', token: 'picker-token' }, null, join(dir, 'g.mp4'), fetch, { rangeBytes: 400_000 });
  check('drive fetch in ranges', g.sha256 === sha, true);

  srv.close();
  console.log(`ingest-sources: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
