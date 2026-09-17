// Desktop agent: sync root detection (pure) and one pass against a fake Volt
// (locate / remote / tus) on localhost with real files in a temp folder.
import express from 'express';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncRootFor, isCloudOnly } from '../../volt-agent/src/syncRoots';
import { pass, walk } from '../../volt-agent/src/agent';
import { createTusRouter, MemoryTusStore } from '../src/services/ingest/tus';

let pass_ = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass_++; else { fail++; console.log(`FAIL ${m}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } };

(async () => {
  console.log('== sync roots ==');
  const mac = '/Users/chris';
  check('macOS Google Drive for desktop', syncRootFor('/Users/chris/Library/CloudStorage/GoogleDrive-chris@x.com/My Drive/Shoots/Day 1/a.mxf', mac, 'darwin'), { provider: 'gdrive', root: '/Users/chris/Library/CloudStorage/GoogleDrive-chris@x.com/My Drive', relativePath: 'Shoots/Day 1/a.mxf', account: 'chris@x.com' });
  check('macOS OneDrive', syncRootFor('/Users/chris/Library/CloudStorage/OneDrive-Vizrt/Docs/b.mov', mac, 'darwin')?.provider, 'onedrive');
  check('macOS Dropbox (CloudStorage and legacy)', [syncRootFor('/Users/chris/Library/CloudStorage/Dropbox-Team/x.mp4', mac, 'darwin')?.relativePath, syncRootFor('/Users/chris/Dropbox/x.mp4', mac, 'darwin')?.provider], ['x.mp4', 'dropbox']);
  check('not a sync root', syncRootFor('/Users/chris/Movies/x.mp4', mac, 'darwin'), null);
  const win = 'C:\\Users\\chris';
  check('windows OneDrive with org suffix', syncRootFor('C:\\Users\\chris\\OneDrive - Vizrt\\Docs\\b.mov', win, 'win32'), { provider: 'onedrive', root: 'C:/Users/chris/OneDrive - Vizrt', relativePath: 'Docs/b.mov', account: null });
  check('windows Drive letter', syncRootFor('G:\\My Drive\\Shoots\\a.mxf', win, 'win32')?.relativePath, 'Shoots/a.mxf');
  check('windows Dropbox', syncRootFor('C:\\Users\\chris\\Dropbox\\a.mxf', win, 'win32')?.provider, 'dropbox');
  check('extra roots configured by the operator win', syncRootFor('/mnt/nas/dropbox-mirror/a.mxf', '/home/x', 'linux', [{ path: '/mnt/nas/dropbox-mirror', provider: 'dropbox' }])?.relativePath, 'a.mxf');
  check('cloud-only heuristic', [isCloudOnly({ size: 100, blocks: 0 }), isCloudOnly({ size: 100, blocks: 8 }), isCloudOnly({ size: 100 })], [true, false, null]);

  console.log('== one pass ==');
  const dir = mkdtempSync(join(tmpdir(), 'agent-'));
  const home = join(dir, 'home'); const drop = join(home, 'Library/CloudStorage/Dropbox-Team/Shoots'); const local = join(dir, 'local');
  mkdirSync(join(drop, 'Day 1'), { recursive: true }); mkdirSync(local, { recursive: true });
  writeFileSync(join(drop, 'Day 1', 'in-dropbox.mxf'), 'x'.repeat(5000));
  writeFileSync(join(drop, 'not-in-account.mov'), 'y'.repeat(3000));
  writeFileSync(join(local, 'local file.mp4'), 'z'.repeat(20000));
  writeFileSync(join(local, 'copying.mp4.part'), 'p');
  writeFileSync(join(local, 'fresh.mp4'), 'f'.repeat(10));
  const old = new Date(Date.now() - 60_000); for (const p of ['Day 1/in-dropbox.mxf', 'not-in-account.mov']) utimesSync(join(drop, p), old, old); utimesSync(join(local, 'local file.mp4'), old, old);

  const app = express(); app.use(express.json());
  const calls: any[] = [];
  app.post('/api/ingest/locate', (req, res) => { calls.push(['locate', req.body.files[0]]); res.json(req.body.files.map((f: any) => ({ name: f.name, hit: f.name === 'in-dropbox.mxf' ? { ref: { provider: 'dropbox', ref: 'id:1' }, name: f.name, bytes: f.bytes, strength: 'path', providerAccountId: 'pa1', label: 'Team Dropbox' } : null }))); });
  app.post('/api/ingest/remote', (req, res) => { calls.push(['remote', req.body]); res.status(202).json({ sessionId: 's1' }); });
  const store = new MemoryTusStore(join(dir, 'tus'));
  const completed: any[] = [];
  app.use('/api/tus', createTusRouter({ store, basePath: '/api/tus', authorise: async () => ({ accountId: 'acc' }), onComplete: async (info) => { completed.push(info.metadata); } }));
  const srv = app.listen(0); const port = (srv.address() as any).port;
  const cfg = { server: `http://127.0.0.1:${port}`, token: 't', folders: [{ path: drop, source: 'agent' }, { path: local, source: 'agent' }], quietMs: 5000, chunkBytes: 4096 };
  const state: any = {};
  const logs: string[] = [];
  const r = await pass(cfg, state, { home, platform: 'darwin', log: (s) => logs.push(s) });
  const routes = Object.fromEntries(r.handled.map((h) => [h.path.split('/').pop(), h.route]));
  check('walk skips junk', (await walk(local)).map((p) => p.split('/').pop()).sort(), ['fresh.mp4', 'local file.mp4']);
  check('dropbox file found in the account went cloud to cloud', routes['in-dropbox.mxf'], 'cloud');
  check('remote request carried the provider ref and the folder path', [calls.find((c) => c[0] === 'remote')?.[1].ref.ref, calls.find((c) => c[0] === 'remote')?.[1].relativePath], ['id:1', 'Day 1/in-dropbox.mxf']);
  check('locate asked with the provider-relative path', calls.find((c) => c[0] === 'locate')?.[1].relativePath, 'Shoots/Day 1/in-dropbox.mxf');
  check('dropbox file NOT in the account (and not cloud-only) was uploaded with tus', routes['not-in-account.mov'], 'tus');
  check('plain local file uploaded with tus', routes['local file.mp4'], 'tus');
  check('fresh file waits for quiet time', routes['fresh.mp4'], undefined);
  check('tus metadata carries path, source and provenance', [completed.find((m) => m.filename === 'not-in-account.mov')?.provider, completed.find((m) => m.filename === 'not-in-account.mov')?.providerPath, completed.find((m) => m.filename === 'local file.mp4')?.relativePath, completed[0]?.source], ['dropbox', 'Shoots/not-in-account.mov', 'local file.mp4', 'agent']);
  check('tus uploads completed on the server', completed.length, 2);
  const r2 = await pass(cfg, state, { home, platform: 'darwin', log: () => {} });
  check('second pass does nothing for handled files', r2.handled.map((h) => h.path.split('/').pop()), []);
  srv.close();
  console.log(`agent: ${pass_} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
