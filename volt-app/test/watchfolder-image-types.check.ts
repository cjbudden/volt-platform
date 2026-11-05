// ============================================================================
//  WATCHFOLDER SLATES AND IMAGE TYPES (build queue H2b-3).
//
//  Through the real API on a real database, with real folders scanned:
//    - `filler-slate` is offered for images only, under Loops & Fillers; a
//      png sent there lands a ready slate in Loops & Fillers (bytes in the
//      filler store), and an mp4 sent to `loop` lands a loop;
//    - a rule's image type: only on an Image Library rule, only a type of
//      the account that is switched on;
//    - `Scrubs-s1-e1-thumbnail.jpg` and `Scrubs-s1-e1_poster.png` after the
//      video become its Thumbnail (poster_key set, locked) and its Poster
//      (vod_asset_images), filed as keyframe and poster, a wrong shape only
//      warned about;
//    - a poster before its video waits in the Image Library and is set when
//      the video lands;
//    - `...-hero.jpg` with no asset after 24 hours (time moved) stays in the
//      Image Library, unmatched, saying so;
//    - `Station-logo.png` is a brand image and attaches to nothing;
//    - an account's own type matched by its key or label;
//    - a rule with `imageType: hero` on `*_key_art.jpg` sets Hero backdrop;
//      with the name switched off, the rule's type wins over a type word;
//    - the dry run shows the type, where it is filed and the asset.
//  Plus the pure parts: typeWordOf and resolveImageType.
//
//  Usage: DATABASE_URL=... npx tsx test/watchfolder-image-types.check.ts
// ============================================================================
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
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

