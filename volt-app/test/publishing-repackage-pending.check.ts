// ============================================================================
//  REPACKAGE PENDING AND THE DECODE CHECK (build queue P4-5).
//
//    (b) The Media Library's **Repackage pending** filter: GET /api/vod with
//        repackage_pending=true keeps the titles whose files do not carry
//        what their publishing policy asks for now (services/repackage.ts
//        repackagePendingIds), the same answer as the Encode tab's per-title
//        test, combined with the other filters; a bad value is a 400; the
//        facets route takes it too.
//    (c) What decodes an encrypted title's packaged files reads the original
//        instead: QC measures the original and says so, and skips (never
//        fails) the decode checks when no original is on hand; a frame still
//        is drawn from the original at that frame's time, or refused with the
//        reason; the skip-marker reader never picks the encrypted master.
//        The frame index and I-frame playlists stay on the packaged files:
//        they read box headers, which cbcs leaves in the clear.
//
//  Usage: DATABASE_URL=... npx tsx test/publishing-repackage-pending.check.ts
// ============================================================================
import { mkdtemp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m: string) => { console.log('PASS ' + m); pass++; };
const bad = (m: string, d: string) => { console.log(`FAIL ${m} -- ${d}`); fail++; };
const check = (m: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(m) : bad(m, `expected ${w} got ${g}`);
};

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'vod-repack-pending-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  process.env.ORIGIN_DIR = process.env.ORIGIN_DIR ?? join(root, '_origin');
  delete process.env.VOD_STORE;
  await mkdir(process.env.CLIPS_DIR!, { recursive: true });

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const R = await import('../src/services/repackage');
  const { resolveForAsset } = await import('../src/services/publishingRules');
  const { packagedOf, pendingFields } = await import('../src/services/encodePolicy');

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rp-${tag}`]))!.id as string;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`rp-other-${tag}`]))!.id as string;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `rp-${tag}@volt.test`]))!.id;
  const schema = async (a: string, name: string) => (await one<any>(`INSERT INTO metadata_schemas(account_id,name,target_kind,fields) VALUES ($1,$2,'vod','[]'::jsonb) RETURNING id`, [a, name]))!.id as string;
  const film = await schema(acct, 'Film'), series = await schema(acct, 'Series'), otherFilm = await schema(other, 'Film');

  const work = join(root, 'work'); await mkdir(work, { recursive: true });
  const mp4 = join(work, 'Original.mp4');
  // Ten seconds whose picture changes each second, so a still at 2 s and one at 7 s differ.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=10', '-f', 'lavfi', '-i', 'sine=f=440:d=10:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', mp4], { stdio: 'ignore' });

  const title = async (a: string, name: string, schemaId: string | null, o: { drm?: boolean; master?: boolean; archived?: boolean; override?: any; source?: string | null } = {}) => (await one<any>(
    `INSERT INTO vod_assets(account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, schema_id, master_key, encode_result, policy_snapshot,
                            archived_at, availability_override, source_key, availability_state, published)
     VALUES ($1,'upload','export',$2,0,10000,10000,'{}'::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,'available',true) RETURNING id`,
    [a, name, schemaId, o.master === false ? null : `/clips/vod/${name.replace(/\W/g, '')}/master.m3u8`,
     JSON.stringify({ drm: o.drm ? 'cbcs' : 'clear' }), JSON.stringify({ packaged: { drm: !!o.drm } }),
     o.archived ? new Date() : null, JSON.stringify(o.override ?? {}), o.source === undefined ? mp4 : o.source]))!.id as string;

  const srv = createServer().listen(0);
  await new Promise((res) => srv.once('listening', res));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const x = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: x.status, j: await x.json().catch(() => null) as any };
  };
  const ids = (j: any) => ((j?.items ?? j?.data ?? j) as any[]).map((r) => r.id).sort();
  const sorted = (a: string[]) => [...a].sort();

  try {
    console.log('== (b) which titles are pending ==');
    const rule = await call('PUT', `/api/publishing-rules/schema/${film}`, { settings: { protection: { drm: true }, distribution: { mp4Download: false } }, lockedFields: [], presetKey: null, name: 'Protected films', confirm: true });
    check('a Film rule asks for DRM', rule.s, 200);
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage' AND state = 'queued'`);
    const A = await title(acct, 'Film clear', film);                                      // pending: DRM asked, clear files
    const B = await title(acct, 'Film encrypted', film, { drm: true });                   // matches
    const C = await title(acct, 'Series encrypted', series, { drm: true });               // pending: DRM not asked, encrypted files
    const D = await title(acct, 'Series clear', series);                                  // matches
    const E = await title(acct, 'Film archived', film, { archived: true });               // archived: not listed
    const F = await title(acct, 'Film not packaged', film, { master: false });            // no files yet: not pending
    const G = await title(acct, 'Film own off', film, { override: { protection: { drm: false } } }); // its own setting: clear is right
    const H = await title(acct, 'No type clear', null);                                   // no rule: matches
    const X = await title(other, 'Other account film clear', otherFilm);
    await call('PUT', `/api/publishing-rules/schema/${otherFilm}`, { settings: { protection: { drm: true } }, lockedFields: [], presetKey: null, name: 'x', confirm: true }).catch(() => null);
    R.forgetRepackagePending();
    const pend = await R.repackagePendingIds(acct);
    check('pending: the clear Film title and the encrypted Series title, nothing else', sorted(pend), sorted([A, C]));
    // The batch pass gives the same answer as the per-title test the Encode tab uses.
    const slow: string[] = [];
    for (const id of [A, B, C, D, F, G, H]) {
      const t = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
      if (!t.master_key) continue;
      const r = await resolveForAsset(acct, t);
      if (pendingFields({ drm: !!r.settings.protection?.drm }, { drm: packagedOf(t).drm }).length) slow.push(id);
    }
    check('...the same answer as resolving each title on its own (the Encode tab)', sorted(pend), sorted(slow));
    check('another account\'s titles never appear', pend.includes(X), false);

    console.log('\n== (b) the list filter ==');
    const l1 = await call('GET', `/api/vod?repackage_pending=true&limit=100`);
    check('GET /api/vod?repackage_pending=true: the two pending titles', [l1.s, ids(l1.j)], [200, sorted([A, C])]);
    const l2 = await call('GET', `/api/vod?repackage_pending=true&schema_id=${film}&limit=100`);
    check('...with a content type filter: the Film one only', [l2.s, ids(l2.j)], [200, [A]]);
    const l3 = await call('GET', `/api/vod?repackage_pending=false&schema_id=${series}&limit=100`);
    check('...false (or absent) filters nothing', [l3.s, ids(l3.j)], [200, sorted([C, D])]);
    const l4 = await call('GET', `/api/vod?repackage_pending=maybe`);
    check('...a bad value is a 400 with the reason', [l4.s, /repackage_pending/.test(JSON.stringify(l4.j))], [400, true]);
    const f1 = await call('GET', `/api/vod/facets?repackage_pending=true`);
    check('the facets route takes the filter: its total is the pending count', [f1.s, f1.j?.total], [200, 2]);

    console.log('\n== (b) it follows the policy ==');
    await call('PUT', `/api/publishing-rules/schema/${series}`, { settings: { protection: { drm: true } }, lockedFields: [], presetKey: null, name: 'Protected series', confirm: true });
    await query(`UPDATE jobs SET state = 'cancelled' WHERE type = 'vod.repackage' AND state = 'queued'`);
    R.forgetRepackagePending(acct);
    check('DRM on for Series too: the encrypted Series title matches now, the clear one waits', sorted(await R.repackagePendingIds(acct)), sorted([A, D]));
    await query(`UPDATE vod_assets SET encode_result = '{"drm":"cbcs"}'::jsonb, policy_snapshot = '{"packaged":{"drm":true}}'::jsonb WHERE id = $1`, [A]);
    R.forgetRepackagePending(acct);
    check('once a title is repackaged it leaves the list', sorted(await R.repackagePendingIds(acct)), [D]);

    console.log('\n== (c) QC of an encrypted title ==');
    const { runQc } = await import('../src/services/qc');
    const q1 = await runQc(B);
    const pk = q1.skipped.find((s) => s.check === 'package');
    check('measured on the original, and said so', [!!pk, /encrypted \(DRM\), so the original was measured/.test(pk?.reason ?? '')], [true, true]);
    check('...it decodes: no playback finding, and the length is the original\'s (10 s)', [q1.findings.filter((f) => f.check === 'playback').length, q1.findings.filter((f) => f.check === 'duration').length], [0, 0]);
    const N = await title(acct, 'Encrypted no original', film, { drm: true, source: null });
    const q2 = await runQc(N);
    check('no original on hand: the decode checks are skipped with the reason, not failed',
      [q2.state !== 'failed', q2.skipped.filter((s) => /encrypted \(DRM\) and its original is not on this server/.test(s.reason)).map((s) => s.check)],
      [true, ['playback', 'duration', 'silence', 'black', 'loudness']]);
    const vq = await one<any>(`SELECT media_state FROM vod_assets WHERE id = $1`, [N]);
    check('...and the title is not marked unplayable', vq.media_state === 'unplayable', false);
    const q3 = await runQc(D);
    check('a clear title is still measured on its packaged files (none here: no media, as before)', [q3.findings.some((f) => f.check === 'media'), q3.skipped.some((s) => s.check === 'package')], [true, false]);

    console.log('\n== (c) a frame still of an encrypted title ==');
    const { assetFrameStill } = await import('../src/services/frames/store');
    const { FrameError } = await import('../src/services/frames/exactFrame');
    const stored: any = { state: 'ready', version: 'v1', error: null,
      index: { rate: { num: 25, den: 1 }, totalFrames: 250, playlist: '720p/stream.m3u8', init: '720p/init.mp4', timescale: 12800,
               segments: [{ uri: 'seg_1.m4s', startFrame: 0, frames: 250 }] } };
    const s1 = await assetFrameStill(acct, B, stored, 50);
    const s2 = await assetFrameStill(acct, B, stored, 175);
    const { imageStore } = await import('../src/services/imageStore');
    const j1 = await imageStore().get(s1.key), j2 = await imageStore().get(s2.key);
    check('frames 50 and 175 are drawn from the original (JPEGs, and different pictures)',
      [s1.cache, j1?.subarray(0, 2).toString('hex'), j2?.subarray(0, 2).toString('hex'), !!j1 && !!j2 && !j1.equals(j2)], ['made', 'ffd8', 'ffd8', true]);
    let err: any = null;
    try { await assetFrameStill(acct, N, stored, 10); } catch (e) { err = e; }
    check('no original: refused with the reason, not a decode error', [err instanceof FrameError, err?.status ?? err?.code, /encrypted \(DRM\) and its original is not on this server/.test(String(err?.message))], [true, 409, true]);
    let err2: any = null;
    try { await assetFrameStill(acct, D, stored, 10); } catch (e) { err2 = e; }
    check('a clear title still reads its packaged segment (none stored here: 410, as before)', [err2 instanceof FrameError, err2?.status ?? err2?.code], [true, 410]);

    console.log('\n== (c) the skip-marker reader ==');
    const { mediaPathFor } = await import('../src/services/vodMarkers');
    const rowOf = (id: string) => one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [id]);
    check('an encrypted title: its original, never the encrypted master', mediaPathFor(await rowOf(B)), mp4);
    check('...no original: nothing, rather than a wrong answer', mediaPathFor(await rowOf(N)), null);
  } finally {
    srv.close();
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
