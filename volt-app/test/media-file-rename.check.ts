// ============================================================================
//  RENAMING AN IMAGE (Image Library > Rename…, PATCH /api/files/:id { name }).
//
//  Through the real API on a real database:
//    - the name (pure): the extension is the image's own and stays, a typed
//      extension is dropped or replaced, slashes are never a path, empty and
//      over-long names are refused;
//    - a rename moves the file in the store, keeps its folder, and everything
//      that uses the image (a channel slate, an asset poster) follows it; the
//      old address keeps opening;
//    - a name already taken in the folder is refused with 409, and nothing moves;
//    - another account's image is not found; an encoder thumbnail is not renamed;
//    - a stale version is refused (409), and changing only the usage type leaves
//      the name and file alone;
//    - a video item (WebM, first frame, original) renames all three files.
//
//  Usage: DATABASE_URL=... npx tsx test/media-file-rename.check.ts
// ============================================================================
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IMAGE_STORE_DIR = mkdtempSync(join(tmpdir(), 'rename-store-'));
let pass = 0, fail = 0;
const ok = (c: unknown, m: string, d?: unknown) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d !== undefined ? ` -- ${typeof d === 'string' ? d : JSON.stringify(d)}` : '')); } };

(async () => {
  const { renamedTo } = await import('../src/modules/mediaFiles');
  console.log('== the name (pure) ==');
  ok(renamedTo('Logo.png', 'Station logo') === 'Station logo.png', 'the extension is kept when none is typed');
  ok(renamedTo('Logo.png', 'Station logo.PNG') === 'Station logo.png', 'a typed matching extension is not doubled');
  ok(renamedTo('Logo.png', 'Station logo.jpg') === 'Station logo.png', 'a different typed extension does not change the kind of file');
  ok(renamedTo('Logo.png', '  a/b\\c  ') === 'a_b_c.png', 'slashes are never a path, and the name is trimmed');
  let threw = ''; try { renamedTo('Logo.png', '  .png '); } catch (e: any) { threw = e.message; }
  ok(/required/.test(threw), 'an empty name is refused', threw);
  threw = ''; try { renamedTo('Logo.png', 'x'.repeat(201)); } catch (e: any) { threw = e.message; }
  ok(/200/.test(threw), 'a name over 200 characters is refused', threw);
  ok(renamedTo('Clip.webm', 'Opener') === 'Opener.webm', 'a video item keeps .webm');

  const { createServer } = await import('../src/server');
  const { pool, one, query } = await import('../src/db');
  const { signAccess } = await import('../src/auth/jwt');
  const { imageStore } = await import('../src/services/imageStore');
  const M = await import('../src/services/media/libraryMoves');
  const store = imageStore();
  const tag = Date.now().toString(36);
  const mk = async (n: string) => {
    const a = (await one<any>(`INSERT INTO accounts(name) VALUES ($1) RETURNING id`, [`${n}-${tag}`]))!.id;
    const u = (await one<any>(`INSERT INTO users(account_id, email, password_hash, role, status) VALUES ($1,$2,'x','owner','active') RETURNING id`, [a, `${n}-${tag}@example.com`]))!.id;
    return { a, tok: signAccess({ sub: u, account_id: a, role: 'owner' } as any) };
  };
  const me = await mk('ren'), them = await mk('oth');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (method: string, path: string, body?: unknown, t = me.tok) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let b: any = null; try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    return { status: r.status, body: b };
  };
  const addImage = async (acc: string, folder: string, name: string, extra: { source?: string; kind?: string } = {}) => {
    const path = folder ? `${folder}/${name}` : name, key = `library/${acc}/${path}`;
    await store.put(key, Buffer.from(`bytes of ${name}`), 'image/png');
    return (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [acc, extra.kind ?? 'slate', path, folder, name, key, extra.source ?? 'upload']))!;
  };

  console.log('== rename through the API ==');
  M.forgetReferenceColumns();
  const img = await addImage(me.a, 'slates', 'Back soon.png');
  const grp = (await one<any>(`INSERT INTO groups(account_id, name) VALUES ($1,'G') RETURNING id`, [me.a]))!.id;
  const ch = (await one<any>(`INSERT INTO channels(group_id, name, status, tz, kind, filler_slate_ref) VALUES ($1,'News','ended','UTC','radio',$2) RETURNING id`, [grp, img.path]))!.id;
  const vod = (await one<any>(`INSERT INTO vod_assets(account_id, source_kind, title, master_key, start_epoch_ms, end_epoch_ms, duration_ms, poster_key) VALUES ($1,'upload','A','/x',0,0,1,$2) RETURNING id`, [me.a, img.store_key]))!.id;
  let r = await api('PATCH', `/api/files/${img.id}`, { name: 'Be right back', version: img.version });
  ok(r.status === 200 && r.body.name === 'Be right back.png' && r.body.path === 'slates/Be right back.png' && r.body.folder === 'slates', 'renamed, extension and folder kept', r.body);
  const newKey = `library/${me.a}/slates/Be right back.png`;
  ok(r.body.store_key === newKey && (await store.get(newKey))?.toString() === 'bytes of Back soon.png', 'the file moved in the store with it');
  ok((await one<any>(`SELECT poster_key FROM vod_assets WHERE id = $1`, [vod])).poster_key === newKey, 'an asset poster using it now points to the new name');
  ok((await one<any>(`SELECT filler_slate_ref FROM channels WHERE id = $1`, [ch])).filler_slate_ref === 'slates/Be right back.png', 'a channel slate using it follows too');
  ok(r.body.references && Object.values(r.body.references).reduce((a: number, b: any) => a + Number(b), 0) >= 1, 'the answer says how many places followed', r.body.references);
  ok((await M.resolveMoved(img.store_key)) === newKey && (await store.get(img.store_key))?.toString() === 'bytes of Back soon.png', 'the old address keeps opening');
  const v1 = r.body.version;

  const other = await addImage(me.a, 'slates', 'Off air.png');
  r = await api('PATCH', `/api/files/${img.id}`, { name: 'Off air' });
  ok(r.status === 409 && /already in slates/.test(r.body?.error ?? r.body?.message ?? JSON.stringify(r.body)), 'a name already taken in the folder is refused', r);
  ok((await one<any>(`SELECT name FROM media_files WHERE id = $1`, [img.id])).name === 'Be right back.png' && (await store.get(other.store_key))?.toString() === 'bytes of Off air.png', 'and nothing moved or was overwritten');

  r = await api('PATCH', `/api/files/${img.id}`, { name: 'Stale', version: img.version });
  ok(r.status === 409, 'a stale version is refused', r.status);
  r = await api('PATCH', `/api/files/${img.id}`, { name: '   ' });
  ok(r.status === 400, 'an empty name is refused (400)', r.status);
  r = await api('PATCH', `/api/files/${img.id}`, { kind: 'poster', version: v1 });
  ok(r.status === 200 && r.body.kind === 'poster' && r.body.name === 'Be right back.png' && r.body.store_key === newKey, 'changing only the usage type leaves the name and file alone', r.body);
  r = await api('PATCH', `/api/files/${img.id}`, { name: 'Mine now' }, them.tok);
  ok(r.status === 404, "another account's image is not found", r.status);
  const enc = await addImage(me.a, 'thumbnails/News/2026-11-07', 'frame.jpg', { source: 'encoder', kind: 'keyframe' });
  r = await api('PATCH', `/api/files/${enc.id}`, { name: 'nice frame' });
  ok(r.status === 409 && (await store.get(enc.store_key)) !== null, 'an encoder thumbnail is not renamed', r);

  console.log('== a video item ==');
  const vb = `library/${me.a}/motion/Opener`;
  for (const [k, body] of [[`${vb}.png`, 'poster'], [`${vb}.webm`, 'video'], [`${vb}.source.mov`, 'source']]) await store.put(k, Buffer.from(body));
  const vid = (await one<any>(`INSERT INTO media_files(account_id, kind, path, folder, name, store_key, source, metadata) VALUES ($1,'motion','motion/Opener.webm','motion','Opener.webm',$2,'upload',$3::jsonb) RETURNING *`,
    [me.a, `${vb}.png`, JSON.stringify({ motion: { video: `${vb}.webm`, poster: `${vb}.png`, source: `${vb}.source.mov` } })]))!;
  r = await api('PATCH', `/api/files/${vid.id}`, { name: 'Show open' });
  const nb = `library/${me.a}/motion/Show open`;
  ok(r.status === 200 && r.body.name === 'Show open.webm' && r.body.metadata?.motion?.video === `${nb}.webm`, 'a video item is renamed as one', r.body);
  ok((await store.get(`${nb}.webm`))?.toString() === 'video' && (await store.get(`${nb}.png`))?.toString() === 'poster' && (await store.get(`${nb}.source.mov`))?.toString() === 'source', 'its WebM, first frame and original all moved together');

  srv.close();
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