/** A real PNG of one colour, any size: no image library needed. */
function png(w: number, h: number, rgb = [40, 90, 200]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-imgt-'));
  process.env.IMAGE_STORE_DIR = process.env.IMAGE_STORE_DIR ?? join(root, '_images');
  process.env.FILLER_DIR = process.env.FILLER_DIR ?? join(root, '_filler');
  process.env.CLIPS_DIR = process.env.CLIPS_DIR ?? join(root, '_clips');
  const T = await import('../src/services/watchfolder/imageTypes');

  // ---- the pure parts -------------------------------------------------------
  console.log('== type words ==');
  const { STANDARD_IMAGE_TYPES } = await import('../src/services/media/assetImageRules');
  const std = STANDARD_IMAGE_TYPES.filter((t) => t.appliesTo.includes('video')).map((t) => ({ key: t.key, label: t.label }));
  const w = (n: string, types = std) => { const r = T.typeWordOf(n, types); return r ? [r.typeKey, r.libraryKind, r.stem] : null; };
  check('-thumbnail: Thumbnail, a keyframe, matched on the episode', w('Scrubs-s1-e1-thumbnail.jpg'), ['thumbnail', 'keyframe', 'Scrubs-s1-e1']);
  check('_poster: Poster, a poster', w('Scrubs-s1-e1_poster.png'), ['poster', 'poster', 'Scrubs-s1-e1']);
  check('case is ignored, a space and a dot are breaks', [w('Ep THUMB.jpg')?.[0], w('Ep.Fanart.jpg')?.[0], w('Ep_SOCIAL.png')?.[0]], ['thumbnail', 'hero', 'social']);
  check('the other standard words', ['cover', 'backdrop', 'background', 'banner', 'share', 'title', 'titleart', 'clearlogo'].map((x) => w(`Ep-${x}.png`)?.[0]),
    ['cover', 'hero', 'hero', 'banner', 'social', 'title', 'title', 'title']);
  check('logo-title is title art, not a brand logo', w('Show_logo-title.png'), ['title', 'other', 'Show']);
  check('-logo alone is a brand image with no type', w('Station-logo.png'), [null, 'brand', 'Station']);
  check('watermark and slate set their kinds', [w('Bug-watermark.png'), w('Open_slate.png')], [[null, 'watermark', 'Bug'], [null, 'slate', 'Open']]);
  check('a word inside the name is not a type word', w('poster-boy-e1.png'), null);
  check('no word, no type', w('Scrubs-s1-e1.png'), null);
  check('a type the account switched off is not a word', w('Ep_poster.png', std.filter((t) => t.key !== 'poster')), null);
  const own = [...std, { key: 'key-art', label: 'Key art' }, { key: 'partner-tile', label: 'Partner tile' }];
  check('an account type by its key', w('Show-e1_key-art.jpg', own), ['key-art', 'other', 'Show-e1']);
  check('and by its label, any separator', [w('Show-e1_key_art.jpg', own)?.[0], w('Show-e1 partnertile.png', own)?.[0]], ['key-art', 'partner-tile']);
  check('a renamed standard type still answers to its words', w('Ep_poster.png', std.map((t) => t.key === 'poster' ? { ...t, label: 'Key visual' } : t))?.[0], 'poster');
  const r = (n: string, rule: any) => { const x = T.resolveImageType(n, rule, std); return x ? [x.typeKey, x.from, x.attach] : null; };
  check('the rule\'s type when the name has no word', r('Show-e1_key_art.jpg', { imageType: 'hero' }), ['hero', 'rule', true]);
  check('a word in the name wins by default', r('Show-e1_poster.jpg', { imageType: 'hero' }), ['poster', 'name', true]);
  check('not when the rule says so', r('Show-e1_poster.jpg', { imageType: 'hero', imageTypeFromName: false }), ['hero', 'rule', true]);
  check('a word with nothing before it is filed, not matched', r('poster.png', {}), ['poster', 'name', false]);

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const tag = Date.now().toString(36);
  const acct = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`wfit-${tag}`]))!.id;
  const owner = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [acct, `wfit-${tag}@volt.test`]))!.id;
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const tok = signAccess({ sub: owner, account_id: acct, role: 'owner' } as any);
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { s: res.status, j: await res.json().catch(() => null) as any };
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
  const image = async (path: string, wd: number, ht: number, rgb?: number[]) => { await writeFile(path, png(wd, ht, rgb)); await utimes(path, old, old); };
  const item = (F: string, key: string) => one<any>(`SELECT i.status, i.target_kind, i.reason, i.vod_asset_id, i.image_type, i.image_attach, m.kind AS media_kind, m.store_key
      FROM watchfolder_items i LEFT JOIN media_files m ON m.id = i.media_file_id WHERE i.watchfolder_id = $1 AND i.object_key = $2 ORDER BY i.id DESC LIMIT 1`, [F, key]);
  const typed = (assetId: string) => query<any>(`SELECT type_key, image_key FROM vod_asset_images WHERE asset_id = $1 ORDER BY type_key`, [assetId]);

  try {
    const drop = join(root, 'drop'); await mkdir(drop, { recursive: true });
    const made = await call('POST', '/api/watchfolders', { name: 'Artwork drop', kind: 'local', config: { path: drop, min_age_ms: 1000 } });
    check('folder created', made.s, 201);
    const F = made.j.id;
    const scan = async () => (await call('POST', `/api/watchfolders/${F}/scan`)).j;
    const dry = async (filename: string) => (await call('POST', `/api/watchfolders/${F}/dry-run`, { filename, sizeBytes: 1000 })).j;

    console.log('\n== the rules ==');
    const got = (await call('GET', `/api/watchfolders/${F}`)).j;
    check('filler-slate is offered for images, under Loops & Fillers', got.targetKinds.find((k: any) => k.kind === 'filler-slate'), { kind: 'filler-slate', goesTo: 'loops', accepts: ['image'] });
    check('the folder lists the account\'s image types for video', got.imageTypes?.map((t: any) => t.key), ['thumbnail', 'cover', 'poster', 'hero', 'banner', 'social', 'title']);
    const add = (b: any) => call('POST', `/api/watchfolders/${F}/rules`, { matchType: 'glob', ...b });
    check('an image rule to filler-slate is fine', (await add({ name: 'Slates to fallbacks', pattern: 'slate_*.png', targetKind: 'filler-slate' })).s, 201);
    const v1 = await add({ name: 'Bad', pattern: '*.mp4', targetKind: 'filler-slate' });
    check('a video to filler-slate is refused, pointing to loop', [v1.s, /loop/.test(v1.j?.error ?? v1.j?.message ?? '')], [400, true]);
    check('a caption to filler-slate is refused', (await add({ name: 'Bad', pattern: '*.vtt', targetKind: 'filler-slate' })).s, 400);
    check('a video to loop lands in Loops & Fillers', (await add({ name: 'Loops', pattern: 'loop_*.mp4', targetKind: 'loop' })).s, 201);
    const t1 = await add({ name: 'Bad', pattern: '*.mp4', targetKind: 'vod', imageType: 'poster' });
    check('an image type on a video rule is refused', [t1.s, t1.j?.code], [400, 'image_type_needs_image_rule']);
    const t2 = await add({ name: 'Bad', pattern: '*.png', targetKind: 'image', imageType: 'nope' });
    check('an image type the account does not have is refused', [t2.s, t2.j?.code], [400, 'unknown_image_type']);
    const t3 = await add({ name: 'Key art as hero', pattern: '*_key_art.jpg', targetKind: 'image', imageType: 'hero' });
    check('an image rule with imageType hero', [t3.s, t3.j?.image_type, t3.j?.image_type_from_name], [201, 'hero', true]);
    const t4 = await add({ name: 'TIFFs are banners', pattern: '*.tiff', targetKind: 'image', imageType: 'banner', imageTypeFromName: false });
    check('and one whose type the name cannot change', [t4.s, t4.j?.image_type_from_name], [201, false]);
    const t5 = await call('PATCH', `/api/watchfolders/${F}/rules/${t3.j.id}`, { targetKind: 'filler-slate' });
    check('moving a typed rule off the Image Library is refused', [t5.s, t5.j?.code], [400, 'image_type_needs_image_rule']);
    const t6 = await call('PATCH', `/api/watchfolders/${F}/rules/${t4.j.id}`, { imageType: 'social' });
    check('the type can be changed', [t6.s, t6.j?.image_type], [200, 'social']);
    await call('PATCH', `/api/watchfolders/${F}/rules/${t4.j.id}`, { imageType: 'banner' });

    console.log('\n== a slate and a loop into Loops & Fillers ==');
    await image(join(drop, 'slate_open.png'), 1920, 1080);
    await video(join(drop, 'loop_ident.mp4'));
    console.log(realVideo ? '(real video from ffmpeg)' : '(no ffmpeg: plain bytes)');
    const s1 = await scan();
    check('counted as a slate', s1.ingest?.slates, 1);
    const sl = await one<any>(`SELECT kind, name, status, width, height, content_type, source_key, bytes FROM filler_assets WHERE account_id = $1 AND name = 'slate_open'`, [acct]);
    check('a ready slate in Loops & Fillers with its size', [sl?.kind, sl?.status, sl?.width, sl?.height, sl?.content_type], ['slate', 'ready', 1920, 1080, 'image/png']);
    truthy('its bytes in the filler store', sl?.source_key && existsSync(join(process.env.FILLER_DIR!, sl.source_key.replace(/^filler\//, ''))) || existsSync(join(process.env.FILLER_DIR!, String(sl?.source_key))), sl?.source_key);
    const si = await item(F, 'slate_open.png');
    check('the item says Loops & Fillers', [si?.status, /Loops & Fillers as the slate "slate_open"/.test(si?.reason ?? '')], ['ingested', true]);
    check('not in the Image Library', Number((await one<any>(`SELECT count(*)::int AS n FROM media_files WHERE account_id = $1 AND name LIKE 'slate_open%'`, [acct]))?.n), 0);
    const lp = await one<any>(`SELECT kind, status FROM filler_assets WHERE account_id = $1 AND name = 'loop_ident'`, [acct]);
    check('the mp4 is a loop', [lp?.kind, lp?.status], ['loop', 'ready']);
    const listed = await call('GET', '/api/filler-assets?kind=slate');
    truthy('Loops & Fillers lists the slate', JSON.stringify(listed.j ?? {}).includes('slate_open'), `${listed.s} ${JSON.stringify(listed.j).slice(0, 200)}`);

    console.log('\n== the video, then its thumbnail and poster ==');
    await video(join(drop, 'Scrubs-s1-e1.mp4'));
    await scan();
    const e1 = (await one<any>(`SELECT vod_asset_id FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Scrubs-s1-e1.mp4'`, [F]))?.vod_asset_id;
    truthy('the video is in the Media Library', e1);
    await image(join(drop, 'Scrubs-s1-e1-thumbnail.jpg'), 1280, 720);
    await image(join(drop, 'Scrubs-s1-e1_poster.png'), 1600, 900, [200, 40, 40]);
    const s2 = await scan();
    check('both set on the asset in that pass', s2.ingest?.typed, 2);
    const th = await item(F, 'Scrubs-s1-e1-thumbnail.jpg'), po = await item(F, 'Scrubs-s1-e1_poster.png');
    check('the thumbnail: in the library as a keyframe, attached', [th?.status, th?.media_kind, th?.image_type, th?.image_attach, th?.vod_asset_id], ['ingested', 'keyframe', 'thumbnail', 'attached', e1]);
    check('the poster: in the library as a poster, attached', [po?.status, po?.media_kind, po?.image_type, po?.image_attach, po?.vod_asset_id], ['ingested', 'poster', 'poster', 'attached', e1]);
    const a1 = await one<any>(`SELECT title, poster_key, poster_locked, poster_source FROM vod_assets WHERE id = $1`, [e1]);
    check('the Thumbnail is the main image: poster_key set and locked, as the asset page does', [a1?.poster_key, a1?.poster_locked, a1?.poster_source], [th?.store_key, true, 'manual']);
    check('the Poster is its typed image', (await typed(e1)).map((x) => [x.type_key, x.image_key]), [['poster', po?.store_key]]);
    truthy('the item says which asset and type', /set as the Poster of "Episode 1 \(S1\)"/.test(po?.reason ?? ''), po?.reason);
    truthy('a wrong shape is a warning, not a refusal', /Not 2:3/.test(po?.reason ?? ''), po?.reason);
    const view = await call('GET', `/api/vod/${e1}/images`);
    const pslot = (view.j?.slots ?? []).find((x: any) => x.type?.key === 'poster');
    truthy('the asset page shows the poster with its fit warning', pslot?.image?.key === po?.store_key && pslot?.warnings?.some((x: string) => /Not 2:3/.test(x)), JSON.stringify(pslot ?? view.j).slice(0, 300));

    console.log('\n== the poster first, then the video ==');
    await image(join(drop, 'Scrubs-s1-e2_poster.png'), 1000, 1500);
    const s3 = await scan();
    check('counted as waiting', s3.ingest?.typedWaiting, 1);
    const pw = await item(F, 'Scrubs-s1-e2_poster.png');
    check('already in the Image Library, waiting', [pw?.status, pw?.media_kind, pw?.image_attach], ['ingested', 'poster', 'waiting']);
    truthy('saying it waits for a video named like it', /waiting for a video named like it/.test(pw?.reason ?? ''), pw?.reason);
    await video(join(drop, 'Scrubs-s1-e2.mp4'));
    await scan();
    const e2 = (await one<any>(`SELECT vod_asset_id FROM watchfolder_items WHERE watchfolder_id = $1 AND object_key = 'Scrubs-s1-e2.mp4'`, [F]))?.vod_asset_id;
    const pw2 = await item(F, 'Scrubs-s1-e2_poster.png');
    check('set as the poster in the pass the video landed', [pw2?.image_attach, pw2?.vod_asset_id], ['attached', e2]);
    check('on that asset only', (await typed(e2)).map((x) => x.type_key), ['poster']);
    truthy('a 2:3 poster has no warning', !/Not 2:3|Smaller/.test(pw2?.reason ?? ''), pw2?.reason);

    console.log('\n== no asset after 24 hours ==');
    await image(join(drop, 'Scrubs-s1-e9-hero.jpg'), 1920, 1080);
    await scan();
    check('waiting at first', (await item(F, 'Scrubs-s1-e9-hero.jpg'))?.image_attach, 'waiting');
    await query(`UPDATE watchfolder_items SET seen_at = now() - interval '25 hours' WHERE watchfolder_id = $1 AND object_key = 'Scrubs-s1-e9-hero.jpg'`, [F]);
    await scan();
    const hero = await item(F, 'Scrubs-s1-e9-hero.jpg');
    check('then unmatched, still ingested', [hero?.status, hero?.image_attach, hero?.vod_asset_id], ['ingested', 'unmatched', null]);
    truthy('saying it stays in the Image Library', /stays in the Image Library/.test(hero?.reason ?? ''), hero?.reason);
    truthy('and it does', !!(await one<any>(`SELECT 1 FROM media_files WHERE account_id = $1 AND store_key = $2`, [acct, hero?.store_key])));

    console.log('\n== kind words ==');
    await image(join(drop, 'Station-logo.png'), 400, 200);
    await scan();
    const logo = await item(F, 'Station-logo.png');
    check('Station-logo.png is a brand image, matched to nothing', [logo?.status, logo?.media_kind, logo?.image_attach], ['ingested', 'brand', null]);

    console.log('\n== a rule\'s type ==');
    await image(join(drop, 'Scrubs-s1-e1_key_art.jpg'), 1920, 1080);
    await image(join(drop, 'Scrubs-s1-e1_poster.tiff'), 1920, 640);
    await scan();
    const ka = await item(F, 'Scrubs-s1-e1_key_art.jpg'), tf = await item(F, 'Scrubs-s1-e1_poster.tiff');
    check('*_key_art.jpg with imageType hero sets Hero backdrop', [ka?.image_type, ka?.image_attach], ['hero', 'attached']);
    check('the name switched off: the rule\'s Banner, not the word poster', [tf?.image_type, tf?.image_attach], ['banner', 'attached']);
    check('the asset has poster, hero and banner', (await typed(e1)).map((x) => x.type_key), ['banner', 'hero', 'poster']);

    console.log('\n== an account\'s own type ==');
    const S = await import('../src/services/media/assetImageSet');
    await S.saveImageType(acct, null, { key: 'partner-tile', label: 'Partner tile', aspect: '4:3', appliesTo: ['video'] });
    await image(join(drop, 'Scrubs-s1-e1_partner-tile.png'), 1200, 900);
    await image(join(drop, 'Scrubs-s1-e2 Partner Tile.png'), 1200, 900);
    await scan();
    check('matched by its key', (await item(F, 'Scrubs-s1-e1_partner-tile.png'))?.image_type, 'partner-tile');
    check('and by its label', (await item(F, 'Scrubs-s1-e2 Partner Tile.png'))?.image_type, 'partner-tile');
    check('set on each asset', [(await typed(e1)).some((x) => x.type_key === 'partner-tile'), (await typed(e2)).some((x) => x.type_key === 'partner-tile')], [true, true]);

    console.log('\n== the dry run ==');
    const d1 = await dry('Scrubs-s1-e1_poster.png');
    check('a poster: the type from the name, filed as a poster, the asset', [d1.imageType?.key, d1.imageType?.from, d1.imageType?.word, d1.libraryKind, d1.asset?.title, d1.asset?.waiting], ['poster', 'name', 'poster', 'poster', 'Episode 1 (S1)', false]);
    const d2 = await dry('Scrubs-s1-e2_key_art.jpg');
    check('key art: Hero backdrop from the rule', [d2.imageType?.key, d2.imageType?.label, d2.imageType?.from, d2.asset?.id], ['hero', 'Hero backdrop', 'rule', e2]);
    const d3 = await dry('Nothing-here-banner.png');
    check('no asset named like it yet', [d3.imageType?.key, d3.asset], ['banner', null]);
    const d4 = await dry('Station-logo.png');
    check('a logo: filed as brand, no type', [d4.libraryKind, d4.imageType], ['brand', null]);
    const d5 = await dry('slate_close.png');
    check('a slate rule: to filler-slate, no type', [d5.decision?.targetKind, d5.imageType, d5.libraryKind], ['filler-slate', null, null]);
    await video(join(drop, 'Later-ep.mp4'));
    // A video accepted but not landed is a match that waits.
    await query(`INSERT INTO watchfolder_items (watchfolder_id, account_id, object_key, checksum, size_bytes, status, target_kind) VALUES ($1,$2,'Waiting-ep.mp4','x',10,'seen','vod')`, [F, acct]);
    const d6 = await dry('Waiting-ep_poster.png');
    check('a video still waiting to be taken in: the poster would wait for it', [d6.asset?.objectKey, d6.asset?.waiting], ['Waiting-ep.mp4', true]);
  } finally {
    srv.close();
    await pool.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
