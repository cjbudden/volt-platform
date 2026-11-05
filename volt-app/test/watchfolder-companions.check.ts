// ============================================================================
//  WATCHFOLDER COMPANIONS BY NAME (build queue H2b-2).
//
//  Through the real API on a real database, with real folders scanned:
//    - a new folder starts with caption and metadata rules as well, sending
//      them to `companion`; a site folder gets them too (H2b-5);
//    - a rule may send captions and sidecars only to `companion`, and nothing
//      else may go there;
//    - `Scrubs-s1-e1.mp4` then `Scrubs-s1-e1_en.vtt` gives one asset with its
//      file name metadata and an English subtitle track in its HLS and DASH;
//    - the caption first, then the video: it waits ("waiting for its video")
//      and attaches when the video lands;
//    - the longest prefix wins (`Show-e1` against `Show-e10`), and a prefix
//      that does not end at a word break never matches;
//    - sdh and forced flags and the language from the name;
//    - a caption with no video goes to review after 24 hours (time moved),
//      and the file to the review folder;
//    - a 26 MB caption is refused at once with the limit;
//    - a JSON sidecar is attached, its fields only proposed, not applied;
//    - a caption that does not read is attached switched off, with why;
//    - another folder's videos are not matched.
//  Plus the pure parts: prefixFits and bestMatch.
//
//  Usage: DATABASE_URL=... npx tsx test/watchfolder-companions.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const truthy = (m: string, v: unknown, d = '') => (v ? ok(m) : bad(m, d || JSON.stringify(v)));

