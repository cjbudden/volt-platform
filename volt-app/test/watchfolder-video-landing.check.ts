// ============================================================================
//  A VIDEO DROPPED IN A WATCH FOLDER LANDS WHERE IT BELONGS (build queue 1.13).
//
//  The real HTTP app and a real Postgres, nothing mocked but the encoder (no
//  worker runs here, so a queued encode stays queued). An operator creates a
//  folder with two rules, drops a programme and a loop, and presses Scan:
//
//    THE PROGRAMME is in the Media Library (GET /api/vod), from a watch folder,
//    with the ingest rules' facts on it (original name, checksum, outcome) and
//    one encode job queued against a copy that is not in the drop folder.
//
//    THE LOOP is in Loops & Fillers (GET /api/filler-assets), ready, with a
//    source key laid out as an upload's and the file where that key says.
//    Before 23 Oct it had source_key '' and no channel could use it.
//
//    NOTHING COMES BACK. Both items close as 'ingested'. Before 23 Oct they
//    stayed 'seen', and 'seen' with a claim older than ten minutes is what the
//    pending query picks up, so every pass ten minutes on made another asset
//    and another encode of the same file. Asserted by ageing the claims past
//    ten minutes and scanning again.
//
//    Another account sees none of it.
//
//  Usage: DATABASE_URL=... npx tsx test/watchfolder-video-landing.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
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

/** A real, short H.264 file when ffmpeg is here, so the ingest probe reads a
 *  real video; plain bytes otherwise (the probe failing is not an error). */
