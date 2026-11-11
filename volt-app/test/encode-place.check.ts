// ============================================================================
//  WHERE AN ASSET IS ENCODED (build queue H4-8).
//
//  The Media Library and the asset page say "At site" beside Processing for an
//  Encode at site item, and "Encoded in the cloud because ..." once it fell
//  back. Both read `encode_place` from the VOD API. This suite drives the real
//  site agent (volt-agent siteWatch.ts) against the real API on a real
//  database, so the place is read from the records the real flow writes:
//    - registered at a site: at the site, the site's name, in the list too;
//    - the site renamed: the new name; another account's site: never named;
//    - fallen back: waiting for the original, with the fallback's reason;
//      then encoded in the cloud with the same reason; a file that could not
//      be sent says what went wrong;
//    - every other asset: null, and the list gains no helper column.
//
//  Usage: DATABASE_URL=... npx tsx test/encode-place.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'enc-place-'));
  process.env.CLIPS_DIR = join(root, 'clips');
  process.env.VOD_STORE = 'local';
  mkdirSync(process.env.CLIPS_DIR, { recursive: true });

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const F = await import('../src/services/sites/siteFallback');
  const EP = await import('../src/services/sites/encodePlace');
  const Wk = await import('../../volt-agent/src/siteWatch');

  console.log('== the answer for one ingest record ==');
  ok(EP.encodePlaceOf(null, null) === null && EP.encodePlaceOf({ status: 'ingested' }, 'x') === null, 'no site source: no place');
  const s0 = EP.encodePlaceOf({ siteSource: { siteId: 'S' } }, 'North');
  ok(s0?.at === 'site' && s0.state === 'site' && s0.siteName === 'North' && s0.reason === null, 'a site source alone: at the site', s0);
  const w0 = EP.encodePlaceOf({ siteSource: { siteId: 'S' }, siteFallback: { state: 'uploading', reason: 'why' } }, null);
  ok(w0?.at === 'cloud' && w0.state === 'fallback_waiting' && w0.reason === 'why' && w0.siteName === null, 'uploading is still waiting for the original', w0);
  const f0 = EP.encodePlaceOf({ siteSource: { siteId: 'S' }, siteFallback: { state: 'failed', reason: 'why', error: 'gone' } }, 'N');
  ok(f0?.state === 'fallback_failed' && f0.error === 'gone', 'a failed fallback carries the error', f0);

  const tag = Date.now().toString(36);
  const mkAccount = async (n: string) => {
    const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`${n}-${tag}`]))!.id;
    const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `${n}-${tag}@example.com`]))!.id;
    return { acct, tok: signAccess({ sub: owner, account_id: acct, role: 'owner' } as any) };
  };
  const me = await mkAccount('place');
  const other = await mkAccount('other');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = me.tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.11.0', encoderVersion: null });
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const tk = (await api('POST', `/api/sites/${site}/enrolment-tokens`, {})).body.token;
  const en = (await api('POST', '/api/site-agent/enrol', { token: tk, host: facts('watch-01') }, null)).body;
  await api('POST', `/api/sites/${site}/hosts/${en.hostId}/approve`, {});
  const cred = en.credential as string;

  const drop = join(root, 'nas', 'drop'); mkdirSync(drop, { recursive: true });
  const fid = (await api('POST', '/api/watchfolders', { name: 'NAS encode', kind: 'site', siteId: site, placement: 'encode_site', config: { path: drop, min_age_ms: 1000 }, defaultRules: false })).body.id;
  await api('POST', `/api/watchfolders/${fid}/rules`, { name: 'Video', matchType: 'extension', pattern: 'mp4', targetKind: 'vod' });
  const old = (Date.now() - 60_000) / 1000;
  const mk = (name: string) => {
    const p = join(drop, name);
    writeFileSync(p, Buffer.concat([Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex'), randomBytes(64 * 1024)]));
    utimesSync(p, old, old);
    return p;
  };
  const files = { a: mk('Evening News.mp4'), c: mk('Weather.mp4') };
  const mem = Wk.emptyMemory();
  const wctx = () => ({ server: base, credential: () => cred, memory: mem, log: (_: string) => {}, chunkBytes: 16 * 1024 });
  const folder = (await Wk.siteFolders(wctx())).find((f) => f.id === fid)!;
  const p1 = await Wk.passFolder(wctx(), folder);
  ok(p1.registered.length === 2, 'two videos registered at the site', p1);
  const assetOf = async (name: string) => (await one<any>(`SELECT vod_asset_id FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2`, [fid, name]))!.vod_asset_id as string;
  const A = await assetOf('Evening News.mp4'), C = await assetOf('Weather.mp4');
  const plain = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms) VALUES ($1,'upload','clip','Plain upload','/clips/vod/x/master.m3u8',0,1000,1000) RETURNING id`, [me.acct]))!.id;
  const listRow = async (id: string, t = me.tok) => ((await api('GET', '/api/vod?limit=100', undefined, t)).body as any[]).find((x) => x.id === id);

  console.log('== at the site ==');
  let r = await api('GET', `/api/vod/${C}`);
  ok(r.status === 200 && r.body.usage_status === 'processing', 'the registered item reads Processing', [r.status, r.body?.usage_status]);
  ok(r.body.encode_place?.at === 'site' && r.body.encode_place.state === 'site' && r.body.encode_place.siteId === site && r.body.encode_place.siteName === 'Main broadcast centre',
    'the asset page is told it is encoded at the site, by name', r.body.encode_place);
  let row = await listRow(C);
  ok(row?.encode_place?.state === 'site' && row.encode_place.siteName === 'Main broadcast centre' && row.encode_state === 'queued', 'the Media Library row says the same, with its queued encode', row && [row.encode_place, row.encode_state]);
  ok(row && !('site_name' in row), 'the list gains no helper column', row && Object.keys(row).filter((k) => /site/.test(k)));
  r = await api('GET', `/api/vod/${plain}`);
  ok(r.status === 200 && r.body.encode_place === null, 'an ordinary upload has no place', r.body?.encode_place);
  ok((await listRow(plain))?.encode_place === null, 'nor in the list');
  await api('PATCH', `/api/sites/${site}`, { name: 'North studios' });
  ok((await api('GET', `/api/vod/${C}`)).body.encode_place?.siteName === 'North studios' && (await listRow(C))?.encode_place?.siteName === 'North studios', 'a renamed site is named as it is now');

  console.log("== another account's site is never named ==");
  const stray = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, ingest) VALUES ($1,'watchfolder','clip','Stray',0,1000,1000,$2) RETURNING id`,
    [other.acct, JSON.stringify({ siteSource: { siteId: site, folderId: fid, itemId: 1, sitePath: '/x', objectKey: 'x.mp4' } })]))!.id;
  r = await api('GET', `/api/vod/${stray}`, undefined, other.tok);
  ok(r.status === 200 && r.body.encode_place?.state === 'site' && r.body.encode_place.siteName === null, "a record naming another account's site gets no name", r.body?.encode_place);
  ok((await listRow(stray, other.tok))?.encode_place?.siteName === null, 'nor in its list');
  ok((await api('GET', `/api/vod/${C}`, undefined, other.tok)).status === 404, "and the other account cannot read this account's asset");

  console.log('== fallen back to the cloud ==');
  await api('PATCH', `/api/watchfolders/${fid}`, { fallbackMinutes: 15 });
  const age = (id: string, minutes: number) => query(`UPDATE jobs SET created_at = now() - make_interval(mins => $2), run_after = now() - make_interval(mins => $2) WHERE id = (SELECT encode_job_id FROM vod_assets WHERE id = $1)`, [id, minutes]);
  await age(C, 20);
  ok(await F.sweepSiteFallbacks() === 1, 'the encode that waited 20 minutes falls back');
  r = await api('GET', `/api/vod/${C}`);
  let p = r.body.encode_place;
  ok(p?.at === 'cloud' && p.state === 'fallback_waiting' && /no server of the site "North studios" took the encode within 15 minutes/.test(p.reason ?? '') && p.siteName === 'North studios',
    'it is to be encoded in the cloud, waiting for the original, and says why', p);
  ok((await listRow(C))?.encode_place?.state === 'fallback_waiting', 'the list row too');
  const p2 = await Wk.passFolder(wctx(), folder);
  ok(p2.fellBack.includes('Weather.mp4'), 'the agent sends the original', p2);
  r = await api('GET', `/api/vod/${C}`);
  p = r.body.encode_place;
  ok(p?.at === 'cloud' && p.state === 'fallback_cloud' && /took the encode within 15 minutes/.test(p.reason ?? '') && r.body.usage_status === 'processing', 'it is encoded in the cloud, still saying why', [p, r.body.usage_status]);
  row = await listRow(C);
  ok(row?.encode_place?.state === 'fallback_cloud' && row.encode_state === 'queued', 'the row shows the cloud encode queued', row && [row.encode_place?.state, row.encode_state]);

  console.log('== an original that could not be sent ==');
  await age(A, 30);
  ok(await F.sweepSiteFallbacks() === 1, 'the other encode falls back');
  unlinkSync(files.a);
  await Wk.passFolder(wctx(), folder);
  r = await api('GET', `/api/vod/${A}`);
  p = r.body.encode_place;
  ok(p?.state === 'fallback_failed' && /could not send the original/.test(p.error ?? '') && r.body.usage_status === 'failed', 'it says what went wrong, and the asset failed', [p, r.body.usage_status]);

  console.log(`\nencode-place: ${pass}/${pass + fail} passed`);
  srv.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