const VTT = (text: string) => `WEBVTT\n\n00:00:00.000 --> 00:00:00.800\n${text}\n`;
const SRT = (text: string) => `1\n00:00:00,000 --> 00:00:00,800\n${text}\n`;

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-comp-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const C = await import('../src/services/watchfolder/companionIngest');
  const D = await import('../src/services/watchfolder/defaults');
  const { withTracks } = await import('../src/services/companions/serve');

  // ---- the pure parts -------------------------------------------------------
  console.log('== matching by name ==');
  check('a stem with a separator after it fits', [C.prefixFits('Scrubs-s1-e1', 'Scrubs-s1-e1_en'), C.prefixFits('Scrubs-s1-e1', 'Scrubs-s1-e1.fr'), C.prefixFits('a b', 'a b sdh')], [true, true, true]);
  check('the same stem fits', C.prefixFits('Scrubs-s1-e1', 'Scrubs-s1-e1'), true);
  check('a prefix that does not end at a word break does not', C.prefixFits('Show-e1', 'Show-e10_en'), false);
  check('case is ignored', C.prefixFits('Scrubs-S1-E1', 'scrubs-s1-e1_EN'), true);
  check('a longer video name never fits a shorter caption', C.prefixFits('Scrubs-s1-e1', 'Scrubs'), false);
  const cands = [{ objectKey: 'Show-e1.mp4', assetId: 'a1' }, { objectKey: 'Show-e10.mp4', assetId: 'a10' }, { objectKey: 'Show.mp4', assetId: 'a0' }];
  check('the longest fitting name wins (e10)', C.bestMatch('Show-e10_en.vtt', cands)?.assetId, 'a10');
  check('the longest fitting name wins (e1)', C.bestMatch('Show-e1.fr.vtt', cands)?.assetId, 'a1');
  check('a vaguer one is taken when nothing closer fits', C.bestMatch('Show_de.vtt', cands)?.assetId, 'a0');
  check('no fit, no match', C.bestMatch('Other_en.vtt', cands), null);
  check('the same subfolder first', C.bestMatch('b/Ep_en.vtt', [{ objectKey: 'a/Ep.mp4', assetId: 'x', seenAt: 9 }, { objectKey: 'b/Ep.mp4', assetId: 'y', seenAt: 1 }])?.assetId, 'y');
  check('a waiting video that fits better wins (the caption waits)', C.bestMatch('Show-e10_en.vtt', [{ objectKey: 'Show.mp4', assetId: 'a0' }, { objectKey: 'Show-e10.mp4', assetId: null }])?.assetId, null);
  check('local and bucket folders start with captions and sidecars too', D.defaultRulesFor('local').map((r) => r.builtin), ['images', 'video', 'audio', 'captions', 'sidecars']);
  check('a site folder gets the caption and sidecar defaults too (H2b-5)', D.defaultRulesFor('site').map((r) => r.builtin).filter((b) => b === 'captions' || b === 'sidecars'), ['captions', 'sidecars']);

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfc-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `wfc-${tag}@volt.test`]))!.id;
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  const old = new Date(Date.now() - 60_000);
  let realVideo = true;
  const video = async (path: string) => {
    if (realVideo) {
      try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { stdio: 'ignore' }); }
      catch { realVideo = false; }
    }
    if (!realVideo) await writeFile(path, 'v'.repeat(8192) + path);
    await utimes(path, old, old);
  };
  const text = async (path: string, body: string | Buffer) => { await writeFile(path, body); await utimes(path, old, old); };
  const item = (F: string, key: string) => one<any>(`SELECT status, target_kind, reason, vod_asset_id, quarantine_key FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = $2 ORDER BY id DESC LIMIT 1`, [F, key]);
  const assetOf = async (F: string, key: string) => (await item(F, key))?.vod_asset_id ?? null;
  const filesOf = (assetId: string) => query<any>(`SELECT name, kind, language, sdh, forced, enabled, source, is_default FROM vod_asset_files WHERE asset_id = $1 ORDER BY created_at`, [assetId]);

  try {
    const drop = join(root, 'drop'); await mkdir(drop, { recursive: true });
    const made = await call('POST', '/api/watchfolders', { name: 'Series drop', kind: 'local', config: { path: drop, min_age_ms: 1000 } });
    check('folder created', made.s, 201);
    const F = made.j.id;
    const scan = async () => (await call('POST', `/api/watchfolders/${F}/scan`)).j;

    console.log('\n== the rules ==');
    const got = (await call('GET', `/api/watchfolders/${F}`)).j;
    check('five default rules, captions and sidecars after video and audio', got.rules.map((r: any) => [r.builtin, r.target_kind]),
      [['images', 'image'], ['video', 'vod'], ['audio', 'vod'], ['captions', 'companion'], ['sidecars', 'companion']]);
    check('companion is offered for captions and sidecars', got.targetKinds.find((k: any) => k.kind === 'companion'), { kind: 'companion', goesTo: 'companions', accepts: ['caption', 'sidecar'] });
    const kindOf = async (filename: string) => { const d = (await call('POST', `/api/watchfolders/${F}/dry-run`, { filename, sizeBytes: 1000 })).j.decision; return d.decision === 'accept' ? d.targetKind : 'review'; };
    check('a caption goes to its video', await kindOf('Scrubs-s1-e1_en.vtt'), 'companion');
    check('an srt, a ttml and a dfxp too', [await kindOf('a.srt'), await kindOf('a.ttml'), await kindOf('a.dfxp')], ['companion', 'companion', 'companion']);
    check('a sidecar too', [await kindOf('a.json'), await kindOf('a.nfo'), await kindOf('a.xml'), await kindOf('a.csv')], ['companion', 'companion', 'companion', 'companion']);
    check('audio goes to the Media Library (H2b-4)', await kindOf('theme.mp3'), 'vod');
    const r1 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'glob', pattern: '*.vtt', targetKind: 'image' });
    check('a caption rule to the Image Library is refused, pointing to companion', [r1.s, /companion/.test(r1.j?.error ?? r1.j?.message ?? '')], [400, true]);
    const r2 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'glob', pattern: '*.png', targetKind: 'companion' });
    check('an image rule to companion is refused', r2.s, 400);
    const r3 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'House subs', matchType: 'glob', pattern: '*_subs.vtt', targetKind: 'companion' });
    check('a custom caption rule to companion is fine', r3.s, 201);

    console.log('\n== the video, then its caption ==');
    await video(join(drop, 'Scrubs-s1-e1.mp4'));
    console.log(realVideo ? '(real video from ffmpeg)' : '(no ffmpeg: plain bytes)');
    await scan();
    const e1 = await assetOf(F, 'Scrubs-s1-e1.mp4');
    truthy('the video is in the Media Library, its asset on the item', e1);
    const a1 = await one<any>(`SELECT title, metadata FROM vod_assets WHERE id = $1`, [e1]);
    console.log('   asset title and metadata:', a1?.title, JSON.stringify(a1?.metadata ?? {}).slice(0, 200));
    check('titled from the file name, as today', a1?.title, 'Episode 1 (S1)');
    check('series, season and episode from the name', [a1?.metadata?.series, a1?.metadata?.season, a1?.metadata?.episodeNumber], ['Scrubs', 1, 1]);
    await text(join(drop, 'Scrubs-s1-e1_en.vtt'), VTT('Hello from episode one'));
    const s1 = await scan();
    check('the scan counts it attached', s1.ingest?.attached, 1);
    const it1 = await item(F, 'Scrubs-s1-e1_en.vtt');
    check('the caption item is in the library', [it1?.status, it1?.target_kind], ['ingested', 'companion']);
    check('on the same asset', it1?.vod_asset_id, e1);
    truthy('the reason says English subtitles', /English subtitles/.test(it1?.reason ?? ''), it1?.reason);
    const f1 = await filesOf(e1);
    check('one caption file, English, on, from the watchfolder, the default', f1.map((f) => [f.kind, f.language, f.enabled, f.source, f.is_default]), [['captions', 'en', true, 'watchfolder', true]]);
    const master = await withTracks('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=160x90\nv0/index.m3u8\n', e1, false);
    truthy('HLS: an English subtitle track in the master', /TYPE=SUBTITLES.*LANGUAGE="en"/.test(master), master);
    truthy('HLS: the variant names the group', /SUBTITLES="volt-subs"/.test(master), master);
    const mpd = await withTracks('<MPD><Period id="0"><AdaptationSet contentType="video"></AdaptationSet></Period></MPD>', e1, true);
    truthy('DASH: an English text adaptation set', /contentType="text"[^>]*lang="en"/.test(mpd), mpd);
    const listed = await call('GET', `/api/vod/${e1}/files`);
    check('the asset page lists it', listed.j?.files?.map((f: any) => f.name), ['Scrubs-s1-e1_en.vtt']);

    console.log('\n== the caption first, then the video ==');
    await text(join(drop, 'Scrubs-s1-e2_en.srt'), SRT('Episode two'));
    const s2 = await scan();
    check('counted as waiting', s2.ingest?.waiting, 1);
    const w = await item(F, 'Scrubs-s1-e2_en.srt');
    check('still Waiting', w?.status, 'seen');
    truthy('saying it waits for its video', /waiting for its video/.test(w?.reason ?? ''), w?.reason);
    check('a second scan leaves it waiting', ((await scan()).ingest?.waiting), 1);
    await video(join(drop, 'Scrubs-s1-e2.mp4'));
    await scan();
    const e2 = await assetOf(F, 'Scrubs-s1-e2.mp4');
    truthy('the video landed', e2);
    const w2 = await item(F, 'Scrubs-s1-e2_en.srt');
    check('the waiting caption attached to it in the same pass', [w2?.status, w2?.vod_asset_id], ['ingested', e2]);
    check('as English', (await filesOf(e2)).map((f) => [f.kind, f.language]), [['captions', 'en']]);

    console.log('\n== the longest prefix wins ==');
    await video(join(drop, 'Show-e1.mp4'));
    await video(join(drop, 'Show-e10.mp4'));
    await text(join(drop, 'Show-e10_en.vtt'), VTT('ten'));
    await text(join(drop, 'Show-e1.fr.vtt'), VTT('un'));
    await scan();
    const se1 = await assetOf(F, 'Show-e1.mp4'), se10 = await assetOf(F, 'Show-e10.mp4');
    check('Show-e10_en.vtt went to Show-e10', (await item(F, 'Show-e10_en.vtt'))?.vod_asset_id, se10);
    check('Show-e1.fr.vtt went to Show-e1', (await item(F, 'Show-e1.fr.vtt'))?.vod_asset_id, se1);
    check('Show-e1 has only the French track', (await filesOf(se1)).map((f) => f.language), ['fr']);
    check('Show-e10 has only the English track', (await filesOf(se10)).map((f) => f.language), ['en']);

    console.log('\n== flags from the name ==');
    await text(join(drop, 'Scrubs-s1-e1.en.sdh.srt'), SRT('[door slams]'));
    await text(join(drop, 'Scrubs-s1-e1.de.forced.vtt'), VTT('Nur Schilder'));
    await scan();
    const f3 = (await filesOf(e1)).filter((f) => f.kind === 'captions').map((f) => [f.name, f.language, f.sdh, f.forced]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1));
    check('sdh and forced read from the name', f3, [
      ['Scrubs-s1-e1.de.forced.vtt', 'de', false, true], ['Scrubs-s1-e1.en.sdh.srt', 'en', true, false], ['Scrubs-s1-e1_en.vtt', 'en', false, false]]);
    const m3 = await withTracks('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv0/index.m3u8\n', e1, false);
    truthy('the forced track is FORCED=YES in HLS', /LANGUAGE="de".*FORCED=YES/.test(m3), m3);

    console.log('\n== a caption that does not read ==');
    await text(join(drop, 'Scrubs-s1-e1_es.srt'), 'this is not a subtitle file\n');
    await scan();
    const bad1 = await item(F, 'Scrubs-s1-e1_es.srt');
    check('attached', bad1?.status, 'ingested');
    truthy('switched off, with why', /switched off/.test(bad1?.reason ?? ''), bad1?.reason);
    check('off on the asset', (await filesOf(e1)).find((f) => f.name === 'Scrubs-s1-e1_es.srt')?.enabled, false);

    console.log('\n== a metadata sidecar ==');
    await text(join(drop, 'Scrubs-s1-e1.json'), JSON.stringify({ title: 'My First Day', description: 'J.D. starts at Sacred Heart.', genre: 'Comedy' }));
    await scan();
    const sc = await item(F, 'Scrubs-s1-e1.json');
    check('attached to the episode', [sc?.status, sc?.vod_asset_id], ['ingested', e1]);
    truthy('for a person to apply', /apply its fields/.test(sc?.reason ?? ''), sc?.reason);
    check('kept as metadata', (await filesOf(e1)).find((f) => f.name === 'Scrubs-s1-e1.json')?.kind, 'metadata');
    const a1b = await one<any>(`SELECT title, metadata FROM vod_assets WHERE id = $1`, [e1]);
    check('nothing applied to the asset by itself', [a1b?.title, a1b?.metadata?.description ?? null], [a1?.title, a1?.metadata?.description ?? null]);

    console.log('\n== too big ==');
    await text(join(drop, 'Scrubs-s1-e1_big.vtt'), Buffer.concat([Buffer.from('WEBVTT\n\n'), Buffer.alloc(26 * 1024 * 1024, 0x61)]));
    const sb = await scan();
    check('counted as review', sb.ingest?.review, 1);
    const big = await item(F, 'Scrubs-s1-e1_big.vtt');
    check('refused to Needs review at once', big?.status, 'quarantined');
    truthy('with the 25 MB limit in the reason', /over the 25 MB limit/.test(big?.reason ?? ''), big?.reason);
    truthy('moved to the review folder', existsSync(join(drop, '_review', 'Scrubs-s1-e1_big.vtt')) && !existsSync(join(drop, 'Scrubs-s1-e1_big.vtt')));
    check('not attached', (await filesOf(e1)).some((f) => f.name === 'Scrubs-s1-e1_big.vtt'), false);

    console.log('\n== no video after 24 hours ==');
    await text(join(drop, 'Lonely_en.vtt'), VTT('alone'));
    await scan();
    check('waiting at first', (await item(F, 'Lonely_en.vtt'))?.status, 'seen');
    await query(`UPDATE watchfolder_items SET seen_at = now() - interval '25 hours' WHERE watchfolder_id = $1 AND object_key = 'Lonely_en.vtt'`, [F]);
    await scan();
    const lone = await item(F, 'Lonely_en.vtt');
    check('then Needs review', lone?.status, 'quarantined');
    truthy('saying no video is named like it', /no video in this folder is named like it/.test(lone?.reason ?? ''), lone?.reason);
    check('the file is in the review folder', [existsSync(join(drop, '_review', 'Lonely_en.vtt')), existsSync(join(drop, 'Lonely_en.vtt')), lone?.quarantine_key], [true, false, '_review/Lonely_en.vtt']);
    const rq = await call('GET', `/api/watchfolders/${F}/items?status=quarantined`);
    truthy('listed in the review queue', (rq.j?.items ?? rq.j?.data ?? []).some((i: any) => i.object_key === 'Lonely_en.vtt'), JSON.stringify(rq.j).slice(0, 300));

    console.log('\n== another folder ==');
    const drop2 = join(root, 'drop2'); await mkdir(drop2, { recursive: true });
    const F2 = (await call('POST', '/api/watchfolders', { name: 'Other drop', kind: 'local', config: { path: drop2, min_age_ms: 1000 } })).j.id;
    await text(join(drop2, 'Scrubs-s1-e1_it.vtt'), VTT('ciao'));
    await call('POST', `/api/watchfolders/${F2}/scan`);
    check('a caption in another folder does not attach to this folder\'s video', (await item(F2, 'Scrubs-s1-e1_it.vtt'))?.status, 'seen');
    check('the episode has no Italian track', (await filesOf(e1)).some((f) => f.language === 'it'), false);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