function video(path: string, seconds: number, colour: string): boolean {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:d=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-land-'));
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { fillerPath } = await import('../src/services/uploads');

  const drop = join(root, 'drop');
  await mkdir(drop, { recursive: true });

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfl-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfl-o-${tag}`]))!.id;
  const mkUser = async (a: string, email: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, email]))!.id;
  const owner = await mkUser(acct, `wfl-${tag}@volt.test`);
  const otherOwner = await mkUser(other, `wfl-o-${tag}@volt.test`);

  const app: any = createServer();
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' });
  const otherTok = signAccess({ sub: otherOwner, account_id: other, role: 'owner' });
  const call = async (method: string, path: string, body?: any, t = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  const scan = (id: string) => call('POST', `/api/watchfolders/${id}/scan`);

  try {
    // ---- an operator sets up the folder ---------------------------------------
    console.log('== a folder with a VOD rule and a loop rule ==');
    const f = await call('POST', '/api/watchfolders', { name: 'Drop', kind: 'local', config: { path: drop, min_age_ms: 1000 } });
    check('folder created', f.s, 201);
    const F = f.j?.id;
    check('loop rule', (await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Loops', matchType: 'glob', pattern: 'loop_*', targetKind: 'loop' })).s, 201);
    check('programme rule', (await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Programmes', matchType: 'extension', pattern: 'mp4', targetKind: 'vod' })).s, 201);

    // ---- the drop -------------------------------------------------------------
    const prog = join(drop, 'Morning Show 0412.mp4');
    const loop = join(drop, 'loop_ident.mp4');
    const real = video(prog, 2, 'blue') && video(loop, 1, 'red');
    if (!real) { await writeFile(prog, 'p'.repeat(8192)); await writeFile(loop, 'l'.repeat(4096)); }
    console.log(real ? '(real H.264 files from ffmpeg)' : '(no ffmpeg here: plain bytes, the probe records nothing)');
    const old = new Date(Date.now() - 60_000);
    await utimes(prog, old, old); await utimes(loop, old, old);
    const progBytes = statSync(prog).size, loopBytes = statSync(loop).size;

    console.log('\n== Scan: accepted and landed in one action ==');
    const s1 = await scan(F);
    check('scan answers', s1.s, 200);
    check('two files accepted', s1.j?.accepted?.length, 2);
    check('one queued for encoding', s1.j?.ingest?.queued, 1);
    check('one added to Loops & Fillers', s1.j?.ingest?.loops, 1);
    check('nothing failed', s1.j?.ingest?.failed, 0);

    // ---- the programme --------------------------------------------------------
    console.log('\n== the programme is in the Media Library ==');
    const lib = await call('GET', '/api/vod?limit=50');
    const rows = Array.isArray(lib.j) ? lib.j : (lib.j?.items ?? lib.j?.member ?? []);
    // Titled from the file's own name, read as an upload of the same file is
    // (services/ingest/filenameParse.ts): the extension goes, the words stay.
    const mine = rows.filter((r: any) => r.title === 'Morning Show 0412');
    check('listed once by title', mine.length, 1);
    const vid = mine[0]?.id;
    const v = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [vid ?? '00000000-0000-0000-0000-000000000000']);
    check('owned by the account', v?.account_id, acct);
    check('from a watch folder', v?.source_kind, 'watchfolder');
    check('with its size', Number(v?.source_bytes), progBytes);
    // The ingest framework ran (it did not before 23 Oct): these are its columns.
    check('the ingest rules ran: original name', v?.original_filename, 'Morning Show 0412.mp4');
    check('...its path in the folder', v?.original_path, 'Morning Show 0412.mp4');
    check('...the checksum', typeof v?.sha256 === 'string' && v.sha256.length === 64, true);
    check('...and the outcome', v?.ingest?.status, 'ingested');
    if (real) check('...with the probe\'s facts', v?.ingest?.probe?.video?.height, 180);
    check('the source is kept outside the drop folder', !!v?.source_key && !String(v.source_key).startsWith(drop), true);
    check('and is really there', !!v?.source_key && existsSync(v.source_key), true);
    const jobs = await query<any>(`SELECT * FROM jobs WHERE type = 'vod.encode' AND payload->>'vodAssetId' = $1`, [vid ?? '']);
    check('one encode job', jobs.length, 1);
    check('reading the kept source', jobs[0]?.payload?.sourcePath, v?.source_key);
    check('linked from the asset', v?.encode_job_id, jobs[0]?.id);

    // ---- the loop -------------------------------------------------------------
    console.log('\n== the loop is in Loops & Fillers, usable ==');
    const fl = await call('GET', '/api/filler-assets?limit=50');
    const frows = Array.isArray(fl.j) ? fl.j : (fl.j?.items ?? fl.j?.member ?? []);
    const lp = frows.filter((r: any) => r.name === 'loop_ident');
    check('listed once by name', lp.length, 1);
    check('a loop', lp[0]?.kind, 'loop');
    check('ready', lp[0]?.status, 'ready');
    check('with its size', Number(lp[0]?.bytes), loopBytes);
    check('a source key laid out as an upload\'s', lp[0]?.source_key, `filler/${acct}/${lp[0]?.id}.mp4`);
    check('the file is where that key says', existsSync(fillerPath(acct, String(lp[0]?.id), 'loop_ident.mp4')), true);
    check('original filename and type', [lp[0]?.filename, lp[0]?.content_type], ['loop_ident.mp4', 'video/mp4']);
    check('no encode for a loop', (await query<any>(`SELECT 1 FROM jobs WHERE type = 'vod.encode' AND payload->>'accountId' = $1`, [acct])).length, 1);
    check('its own page answers', (await call('GET', `/api/filler-assets/${lp[0]?.id}`)).s, 200);

    // ---- the review queue -----------------------------------------------------
    console.log('\n== the queue says where each went, and both are closed ==');
    const it = await call('GET', `/api/watchfolders/${F}/items?limit=50`);
    const items = Array.isArray(it.j) ? it.j : (it.j?.items ?? it.j?.member ?? []);
    const byKey = new Map<string, any>(items.map((x: any) => [x.object_key, x]));
    check('programme: ingested', byKey.get('Morning Show 0412.mp4')?.status, 'ingested');
    check('...in the Media Library, encoding', /in the Media Library .*queued for encoding/.test(byKey.get('Morning Show 0412.mp4')?.reason ?? ''), true);
    check('loop: ingested', byKey.get('loop_ident.mp4')?.status, 'ingested');
    check('...in Loops & Fillers', /in Loops & Fillers/.test(byKey.get('loop_ident.mp4')?.reason ?? ''), true);

    // ---- ten minutes later ----------------------------------------------------
    console.log('\n== ten minutes later, nothing is made twice ==');
    await query(`UPDATE watchfolder_items SET resolved_at = now() - interval '11 minutes' WHERE watchfolder_id = $1`, [F]);
    const s2 = await scan(F);
    check('the scan answers', s2.s, 200);
    check('nothing queued', s2.j?.ingest?.queued ?? 0, 0);
    check('no new loop', s2.j?.ingest?.loops ?? 0, 0);
    check('still one programme', Number((await one<any>(`SELECT count(*) FROM vod_assets WHERE account_id = $1`, [acct]))?.count), 1);
    check('still one loop', Number((await one<any>(`SELECT count(*) FROM filler_assets WHERE account_id = $1`, [acct]))?.count), 1);
    check('still one encode', (await query<any>(`SELECT 1 FROM jobs WHERE type = 'vod.encode' AND payload->>'accountId' = $1`, [acct])).length, 1);

    // ---- tenancy ---------------------------------------------------------------
    console.log('\n== another account sees none of it ==');
    const ol = await call('GET', '/api/vod?limit=50', undefined, otherTok);
    const orows = Array.isArray(ol.j) ? ol.j : (ol.j?.items ?? ol.j?.member ?? []);
    check('not in their Media Library', orows.some((r: any) => r.id === vid), false);
    const of = await call('GET', '/api/filler-assets?limit=50', undefined, otherTok);
    const ofrows = Array.isArray(of.j) ? of.j : (of.j?.items ?? of.j?.member ?? []);
    check('not in their Loops & Fillers', ofrows.length, 0);
    check('the loop\'s page is a 404 for them', (await call('GET', `/api/filler-assets/${lp[0]?.id}`, undefined, otherTok)).s, 404);
    check('the folder is a 404 for them', (await call('POST', `/api/watchfolders/${F}/scan`, undefined, otherTok)).s, 404);
  } finally {
    srv.close();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
  console.log(`\nwatchfolder-video-landing: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
