// ============================================================================
//  HYBRID SITES 4g: THE INGEST SIDECAR OF A REGISTERED ORIGINAL (build queue H4-7).
//
//  An upload gets its ingest sidecar (`<file>.json`, or `.xml`, as the ingest
//  rules say) written beside the original in the cloud. A file registered from
//  an Encode at site folder stays at the site, so until H4-7 it got none. Now:
//    - the ingest makes the same sidecar on the facts and keeps it on the asset
//      (name, text, SHA-256); the registration answer carries it;
//    - the real site agent writes it beside the original at the site, through
//      a .part file, and the original is untouched;
//    - the next scan does not take it as a new drop, even with the agent's
//      memory lost (the cloud knows its exact text), so the companion rule
//      never attaches Volt's own sidecar to its video; edited, it is decided
//      like any other file;
//    - xml when the rules say xml, none when they say none;
//    - a customer's own file of that name is kept, never replaced; a name the
//      cloud gives that is not `<original>.json|xml`, or text that does not
//      match its checksum, is refused by the agent;
//    - registering again gives the same sidecar; a held duplicate gets one,
//      as an upload's does.
//
//  Usage: DATABASE_URL=... npx tsx test/site-registration-sidecar.check.ts
// ============================================================================
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, utimesSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

(async () => {
  const root = mkdtempSync(join(tmpdir(), 'site-sidecar-'));
  process.env.CLIPS_DIR = join(root, 'clips');
  process.env.VOD_STORE = 'local';
  mkdirSync(process.env.CLIPS_DIR, { recursive: true });

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const Wk = await import('../../volt-agent/src/siteWatch');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name, licences) VALUES ($1, '{hybrid_sites}') RETURNING id`, [`ss-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `ss-${tag}@example.com`]))!.id;
  const prof = (await one<any>(`INSERT INTO output_profiles(account_id, name, rungs, workflow_type, codec_backend, packaging)
      VALUES ($1,'HD','[{"height":360,"bitrate_kbps":800}]','transcode','x264','both') RETURNING id`, [acct]))!.id;
  const { ensureTrackingGroup } = await import('../src/services/encode/store');
  await ensureTrackingGroup(acct, prof, 'Same as live', { makeDefault: true });
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t: string | null = tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const facts = { hostname: 'enc-01', cpuCores: 8, memoryBytes: 16 * 2 ** 30, gpus: [], diskFreeBytes: 1e12, diskTotalBytes: 2e12, os: 'Linux', arch: 'x64', agentVersion: '0.10.0', encoderVersion: null };
  const site = (await api('POST', '/api/sites', { name: 'Main broadcast centre' })).body.id;
  const tk = (await api('POST', `/api/sites/${site}/enrolment-tokens`, {})).body.token;
  const e = (await api('POST', '/api/site-agent/enrol', { token: tk, host: facts }, null)).body;
  await api('POST', `/api/sites/${site}/hosts/${e.hostId}/approve`, {});
  const cred = e.credential as string;
  ok(!!cred, 'a site with an approved host');

  // The built-in default rules: video to the library AND metadata files (json,
  // xml) attached to their video by name. Without the cloud knowing its own
  // sidecar, the next pass would attach it to the very video it describes.
  const drop = join(root, 'nas', 'drop'); mkdirSync(drop, { recursive: true });
  let r = await api('POST', '/api/watchfolders', { name: 'NAS encode', kind: 'site', siteId: site, placement: 'encode_site', config: { path: drop, min_age_ms: 1000 }, defaultRules: true });
  ok(r.status === 201 && r.body.placement === 'encode_site', 'an Encode at site folder with the default rules', [r.status, r.body?.code]);
  const fid = r.body.id;
  const rules = (await api('GET', `/api/watchfolders/${fid}/rules`)).body;
  const ruleList = rules?.items ?? rules ?? [];
  ok(Array.isArray(ruleList) && ruleList.some((x: any) => (x.targetKind ?? x.target_kind) === 'companion' && /json/.test(x.pattern)), 'its rules attach json files to their video by name', ruleList.map?.((x: any) => [x.pattern, x.target_kind]));

  const old = (Date.now() - 60_000) / 1000;
  const mkVideo = (path: string, d = 2) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=s=320x180:r=25:d=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { stdio: 'ignore' });
    utimesSync(path, old, old);
  };
  const src = join(drop, 'Evening News.mp4');
  mkVideo(src);
  const srcSum = sha(readFileSync(src));

  const logs: string[] = [];
  let mem = Wk.emptyMemory();
  const wctx = () => ({ server: base, credential: () => cred, memory: mem, log: (s: string) => logs.push(s) });
  const folder = (await Wk.siteFolders(wctx())).find((f) => f.id === fid)!;

  console.log('== registered: the sidecar is written beside the original at the site ==');
  const p1 = await Wk.passFolder(wctx(), folder);
  ok(!p1.error && p1.registered.includes('Evening News.mp4'), 'the video is registered', [p1.error, p1.registered, p1.uploadErrors]);
  const item = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News.mp4'`, [fid]);
  const A = item?.vod_asset_id;
  const a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [A]);
  const sc = a?.ingest?.siteSidecar;
  ok(sc?.name === 'Evening News.mp4.json' && sc.format === 'json' && sc.mediaType === 'application/json', 'the asset keeps the sidecar: the original\'s name plus .json (the default rules ask for json)', sc && [sc.name, sc.format]);
  ok(typeof sc?.text === 'string' && sha(sc.text) === sc.sha256, 'with its text and that text\'s SHA-256', sc && sc.sha256);
  const scPath = join(drop, 'Evening News.mp4.json');
  ok(p1.sidecars.includes('Evening News.mp4.json') && existsSync(scPath), 'the agent wrote it beside the original', [p1.sidecars, readdirSync(drop)]);
  const written = existsSync(scPath) ? readFileSync(scPath) : Buffer.alloc(0);
  ok(sha(written) === sc?.sha256, 'byte for byte the text Volt made');
  let payload: any = null; try { payload = JSON.parse(written.toString('utf8')); } catch { /* checked below */ }
  ok(payload?.asset?.id === A && payload?.object?.sha256 === srcSum && payload?.event === 'ingested', 'it is the ingest payload an upload gets: the asset, the original\'s checksum, the event', payload && { asset: payload.asset?.id, sha: payload.object?.sha256, event: payload.event });
  ok(payload?.object?.key === 'Evening News.mp4' && payload.object.store === 'site' && payload.naming?.renamed === false, 'naming the original as it is at the site: its own name (not renamed there), store "site"', payload && [payload.object?.key, payload.object?.store, payload.naming]);
  ok(!readdirSync(drop).some((n) => n.endsWith('.part')), 'no .part file left behind');
  ok(sha(readFileSync(src)) === srcSum, 'the original is untouched');
  ok(a?.media_state === 'processing' && a.ingest?.siteSource?.objectKey === 'Evening News.mp4', 'the registration is otherwise as before: Processing, the place at the site', a && [a.media_state, a.ingest?.siteSource]);
  ok(!p1.uploaded.includes('Evening News.mp4.json'), 'the sidecar is not uploaded');

  console.log('== the next scans: Volt\'s own file, not a new drop ==');
  if (existsSync(scPath)) utimesSync(scPath, old, old);   // quiet long enough for the scan to consider it
  const p2 = await Wk.passFolder(wctx(), folder);
  let scRow = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News.mp4.json'`, [fid]);
  ok(!p2.error && !scRow && (p2.scan?.skippedKnown ?? 0) >= 2 && !(p2.scan?.skippedTooNew ?? []).length, 'the next pass considers it and does not report it', [p2.error, scRow?.status, p2.scan?.skippedKnown, p2.scan?.skippedTooNew]);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/known`, { objectKey: 'Evening News.mp4.json', checksum: sc?.sha256 }, cred);
  ok(r.status === 200 && r.body.known === true, 'the cloud answers known for it with its exact text', r.body);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/known`, { objectKey: 'Evening News.mp4.json', checksum: 'a'.repeat(64) }, cred);
  ok(r.status === 200 && r.body.known === false, 'and not known with other content', r.body);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/known`, { objectKey: 'Other.mp4.json', checksum: sc?.sha256 }, cred);
  ok(r.body.known === false, 'nor under another name', r.body);
  mem = Wk.emptyMemory();   // the state file lost: the agent asks the cloud for every file again
  const p3 = await Wk.passFolder(wctx(), folder);
  scRow = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News.mp4.json'`, [fid]);
  ok(!p3.error && !scRow && (p3.scan?.skippedKnown ?? 0) >= 2, 'with the agent\'s memory lost it is still known (the original too)', [p3.error, scRow?.status, p3.scan?.skippedKnown]);
  const companions = await one<any>(`SELECT count(*)::int AS n FROM watchfolder_items WHERE watchfolder_id = $1 AND target_kind = 'companion'`, [fid]);
  ok(companions?.n === 0, 'nothing is attached to the video as a companion', companions);

  console.log('== edited at the site, it is decided like any other file ==');
  writeFileSync(scPath, written.toString('utf8').replace('"ingested"', '"ingested" ') + '\n');
  utimesSync(scPath, old, old);
  const p4 = await Wk.passFolder(wctx(), folder);
  scRow = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News.mp4.json'`, [fid]);
  ok(!p4.error && scRow && scRow.target_kind === 'companion', 'an edited sidecar is a new file, taken by the companion rule', [p4.error, scRow?.status, scRow?.target_kind]);

  console.log('== xml, none ==');
  await query(`INSERT INTO ingest_rules(account_id, rung, name, "then") VALUES ($1,'account','Sidecars as XML',$2::jsonb)`, [acct, JSON.stringify({ sidecar: 'xml' })]);
  const x = join(drop, 'Late Show.mp4'); mkVideo(x, 1);
  const p5 = await Wk.passFolder(wctx(), folder);
  const xItem = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Late Show.mp4'`, [fid]);
  const xa = await one<any>(`SELECT ingest FROM vod_assets WHERE id = $1`, [xItem?.vod_asset_id]);
  const xPath = join(drop, 'Late Show.mp4.xml');
  ok(p5.registered.includes('Late Show.mp4') && xa?.ingest?.siteSidecar?.name === 'Late Show.mp4.xml' && existsSync(xPath), 'the rules say xml: Late Show.mp4.xml beside it', [p5.registered, xa?.ingest?.siteSidecar?.name, readdirSync(drop)]);
  ok(existsSync(xPath) && /^<\?xml/.test(readFileSync(xPath, 'utf8')) && sha(readFileSync(xPath)) === xa?.ingest?.siteSidecar?.sha256, 'XML, the text Volt made');
  ok(!existsSync(join(drop, 'Late Show.mp4.json')), 'and no json');
  await query(`UPDATE ingest_rules SET "then" = $2::jsonb WHERE account_id = $1 AND name = 'Sidecars as XML'`, [acct, JSON.stringify({ sidecar: 'none' })]);
  const n = join(drop, 'Weather.mp4'); mkVideo(n, 1);
  const p6 = await Wk.passFolder(wctx(), folder);
  const nItem = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Weather.mp4'`, [fid]);
  const na = await one<any>(`SELECT ingest FROM vod_assets WHERE id = $1`, [nItem?.vod_asset_id]);
  ok(p6.registered.includes('Weather.mp4') && na?.ingest && !na.ingest.siteSidecar && !readdirSync(drop).some((f) => f.startsWith('Weather.mp4.')), 'the rules say none: no sidecar kept or written', [p6.registered, na?.ingest?.siteSidecar, readdirSync(drop)]);
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${nItem.id}`, { sizeBytes: Number(nItem.size_bytes), checksum: nItem.checksum, head: '' }, cred);
  ok(r.status === 201 && r.body.sidecar === null, 'its registration answer has sidecar null', r.body?.sidecar);
  await query(`DELETE FROM ingest_rules WHERE account_id = $1 AND name = 'Sidecars as XML'`, [acct]);

  console.log('== registering again; a held duplicate ==');
  r = await api('POST', `/api/site-agent/watchfolders/${fid}/registrations/${item.id}`, { sizeBytes: Number(item.size_bytes), checksum: item.checksum, head: '' }, cred);
  ok(r.status === 201 && r.body.vodAssetId === A && r.body.sidecar?.name === 'Evening News.mp4.json' && r.body.sidecar.sha256 === sc?.sha256 && r.body.sidecar.text === sc?.text, 'registering again answers the same sidecar', r.body?.sidecar && [r.body.sidecar.name]);
  copyFileSync(src, join(drop, 'Evening News copy.mp4')); utimesSync(join(drop, 'Evening News copy.mp4'), old, old);
  const p7 = await Wk.passFolder(wctx(), folder);
  const dItem = await one<any>(`SELECT * FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Evening News copy.mp4'`, [fid]);
  const d = await one<any>(`SELECT ingest FROM vod_assets WHERE id = $1`, [dItem?.vod_asset_id]);
  const dPath = join(drop, 'Evening News copy.mp4.json');
  ok(p7.registered.includes('Evening News copy.mp4') && d?.ingest?.status === 'duplicate', 'the same content again is held as a duplicate', d?.ingest?.status);
  let dPayload: any = null; try { dPayload = JSON.parse(readFileSync(dPath, 'utf8')); } catch { /* checked below */ }
  ok(dPayload?.event === 'duplicate' && dPayload?.asset?.id === dItem?.vod_asset_id, 'it gets its sidecar too, saying duplicate (as an upload\'s does)', dPayload && [dPayload.event]);

  console.log('== the agent writes only its own file ==');
  const own = join(root, 'own'); mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'Clip.mp4.json'), '{"mine":true}');
  const text = '{"volt":1}';
  let w = await Wk.writeSidecar(own, 'Clip.mp4', { name: 'Clip.mp4.json', text, sha256: sha(text) });
  ok(w === 'kept' && readFileSync(join(own, 'Clip.mp4.json'), 'utf8') === '{"mine":true}', 'a customer\'s own file of that name is kept, never replaced', w);
  w = await Wk.writeSidecar(own, 'New.mp4', { name: 'New.mp4.json', text, sha256: sha(text) });
  const w2 = await Wk.writeSidecar(own, 'New.mp4', { name: 'New.mp4.json', text, sha256: sha(text) });
  ok(w === 'written' && w2 === 'same' && readFileSync(join(own, 'New.mp4.json'), 'utf8') === text, 'written once; the same text again is left alone', [w, w2]);
  const refused = async (args: [string, { name: string; text: string; sha256: string }]) => { try { await Wk.writeSidecar(own, ...args); return false; } catch { return true; } };
  ok(await refused(['New.mp4', { name: '../escape.json', text, sha256: sha(text) }]) && !existsSync(join(root, 'escape.json')), 'a name that is not <original>.json or .xml is refused');
  ok(await refused(['Sub/A.mp4', { name: 'A.mp4.json', text, sha256: sha(text) }]), 'so is the right extension on another name');
  ok(await refused(['Other.mp4', { name: 'Other.mp4.json', text, sha256: 'b'.repeat(64) }]) && !existsSync(join(own, 'Other.mp4.json')), 'text that does not match its checksum is refused and nothing written');

  srv.close();
  await pool.end();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
