// ============================================================================
//  CLIP OUTPUT FOLDERS UNDER ENFORCE (build queue P2-2d; services/edgeTokens.ts
//  PLAIN_VOD_RE, plainAssetId and tokenPathMiddleware, deploy/edge/
//  vod-plain-refuse.js, deploy/staging/edge-token.js and nginx.conf.template,
//  deploy/terraform/edge_tokens.tf, modules/recordings.ts exportLinks).
//
//  A clip cut from a recording keeps its files in /clips/<asset id>/, not
//  under /clips/vod/. Under VOLT_EDGE_TOKENS=enforce those are refused by
//  plain address at the API, the staging edge and CloudFront, like an
//  encode's; with a token (the play gate, the console's preview, a recording
//  export's download links) they play; a token-free clip plays plain; folders
//  under /clips/ that are not titles (ad creatives) are untouched.
//    DATABASE_URL=... npx tsx test/edge-clip-outputs.check.ts
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CLIPS = mkdtempSync(join(tmpdir(), 'volt-clipout-'));
process.env.CLIPS_DIR = CLIPS;
process.env.TRUST_EDGE_GEO = 'true';
delete process.env.EDGE_SHARED_SECRET;
process.env.VOLT_EDGE_TOKENS = 'enforce';

let pass = 0, fail = 0;
const check = (m: string, got: unknown, want: unknown) => {
  const g = typeof got === 'object' ? JSON.stringify(got) : got, w = typeof want === 'object' ? JSON.stringify(want) : want;
  if (g === w) { console.log('PASS ' + m); pass++ } else { console.log(`FAIL ${m} -- expected [${String(w)}] got [${String(g)}]`); fail++ }
};

