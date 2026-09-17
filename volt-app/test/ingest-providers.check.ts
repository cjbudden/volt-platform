// Transfer providers against fake endpoints: request shapes, launch payloads,
// event parsing. Plus S3 presigned URL generation with fixed credentials.
import express from 'express';
import { AsperaProvider, MasvProvider, SigniantProvider, S3AccelProvider } from '../src/services/ingest/providers';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };

(async () => {
  const app = express(); app.use(express.json());
  const calls: any[] = [];
  app.post('/node/files/upload_setup', (req, res) => { calls.push({ url: req.url, auth: req.headers.authorization, body: req.body }); res.json({ transfer_specs: [{ transfer_spec: { remote_host: 'node.example', remote_user: 'xfer', token: 'ATM3-abc', ssh_port: 33001, fasp_port: 33001, paths: req.body.transfer_requests[0].transfer_request.paths, destination_root: req.body.transfer_requests[0].transfer_request.destination_root } }] }); });
  app.get('/node/ops/transfers/:id', (req, res) => res.json({ id: req.params.id, status: 'completed', bytes_transferred: 100, percentage: 1, files: [{ path: '/volt/inbox/volt-1234/Match Day.mxf', bytes_written: 100 }] }));
  app.post('/masv/teams/:team/packages', (req, res) => { calls.push({ url: req.url, key: req.headers['x-api-key'], body: req.body }); res.json({ id: 'pkg_1', name: req.body.name }); });
  app.post('/sig/oauth/token', (_req, res) => res.json({ access_token: 'sig-tok' }));
  app.post('/sig/v3.1/portals/:portal/packages', (req, res) => { calls.push({ url: req.url, auth: req.headers.authorization, body: req.body }); res.json({ id: 'ms_1', uploadUrl: 'https://portal.example/upload/ms_1' }); });
  const srv = app.listen(0); const port = (srv.address() as any).port; const base = `http://127.0.0.1:${port}`;
  const ctx = { transferId: '12345678-aaaa-bbbb-cccc-ddddeeeeffff', accountId: 'acc', callbackUrl: 'https://volt/api/ingest/transfers/1234/events' };
  const files = [{ name: 'Match Day.mxf', bytes: 100, relativePath: 'Day 1/Match Day.mxf' }];

  console.log('== aspera ==');
  const asp = new AsperaProvider(fetch);
  const a = await asp.createTransfer(files, { kind: 'node_path', root: '/volt/inbox', folder: 'volt-12345678' }, { config: { nodeUrl: `${base}/node`, user: 'u', password: 'p' } }, ctx);
  check('upload_setup called with basic auth and destination root', [calls[0].auth, calls[0].body.transfer_requests[0].transfer_request.destination_root, calls[0].body.transfer_requests[0].transfer_request.paths[0].destination], ['Basic dTpw', '/volt/inbox/volt-12345678', 'Day 1/Match Day.mxf']);
  check('tags carry the transfer id and callback', calls[0].body.transfer_requests[0].transfer_request.tags.volt.callbackUrl, ctx.callbackUrl);
  check('launch is the transfer spec for the desktop client', [a.launch.kind, (a.launch as any).transferSpec.token, (a.launch as any).transferSpec.direction], ['aspera_spec', 'ATM3-abc', 'send']);
  const ev = asp.parseEvent({ transfer: { id: 't1', status: 'completed', bytes_transferred: 100, percentage: 1, files: [{ path: '/volt/inbox/volt-12345678/Match Day.mxf', bytes_written: 100 }] } });
  check('completed transfer event', [ev?.state, ev?.externalId, ev?.progress?.pct, ev?.files?.[0].name], ['landed', 't1', 100, 'Match Day.mxf']);
  check('running event', asp.parseEvent({ id: 't2', status: 'running', percentage: 42 })?.state, 'running');
  check('failed event', asp.parseEvent({ id: 't3', status: 'failed', error_desc: 'disk full' })?.error, 'disk full');
  check('unrelated body is null', asp.parseEvent({ hello: 1 }), null);
  const polled = await asp.poll('t9', { config: { nodeUrl: `${base}/node`, bearer: 'B' } });
  check('poll reads ops/transfers', [polled.state, polled.externalId], ['landed', 't9']);
  let err = ''; try { await asp.createTransfer(files, { kind: 'node_path', root: '/x', folder: 'f' }, { config: {} }, ctx); } catch (e: any) { err = e.message; }
  check('missing node url is a clear error', /node URL/.test(err), true);

  console.log('== masv ==');
  const masv = new MasvProvider(fetch, `${base}/masv`);
  const m = await masv.createTransfer(files, { kind: 'portal', root: 'inbox', folder: 'volt-12345678' }, { config: { apiKey: 'K', teamId: 'team1', portalSubdomain: 'volt' } }, ctx);
  check('package created with the api key and our metadata', [calls[1].key, calls[1].body.metadata.voltTransferId, m.externalId], ['K', ctx.transferId, 'pkg_1']);
  check('launch is the portal', [m.launch.kind, (m.launch as any).url], ['portal', 'https://volt.portal.massive.io/?package=pkg_1']);
  check('delivered webhook lands', masv.parseEvent({ event: 'package.delivered', package: { id: 'pkg_1', files: [{ name: 'a.mov', size: 5 }] } })?.state, 'landed');
  check('progress webhook runs', masv.parseEvent({ event: 'package.progress', package: { id: 'pkg_1', bytes_uploaded: 50 } })?.progress?.bytes, 50);
  check('expired webhook fails', masv.parseEvent({ event: 'package.expired', package: { id: 'pkg_1' } })?.state, 'failed');

  console.log('== signiant ==');
  const sig = new SigniantProvider(fetch, `${base}/sig/v3.1`);
  const s = await sig.createTransfer(files, { kind: 'portal', root: 'inbox', folder: 'volt-12345678' }, { config: { clientId: 'c', clientSecret: 's', portalId: 'p1' } }, ctx);
  check('token then package with bearer', [calls[2].auth, calls[2].url, calls[2].body.files[0].name], ['Bearer sig-tok', '/sig/v3.1/portals/p1/packages', 'Match Day.mxf']);
  check('launch is the upload url', (s.launch as any).url, 'https://portal.example/upload/ms_1');
  check('completed notification', sig.parseEvent({ eventType: 'PACKAGE_TRANSFER_COMPLETE', package: { id: 'ms_1', files: [{ name: 'a.mov', size: 1 }] } })?.state, 'landed');
  check('cancelled notification', sig.parseEvent({ eventType: 'PACKAGE_CANCELLED', package: { id: 'ms_1' } })?.state, 'cancelled');

  console.log('== s3 acceleration ==');
  const s3 = new S3AccelProvider({ bucket: 'volt-origin', region: 'ap-southeast-2', accelerate: true, credentials: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' }), now: () => new Date('2026-09-17T10:00:00Z'), expiresSec: 900 });
  const p = await s3.createTransfer(files, { kind: 's3', root: 'media/inbox', folder: 'volt-12345678' }, { config: {} }, ctx);
  const u = new URL((p.launch as any).uploads[0].url);
  check('presigned put on the accelerate endpoint', [p.launch.kind, u.hostname, u.pathname, u.searchParams.get('X-Amz-Expires'), u.searchParams.get('X-Amz-Algorithm'), u.searchParams.get('X-Amz-Credential')?.startsWith('AKIAEXAMPLE/20260917/ap-southeast-2/s3/'), !!u.searchParams.get('X-Amz-Signature')],
    ['presigned', 'volt-origin.s3-accelerate.amazonaws.com', '/media/inbox/volt-12345678/Day%201/Match%20Day.mxf', '900', 'AWS4-HMAC-SHA256', true, true]);
  const s3ev = s3.parseEvent({ Records: [{ eventName: 'ObjectCreated:Put', s3: { object: { key: 'media/inbox/volt-12345678/Day+1/Match+Day.mxf', size: 100 } } }] });
  check('s3 event lands', [s3ev?.state, s3ev?.files?.[0].name], ['landed', 'Match Day.mxf']);
  err = ''; try { await s3.createTransfer([{ name: 'huge.mxf', bytes: 6e9 }], { kind: 's3', root: 'x', folder: 'f' }, { config: {} }, ctx); } catch (e: any) { err = e.message; }
  check('over 5 GB is refused with a pointer to tus', /tus/.test(err), true);

  srv.close();
  console.log(`ingest-providers: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
