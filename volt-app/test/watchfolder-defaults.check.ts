// ============================================================================
//  WATCHFOLDER DEFAULT RULES BY FILE TYPE, and where a rule may send each
//  type (build queue H2b (a) and (d), first part).
//
//  Through the real API on a real database, with a real folder scanned:
//    - a new folder starts with one ordinary rule per file type, images to the
//      Image Library and video to the Media Library, at the bottom of the
//      order; a site folder gets the same five (H2b-5); a folder made
//      with `defaultRules: false` starts with none;
//    - the dry run shows them like any rule, and a file nothing recognises
//      (a project file) still goes to review; audio goes to the Media
//      Library as an audio asset (H2b-4);
//    - a scan of a fresh folder takes a png into the Image Library and an mp4
//      into the Media Library, with its encode queued;
//    - a custom rule added later goes ABOVE the defaults and wins;
//    - each default can be switched off (the file falls through to review)
//      and on again, edited, deleted;
//    - "Add default rules" on an older folder adds only the missing ones,
//      after the folder's own rules, and a second call adds nothing;
//    - a rule may only send a file type somewhere that takes it: an image
//      pattern to the Media Library is refused, so is a video pattern to the
//      Image Library, also when a rule is edited into that shape; a pattern
//      that could match anything is not checked;
//    - another account cannot add defaults to the folder.
//  Plus the pure parts: extension lists in `matches`, typesOfPattern and the
//  ordinal a custom rule gets.
//
//  Usage: DATABASE_URL=... npx tsx test/watchfolder-defaults.check.ts
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

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-def-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { matches } = await import('../src/services/watchfolder/rules');
  const D = await import('../src/services/watchfolder/defaults');

  // ---- the pure parts -------------------------------------------------------
  console.log('== extension lists, file types and ordinals ==');
  const ext = (pattern: string) => ({ id: 'x', ordinal: 1, name: 'x', matchType: 'extension' as const, pattern, targetKind: 'image' });
  check('a list matches each of its extensions', ['a.png', 'b.JPG', 'c.tiff'].map((n) => matches(ext('png, jpg, tiff'), n)), [true, true, true]);
  check('and nothing else', ['a.pdf', 'png', 'a.png.part'].map((n) => matches(ext('png, jpg'), n)), [false, false, false]);
  check('a single extension behaves as before', [matches(ext('mp4'), 'x.mp4'), matches(ext('.mp4'), 'x.MP4'), matches(ext('mp4'), 'x.mov')], [true, true, false]);
  check('dots and spaces are allowed in a list', matches(ext('.mov .mxf'), 'show.mxf'), true);
  check('an extension rule names its types', D.typesOfPattern('extension', 'png, jpg'), ['image']);
  check('mixed types are both named', D.typesOfPattern('extension', 'png, mp4'), ['image', 'video']);
  check('a glob ending in an extension names its type', D.typesOfPattern('glob', 'slate_*.png'), ['image']);
  check('a glob with no extension says nothing', D.typesOfPattern('glob', 'loop_*'), null);
  check('an extension Volt does not know says nothing', D.typesOfPattern('glob', '*.pdf'), null);
  check('a regex says nothing', D.typesOfPattern('regex', '\\.png$'), null);
  check('typeOfName reads captions and sidecars', ['a_en.vtt', 'b.nfo', 'c.flac', 'd.MXF'].map(D.typeOfName), ['caption', 'sidecar', 'audio', 'video']);
  check('a custom rule goes after custom rules and before the defaults',
    D.customOrdinal([{ ordinal: 10 }, { ordinal: 100000, builtin: 'images' }, { ordinal: 100010, builtin: 'video' }]), 20);
  check('the first custom rule on a fresh folder is 10', D.customOrdinal([{ ordinal: 100000, builtin: 'images' }]), 10);
  check('a full gap halves', D.customOrdinal([{ ordinal: 10 }, { ordinal: 14, builtin: 'images' }]), 12);
  check('no gap at all goes to the end', D.customOrdinal([{ ordinal: 10 }, { ordinal: 11, builtin: 'images' }]), 21);
  check('a site folder starts with the same five (H2b-5: its agent carries every type)', D.defaultRulesFor('site').map((r) => r.builtin), ['images', 'video', 'audio', 'captions', 'sidecars']);
  check('local and bucket folders with images, video, audio, captions and sidecars', [D.defaultRulesFor('local'), D.defaultRulesFor('s3')].map((l) => l.map((r) => r.builtin)), [['images', 'video', 'audio', 'captions', 'sidecars'], ['images', 'video', 'audio', 'captions', 'sidecars']]);

  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfd-${tag}`]))!.id;
  const other = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfd-o-${tag}`]))!.id;
  const mkUser = async (a: string, email: string) =>
    (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, email]))!.id;
  const owner = await mkUser(acct, `wfd-${tag}@volt.test`);
  const otherOwner = await mkUser(other, `wfd-o-${tag}@volt.test`);

  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const otherTok = signAccess({ sub: otherOwner, account_id: other, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any, t = tok) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json().catch(() => null) as any };
  };
  const dry = async (F: string, filename: string) => (await call('POST', `/api/watchfolders/${F}/dry-run`, { filename, sizeBytes: 1000 })).j;
  const kindOf = async (F: string, filename: string) => { const d = (await dry(F, filename)).decision; return d.decision === 'accept' ? d.targetKind : 'review'; };

  try {
    // ---- a new folder ---------------------------------------------------------
    console.log('\n== a new folder starts with the rules by type ==');
    const drop = join(root, 'drop'); await mkdir(drop, { recursive: true });
    const made = await call('POST', '/api/watchfolders', { name: 'Agency drop', kind: 'local', config: { path: drop, min_age_ms: 1000 } });
    check('created', made.s, 201);
    const F = made.j.id;
    check('with five rules in the answer', made.j.rules?.map((r: any) => r.builtin), ['images', 'video', 'audio', 'captions', 'sidecars']);
    const got = (await call('GET', `/api/watchfolders/${F}`)).j;
    check('shown as ordinary rules, images first', got.rules.map((r: any) => [r.name, r.match_type, r.target_kind, r.enabled]),
      [['Images to the Image Library', 'extension', 'image', true], ['Video to the Media Library', 'extension', 'vod', true],
       ['Audio to the Media Library', 'extension', 'vod', true], ['Captions to their video', 'extension', 'companion', true], ['Metadata files to their video', 'extension', 'companion', true]]);
    check('at the bottom of the order', got.rules.map((r: any) => r.ordinal), [100000, 100010, 100020, 100030, 100040]);
    check('nothing missing', got.defaultsMissing, []);
    check('the destinations say which file types they take', got.targetKinds.find((k: any) => k.kind === 'vod')?.accepts, ['video', 'audio']);
    check('Loops & Fillers takes video only', got.targetKinds.find((k: any) => k.kind === 'loop')?.accepts, ['video']);

    console.log('\n== the dry run ==');
    check('a png goes to the Image Library', await kindOf(F, 'Scrubs-s1-e1.png'), 'image');
    check('a JPEG too, any case', await kindOf(F, 'still.JPEG'), 'image');
    check('an mp4 to the Media Library', await kindOf(F, 'Scrubs-s1-e1.mp4'), 'vod');
    check('an mxf too', await kindOf(F, 'master.mxf'), 'vod');
    const d1 = await dry(F, 'Scrubs-s1-e1.mp4');
    check('the winning rule is the video default', d1.rules.find((r: any) => r.winner)?.name, 'Video to the Media Library');
    check('a project file still goes to review', await kindOf(F, 'edit.prproj'), 'review');
    check('audio goes to the Media Library as an audio asset (H2b-4)', [await kindOf(F, 'theme.mp3'), await kindOf(F, 'interview.WAV'), await kindOf(F, 'a.flac')], ['vod', 'vod', 'vod']);
    check('a caption goes to its video (companions by name, H2b-2)', await kindOf(F, 'Scrubs-s1-e1_en.vtt'), 'companion');
    check('a partial upload is still refused first', await kindOf(F, 'big.mp4.part'), 'review');

    // ---- a real scan ------------------------------------------------------------
    console.log('\n== a scan of the fresh folder ==');
    const old = new Date(Date.now() - 60_000);
    const png = join(drop, 'Station-card.png');
    let realPng = true;
    try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x36', '-frames:v', '1', png], { stdio: 'ignore' }); }
    catch { realPng = false; await writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex')); }
    const mp4 = join(drop, 'Morning Show.mp4');
    let realMp4 = true;
    try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4], { stdio: 'ignore' }); }
    catch { realMp4 = false; await writeFile(mp4, 'v'.repeat(8192)); }
    await writeFile(join(drop, 'notes.prproj'), 'p'.repeat(100));
    for (const p of [png, mp4, join(drop, 'notes.prproj')]) await utimes(p, old, old);
    console.log(realPng && realMp4 ? '(real files from ffmpeg)' : '(no ffmpeg: plain bytes)');
    const sc = await call('POST', `/api/watchfolders/${F}/scan`);
    check('the scan ran', sc.s, 200);
    const items = await query<any>(`SELECT object_key, status, target_kind FROM watchfolder_items WHERE watchfolder_id = $1 ORDER BY object_key`, [F]);
    const by = Object.fromEntries(items.map((i) => [i.object_key, [i.status, i.target_kind]]));
    check('the png was taken into the Image Library', by['Station-card.png'], ['ingested', 'image']);
    const mf = await one<any>(`SELECT kind, name FROM media_files WHERE account_id = $1 AND name = 'Station-card.png'`, [acct]);
    check('as an image in the library', mf?.kind, 'other');
    check('the mp4 is in the Media Library', by['Morning Show.mp4']?.[1], 'vod');
    const asset = await one<any>(`SELECT id FROM vod_assets WHERE account_id = $1 AND source_kind = 'watchfolder'`, [acct]);
    check('with an asset', !!asset, true);
    const job = asset ? await one<any>(`SELECT id FROM jobs WHERE payload::text LIKE $1`, [`%${asset.id}%`]) : null;
    check('and its encode queued', !!job, true);
    check('the project file is in review', by['notes.prproj'], ['quarantined', null]);
    check('moved to the review folder', existsSync(join(drop, '_review', 'notes.prproj')), true);

    // ---- custom rules -------------------------------------------------------------
    console.log('\n== a custom rule added later wins over the defaults ==');
    const loopRule = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Loops', matchType: 'glob', pattern: 'loop_*.mp4', targetKind: 'loop' });
    check('added', loopRule.s, 201);
    check('above the defaults', loopRule.j.ordinal < 100000, true);
    check('loop_ident.mp4 is a loop', await kindOf(F, 'loop_ident.mp4'), 'loop');
    check('other video still goes to the Media Library', await kindOf(F, 'show.mp4'), 'vod');
    const second = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Slates', matchType: 'glob', pattern: 'slate_*.png', targetKind: 'slate' });
    check('a second custom rule goes after the first', second.j.ordinal > loopRule.j.ordinal && second.j.ordinal < 100000, true);
    check('slate_open.png is a slate', await kindOf(F, 'slate_open.png'), 'slate');

    console.log('\n== where a rule may send each type ==');
    const r1 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'glob', pattern: '*.png', targetKind: 'vod' });
    check('an image pattern to the Media Library is refused', [r1.s, r1.j?.code], [400, 'target_does_not_fit_type']);
    check('and says where it can go', /Image Library/.test(r1.j?.error ?? r1.j?.message ?? ''), true);
    const r2 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'extension', pattern: 'mp4, mov', targetKind: 'poster' });
    check('a video pattern to the Image Library is refused', r2.s, 400);
    const r3 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Bad', matchType: 'extension', pattern: 'png, mp4', targetKind: 'image' });
    check('a pattern of images and video sent to images only is refused', r3.s, 400);
    const r4 = await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Captions', matchType: 'glob', pattern: '*.vtt', targetKind: 'image' });
    check('a caption pattern to the Image Library is refused', r4.s, 400);
    check('an mp4 to Loops & Fillers is fine', (await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Fill', matchType: 'suffix', pattern: '_fill.mp4', targetKind: 'filler' })).s, 201);
    check('a pattern of any type is not checked', (await call('POST', `/api/watchfolders/${F}/rules`, { name: 'Promo', matchType: 'glob', pattern: 'promo_*', targetKind: 'vod' })).s, 201);
    check('a refusing rule is not checked', (await call('POST', `/api/watchfolders/${F}/rules`, { name: 'No mov', matchType: 'glob', pattern: '*.mov', targetKind: 'image', action: 'reject', rejectReason: 'send MP4' })).s, 201);
    const videoDefault = got.rules.find((r: any) => r.builtin === 'video');
    const e1 = await call('PATCH', `/api/watchfolders/${F}/rules/${videoDefault.id}`, { pattern: 'png' });
    check('editing the video rule to match images is refused', e1.s, 400);
    const e2 = await call('PATCH', `/api/watchfolders/${F}/rules/${second.j.id}`, { targetKind: 'vod' });
    check('pointing the slate rule at the Media Library is refused', e2.s, 400);
    const e3 = await call('PATCH', `/api/watchfolders/${F}/rules/${videoDefault.id}`, { pattern: 'mp4, mov, mxf, m4v' });
    check('editing a default within its type is fine', e3.s, 200);
    check('and it is still the default', e3.j?.builtin, 'video');
    check('mkv is no longer caught', await kindOf(F, 'x.mkv'), 'review');

    console.log('\n== switching a default off and on ==');
    const imageDefault = got.rules.find((r: any) => r.builtin === 'images');
    check('off', (await call('PATCH', `/api/watchfolders/${F}/rules/${imageDefault.id}`, { enabled: false })).j?.enabled, false);
    check('a png now goes to review', await kindOf(F, 'poster.png'), 'review');
    check('a slate still goes by its own rule', await kindOf(F, 'slate_a.png'), 'slate');
    check('off is not missing', (await call('GET', `/api/watchfolders/${F}`)).j.defaultsMissing, []);
    check('on again', (await call('PATCH', `/api/watchfolders/${F}/rules/${imageDefault.id}`, { enabled: true })).j?.enabled, true);
    check('a png goes to the Image Library again', await kindOf(F, 'poster.png'), 'image');

    console.log('\n== deleting a default and adding it back ==');
    check('deleted', (await call('DELETE', `/api/watchfolders/${F}/rules/${videoDefault.id}`)).s, 204);
    check('shown as missing', (await call('GET', `/api/watchfolders/${F}`)).j.defaultsMissing, ['video']);
    const add = await call('POST', `/api/watchfolders/${F}/rules/defaults`);
    check('Add default rules adds it', [add.s, add.j.added.map((r: any) => r.builtin)], [201, ['video']]);
    const maxBefore = Math.max(...add.j.rules.filter((r: any) => r.builtin !== 'video').map((r: any) => r.ordinal));
    check('after every rule the folder has', add.j.added[0].ordinal > maxBefore, true);
    const again = await call('POST', `/api/watchfolders/${F}/rules/defaults`);
    check('a second call adds nothing', [again.s, again.j.added.length], [200, 0]);
    check('another account cannot add them', (await call('POST', `/api/watchfolders/${F}/rules/defaults`, undefined, otherTok)).s, 404);
    const audit = await one<any>(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id::text = $1 AND detail::text LIKE '%defaultRulesAdded%'`, [F]).catch(() => null);
    if (audit) check('the change is in the audit log', audit.n >= 1, true);

    console.log('\n== an older folder ==');
    const olderDrop = join(root, 'older'); await mkdir(olderDrop, { recursive: true });
    const older = (await one<any>(`INSERT INTO watchfolders(account_id, name, kind, config, quarantine_path) VALUES ($1,'Older','local',$2::jsonb,'_review') RETURNING id`,
      [acct, JSON.stringify({ path: olderDrop })]))!.id;
    await query(`INSERT INTO watchfolder_rules(watchfolder_id, ordinal, name, match_type, pattern, target_kind) VALUES ($1,10,'Posters','glob','*.png','poster')`, [older]);
    check('it keeps its rules and has no defaults', (await call('GET', `/api/watchfolders/${older}`)).j.rules.length, 1);
    check('all shown as missing', (await call('GET', `/api/watchfolders/${older}`)).j.defaultsMissing, ['images', 'video', 'audio', 'captions', 'sidecars']);
    check('a png is still a poster', await kindOf(older, 'a.png'), 'poster');
    const oa = await call('POST', `/api/watchfolders/${older}/rules/defaults`);
    check('all added after its own rule', oa.j.rules.map((r: any) => r.builtin ?? r.name), ['Posters', 'images', 'video', 'audio', 'captions', 'sidecars']);
    check('a png is still a poster (its own rule wins)', await kindOf(older, 'a.png'), 'poster');
    check('a jpg is now an image', await kindOf(older, 'a.jpg'), 'image');

    console.log('\n== a folder made without them ==');
    const bare = await call('POST', '/api/watchfolders', { name: 'Bare', kind: 'local', config: { path: olderDrop }, defaultRules: false });
    check('created with no rules', [bare.s, bare.j.rules], [201, []]);
    check('a png goes to review', await kindOf(bare.j.id, 'a.png'), 'review');
    const s3 = await call('POST', '/api/watchfolders', { name: 'Bucket', kind: 's3', config: { bucket: 'b', prefix: 'watch/x/' } });
    check('a bucket folder gets the same five', s3.j.rules?.map((r: any) => r.builtin), ['images', 'video', 'audio', 'captions', 'sidecars']);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
