// ============================================================================
//  MIRROR AND ARCHIVE: asset sidecars and nightly copies (build queue H3-8,
//  HYBRID_SITES.md "Copy rules": sidecars (captions, thumbnails, metadata as
//  JSON) and "on a schedule").
//
//  Through the real API on a real database, with the REAL site agent code
//  (volt-agent/src/siteArchive.ts) writing into folders that stand in for
//  the customer's NAS:
//    - rules: `what` saved (sidecars, both), "original only" stored unsaid,
//      an unknown `what` refused, `schedule` accepted;
//    - sidecars: a metadata JSON, each caption file as delivered, a
//      companion file and the poster, named after the original, copied and
//      verified beside it; the cloud's built files go once verified; asking
//      again copies nothing; sidecars alone copy no original; a poster
//      missing from the store is skipped and the rest still go;
//    - nightly: the walk copies what a `schedule` rule covers and the target
//      lacks, in bounded steps from a cursor, once per UTC day, within the
//      off-peak window; ingest-only rules, an asset whose own rung says no,
//      and an unlicensed account get nothing.
//
//  Usage: DATABASE_URL=... npx tsx test/mirror-archive-sidecars.check.ts
// ============================================================================
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(async () => {
  process.env.CLIPS_DIR ||= mkdtempSync(join(tmpdir(), 'mas-clips-'));
  process.env.IMAGE_STORE_DIR = mkdtempSync(join(tmpdir(), 'mas-img-'));
  process.env.ARCHIVE_BUILD_DIR = mkdtempSync(join(tmpdir(), 'mas-build-'));
  const A = await import('../src/services/archive/archive');
  const S = await import('../src/services/archive/sidecars');
  const AG = await import('../../volt-agent/src/siteArchive');
  const { imageStore } = await import('../src/services/imageStore');

  console.log('== names (pure) ==');
  ok(S.baseNameFor({ source_key: '/x/Morning News 1.mp4', title: 'T' }) === 'MorningNews1', 'the base is the original\'s name without its extension', S.baseNameFor({ source_key: '/x/Morning News 1.mp4', title: 'T' }));
  ok(S.baseNameFor({ source_key: 's3://bucket/a/b/Clip.MOV', title: 'T' }) === 'Clip', 'an S3 original too');
  ok(S.baseNameFor({ source_key: null, title: 'Café Show' }) === 'CafeShow', 'the title when there is no original');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');

  const tag = Date.now().toString(36);
  const mkAcct = async (n: string, lic: string[]) => (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, $2) RETURNING id`, [`${n}-${tag}`, lic]))!.id;
  const acct = await mkAcct('mas', ['mirror_archive']);
  const none = await mkAcct('mns', []);
  const tokFor = async (a: string, n: string) => {
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return signAccess({ sub: u, account_id: a, role: 'owner' } as any);
  };
  const tok = await tokFor(acct, 'own');
  await tokFor(none, 'none');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = (hostname: string) => ({ hostname, cpuCores: 4, memoryBytes: 8 * 2 ** 30, diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.6.0' });
  const site = (await api('POST', '/api/sites', { name: 'NAS room' })).body.id;
  const tk = await api('POST', `/api/sites/${site}/enrolment-tokens`, {});
  const en = await api('POST', '/api/site-agent/enrol', { token: tk.body.token, host: facts('nas-01') }, null);
  await api('POST', `/api/sites/${site}/hosts/${en.body.hostId}/approve`, {});
  const ctx = { server: base, credential: () => en.body.credential as string, log: (_s: string) => {}, progressEveryMs: 50 };
  const drain = async () => { let n = 0; for (let i = 0; i < 20; i++) { const ran = await AG.archivePass(ctx); n += ran; if (!ran) break; } return n; };

  const nas = mkdtempSync(join(tmpdir(), 'mas-nas-'));
  const nas2 = mkdtempSync(join(tmpdir(), 'mas-nas2-'));
  const target = (await api('POST', '/api/archive/targets', { name: 'Archive NAS', siteId: site, path: nas })).body.id;
  const target2 = (await api('POST', '/api/archive/targets', { name: 'Nightly NAS', siteId: site, path: nas2 })).body.id;

  console.log('== copy rules: what and schedule ==');
  let r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['tapes'] }] } } });
  ok(r.status === 422, 'an unknown "what" is refused (schema check)', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: [] }] } } });
  ok(r.status === 422, 'an empty "what" is refused', r.status);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['source'] }] } } });
  ok(r.status === 200 && r.body.settings.archive.copies[0].what === undefined, '"original only" is stored unsaid, as rules saved before sidecars read', r.body?.settings?.archive);
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'], what: ['source', 'sidecars', 'sidecars'] }, { targetId: target2, on: ['schedule'] }] } } });
  ok(r.status === 200 && JSON.stringify(r.body.settings.archive.copies[0].what) === '["source","sidecars"]' && r.body.settings.archive.copies[1].on[0] === 'schedule',
    'original and sidecars (deduplicated) and a nightly target are saved', r.body?.settings?.archive);

  console.log('== sidecars on ingest ==');
  const srcDir = join(process.env.CLIPS_DIR!, 'vod-src');
  mkdirSync(srcDir, { recursive: true });
  const mkAsset = async (a: string, file: string, body: Buffer, extra: Record<string, any> = {}) => {
    const key = join(srcDir, file); writeFileSync(key, body);
    const id = (await one<any>(`INSERT INTO vod_assets (account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, source_key, sha256)
      VALUES ($1,'upload',$2,'/x',0,0,61000,$3,$4) RETURNING id`, [a, file.replace(/\.[a-z0-9]+$/, ''), key, sha(body)]))!.id as string;
    for (const [k, v] of Object.entries(extra)) await query(`UPDATE vod_assets SET ${k} = $2 WHERE id = $1`, [id, v]);
    return id;
  };
  const bytes1 = randomBytes(150_000);
  const asset1 = await mkAsset(acct, `Morning News ${tag}.mp4`, bytes1);
  await query(`UPDATE vod_assets SET metadata = $2::jsonb WHERE id = $1`, [asset1, JSON.stringify({ description: 'The early show', tags: ['news'] })]).catch(() => {});
  const en1 = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  const fr1 = Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n');
  const xml1 = Buffer.from('<asset><title>Morning</title></asset>\n');
  const poster = randomBytes(5000);
  const addFile = async (kind: string, format: string, name: string, body: Buffer, language: string | null) => {
    const id = (await one<any>(`SELECT gen_random_uuid() AS id`))!.id;
    const key = `companions/${acct}/${asset1}/${id}/${name}`;
    await imageStore().put(key, body);
    await query(`INSERT INTO vod_asset_files (id, asset_id, account_id, kind, format, name, store_key, bytes, sha256, language, label)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, asset1, acct, kind, format, name, key, body.length, sha(body), language, language]);
  };
  await addFile('captions', 'srt', 'news_en.srt', en1, 'en');
  await addFile('captions', 'vtt', 'news_fr.vtt', fr1, 'fr');
  await addFile('metadata', 'xml', 'news.xml', xml1, null);
  await imageStore().put(`posters/${asset1}.jpg`, poster);
  await query(`UPDATE vod_assets SET poster_key = $2 WHERE id = $1`, [asset1, `posters/${asset1}.jpg`]);

  let out = await A.copyOnRule(acct, asset1, 'ingest');
  ok(out.queued.length === 6, 'ingest queues the original and five sidecars (metadata, two caption files, the XML, the poster)', out);
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2`, [asset1, target2])).n === 0, 'the nightly-only target gets nothing on ingest');
  const ran = await drain();
  const copies = (await query<any>(`SELECT what, state, stored_path, file_name, source_uri FROM archive_copies WHERE vod_asset_id = $1 AND target_id = $2 ORDER BY what`, [asset1, target]));
  ok(ran >= 6 && copies.length === 6 && copies.every((c) => c.state === 'verified'), 'the agent copies all six and each is verified', { ran, copies: copies.map((c) => [c.what, c.state]) });
  const b = `MorningNews${tag}`;
  const at = (n: string) => join(nas, n);
  ok(existsSync(at(`${b}.mp4`)) && readFileSync(at(`${b}.mp4`)).equals(bytes1), 'the original is at the target');
  ok(existsSync(at(`${b}.en.srt`)) && readFileSync(at(`${b}.en.srt`)).equals(en1), 'the English captions sit beside it, byte for byte as delivered', readdirSync(nas));
  ok(existsSync(at(`${b}.fr.vtt`)) && readFileSync(at(`${b}.fr.vtt`)).equals(fr1), 'and the French WebVTT');
  ok(existsSync(at(`${b}.news.xml`)) && readFileSync(at(`${b}.news.xml`)).equals(xml1), 'the companion XML, named after the original');
  ok(existsSync(at(`${b}.jpg`)) && readFileSync(at(`${b}.jpg`)).equals(poster), 'the poster');
  let meta: any = null; try { meta = JSON.parse(readFileSync(at(`${b}.json`), 'utf8')); } catch { /* checked below */ }
  ok(meta?.kind === 'volt.asset' && meta.asset.id === asset1 && meta.asset.original.fileName === `${b}.mp4` && meta.asset.original.sha256 === sha(bytes1),
    'the metadata file says what the asset is and which original it belongs to', meta?.asset);
  ok(meta?.captions?.length === 2 && meta.captions.some((c: any) => c.fileName === `${b}.en.srt` && c.language === 'en'), 'and lists the caption files by their names at the target', meta?.captions);
  const built = join(process.env.ARCHIVE_BUILD_DIR!, 'assets', asset1);
  const left = existsSync(built) ? readdirSync(built, { recursive: true } as any).filter((f: any) => /\.[a-z]+$/.test(String(f))) : [];
  ok(left.length === 0, 'the cloud\'s built sidecar files are removed once verified', left);
  ok(existsSync(srcDir) && existsSync(join(srcDir, `Morning News ${tag}.mp4`)), 'the asset\'s own original is never removed');

  out = await A.copyOnRule(acct, asset1, 'ingest');
  ok(out.queued.length === 0, 'asking again copies nothing more', out);

  // Sidecars alone, on the asset's own rung.
  const nas3 = mkdtempSync(join(tmpdir(), 'mas-nas3-'));
  const target3 = (await api('POST', '/api/archive/targets', { name: 'Sidecar NAS', siteId: site, path: nas3 })).body.id;
  r = await api('PATCH', `/api/vod/${asset1}/availability`, { override: { archive: { copies: [{ targetId: target3, on: ['publish'], what: ['sidecars'] }] } } });
  ok(r.status === 200, 'an asset\'s own rung can ask for sidecars alone', r.status === 200 ? r.status : r.body);
  await imageStore().delete(`posters/${asset1}.jpg`);
  out = await A.copyOnRule(acct, asset1, 'publish');
  await drain();
  const c3 = await query<any>(`SELECT what, state FROM archive_copies WHERE target_id = $1`, [target3]);
  ok(c3.length === 4 && !c3.some((c) => c.what === 'source') && c3.every((c) => c.state === 'verified'),
    'sidecars alone copy no original; a poster missing from the store is skipped and the other four still go', c3);
  await query(`UPDATE vod_assets SET availability_override = '{}'::jsonb WHERE id = $1`, [asset1]);

  console.log('== nightly copies ==');
  // Clean slate for the walk: older assets that came in before the rule.
  const olds: string[] = [];
  for (let i = 0; i < 5; i++) olds.push(await mkAsset(acct, `Old ${i} ${tag}.mp4`, randomBytes(20_000 + i)));
  const optedOut = olds[4];
  await query(`UPDATE vod_assets SET availability_override = $2::jsonb WHERE id = $1`, [optedOut, JSON.stringify({ archive: { copies: [] } })]);
  const unlicensed = await mkAsset(none, `Theirs ${tag}.mp4`, randomBytes(1000));
  const day1 = new Date('2026-11-07T23:00:00Z');
  let sw = await S.scheduledSweep({ accountId: acct, limit: 3, now: day1 });
  ok(sw.accounts === 1 && sw.assets === 3, 'the walk takes a bounded step (3 assets)', sw);
  let cur = await one<any>(`SELECT * FROM archive_sweeps WHERE account_id = $1`, [acct]);
  ok(cur && !cur.done && cur.after_id, 'and remembers where it got to', cur);
  for (let i = 0; i < 5 && !(await one<any>(`SELECT done FROM archive_sweeps WHERE account_id = $1`, [acct])).done; i++) {
    const s2 = await S.scheduledSweep({ accountId: acct, limit: 3, now: day1 });
    sw = { accounts: sw.accounts + s2.accounts, assets: sw.assets + s2.assets, queued: sw.queued + s2.queued };
  }
  cur = await one<any>(`SELECT * FROM archive_sweeps WHERE account_id = $1`, [acct]);
  const nightly = await query<any>(`SELECT vod_asset_id, what FROM archive_copies WHERE target_id = $1`, [target2]);
  const got = new Set(nightly.map((c) => c.vod_asset_id));
  ok(cur.done && sw.assets === 6, 'the walk reaches the end and is done for the day (all six assets seen)', { cur, sw });
  ok(olds.slice(0, 4).every((id) => got.has(id)) && got.has(asset1), 'every asset the nightly rule covers is copied to the nightly target, older ones included', [...got]);
  ok(!got.has(optedOut), 'an asset whose own rung says no copies is not copied');
  ok(nightly.every((c) => c.what === 'source'), 'a nightly rule with no "what" copies originals only', nightly);
  ok(!(await one<any>(`SELECT 1 FROM archive_copies WHERE vod_asset_id = $1`, [unlicensed])), 'an unlicensed account\'s assets are not walked');
  sw = await S.scheduledSweep({ accountId: acct, limit: 3, now: new Date('2026-11-07T23:30:00Z') });
  ok(sw.accounts === 0 && sw.assets === 0, 'later the same day the walk does nothing', sw);
  await drain();
  ok((await one<any>(`SELECT count(*)::int AS n FROM archive_copies WHERE target_id = $1 AND state = 'verified'`, [target2])).n === 5, 'the agent copies the nightly ones and they are verified');
  const extra = await mkAsset(acct, `Missed ${tag}.mp4`, randomBytes(3000));
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target2, on: ['schedule'] }], offPeak: { from: '01:00', to: '05:00', timeZone: 'UTC' } } } });
  ok(r.status === 200, 'an off-peak window is added', r.status);
  sw = await S.scheduledSweep({ accountId: acct, limit: 50, now: new Date('2026-11-08T12:00:00Z') });
  const held = await one<any>(`SELECT j.run_after FROM archive_copies c JOIN jobs j ON j.id = c.job_id WHERE c.vod_asset_id = $1 AND c.target_id = $2`, [extra, target2]);
  ok(sw.queued === 1 && held && new Date(held.run_after).toISOString() === '2026-11-09T01:00:00.000Z',
    'the next day the walk starts again, copies only what is missing, and holds it for the window', { sw, held });
  r = await api('PUT', '/api/publishing-rules/account', { settings: { archive: { copies: [{ targetId: target, on: ['ingest'] }] } } });
  sw = await S.scheduledSweep({ accountId: acct, limit: 50, now: new Date('2026-11-09T12:00:00Z') });
  ok(sw.queued === 0, 'an ingest-only rule is not run by the nightly walk', sw);
  await query(`UPDATE accounts SET licences = '{}' WHERE id = $1`, [acct]);
  sw = await S.scheduledSweep({ accountId: acct, limit: 50, now: new Date('2026-11-10T12:00:00Z') });
  ok(sw.accounts === 0, 'without the licence there is no walk', sw);
  await query(`UPDATE accounts SET licences = '{mirror_archive}' WHERE id = $1`, [acct]);

  console.log('== wired ==');
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  ok(/scheduledSweep\(\)/.test(src('src/services/orchestrator/index.ts')), 'the scheduler runs the nightly walk');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