(async () => {
  const T = await import('../src/services/edgeTokens');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { invalidateTag } = await import('../src/scale/cache');
  const P = await import('../src/services/publicStatus');

  // ---------------------------------------------------------------- the reference
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const nowS = Math.floor(Date.now() / 1000);
  check('plainAssetId reads a clip folder', [T.plainAssetId(`/clips/${id}/hls/master.m3u8`), T.plainAssetId(`/clips/${id.toUpperCase()}/clip.mp4`), T.plainAssetId('/clips/ads/x/a.m3u8')], [id, id, null]);
  const cases: [string, string, string | null, number][] = [
    [`/clips/${id}/hls/master.m3u8`, 'enforce', null, nowS],          // a clip, plain: refused
    [`/clips/${id}/clip.mp4`, 'enforce', null, nowS],
    [`/clips/${id}/hls/720p/seg_1.ts`, 'enforce', '0', nowS],           // token-free: through
    [`/clips/${id}/clip.mp4`, 'enforce', String(nowS - 5), nowS],      // its window ended
    [`/clips/${id}/../${id}/clip.mp4`, 'enforce', '0', nowS],           // climbing
    [`/clips/${id}/hls/master.m3u8`, 'issue', null, nowS],             // issue: plain plays
    [`/clips/ads/${id}/master.m3u8`, 'enforce', null, nowS],           // an ad creative: not a title
    [`/clips/vod-src/${id}.mp4`, 'enforce', null, nowS],               // private, 404 by the API
    [`/clips/vod/${id}/master.m3u8`, 'enforce', null, nowS],           // an encode, as before
    [`/vod/${id}/master.m3u8`, 'enforce', '0', nowS],
    [`/clips/not-a-uuid/x.m3u8`, 'enforce', null, nowS],
  ];
  const ref = cases.map(([uri, mode, open, n]) => T.plainPathVerdict(uri, mode, open, n));
  check('the reference on clip folders', ref, ['403', '403', 'ok', '403', '403', 'ok', 'ok', 'ok', '403', 'ok', 'ok']);

  const njsSrc = readFileSync(join(__dirname, '../../deploy/staging/edge-token.js'), 'utf8');
  const njs = new Function(`${njsSrc.replace("import fs from 'fs';", 'const fs = null;').replace("import crypto from 'crypto';", 'const crypto = null;').replace(/export default .*/, 'return { plainVerdict };')}`)();
  check('the staging edge agrees with the reference', cases.map(([uri, mode, open, n]) => njs.plainVerdict(uri, mode, open == null ? {} : { [`f:${id}`]: open }, n)), ref);

  const cfSrc = readFileSync(join(__dirname, '../../deploy/edge/vod-plain-refuse.js'), 'utf8');
  let kvsData: Record<string, string> = {};
  (globalThis as any).__cft = { kvs: (k: string) => ({ async get(key: string) { if (k !== 'kvs-test') throw new Error('wrong store'); if (!(key in kvsData)) throw new Error('key not found'); return kvsData[key]; } }) };
  const cfh = new Function(`${cfSrc.replace("import cf from 'cloudfront';", 'const cf = globalThis.__cft;').replace('${kvs_id}', 'kvs-test')}\nreturn handler;`)();
  // The function sits on /vod/*, /clips/vod/* and /clips/* under enforce: every enforce case reaches it.
  const enforced = cases.filter(([uri, mode]) => mode === 'enforce' && /^\/(vod|clips)\//.test(uri));
  const cfOut: string[] = [];
  for (const [uri, , open] of enforced) {
    kvsData = open == null ? {} : { [`f:${id}`]: open };
    const out = await cfh({ request: { uri, headers: {} } });
    cfOut.push(out.statusCode === 403 ? '403' : out.uri === uri ? 'ok' : 'changed');
  }
  check('CloudFront agrees with the reference on every path its behaviours send it', cfOut, enforced.map(([uri, mode, open]) => T.plainPathVerdict(uri, mode, open, nowS)));
  check('the CloudFront function still fits in 10 KB', Buffer.byteLength(cfSrc) < 10240, true);

  const tf = readFileSync(join(__dirname, '../../deploy/terraform/edge_tokens.tf'), 'utf8');
  check('Terraform: enforce adds /clips/* after /clips/vod/*', /edge_plain_vod_paths\s*=\s*local\.edge_tokens_mode == "enforce" \? \["\/vod\/\*", "\/clips\/vod\/\*", "\/clips\/\*"\]/.test(tf), true);
  const nginx = readFileSync(join(__dirname, '../../deploy/staging/nginx.conf.template'), 'utf8');
  const loc = /location ~ "?(\^\/clips\/[^"\s]+)"? \{\s*\n\s*limit_req zone=viewer_rl burst=200 nodelay;\s*\n\s*default_type text\/plain;\s*\n\s*if \(\$edge_plain != "ok"\)/.exec(nginx);
  const locRe = loc ? new RegExp(loc[1]) : null;
  check('the staging nginx sends clip folders and /clips/vod/ to the plain check, not ad creatives',
    locRe ? [locRe.test(`/clips/${id}/clip.mp4`), locRe.test(`/clips/vod/${id}/master.m3u8`), locRe.test(`/clips/ads/${id}/a.m3u8`), locRe.test('/clips/vod-src/x.mp4')] : null, [true, true, false, false]);

  // ---------------------------------------------------------------- the API
  const tag = Date.now().toString(36);
  const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`co-${tag}`]))!.id;
  const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `co-${tag}@volt.test`]))!.id;
  const tok = signAccess({ sub: u, account_id: a, role: 'owner' });
  const G = randomUUID(), CH = randomUUID(), REC = randomUUID();
  await query(`INSERT INTO groups(id,account_id,name,max_channels) VALUES ($1,$2,'g',10)`, [G, a]);
  await query(`INSERT INTO channels(id,group_id,name,status) VALUES ($1,$2,'clip-ch','scheduled')`, [CH, G]);
  await query(`INSERT INTO recordings(id,kind,channel_id,title,status,start_epoch_ms,end_epoch_ms,duration_ms,day_utc) VALUES ($1,'channel_day',$2,'Noon','complete',0,60000,60000,'2026-11-02')`, [REC, CH]);

  const mkClip = async (title: string, opts: { stamp?: string | null; kind?: string; rec?: string | null } = {}) => {
    const cid = (await one<any>(
      `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, formats)
       VALUES ($1,'upload',$3,$2,0,60000,60000,'{"hls":true,"progressive":true}'::jsonb) RETURNING id`, [a, title, opts.kind ?? 'clip']))!.id;
    await query(`UPDATE vod_assets SET master_key = $2, progressive_key = $3, export_mp4_key = $3, recording_id = $5, availability_state = 'available', published = true, media_state = 'ready',
                   availability = COALESCE($4::jsonb, '{"targets":[{"kind":"portal"}],"access":"free"}'::jsonb), available_from = now() - interval '1 day' WHERE id = $1`,
      [cid, `/clips/${cid}/hls/master.m3u8`, `/clips/${cid}/clip.mp4`, opts.stamp ?? null, opts.rec ?? null]);
    mkdirSync(join(CLIPS, cid, 'hls', '720p'), { recursive: true });
    writeFileSync(join(CLIPS, cid, 'hls', 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n720p/index.m3u8\n');
    writeFileSync(join(CLIPS, cid, 'hls', '720p', 'index.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg_1.ts\n#EXT-X-ENDLIST\n');
    writeFileSync(join(CLIPS, cid, 'hls', '720p', 'seg_1.ts'), 'SEGMENT');
    writeFileSync(join(CLIPS, cid, 'clip.mp4'), 'MP4FILE');
    await P.refreshPublicStatus(cid); invalidateTag(`asset:${cid}`);
    return cid;
  };
  const clip = await mkClip('Goal of the week');
  const other = await mkClip('Another clip');
  const free = await mkClip('Free clip', { stamp: JSON.stringify({ targets: [{ kind: 'portal' }], access: 'free', geo: { mode: 'worldwide', countries: [] }, protection: { tokenFree: true } }) });
  const exp = await mkClip('Noon export', { kind: 'export', rec: REC });
  mkdirSync(join(CLIPS, 'ads', 'cr1'), { recursive: true });
  writeFileSync(join(CLIPS, 'ads', 'cr1', 'master.m3u8'), '#EXTM3U\n');

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const http = async (method: string, path: string, body?: any, auth?: string, h: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...h }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch { j = t; }
    return { s: r.status, j, t };
  };
  const get = (p: string, h: Record<string, string> = {}) => http('GET', p, undefined, undefined, h);
  try {
    // ---- plain addresses under enforce
    const plain = [`/clips/${clip}/hls/master.m3u8`, `/clips/${clip}/hls/720p/index.m3u8`, `/clips/${clip}/hls/720p/seg_1.ts`, `/clips/${clip}/clip.mp4`];
    const pr = await Promise.all(plain.map((p) => get(p)));
    check('enforce: a clip\'s manifest, playlist, segment and MP4 refused by plain address', pr.map((r) => r.s), [403, 403, 403, 403]);
    check('...with the edge\'s words, never cached', [pr[0].t.trim(), (await fetch(base + plain[0])).headers.get('cache-control')], ['Not available', 'no-store']);
    check('...an upper-case id and an encoded slash are refused too', [(await get(`/clips/${clip.toUpperCase()}/clip.mp4`)).s, (await get(`/clips/${clip}%2Fclip.mp4`)).s === 200], [403, false]);
    check('an ad creative under /clips/ads/ is not a title: served', (await get('/clips/ads/cr1/master.m3u8')).s, 200);
    check('the private upload folder stays 404', (await get(`/clips/vod-src/${clip}.mp4`)).s, 404);

    // ---- the play gate hands out a tokenised clip
    const pk = (await http('POST', '/api/apps', { name: 'Web', type: 'web' }, tok)).j.publishableKey.key;
    const gate = (aid: string, geo = 'AU') => http('POST', '/api/availability', { appKey: pk, assetId: aid, geo, sid: 'sid-clipout1' });
    const g = await gate(clip);
    const gh = g.j.delivery?.hls ?? '';
    check('the gate hands a clip out with a token in front of its folder', [g.s, new RegExp(`^/t/[^/]+/clips/${clip}/`).test(gh)], [200, true]);
    const tdir = gh.replace(/master\.m3u8$/, '');
    check('...its manifest, playlist and segment play through the token', [(await get(gh, { 'cloudfront-viewer-country': 'AU' })).s, (await get(tdir + '720p/index.m3u8', { 'cloudfront-viewer-country': 'AU' })).s, (await get(tdir + '720p/seg_1.ts', { 'cloudfront-viewer-country': 'AU' })).t], [200, 200, 'SEGMENT']);
    check('...from another country it is refused', (await get(gh, { 'cloudfront-viewer-country': 'JP' })).s, 403);
    check('...and the token does not open another clip\'s folder', (await get(gh.replace(clip, other))).s, 403);

    // ---- the console's preview
    const d = await http('GET', `/api/vod/${clip}`, undefined, tok);
    const pv = d.j.preview ?? {};
    check('the console\'s preview of a clip is tokenised (HLS and the MP4)', [d.s, /^\/t\/[^/]+\/clips\//.test(pv.hls ?? ''), /^\/t\/[^/]+\/clips\/.+\/clip\.mp4$/.test(pv.progressive ?? '')], [200, true, true]);
    check('...and plays', [(await get(pv.hls)).s, (await get(pv.progressive)).t], [200, 'MP4FILE']);

    // ---- a recording export's download links
    const dl = await http('GET', `/api/recordings/${REC}/download`, undefined, tok);
    check('a recording export\'s download link carries a token, with when it ends', [dl.s, dl.j.status, dl.j.assetId, new RegExp(`^/t/[^/]+/clips/${exp}/clip\\.mp4$`).test(dl.j.url ?? ''), typeof dl.j.expiresAt], [200, 'ready', exp, true, 'string']);
    check('...and downloads', (await get(dl.j.url)).t, 'MP4FILE');

    // ---- token-free
    const gf = await gate(free);
    check('a token-free clip is handed out plain and plays plain under enforce', [gf.j.delivery?.hls, (await get(`/clips/${free}/hls/master.m3u8`)).s, (await get(`/clips/${free}/clip.mp4`)).t], [`/clips/${free}/hls/master.m3u8`, 200, 'MP4FILE']);
    const store = await T.fileEdgeStore(join(CLIPS, 'edge', 'store.json'));
    await T.syncEdgeOpen(store);
    check('...and the edge set names it, so both edges let its folder through', [await store.get(T.openKey(free)) != null, njs.plainVerdict(`/clips/${free}/clip.mp4`, 'enforce', JSON.parse(readFileSync(join(CLIPS, 'edge', 'store.json'), 'utf8')), nowS)], [true, 'ok']);

    // ---- withdrawn: the old token stops
    await query(`UPDATE vod_assets SET availability_state = 'withdrawn' WHERE id = $1`, [clip]);
    await P.refreshPublicStatus(clip);
    await T.revokeAsset(clip, 'test: withdrawn', Math.floor(Date.now() / 1000) + 1);
    invalidateTag(`asset:${clip}`);
    await new Promise((r) => setTimeout(r, 5200));   // the revocation read is cached 5 s
    check('withdrawn: the clip\'s old token is refused, the gate answers 404', [(await get(gh, { 'cloudfront-viewer-country': 'AU' })).s, (await gate(clip)).s], [403, 404]);

    // ---- issue and off
    process.env.VOLT_EDGE_TOKENS = 'issue';
    check('issue: plain clip addresses play as before', [(await get(`/clips/${other}/hls/master.m3u8`)).s, (await get(`/clips/${other}/clip.mp4`)).t], [200, 'MP4FILE']);
    process.env.VOLT_EDGE_TOKENS = 'off';
    const dlOff = await http('GET', `/api/recordings/${REC}/download`, undefined, tok);
    check('off: the export link is the plain address, as before', [dlOff.j.url, 'expiresAt' in dlOff.j], [`/clips/${exp}/clip.mp4`, false]);
    process.env.VOLT_EDGE_TOKENS = 'enforce';
  } catch (e: any) {
    console.log('FAIL unexpected error -- ' + (e?.stack ?? e)); fail++;
  } finally {
    srv.close();
    await pool.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
